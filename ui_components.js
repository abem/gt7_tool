/**
 * GT7 Telemetry Dashboard
 * DOM要素キャッシュ・ユーティリティ関数
 *
 * @module ui_components
 * @depends constants.js (COLORS, TYRE_TEMP, SPEED_THRESHOLDS)
 */

/* ================================================================
 *  デバッグモード
 * ================================================================ */
let DEBUG_MODE = false;

/* ================================================================
 *  コースマップ状態
 * ================================================================ */
const courseMapState = {
    canvas: null,
    ctx: null,
    domReady: false,
    initialized: false,
    bounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
    trajectory: [],
    currentPosition: { x: 0, y: 0, z: 0 },
    sampleCount: 0,
    infoEl: null
};

/* ================================================================
 *  加速度データ
 * ================================================================ */
const accelData = {
    accelG: [],
    accelDecel: []
};

/* ================================================================
 *  DOM要素キャッシュ
 * ================================================================ */
let elements = {};

/**
 * DOM要素をキャッシュする
 * 初期化時に一度だけ呼び出すこと
 */
function cacheElements() {
    elements = {
        // Racing Style Top Bar
        shiftLights: document.getElementById('shift-lights'),
        
        // ペダル詳細（左パネル用）
        throttleBarDetail: document.getElementById('throttle-bar-detail'),
        throttleValueDetail: document.getElementById('throttle-value-detail'),
        brakeBarDetail: document.getElementById('brake-bar-detail'),
        brakeValueDetail: document.getElementById('brake-value-detail'),
        wheelRotationDetail: document.getElementById('wheel-rotation-detail'),

        // 速度・ギア
        speed: document.getElementById('speed'),
        gear: document.getElementById('gear'),
        suggestedGear: document.getElementById('suggested-gear'),
        wheelRotation: document.getElementById('wheel-rotation'),
        maxSpeed: document.getElementById('max-speed'),

        // RPM
        rpmBar: document.getElementById('rpm-bar'),
        rpmText: document.getElementById('rpm-text'),

        // ペダル
        throttleBar: document.getElementById('throttle-bar'),
        throttleValue: document.getElementById('throttle-value'),
        throttleFilteredBar: document.getElementById('throttle-filtered-bar'),
        brakeBar: document.getElementById('brake-bar'),
        brakeValue: document.getElementById('brake-value'),
        brakeFilteredBar: document.getElementById('brake-filtered-bar'),
        clutchBar: document.getElementById('clutch-bar'),
        clutchValue: document.getElementById('clutch-value'),

        // 燃料
        fuel: document.getElementById('fuel'),
        fuelCapacity: document.getElementById('fuel-capacity'),
        fuelPerLap: document.getElementById('fuel-per-lap'),
        fuelLapsRemaining: document.getElementById('fuel-laps-remaining'),

        // エンジン
        boost: document.getElementById('boost'),
        oilPressure: document.getElementById('oil-pressure'),
        gearRatios: document.getElementById('gear-ratios'),

        // 位置
        posX: document.getElementById('pos-x'),
        posY: document.getElementById('pos-y'),
        posZ: document.getElementById('pos-z'),
        velX: document.getElementById('vel-x'),
        velY: document.getElementById('vel-y'),
        velZ: document.getElementById('vel-z'),

        // 姿勢角
        rotPitch: document.getElementById('rot-pitch'),
        rotYaw: document.getElementById('rot-yaw'),
        rotRoll: document.getElementById('rot-roll'),
        orientation: document.getElementById('orientation'),
        bodyHeight: document.getElementById('body-height'),

        // タイヤ
        flTemp: document.getElementById('fl-temp'),
        frTemp: document.getElementById('fr-temp'),
        rlTemp: document.getElementById('rl-temp'),
        rrTemp: document.getElementById('rr-temp'),
        flRps: document.getElementById('fl-rps'),
        frRps: document.getElementById('fr-rps'),
        rlRps: document.getElementById('rl-rps'),
        rrRps: document.getElementById('rr-rps'),
        flRadius: document.getElementById('fl-radius'),
        frRadius: document.getElementById('fr-radius'),
        rlRadius: document.getElementById('rl-radius'),
        rrRadius: document.getElementById('rr-radius'),
        flSusp: document.getElementById('fl-susp'),
        frSusp: document.getElementById('fr-susp'),
        rlSusp: document.getElementById('rl-susp'),
        rrSusp: document.getElementById('rr-susp'),

        // 路面・車体
        roadPlaneX: document.getElementById('road-plane-x'),
        roadPlaneY: document.getElementById('road-plane-y'),
        roadPlaneZ: document.getElementById('road-plane-z'),
        roadPlaneDist: document.getElementById('road-plane-dist'),

        // 詳細データ
        transMaxSpeed: document.getElementById('trans-max-speed'),
        clutchEngagement: document.getElementById('clutch-engagement'),
        clutchGearboxRpm: document.getElementById('clutch-gearbox-rpm'),
        carId: document.getElementById('car-id'),
        pkgId: document.getElementById('pkg-id'),

        // 加速度
        accelG: document.getElementById('accel-g'),
        accelDecel: document.getElementById('accel-decel'),
        bodySway: document.getElementById('body-sway'),
        bodyHeave: document.getElementById('body-heave'),
        bodySurge: document.getElementById('body-surge'),

        // 角速度（CAR ATTITUDEセクションに統合）
        pitchRate: document.getElementById('pitch-rate'),
        yawRate: document.getElementById('yaw-rate'),
        rollRate: document.getElementById('roll-rate'),

        // トルクベクタリング
        torque1: document.getElementById('torque-1'),
        torque2: document.getElementById('torque-2'),
        torque3: document.getElementById('torque-3'),
        torque4: document.getElementById('torque-4'),
        energyRecovery: document.getElementById('energy-recovery'),

        // ラップ
        currentLap: document.getElementById('current-lap'),
        runningLapTime: document.getElementById('running-lap-time'),
        currentLapTime: document.getElementById('current-lap-time'),
        bestLapTime: document.getElementById('best-lap-time'),
        lapDelta: document.getElementById('lap-delta'),
        lapList: document.getElementById('lap-list'),
        racePosition: document.getElementById('race-position'),
        courseName: document.getElementById('course-name'),
        
        // セクター
        sector1: document.getElementById('sector-1'),
        sector2: document.getElementById('sector-2'),
        sector3: document.getElementById('sector-3'),

        // フラグ・ステータス
        flagsBar: document.getElementById('flags-bar'),
        connectionStatus: document.getElementById('connection-status'),

        // 回転矢印インジケーター
        pitchIndicator: document.getElementById('pitch-indicator'),
        yawIndicator: document.getElementById('yaw-indicator'),
        rollIndicator: document.getElementById('roll-indicator'),

        // ステアリングメーター
        steeringNeedle: document.getElementById('steering-needle'),
        steeringValue: document.getElementById('steering-value')
    };
}

