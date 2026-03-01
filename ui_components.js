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

        // 角速度
        angX: document.getElementById('ang-x'),
        angY: document.getElementById('ang-y'),
        angZ: document.getElementById('ang-z'),
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

        // フラグ・ステータス
        flagsBar: document.getElementById('flags-bar'),
        connectionStatus: document.getElementById('connection-status'),

        // 3D回転表示
        rotationCube: document.getElementById('rotation-cube'),
        rotPitchDisplay: document.getElementById('rot-pitch-display'),
        rotYawDisplay: document.getElementById('rot-yaw-display'),
        rotRollDisplay: document.getElementById('rot-roll-display'),
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
        return COLORS.accentCyan;
    }
    if (temp < TYRE_TEMP.OPTIMAL_HIGH) {
        return COLORS.accentGreen;
    }
    if (temp < TYRE_TEMP.HOT_THRESHOLD) {
        return COLORS.accentYellow;
    }
    return COLORS.accentRed;
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
 *  3D回転表示更新
 * ================================================================ */

/**
 * 3D回転立方体の表示を更新
 * @param {number} pitch - ピッチ角（ラジアン）
 * @param {number} yaw - ヨー角（ラジアン）
 * @param {number} roll - ロール角（ラジアン）
 */
function updateRotation3D(pitch, yaw, roll) {
    if (!elements.rotationCube) {
        return;
    }

    const transform = `rotateZ(${roll}rad) rotateX(${pitch}rad) rotateY(${yaw}rad)`;
    elements.rotationCube.style.transform = transform;

    if (elements.rotPitchDisplay) {
        elements.rotPitchDisplay.textContent = pitch.toFixed(3);
    }
    if (elements.rotYawDisplay) {
        elements.rotYawDisplay.textContent = yaw.toFixed(3);
    }
    if (elements.rotRollDisplay) {
        elements.rotRollDisplay.textContent = roll.toFixed(3);
    }
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
