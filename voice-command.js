/**
 * GT7 Telemetry Dashboard - 音声コマンドビュー切替 (#436 B3)
 *
 * SpeechRecognition Web API(明示的トリガー方式、ワンショット)でDRIVE/ANALYSIS切替・
 * カード表示グループ(g1〜g6)切替を音声操作する。#434 P4のSpeechSynthesis(読み上げ)と
 * 対になる、逆方向(音声→操作)の機能。常時待ち受けはせず、ツールバーのVOICEボタンを
 * 押した時だけ1発話分認識する(電力・プライバシー配慮、予備調査(c)で承認済み)。
 *
 * 非対応ブラウザ(Firefox既定等)では機能検出でボタン自体を生成しない(優雅な縮退、
 * 予備調査(a)で承認済み)。
 *
 * @module voice-command
 * @depends drive-view.js (applyViewMode), card-groups.js (window.cgVoiceShowOnly、
 *          #436 B3向けに新設した唯一のpublic API)。全てtypeofガードで安全に参照。
 */

const VC_LISTEN_TIMEOUT_MS = 5000;   // 発話が検出されないまま経過したら自動キャンセル

// 音声コマンド語彙(予備調査(b)で承認済み)。日本語音声認識の表記ゆれを考慮し、
// 完全一致ではなくキーワード配列との部分一致判定(vcMatchCommand)で吸収する。
const VC_COMMANDS = [
    { keywords: ['ドライブ', 'drive'], group: null, view: true, label: 'DRIVE' },
    { keywords: ['アナリシス', 'analysis', '解析'], group: null, view: false, label: 'ANALYSIS' },
    { keywords: ['チャート', 'charts'], group: 'g1', label: 'CHARTS' },
    { keywords: ['ペダル', 'ドライブトレイン', 'pedals', 'drivetrain'], group: 'g2', label: 'PEDALS/DRIVETRAIN' },
    { keywords: ['フューエル', 'ストラテジー', '燃料', 'fuel', 'strategy'], group: 'g3', label: 'FUEL/STRATEGY' },
    { keywords: ['ビヘイビア', '挙動', 'behavior'], group: 'g4', label: 'CAR BEHAVIOR' },
    { keywords: ['ラップ', 'タイミング', 'lap', 'timing'], group: 'g5', label: 'LAP/TIMING' },
    { keywords: ['車両情報', 'インフォ', 'info'], group: 'g6', label: 'CAR INFO' }
];

const vcState = {
    recognition: null,
    listening: false,
    btn: null,
    timeoutTimer: null
};

/** 機能検出: SpeechRecognition(標準)またはwebkitSpeechRecognition(Safari等)。 */
function vcSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/** 認識結果の文字列から該当コマンドを探す(部分一致、大小文字無視)。 */
function vcMatchCommand(transcript) {
    const t = (transcript || '').toLowerCase();
    for (let i = 0; i < VC_COMMANDS.length; i++) {
        const cmd = VC_COMMANDS[i];
        for (let j = 0; j < cmd.keywords.length; j++) {
            if (t.indexOf(cmd.keywords[j].toLowerCase()) !== -1) {
                return cmd;
            }
        }
    }
    return null;
}

/** マッチしたコマンドを実行する(既存関数を読み取り専用で呼び出すのみ)。 */
function vcExecuteCommand(cmd) {
    if (cmd.group) {
        if (typeof window.cgVoiceShowOnly === 'function') {
            window.cgVoiceShowOnly(cmd.group);
        }
    } else if (typeof applyViewMode === 'function') {
        applyViewMode(cmd.view);
    }
}

function vcSetListening(on) {
    vcState.listening = on;
    if (vcState.btn) {
        vcState.btn.classList.toggle('vc-listening', on);
        vcState.btn.setAttribute('aria-pressed', String(on));
    }
    if (vcState.timeoutTimer) {
        clearTimeout(vcState.timeoutTimer);
        vcState.timeoutTimer = null;
    }
}

/** VOICEボタン押下時の入口(ワンショット起動)。 */
function vcStart() {
    if (vcState.listening || !vcState.recognition) {
        return;
    }
    try {
        vcState.recognition.start();
        vcSetListening(true);
        // タイムアウト(発話なしで一定時間経過したら自動キャンセル、予備調査(c))
        vcState.timeoutTimer = setTimeout(function() {
            if (vcState.recognition) {
                vcState.recognition.stop();
            }
        }, VC_LISTEN_TIMEOUT_MS);
    } catch (e) {
        // 短時間の連打等でstart()が例外を投げるケース(既に開始中等)を握りつぶさず視認可能にする
        vcSetListening(false);
        if (typeof pushNotification === 'function') {
            pushNotification('VOICE', '音声認識を開始できませんでした', 'notice');
        }
    }
}

function vcBuildRecognition() {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new Ctor();
    recognition.lang = 'ja-JP';
    recognition.continuous = false;     // 1発話で自動終了(常時待ち受けにしない)
    recognition.interimResults = false; // 確定結果のみ処理
    recognition.maxAlternatives = 1;

    recognition.onresult = function(event) {
        const transcript = event.results[0][0].transcript;
        const cmd = vcMatchCommand(transcript);
        if (cmd) {
            vcExecuteCommand(cmd);
        } else if (typeof pushNotification === 'function') {
            pushNotification('VOICE', '認識できませんでした: ' + transcript, 'notice');
        }
    };
    recognition.onerror = function(event) {
        if (typeof pushNotification === 'function') {
            pushNotification('VOICE', '音声認識エラー(' + event.error + ')', 'notice');
        }
    };
    recognition.onend = function() {
        vcSetListening(false);
    };
    return recognition;
}

function vcInsertButton() {
    const bar = document.getElementById('app-toolbar');
    if (!bar || document.getElementById('vc-toolbar-btn')) {
        return !!document.getElementById('vc-toolbar-btn');
    }
    const btn = document.createElement('button');
    btn.id = 'vc-toolbar-btn';
    btn.type = 'button';
    btn.className = 'tb-btn';
    btn.title = '音声コマンドでビュー/カード表示を切替(押している間ではなく、押すと1回だけ聞き取ります)';
    btn.setAttribute('aria-label', 'VOICE');
    btn.setAttribute('aria-pressed', 'false');
    const ico = document.createElement('span');
    ico.className = 'tb-ico';
    ico.setAttribute('aria-hidden', 'true');
    ico.textContent = '🎤'; // 🎤
    const label = document.createElement('span');
    label.className = 'tb-label';
    label.textContent = 'VOICE';
    btn.appendChild(ico);
    btn.appendChild(label);
    btn.addEventListener('click', vcStart);
    bar.appendChild(btn);
    vcState.btn = btn;
    return true;
}

function vcInit() {
    if (!vcSupported()) {
        return; // 非対応ブラウザ(Firefox既定等)ではボタン自体を作らない(優雅な縮退)
    }
    vcState.recognition = vcBuildRecognition();
    // menu.js のツールバーは DOMContentLoaded で生成される。本ファイルは
    // menu.js より後だが、生成前に走った場合に備えて短いリトライを持つ
    // (card-groups.js の cgInit と同型の防御)。
    if (!vcInsertButton()) {
        let tries = 0;
        const t = setInterval(function() {
            if (vcInsertButton() || ++tries > 20) {
                clearInterval(t);
            }
        }, 100);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', vcInit);
} else {
    vcInit();
}
