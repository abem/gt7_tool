/**
 * GT7 Telemetry Dashboard
 * チャート初期化・管理（uPlot + 加速度Canvas）
 *
 * 依存: ui_components.js (CHART_POINTS, ACCEL_CHART_CONFIG, accelData, debugLog)
 */

var timeCounter = 0;

// チャートデータ配列
var timeData = new Array(CHART_POINTS).fill(0);
var speedData = new Array(CHART_POINTS).fill(0);
var rpmData = new Array(CHART_POINTS).fill(0);
var throttleData = new Array(CHART_POINTS).fill(0);
var brakeData = new Array(CHART_POINTS).fill(0);

// チャートインスタンス
var speedChart = null;
var rpmChart = null;
var throttleChart = null;
var brakeChart = null;

// 加速度チャート
var accelCanvas = null;
var accelCtx = null;
var chartsInitialized = false;

// uPlot 共通設定
var chartOptions = {
    width: 200,
    height: 100,
    pxAlign: 0,
    pxSnap: true,
    plugins: [],
    scales: {
        x: { time: false, min: 0, max: CHART_POINTS - 1 },
        y: { auto: true }
    },
    axes: [
        { show: false },
        { show: false }
    ],
    series: [{}, { stroke: COLORS.accentGreen, width: 1.5, fill: 'rgba(0, 255, 136, 0.1)' }],
    cursor: { show: false },
    legend: { show: false },
    padding: [0, 0, 0, 0],
    points: { show: false }
};

function drawAccelChart() {
    if (!accelCanvas || !accelCtx) return;

    var width = accelCanvas.width;
    var height = accelCanvas.height;
    var config = ACCEL_CHART_CONFIG;

    accelCtx.fillStyle = '#1a1a2e';
    accelCtx.fillRect(0, 0, width, height);

    var maxDataPoints = Math.max(accelData.accelG.length, accelData.accelDecel.length);
    var stepX = width / Math.max(maxDataPoints - 1, 1);

    // 基準線（0G）
    accelCtx.strokeStyle = 'rgba(100, 100, 100, 0.3)';
    accelCtx.lineWidth = 2;
    accelCtx.beginPath();
    accelCtx.moveTo(0, height / 2);
    accelCtx.lineTo(width, height / 2);
    accelCtx.stroke();

    // 加速G（緑）
    if (accelData.accelG.length > 0) {
        accelCtx.strokeStyle = config.lineColor;
        accelCtx.lineWidth = config.lineWidth;
        accelCtx.beginPath();
        for (var i = 0; i < accelData.accelG.length; i++) {
            var x = i * stepX;
            var y = height / 2 - (accelData.accelG[i] / 10) * (height / 2);
            if (i === 0) accelCtx.moveTo(x, y);
            else accelCtx.lineTo(x, y);
        }
        accelCtx.stroke();
    }

    // 減速G（赤）
    if (accelData.accelDecel.length > 0) {
        accelCtx.strokeStyle = COLORS.accentRed;
        accelCtx.lineWidth = config.lineWidth;
        accelCtx.beginPath();
        for (var i = 0; i < accelData.accelDecel.length; i++) {
            var x = i * stepX;
            var y = height / 2 - (accelData.accelDecel[i] / 10) * (height / 2);
            if (i === 0) accelCtx.moveTo(x, y);
            else accelCtx.lineTo(x, y);
        }
        accelCtx.stroke();
    }

    // テキスト表示
    accelCtx.font = '12px sans-serif';
    var lastAccelG = accelData.accelG[accelData.accelG.length - 1] || 0;
    accelCtx.textAlign = 'right';
    accelCtx.fillStyle = COLORS.accentGreen;
    accelCtx.fillText('ACCEL: ' + lastAccelG.toFixed(2) + ' G', width - 10, 20);

    var lastAccelDecel = accelData.accelDecel[accelData.accelDecel.length - 1] || 0;
    accelCtx.textAlign = 'left';
    accelCtx.fillStyle = COLORS.accentRed;
    accelCtx.fillText('DECEL: ' + lastAccelDecel.toFixed(2) + ' G', 10, 20);
}

