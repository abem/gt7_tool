/**
 * GT7 Telemetry Dashboard - 運転支援の作動表示 (#603)
 *
 * CAR ATTITUDE のタイトル右に TCS / ABS / ASM の小さな表示を常設し、作動中だけ点灯する。
 *  - TCS / ASM: パケットの旗(flags.tcs_active / flags.asm_active)そのもの。
 *  - ABS: 旗が無いため推定。制動中に、(a) ペダル値(brake_pct)より ABS 補正後(brake_filtered_pct)が
 *    ABS_FILTER_DIFF_PCT 以上弱い、または (b) 車輪のスリップ(1 − 車輪速/車速)が ABS_SLIP_MIN 以上、
 *    のどちらかで点灯する。実データでは、全開制動中に (a) が 0 のまま (b) が 7% 前後で安定する
 *    (GT7 の ABS が制動を調整している状態)。惰行中のスリップは 4% 未満。
 *
 * 経路: ライブ・全カード再生・TEST MODE のどれも handleTelemetryMessage → daOnFrame(typeof ガード付き)。
 * フレームが STALE_MS 来なければ全て消灯する(切断・再生終了・REVIEW)。全カード再生の一時停止中は保つ。
 * IIFE で隔離。公開は window.daOnFrame のみ。既存の id・class は変えない。
 */
(function() {
    'use strict';

    const ABS_FILTER_DIFF_PCT = 3;        // ペダル値より ABS 補正後の制動がこれ以上弱い[%]
    const ABS_SLIP_MIN = 0.05;            // 制動中の車輪のスリップ(1 − 車輪速/車速)がこれ以上
    const ABS_MIN_SPEED_MS = 10 / 3.6;    // この車速未満ではスリップを見ない(低速では比が荒れる)
    const STALE_MS = 2000;                // フレームがこれだけ来なければ消灯
    const AIDS = [
        { key: 'tcs', label: 'TCS', title: 'トラクションコントロール(作動中に点灯。パケットの旗)' },
        { key: 'abs', label: 'ABS', title: 'ABS(推定: ペダルより ABS 補正後の制動が ' + ABS_FILTER_DIFF_PCT +
                 '% 以上弱い、または制動中に車輪のスリップが ' + Math.round(ABS_SLIP_MIN * 100) + '% 以上)' },
        { key: 'asm', label: 'ASM', title: 'アクティブ・スタビリティ・マネジメント(作動中に点灯。パケットの旗)' }
    ];

    const state = { els: null, on: { tcs: false, abs: false, asm: false }, lastFrameMs: 0 };

    function build() {
        if (state.els) {
            return true;
        }
        const card = document.querySelector('.car-3d-card');
        const title = card ? card.querySelector('.card-title') : null;
        if (!title) {
            return false;
        }
        const row = document.createElement('span');
        row.id = 'da-aids';
        row.className = 'da-aids';
        row.setAttribute('aria-label', '運転支援の作動');
        const els = {};
        AIDS.forEach(function(a) {
            const el = document.createElement('span');
            el.id = 'da-' + a.key;
            el.className = 'da-aid da-' + a.key;
            el.textContent = a.label;
            el.title = a.title;
            row.appendChild(el);
            els[a.key] = el;
        });
        title.appendChild(row);
        state.els = els;
        return true;
    }

    function set(key, on) {
        if (state.on[key] === on) {
            return;
        }
        state.on[key] = on;
        state.els[key].classList.toggle('da-on', on);
    }

    /** ABS の推定(本ファイル冒頭の規則)。 */
    function absActive(d) {
        const brake = d.brake_pct || 0;
        if (brake <= 0) {
            return false;
        }
        const filtered = d.brake_filtered_pct;
        if (typeof filtered === 'number' && brake - filtered >= ABS_FILTER_DIFF_PCT) {
            return true;
        }
        const v = d.speed_ms != null ? d.speed_ms : (d.speed_kmh || 0) / 3.6;
        if (v < ABS_MIN_SPEED_MS || !Array.isArray(d.wheel_rps) || !Array.isArray(d.tyre_radius) ||
            d.wheel_rps.length < 4 || d.tyre_radius.length < 4) {
            return false;
        }
        for (let i = 0; i < 4; i++) {
            const wheel = Math.abs(d.wheel_rps[i] || 0) * (d.tyre_radius[i] || 0);
            if (1 - wheel / v >= ABS_SLIP_MIN) {
                return true;
            }
        }
        return false;
    }

    /** 1フレームごとに websocket.js から呼ばれる(typeof ガード付き)。 */
    window.daOnFrame = function(d) {
        if (!d || !build()) {
            return;
        }
        const flags = d.flags || {};
        set('tcs', !!flags.tcs_active);
        set('asm', !!flags.asm_active);
        set('abs', absActive(d));
        state.lastFrameMs = performance.now();
    };

    /** 全カード再生の一時停止中は、他のカードと同じく最後のフレームの表示を保つ。 */
    function replayPaused() {
        return typeof replayActive !== 'undefined' && replayActive &&
            typeof replayState !== 'undefined' && replayState && !replayState.playing;
    }

    setInterval(function() {
        if (state.els && !replayPaused() && performance.now() - state.lastFrameMs > STALE_MS) {
            set('tcs', false);
            set('abs', false);
            set('asm', false);
        }
    }, 500);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', build);
    } else {
        build();
    }
})();
