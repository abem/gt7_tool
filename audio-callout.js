/**
 * GT7 Telemetry Dashboard - 音声の通知 (#564)
 *
 * Crew Chief(https://github.com/mrbelowski/CrewChiefV4)のような、音声でのアナウンスを、
 * ブラウザの音声合成(speechSynthesis)だけで実現する。DRIVE では画面を見続けられないため、
 * 次の2つだけを読み上げる(外部サービスは使わない)。
 *  - 重大な通知(severity が serious / critical): 油圧低下・燃料残量・残り周回・ファイナルラップ等
 *  - ラップ完了時のタイム: 自己ベスト更新、または、ベストとの差
 * 既定はオフ。ツールバーの AUDIO ボタンで切り替え、設定は localStorage に保存する。
 *
 * 制約(ブラウザの仕様):
 *  - 音声合成は、ページで最初のユーザー操作(クリック・キー入力)の後でないと鳴らない。
 *    オンにした状態で読み込み直したときは、最初の操作の後から読み上げる。
 *  - 読み上げは、再生・REVIEW 表示中は行わない(記録データによる通知が、ライブの警告と混ざらないように)。
 *  - 同時に1件だけ。連続する通知は、最小間隔(既定3秒)より短いものを捨てる。critical だけは、
 *    読み上げ中でも割り込む。
 *  - 音声合成が使えないブラウザでは、ボタンを作らず、何もしない。
 *
 * 契約: telemetry-analysis.js の pushNotification / onLapComplete と、race-metrics.js の
 * rmRaiseAlert(警告の1枠)から、acOnNotification / acOnLapComplete が(typeof ガード付きで)呼ばれる。
 * 公開するグローバルはこの2つのみ。通知の表示・記録の処理は変更しない。
 */