function updateAccelChart(accelG, accelDecel) {
    if (accelG !== undefined) {
        accelData.accelG.push(accelG);
        if (accelData.accelG.length > ACCEL_CHART_CONFIG.maxPoints) {
            accelData.accelG.shift();
        }
    }
    if (accelDecel !== undefined) {
        accelData.accelDecel.push(accelDecel);
        if (accelData.accelDecel.length > ACCEL_CHART_CONFIG.maxPoints) {
            accelData.accelDecel.shift();
        }
    }
    drawAccelChart();
}

function initCharts() {
    if (chartsInitialized) return;
    var initSucceeded = false;
    var chartElements = {
        'speed-chart': document.getElementById('speed-chart'),
        'rpm-chart': document.getElementById('rpm-chart'),
        'throttle-chart': document.getElementById('throttle-chart'),
        'brake-chart': document.getElementById('brake-chart')
    };

    // 加速度チャート初期化
    var accelCanvasEl = document.getElementById('accel-chart');
    if (accelCanvasEl) {
        accelCanvas = accelCanvasEl;
        accelCtx = accelCanvas.getContext('2d');

        var resizeAccelChart = function() {
            var container = accelCanvas.parentElement;
            if (container) {
                accelCanvas.width = container.clientWidth;
                accelCanvas.height = container.clientHeight;
                drawAccelChart();
            }
        };

        var accelResizeObserver = new ResizeObserver(resizeAccelChart);
        if (accelCanvas.parentElement) {
            accelResizeObserver.observe(accelCanvas.parentElement);
        }
        resizeAccelChart();
    }

    try {
        speedChart = new uPlot(
            Object.assign({}, chartOptions, {
                series: [{}, { stroke: COLORS.accentGreen, width: 1.5, fill: 'rgba(0, 255, 136, 0.1)' }]
            }),
            [timeData, speedData],
            chartElements['speed-chart']
        );

        rpmChart = new uPlot(
            Object.assign({}, chartOptions, {
                series: [{}, { stroke: COLORS.accentYellow, width: 1.5, fill: 'rgba(255, 215, 0, 0.1)' }]
            }),
            [timeData, rpmData],
            chartElements['rpm-chart']
        );

        throttleChart = new uPlot(
            Object.assign({}, chartOptions, {
                series: [{}, { stroke: COLORS.accentGreen, width: 1.5, fill: 'rgba(0, 255, 136, 0.15)' }]
            }),
            [timeData, throttleData],
            chartElements['throttle-chart']
        );

        brakeChart = new uPlot(
            Object.assign({}, chartOptions, {
                series: [{}, { stroke: COLORS.accentRed, width: 1.5, fill: 'rgba(255, 68, 68, 0.15)' }]
            }),
            [timeData, brakeData],
            chartElements['brake-chart']
        );

        drawAccelChart();

        // リサイズ処理（デバウンス付き）
        var resizeTimeout;
        var resizeCharts = function() {
            var ids = ['speed-chart', 'rpm-chart', 'throttle-chart', 'brake-chart'];
            var charts = [speedChart, rpmChart, throttleChart, brakeChart];
            ids.forEach(function(id, i) {
                var el = document.getElementById(id);
                if (el && charts[i]) {
                    var rect = el.getBoundingClientRect();
                    charts[i].setSize({ width: rect.width, height: rect.height });
                }
            });
        };

        var debouncedResize = function() {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(resizeCharts, 100);
        };

        window.addEventListener('resize', debouncedResize);

        var resizeObserver = new ResizeObserver(debouncedResize);
        Object.values(chartElements).forEach(function(el) {
            if (el) resizeObserver.observe(el);
        });

        setTimeout(resizeCharts, 50);
        setTimeout(resizeCharts, 200);
        initSucceeded = true;

    } catch (e) {
        console.error('[CHART] Error:', e);
    }

    chartsInitialized = initSucceeded;
}