/* ================================================================
 *  ユーティリティ関数
 * ================================================================ */

/**
 * デバッグログを出力
 * @param {string} category - ログカテゴリ
 * @param {string} message - ログメッセージ
 * @param {...*} args - 追加引数
 */
function debugLog(category, message, ...args) {
    if (DEBUG_MODE) {
        console.log(`[${category}]`, message, ...args);
    }
}

/**
 * ラップタイムを文字列形式にフォーマット
 * @param {number} ms - ミリ秒（-1 = 未計測）
 * @returns {string} "M:SS.mmm" 形式の文字列
 */
function formatLapTime(ms) {
    if (ms === -1 || ms === undefined || ms === null) {
        return '--:--.---';
    }
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const millis = ms % 1000;
    return `${minutes}:${seconds.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
}

/**
 * タイヤ温度に応じた表示色を取得
 * @param {number} temp - タイヤ温度（摂氏）
 * @returns {string} CSS色文字列
 */
function getTyreTempColor(temp) {
    if (temp < TYRE_TEMP.COLD_THRESHOLD) {
        return COLORS.accentCyan;   // tyre-cold = azure #3D9BFF
    }
    if (temp < TYRE_TEMP.OPTIMAL_HIGH) {
        return STATUS.good;         // tyre-optimal = #0CA30C
    }
    if (temp < TYRE_TEMP.HOT_THRESHOLD) {
        return STATUS.warning;      // tyre-warm = #FAB219
    }
    return STATUS.critical;         // tyre-hot = #D03B3B
}

/**
 * 速度に応じた軌跡色を取得
 * @param {number} speed - 速度（km/h）
 * @returns {string} CSS色文字列
 */
function getSpeedColor(speed) {
    if (speed < SPEED_THRESHOLDS.LOW) {
        return COURSE_MAP_CONFIG.colors.trajectoryLow;
    }
    if (speed < SPEED_THRESHOLDS.HIGH) {
        return COURSE_MAP_CONFIG.colors.trajectoryMid;
    }
    return COURSE_MAP_CONFIG.colors.trajectoryHigh;
}

/* ================================================================
 *  ステアリングメーター更新
 * ================================================================ */

/**
 * ステアリングメーターの表示を更新
 * @param {number} steeringRad - ステアリング角度（ラジアン）
 */
function updateSteeringGauge(steeringRad) {
    const steeringDeg = steeringRad * 180 / Math.PI;

    // メーター針の回転
    // -45度〜+45度の入力を-60deg〜+60degの表示角度にマッピング
    const MAX_DISPLAY_ANGLE = 60;
    const MAX_INPUT_ANGLE = 45;

    const clampedAngle = Math.max(
        -MAX_INPUT_ANGLE,
        Math.min(MAX_INPUT_ANGLE, steeringDeg)
    );
    const displayRotation = (clampedAngle / MAX_INPUT_ANGLE) * MAX_DISPLAY_ANGLE;

    if (elements.steeringNeedle) {
        elements.steeringNeedle.style.transform =
            `translateX(-50%) rotate(${displayRotation}deg)`;
    }
    if (elements.steeringValue) {
        elements.steeringValue.textContent = steeringDeg.toFixed(1) + '\u00B0';
    }
}

/* ================================================================
 *  ペダルトレース
 * ================================================================ */

const pedalTraceState = {
    canvas: null,
    ctx: null,
    initialized: false,
    // 履歴データ
    throttleHistory: [],
    brakeHistory: [],
    maxPoints: 100,
    // 更新間隔制御
    lastUpdate: 0,
    updateInterval: 50 // 20fps
};

/**
 * ペダルトレースを初期化
 */
function initPedalTrace() {
    pedalTraceState.canvas = document.getElementById('pedal-trace-canvas');
    if (!pedalTraceState.canvas) return;
    
    // キャンバスサイズを設定
    const container = pedalTraceState.canvas.parentElement;
    pedalTraceState.canvas.width = container.offsetWidth || 300;
    pedalTraceState.canvas.height = container.offsetHeight || 30;
    
    pedalTraceState.ctx = pedalTraceState.canvas.getContext('2d');
    pedalTraceState.initialized = true;
    
    // 初期データで埋める
    for (let i = 0; i < pedalTraceState.maxPoints; i++) {
        pedalTraceState.throttleHistory.push(0);
        pedalTraceState.brakeHistory.push(0);
    }
    
    drawPedalTrace();
}

/**
 * ペダルトレースを描画
 */
function drawPedalTrace() {
    const ctx = pedalTraceState.ctx;
    const canvas = pedalTraceState.canvas;
    if (!ctx || !canvas) return;
    
    const width = canvas.width;
    const height = canvas.height;
    
    // クリア
    ctx.clearRect(0, 0, width, height);
    
    // 背景（--surface-2 プロット面）
    ctx.fillStyle = '#1B1F26';
    ctx.fillRect(0, 0, width, height);
    
    const points = pedalTraceState.maxPoints;
    const stepX = width / (points - 1);
    
    // スロットル描画（上半分）
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    
    for (let i = 0; i < pedalTraceState.throttleHistory.length; i++) {
        const x = i * stepX;
        const y = (height / 2) - (pedalTraceState.throttleHistory[i] / 100) * (height / 2);
        ctx.lineTo(x, y);
    }
    
    ctx.strokeStyle = '#1F9E57';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // スロットル塗りつぶし（--series-throttle）
    ctx.lineTo(width, height / 2);
    ctx.lineTo(0, height / 2);
    ctx.closePath();
    ctx.fillStyle = 'rgba(31, 158, 87, 0.2)';
    ctx.fill();
    
    // ブレーキ描画（下半分）
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    
    for (let i = 0; i < pedalTraceState.brakeHistory.length; i++) {
        const x = i * stepX;
        const y = (height / 2) + (pedalTraceState.brakeHistory[i] / 100) * (height / 2);
        ctx.lineTo(x, y);
    }
    
    ctx.strokeStyle = '#D84B4F';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // ブレーキ塗りつぶし（--series-brake）
    ctx.lineTo(width, height / 2);
    ctx.lineTo(0, height / 2);
    ctx.closePath();
    ctx.fillStyle = 'rgba(216, 75, 79, 0.2)';
    ctx.fill();

    // センターライン（--axis）
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.strokeStyle = '#2C313A';
    ctx.lineWidth = 1;
    ctx.stroke();
}

/**
 * ペダルトレースを更新
 * @param {number} throttle - スロットル率（0-100）
 * @param {number} brake - ブレーキ率（0-100）
 */
function updatePedalTrace(throttle, brake) {
    if (!pedalTraceState.initialized) {
        initPedalTrace();
    }
    
    const now = performance.now();
    if (now - pedalTraceState.lastUpdate < pedalTraceState.updateInterval) {
        return;
    }
    pedalTraceState.lastUpdate = now;
    
    // 履歴を更新
    pedalTraceState.throttleHistory.push(throttle);
    pedalTraceState.brakeHistory.push(brake);
    
    if (pedalTraceState.throttleHistory.length > pedalTraceState.maxPoints) {
        pedalTraceState.throttleHistory.shift();
        pedalTraceState.brakeHistory.shift();
    }
    
    drawPedalTrace();
}
