/**
 * GT7 Telemetry Dashboard
 * チャート初期化・管理（uPlot + 加速度Canvas）
 *
 * @module charts
 * @depends constants.js (CHART_POINTS, COLORS, ACCEL_CHART_CONFIG)
 * @depends ui_components.js (accelData, debugLog)
 */

/* ================================================================
 *  チャートデータ
 * ================================================================ */
/** タイムカウンター */
let timeCounter = 0;

/** 時刻データ配列 */
const timeData = new Array(CHART_POINTS).fill(0);
/** 速度データ配列 */
const speedData = new Array(CHART_POINTS).fill(0);
/** RPMデータ配列 */
const rpmData = new Array(CHART_POINTS).fill(0);
/** スロットルデータ配列 */
const throttleData = new Array(CHART_POINTS).fill(0);
/** ブレーキデータ配列 */
const brakeData = new Array(CHART_POINTS).fill(0);

/* ================================================================
 *  チャートインスタンス
 * ================================================================ */
/** 速度チャート */
let speedChart = null;
/** RPMチャート */
let rpmChart = null;
/** スロットルチャート */
let throttleChart = null;
/** ブレーキチャート */
let brakeChart = null;

/* ================================================================
 *  加速度チャート（Canvas）
 * ================================================================ */
/** 加速度チャートCanvas要素 */
let accelCanvas = null;
/** 加速度チャート描画コンテキスト */
let accelCtx = null;

/** チャート初期化済みフラグ */
let chartsInitialized = false;

/* ================================================================
 *  uPlot共通設定
 * ================================================================ */
const chartOptions = {
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

/* ================================================================
 *  加速度チャート描画
 * ================================================================ */

/**
 * 加速度チャートを描画
 */
function drawAccelChart() {
    if (!accelCanvas || !accelCtx) {
        return;
    }

    const width = accelCanvas.width;
    const height = accelCanvas.height;
    const config = ACCEL_CHART_CONFIG;

    // 背景クリア
    accelCtx.fillStyle = '#1a1a2e';
    accelCtx.fillRect(0, 0, width, height);

    const maxDataPoints = Math.max(accelData.accelG.length, accelData.accelDecel.length);
    const stepX = width / Math.max(maxDataPoints - 1, 1);

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

        for (let i = 0; i < accelData.accelG.length; i++) {
            const x = i * stepX;
            const y = height / 2 - (accelData.accelG[i] / 10) * (height / 2);

            if (i === 0) {
                accelCtx.moveTo(x, y);
            } else {
                accelCtx.lineTo(x, y);
            }
        }
        accelCtx.stroke();
    }

    // 減速G（赤）
    if (accelData.accelDecel.length > 0) {
        accelCtx.strokeStyle = COLORS.accentRed;
        accelCtx.lineWidth = config.lineWidth;
        accelCtx.beginPath();

        for (let i = 0; i < accelData.accelDecel.length; i++) {
            const x = i * stepX;
            const y = height / 2 - (accelData.accelDecel[i] / 10) * (height / 2);

            if (i === 0) {
                accelCtx.moveTo(x, y);
            } else {
                accelCtx.lineTo(x, y);
            }
        }
        accelCtx.stroke();
    }

    // テキスト表示
    accelCtx.font = '12px sans-serif';

    const lastAccelG = accelData.accelG[accelData.accelG.length - 1] || 0;
    accelCtx.textAlign = 'right';
    accelCtx.fillStyle = COLORS.accentGreen;
    accelCtx.fillText('ACCEL: ' + lastAccelG.toFixed(2) + ' G', width - 10, 20);

    const lastAccelDecel = accelData.accelDecel[accelData.accelDecel.length - 1] || 0;
    accelCtx.textAlign = 'left';
    accelCtx.fillStyle = COLORS.accentRed;
    accelCtx.fillText('DECEL: ' + lastAccelDecel.toFixed(2) + ' G', 10, 20);
}

/**
 * 加速度チャートのデータを更新
 * @param {number} accelG - 加速G
 * @param {number} accelDecel - 減速G
 */
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

