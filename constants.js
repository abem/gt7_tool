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
    /** アクセント赤（ブレーキ／減速 series-brake, --accent-red） */
    accentRed: '#D84B4F',
    /** アクセント緑（スロットル／加速 series-throttle, --accent-green） */
    accentGreen: '#1F9E57',
    /** アクセント黄（RPMテキスト／warm-tyre／caution, --accent-yellow） */
    accentYellow: '#FAB219',
    /** アクセントシアン（低温タイヤ／情報, azure = --accent-brand） */
    accentCyan: '#3D9BFF',
    /** 速度チャート線（azure-deep, --series-speed） */
    accentBlue: '#2F80D6',
    /** RPMチャート線（帯域内アンバー, --series-rpm） */
    rpmLine: '#BD8410',
    /** セッションベスト（紫, --session-best） */
    accentPurple: '#B37BFF'
});

/* ================================================================
 *  ステータス色（状態＝予約語彙。data系列色とは分離。必ずicon/ラベル併記）
 * ================================================================ */
const STATUS = Object.freeze({
    /** 良好・接続・自己ベスト・tyre optimal (--good) */
    good: '#0CA30C',
    /** 注意・warm・fuel warning (--warning) */
    warning: '#FAB219',
    /** 重度注意・低燃料 (--serious) */
    serious: '#EC835A',
    /** 危険・切断・hot・delta遅い・レブリミッタ (--critical) */
    critical: '#D03B3B'
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
    gridColor: 'rgba(255, 255, 255, 0.06)'
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
        background: 'var(--accent-brand, #3D9BFF)',
        color: 'var(--on-accent, #06121F)'
    })
});
