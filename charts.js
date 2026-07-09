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
 *  解析チャート（距離軸: 現在ラップ + リファレンスラップ重畳）
 * ================================================================ */
/** 距離軸 速度チャート（現在ラップ + ベスト半透明重畳） */
let analysisSpeedChart = null;
/** 距離軸 タイムデルタチャート */
let timeDeltaChart = null;
/** 解析チャート初期化済みフラグ */
let analysisChartsInitialized = false;

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
    series: [{}, { stroke: COLORS.accentBlue, width: 1.5, fill: 'rgba(47, 128, 214, 0.1)' }],
    cursor: { show: false },
    legend: { show: false },
    padding: [0, 0, 0, 0],
    points: { show: false }
};

/* ================================================================
 *  解析チャート共通設定（距離軸: 固定 min/max を外し距離レンジ自動）
 * ================================================================ */
const analysisChartOptions = Object.assign({}, chartOptions, {
    scales: { x: { time: false }, y: { auto: true } }
});

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

    // 背景クリア（--surface-2 プロット面）
    accelCtx.fillStyle = '#1B1F26';
    accelCtx.fillRect(0, 0, width, height);

    const maxDataPoints = Math.max(accelData.accelG.length, accelData.accelDecel.length);
    const stepX = width / Math.max(maxDataPoints - 1, 1);
    const ACCEL_G_FULL_SCALE = 10;

    // 基準線（0G, --axis）
    accelCtx.strokeStyle = '#2C313A';
    accelCtx.lineWidth = 2;
    accelCtx.beginPath();
    accelCtx.moveTo(0, height / 2);
    accelCtx.lineTo(width, height / 2);
    accelCtx.stroke();

    const drawSeries = (arr, color) => {
        if (!arr.length) return;
        accelCtx.strokeStyle = color;
        accelCtx.lineWidth = config.lineWidth;
        accelCtx.beginPath();
        arr.forEach((v, i) => {
            const x = i * stepX;
            const y = height / 2 - (v / ACCEL_G_FULL_SCALE) * (height / 2);
            if (i === 0) accelCtx.moveTo(x, y);
            else accelCtx.lineTo(x, y);
        });
        accelCtx.stroke();
    };

    // 加速G（緑）
    drawSeries(accelData.accelG, config.lineColor);
    // 減速G（赤）
    drawSeries(accelData.accelDecel, COLORS.accentRed);

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
                series: [{}, { stroke: COLORS.accentBlue, width: 1.5, fill: 'rgba(47, 128, 214, 0.1)' }]
            }),
            [timeData, speedData],
            chartElements['speed-chart']
        );

        // RPMチャート
        rpmChart = new uPlot(
            Object.assign({}, chartOptions, {
                series: [{}, { stroke: COLORS.rpmLine, width: 1.5, fill: 'rgba(189, 132, 16, 0.1)' }]
            }),
            [timeData, rpmData],
            chartElements['rpm-chart']
        );

        // スロットルチャート
        throttleChart = new uPlot(
            Object.assign({}, chartOptions, {
                series: [{}, { stroke: COLORS.accentGreen, width: 1.5, fill: 'rgba(31, 158, 87, 0.15)' }]
            }),
            [timeData, throttleData],
            chartElements['throttle-chart']
        );

        // ブレーキチャート
        brakeChart = new uPlot(
            Object.assign({}, chartOptions, {
                series: [{}, { stroke: COLORS.accentRed, width: 1.5, fill: 'rgba(216, 75, 79, 0.15)' }]
            }),
            [timeData, brakeData],
            chartElements['brake-chart']
        );

        drawAccelChart();

        // リサイズ処理設定
        setupChartResize(chartElements);

        chartsInitialized = true;

    } catch (e) {
        console.error('[CHART] Error:', e);
    }
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

