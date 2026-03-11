/**
 * GT7 Telemetry Dashboard
 * エントリーポイント
 *
 * 依存: ui_components.js, charts.js, course-map.js, websocket.js, test-mode.js
 */

(function() {
    debugLog('INIT', 'GT7 Telemetry Dashboard loaded');

    if (typeof uPlot === 'undefined') {
        console.error('[CRITICAL] uPlot library not loaded!');
    }

    // 初期化は websocket.js の DOMContentLoaded で実行
    // ここではテストモード初期化のみ行う
    initTestMode();
})();