/* ================================================================
 *  チャート初期化
 * ================================================================ */

/**
 * チャートを初期化
 */
function initCharts() {
    if (chartsInitialized) {
        return;
    }

    let initSucceeded = false;

    const chartElements = {
        'speed-chart': document.getElementById('speed-chart'),
        'rpm-chart': document.getElementById('rpm-chart'),
        'throttle-chart': document.getElementById('throttle-chart'),
        'brake-chart': document.getElementById('brake-chart')
    };

    // 加速度チャート初期化
    initAccelChart(chartElements);

    try {
        // 速度チャート
        speedChart = new uPlot(
            Object.assign({}, chartOptions, {
                series: [{}, { stroke: COLORS.accentGreen, width: 1.5, fill: 'rgba(0, 255, 136, 0.1)' }]
            }),
            [timeData, speedData],
            chartElements['speed-chart']
        );

        // RPMチャート
        rpmChart = new uPlot(
            Object.assign({}, chartOptions, {
                series: [{}, { stroke: COLORS.accentYellow, width: 1.5, fill: 'rgba(255, 215, 0, 0.1)' }]
            }),
            [timeData, rpmData],
            chartElements['rpm-chart']
        );

        // スロットルチャート
        throttleChart = new uPlot(
            Object.assign({}, chartOptions, {
                series: [{}, { stroke: COLORS.accentGreen, width: 1.5, fill: 'rgba(0, 255, 136, 0.15)' }]
            }),
            [timeData, throttleData],
            chartElements['throttle-chart']
        );

        // ブレーキチャート
        brakeChart = new uPlot(
            Object.assign({}, chartOptions, {
                series: [{}, { stroke: COLORS.accentRed, width: 1.5, fill: 'rgba(255, 68, 68, 0.15)' }]
            }),
            [timeData, brakeData],
            chartElements['brake-chart']
        );

        drawAccelChart();

        // リサイズ処理設定
        setupChartResize(chartElements);

        initSucceeded = true;

    } catch (e) {
        console.error('[CHART] Error:', e);
    }

    chartsInitialized = initSucceeded;
}

/**
 * 加速度チャートを初期化
 * @param {Object} chartElements - チャート要素マップ
 */
function initAccelChart(chartElements) {
    const accelCanvasEl = document.getElementById('accel-chart');

    if (!accelCanvasEl) {
        return;
    }

    accelCanvas = accelCanvasEl;
    accelCtx = accelCanvas.getContext('2d');

    const resizeAccelChart = function() {
        const container = accelCanvas.parentElement;
        if (container) {
            accelCanvas.width = container.clientWidth;
            accelCanvas.height = container.clientHeight;
            drawAccelChart();
        }
    };

    const accelResizeObserver = new ResizeObserver(resizeAccelChart);
    if (accelCanvas.parentElement) {
        accelResizeObserver.observe(accelCanvas.parentElement);
    }

    resizeAccelChart();
}

/**
 * チャートのリサイズ処理を設定
 * @param {Object} chartElements - チャート要素マップ
 */
function setupChartResize(chartElements) {
    let resizeTimeout;

    const resizeCharts = function() {
        const ids = ['speed-chart', 'rpm-chart', 'throttle-chart', 'brake-chart'];
        const charts = [speedChart, rpmChart, throttleChart, brakeChart];

        ids.forEach(function(id, i) {
            const el = document.getElementById(id);
            if (el && charts[i]) {
                const rect = el.getBoundingClientRect();
                charts[i].setSize({ width: rect.width, height: rect.height });
            }
        });
    };

    const debouncedResize = function() {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(resizeCharts, 100);
    };

    window.addEventListener('resize', debouncedResize);

    const resizeObserver = new ResizeObserver(debouncedResize);
    Object.values(chartElements).forEach(function(el) {
        if (el) {
            resizeObserver.observe(el);
        }
    });

    // 遅延リサイズ（初期レイアウト安定後）
    setTimeout(resizeCharts, 50);
    setTimeout(resizeCharts, 200);
}