/* ================================================================
 *  解析チャート（距離軸: 現在ラップ + リファレンスラップ重畳）
 *
 *  telemetry-analysis.js の ensureAnalysisInit() から typeof ガードで
 *  冪等呼出される。既存4チャート/chartOptions/setData は一切不変。
 * ================================================================ */

/**
 * 解析チャート（速度重畳 / タイムデルタ）を初期化
 * uPlot 未ロードや要素欠落は try/catch + 存在ガードでスキップ
 */
function initAnalysisCharts() {
    if (analysisChartsInitialized) {
        return;
    }

    const se = document.getElementById('analysis-speed-chart');
    const de = document.getElementById('time-delta-chart');

    try {
        // 距離軸 速度チャート: CUR(現在ラップ実線) + REF(ベスト半透明破線)
        if (se) {
            analysisSpeedChart = new uPlot(
                Object.assign({}, analysisChartOptions, {
                    series: [
                        {},
                        // CUR 現在ラップ（--series-speed = azure-deep）
                        { stroke: COLORS.accentBlue, width: 1.5, fill: 'rgba(47, 128, 214, 0.10)' },
                        // REF ベストラップ（半透明・破線・fill なし）
                        { stroke: 'rgba(47, 128, 214, 0.42)', width: 1, dash: [4, 3], fill: undefined }
                    ]
                }),
                [[0], [null], [null]],
                se
            );
        }

        // 距離軸 タイムデルタチャート（0 = オンペース。y 自動レンジ）
        if (de) {
            timeDeltaChart = new uPlot(
                Object.assign({}, analysisChartOptions, {
                    series: [
                        {},
                        // デルタ線（azure = --accent-brand）
                        { stroke: COLORS.accentCyan, width: 1.25 }
                    ]
                }),
                [[0], [null]],
                de
            );
        }

        analysisChartsInitialized = !!(analysisSpeedChart || timeDeltaChart);

        // リサイズ処理（既存 setupChartResize を踏襲）
        setupAnalysisChartResize(se, de);

    } catch (e) {
        console.error('[ANALYSIS_CHART]', e);
    }
}

/**
 * 解析チャートを再描画（telemetry-analysis.js が 100ms スロットルで供給）
 * @param {Object} pkg - {xs, curSpeed, refSpeed, delta}（全て等長, 未確定区間は null）
 */
function renderAnalysisCharts(pkg) {
    if (!pkg || !pkg.xs) {
        return;
    }
    try {
        if (analysisSpeedChart) {
            analysisSpeedChart.setData([pkg.xs, pkg.curSpeed, pkg.refSpeed]);
        }
        if (timeDeltaChart) {
            timeDeltaChart.setData([pkg.xs, pkg.delta]);
        }
    } catch (e) {
        // 描画失敗は握りつぶす（他機能に波及させない）
    }
}

/**
 * 解析チャートのリサイズ処理を設定
 * @param {HTMLElement} se - 速度チャートコンテナ
 * @param {HTMLElement} de - デルタチャートコンテナ
 */
function setupAnalysisChartResize(se, de) {
    const pairs = [
        { el: se, getChart: function() { return analysisSpeedChart; } },
        { el: de, getChart: function() { return timeDeltaChart; } }
    ];

    const applySize = function(el, chart) {
        if (!el || !chart) {
            return;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            chart.setSize({ width: rect.width, height: rect.height });
        }
    };

    pairs.forEach(function(p) {
        if (!p.el) {
            return;
        }
        const observer = new ResizeObserver(function() {
            applySize(p.el, p.getChart());
        });
        observer.observe(p.el);
        applySize(p.el, p.getChart());
    });

    // 遅延リサイズ（初期レイアウト安定後）
    setTimeout(function() {
        applySize(se, analysisSpeedChart);
        applySize(de, timeDeltaChart);
    }, 50);
    setTimeout(function() {
        applySize(se, analysisSpeedChart);
        applySize(de, timeDeltaChart);
    }, 200);
}
