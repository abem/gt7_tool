/**
 * GT7 Telemetry Dashboard
 * 共通定数・設定値
 *
 * @module constants
 */

/* ================================================================
 *  表示色定義
 * ================================================================ */
const COLORS = Object.freeze({
    /** アクセント赤（警告・高回転） */
    accentRed: '#ff4444',
    /** アクセント緑（正常・加速） */
    accentGreen: '#00ff88',
    /** アクセント黄（注意・推奨ギア） */
    accentYellow: '#ffd700',
    /** アクセントシアン（低温・情報） */
    accentCyan: '#44ffff'
});

/* ================================================================
 *  チャート設定
 * ================================================================ */
/** チャート表示ポイント数 */
const CHART_POINTS = 1200;

/** 加速度チャート設定 */
const ACCEL_CHART_CONFIG = Object.freeze({
    /** 最大データポイント数 */
    maxPoints: 200,
    /** ライン色 */
    lineColor: COLORS.accentGreen,
    /** ライン太さ */
    lineWidth: 2,
    /** グリッド色 */
    gridColor: 'rgba(255, 255, 255, 0.1)'
});

/* ================================================================
 *  タイヤ温度閾値
 * ================================================================ */
const TYRE_TEMP = Object.freeze({
    /** 低温閾値（摂氏） - これ未満はシアン */
    COLD_THRESHOLD: 40,
    /** 最適温度下限（摂氏） */
    OPTIMAL_LOW: 40,
    /** 最適温度上限（摂氏） */
    OPTIMAL_HIGH: 80,
    /** 高温閾値（摂氏） - これ以上は赤 */
    HOT_THRESHOLD: 100
});

/* ================================================================
 *  コースマップ設定
 * ================================================================ */
const COURSE_MAP_CONFIG = Object.freeze({
    colors: Object.freeze({
        grid: 'rgba(255, 255, 255, 0.05)',
        text: 'rgba(255, 255, 255, 0.5)',
        car: COLORS.accentGreen,
        trajectoryLow: COLORS.accentRed,
        trajectoryMid: COLORS.accentYellow,
        trajectoryHigh: COLORS.accentGreen
    }),
    /** 軌跡サンプリング間隔 */
    trajectorySampleInterval: 3,
    /** 軌跡最大ポイント数 */
    maxTrajectoryPoints: 2000
});

/* ================================================================
 *  更新レート設定
 * ================================================================ */
const UPDATE_INTERVALS = Object.freeze({
    /** UI更新間隔（ms） - 30fps */
    UI: 1000 / 30,
    /** チャート更新間隔（ms） - 20fps */
    CHART: 1000 / 20,
    /** マップ更新間隔（ms） - 10fps */
    MAP: 1000 / 10,
    /** 3D回転更新間隔（ms） - 30fps */
    ROTATION: 1000 / 30
});

/* ================================================================
 *  WebSocket設定
 * ================================================================ */
const WEBSOCKET_CONFIG = Object.freeze({
    /** 初期再接続遅延（ms） */
    reconnectDelayInitial: 2000,
    /** 最大再接続遅延（ms） */
    reconnectDelayMax: 30000,
    /** 再接続遅延倍率 */
    reconnectDelayMultiplier: 1.5
});

/* ================================================================
 *  テストモード設定
 * ================================================================ */
const TEST_MODE_CONFIG = Object.freeze({
    /** 更新間隔（ms） */
    intervalMs: 200,
    /** ステータス表示 */
    status: Object.freeze({
        text: 'TEST MODE',
        background: 'var(--accent-yellow)',
        color: '#000'
    })
});

/* ================================================================
 *  速度閾値（コースマップ軌跡色分け用）
 * ================================================================ */
const SPEED_THRESHOLDS = Object.freeze({
    /** 低速閾値（km/h） */
    LOW: 60,
    /** 中速閾値（km/h） */
    HIGH: 120
});