(function() {
    'use strict';

    const STORAGE_KEY = 'gt7.audioCallouts';
    const MIN_GAP_MS = 3000;
    const SPOKEN_SEVERITIES = { serious: 1, critical: 2 };

    // 通知のラベル→読み上げ文(値の入れ方も含む)。無い場合は「ラベル 値」をそのまま読む
    const LABEL_TEXT = {
        'OIL PRESSURE': function(v) { return '油圧が低下しています。' + v; },
        'LAP ANOMALY': function(v) { return 'ラップタイムが悪化しています。' + v; },
        'TYRE TEMP': function(v) { return 'タイヤ温度が急上昇しています。' + v; },
        'FUEL RATE': function(v) { return '燃料消費が増えています。' + v; },
        'FUEL': function(v) { return '燃料、残り ' + String(v).replace('%', '') + ' パーセント'; },
        'LAPS LEFT': function(v) { return '残り ' + v + ' 周'; },
        'FINAL LAP': function() { return 'ファイナルラップ'; }
    };

    const state = {
        supported: typeof window.speechSynthesis !== 'undefined' &&
            typeof window.SpeechSynthesisUtterance !== 'undefined',
        enabled: false,
        armed: false,        // 最初のユーザー操作があったか(音声合成の許可)
        lastAtMs: -Infinity,
        btn: null
    };

    function load() {
        try {
            return localStorage.getItem(STORAGE_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    function save(on) {
        try {
            localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
        } catch (e) {
            // 保存できなくても、その場の切り替えは動く
        }
    }

    /** 再生・REVIEW 中は読み上げない。 */
    function suppressedByView() {
        const cl = document.body ? document.body.classList : null;
        return !!(cl && (cl.contains('replay-mode') || cl.contains('review-mode')));
    }

    /** ms → 「1分23秒456」。 */
    function spokenLapTime(ms) {
        const total = Math.round(ms);
        const min = Math.floor(total / 60000);
        const sec = Math.floor((total % 60000) / 1000);
        const milli = total % 1000;
        return (min > 0 ? min + '分' : '') + sec + '秒' + String(milli).padStart(3, '0');
    }

    function speak(text, interrupt) {
        if (!state.supported || !state.enabled || !state.armed) {
            return false;
        }
        const now = performance.now();
        if (!interrupt && (now - state.lastAtMs < MIN_GAP_MS || window.speechSynthesis.speaking)) {
            return false;
        }
        try {
            if (interrupt) {
                window.speechSynthesis.cancel();
            }
            const u = new window.SpeechSynthesisUtterance(text);
            u.lang = 'ja-JP';
            u.rate = 1.05;
            window.speechSynthesis.speak(u);
            state.lastAtMs = now;
            return true;
        } catch (e) {
            return false;       // 読み上げの失敗は、画面の動作に影響させない
        }
    }

    /** 通知(pushNotification・警告の1枠)から。serious / critical だけ読む。 */
    window.acOnNotification = function(label, value, severity) {
        const rank = SPOKEN_SEVERITIES[severity];
        if (!rank || suppressedByView()) {
            return;
        }
        const v = value == null ? '' : String(value);
        const make = LABEL_TEXT[label];
        speak(make ? make(v) : (label + ' ' + v), rank >= 2);
    };

    /**
     * ラップ完了(telemetry-analysis.js の onLapComplete)から。
     * @param {number} lapMs - 確定したラップタイム
     * @param {number} bestBeforeMs - このラップの前のベスト(無ければ 0)
     */
    window.acOnLapComplete = function(lapMs, bestBeforeMs) {
        if (!(lapMs > 0) || suppressedByView()) {
            return;
        }
        let text;
        if (!(bestBeforeMs > 0)) {
            text = 'ラップタイム ' + spokenLapTime(lapMs);
        } else if (lapMs < bestBeforeMs) {
            text = '自己ベスト更新。' + spokenLapTime(lapMs) + '。前回のベストより ' +
                ((bestBeforeMs - lapMs) / 1000).toFixed(2) + ' 秒速い';
        } else {
            text = 'ラップタイム ' + spokenLapTime(lapMs) + '。ベストより ' +
                ((lapMs - bestBeforeMs) / 1000).toFixed(2) + ' 秒遅い';
        }
        speak(text, false);
    };

    function setEnabled(on, byUser) {
        state.enabled = on;
        save(on);
        if (state.btn) {
            state.btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            state.btn.title = on ? '音声の通知: オン(クリックでオフ)' : '音声の通知: オフ(クリックでオン)';
        }
        if (on && byUser) {
            state.armed = true;
            speak('音声通知をオンにしました', true);
        } else if (!on && state.supported) {
            try {
                window.speechSynthesis.cancel();
            } catch (e) {
                // 何もしない
            }
        }
    }

    function insertButton() {
        const bar = document.getElementById('app-toolbar');
        if (!bar || document.getElementById('ac-toolbar-btn')) {
            return !!document.getElementById('ac-toolbar-btn');
        }
        const btn = document.createElement('button');
        btn.id = 'ac-toolbar-btn';
        btn.type = 'button';
        btn.className = 'tb-btn';
        btn.setAttribute('aria-label', 'AUDIO');
        btn.setAttribute('aria-pressed', 'false');
        const ico = document.createElement('span');
        ico.className = 'tb-ico';
        ico.setAttribute('aria-hidden', 'true');
        ico.textContent = '🔊';
        const label = document.createElement('span');
        label.className = 'tb-label';
        label.textContent = 'AUDIO';
        btn.appendChild(ico);
        btn.appendChild(label);
        btn.addEventListener('click', function() {
            setEnabled(!state.enabled, true);
        });
        bar.appendChild(btn);
        state.btn = btn;
        setEnabled(load(), false);      // 保存された設定を反映(読み上げの許可は、最初の操作を待つ)
        return true;
    }

    function init() {
        if (!state.supported) {
            return;       // 音声合成が使えないブラウザでは、ボタンを作らない
        }
        // 最初のユーザー操作で、音声合成の許可が得られたとみなす
        const arm = function() {
            state.armed = true;
            document.removeEventListener('pointerdown', arm, true);
            document.removeEventListener('keydown', arm, true);
        };
        document.addEventListener('pointerdown', arm, true);
        document.addEventListener('keydown', arm, true);
        if (!insertButton()) {
            let tries = 0;
            const t = setInterval(function() {
                if (insertButton() || ++tries > 20) {
                    clearInterval(t);
                }
            }, 100);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
