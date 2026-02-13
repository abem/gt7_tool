/**
 * GT7 Telemetry Dashboard
 * 定数・ユーティリティ・DOM要素キャッシュ
 */

var DEBUG_MODE = false;

// チャート設定
var CHART_POINTS = 1200;

var ACCEL_CHART_CONFIG = {
    maxPoints: 200,
    lineColor: '#00ff88',
    lineWidth: 2,
    gridColor: 'rgba(255, 255, 255, 0.1)'
};

// コースマップ設定
var COURSE_MAP_CONFIG = {
    colors: {
        grid: 'rgba(255, 255, 255, 0.05)',
        text: 'rgba(255, 255, 255, 0.5)',
        car: '#00ff88',
        trajectoryLow: '#ff4444',
        trajectoryMid: '#ffd700',
        trajectoryHigh: '#00ff88'
    },
    trajectorySampleInterval: 3,
    maxTrajectoryPoints: 2000
};

// コースマップ状態
var courseMapState = {
    canvas: null,
    ctx: null,
    initialized: false,
    bounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
    trajectory: [],
    currentPosition: { x: 0, y: 0, z: 0 },
    sampleCount: 0
};

// 加速度データ
var accelData = {
    times: new Array(ACCEL_CHART_CONFIG.maxPoints).fill(0),
    accelG: new Array(ACCEL_CHART_CONFIG.maxPoints).fill(0),
    accelDecel: new Array(ACCEL_CHART_CONFIG.maxPoints).fill(0)
};

// DOM要素キャッシュ
var elements = {};

function cacheElements() {
    elements = {
        speed: document.getElementById('speed'),
        gear: document.getElementById('gear'),
        suggestedGear: document.getElementById('suggested-gear'),
        wheelRotation: document.getElementById('wheel-rotation'),
        rpmBar: document.getElementById('rpm-bar'),
        rpmText: document.getElementById('rpm-text'),
        throttleBar: document.getElementById('throttle-bar'),
        throttleValue: document.getElementById('throttle-value'),
        throttleFilteredBar: document.getElementById('throttle-filtered-bar'),
        brakeBar: document.getElementById('brake-bar'),
        brakeValue: document.getElementById('brake-value'),
        brakeFilteredBar: document.getElementById('brake-filtered-bar'),
        clutchBar: document.getElementById('clutch-bar'),
        clutchValue: document.getElementById('clutch-value'),
        fuel: document.getElementById('fuel'),
        fuelCapacity: document.getElementById('fuel-capacity'),
        fuelPerLap: document.getElementById('fuel-per-lap'),
        fuelLapsRemaining: document.getElementById('fuel-laps-remaining'),
        boost: document.getElementById('boost'),
        oilPressure: document.getElementById('oil-pressure'),
        gearRatios: document.getElementById('gear-ratios'),
        posX: document.getElementById('pos-x'),
        posY: document.getElementById('pos-y'),
        posZ: document.getElementById('pos-z'),
        velX: document.getElementById('vel-x'),
        velY: document.getElementById('vel-y'),
        velZ: document.getElementById('vel-z'),
        rotPitch: document.getElementById('rot-pitch'),
        rotYaw: document.getElementById('rot-yaw'),
        rotRoll: document.getElementById('rot-roll'),
        orientation: document.getElementById('orientation'),
        bodyHeight: document.getElementById('body-height'),
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
        roadPlaneX: document.getElementById('road-plane-x'),
        roadPlaneY: document.getElementById('road-plane-y'),
        roadPlaneZ: document.getElementById('road-plane-z'),
        roadPlaneDist: document.getElementById('road-plane-dist'),
        maxSpeed: document.getElementById('max-speed'),
        transMaxSpeed: document.getElementById('trans-max-speed'),
        clutchEngagement: document.getElementById('clutch-engagement'),
        clutchGearboxRpm: document.getElementById('clutch-gearbox-rpm'),
        carId: document.getElementById('car-id'),
        pkgId: document.getElementById('pkg-id'),
        accelG: document.getElementById('accel-g'),
        accelDecel: document.getElementById('accel-decel'),
        bodySway: document.getElementById('body-sway'),
        bodyHeave: document.getElementById('body-heave'),
        bodySurge: document.getElementById('body-surge'),
        angX: document.getElementById('ang-x'),
        angY: document.getElementById('ang-y'),
        angZ: document.getElementById('ang-z'),
        pitchRate: document.getElementById('pitch-rate'),
        yawRate: document.getElementById('yaw-rate'),
        rollRate: document.getElementById('roll-rate'),
        torque1: document.getElementById('torque-1'),
        torque2: document.getElementById('torque-2'),
        torque3: document.getElementById('torque-3'),
        torque4: document.getElementById('torque-4'),
        energyRecovery: document.getElementById('energy-recovery'),
        currentLap: document.getElementById('current-lap'),
        runningLapTime: document.getElementById('running-lap-time'),
        currentLapTime: document.getElementById('current-lap-time'),
        bestLapTime: document.getElementById('best-lap-time'),
        lapDelta: document.getElementById('lap-delta'),
        lapList: document.getElementById('lap-list'),
        racePosition: document.getElementById('race-position'),
        courseName: document.getElementById('course-name'),
        flagsBar: document.getElementById('flags-bar'),
        connectionStatus: document.getElementById('connection-status'),
        rotationCube: document.getElementById('rotation-cube'),
        rotPitchDisplay: document.getElementById('rot-pitch-display'),
        rotYawDisplay: document.getElementById('rot-yaw-display'),
        rotRollDisplay: document.getElementById('rot-roll-display'),
        pitchIndicator: document.getElementById('pitch-indicator'),
        yawIndicator: document.getElementById('yaw-indicator'),
        rollIndicator: document.getElementById('roll-indicator')
    };
}

// ユーティリティ関数

function debugLog(category, message) {
    if (DEBUG_MODE) {
        var args = Array.prototype.slice.call(arguments, 2);
        console.log.apply(console, ['[' + category + ']', message].concat(args));
    }
}

function formatLapTime(ms) {
    if (ms === -1 || ms === undefined || ms === null) return '--:--.---';
    var minutes = Math.floor(ms / 60000);
    var seconds = Math.floor((ms % 60000) / 1000);
    var millis = ms % 1000;
    return minutes + ':' + seconds.toString().padStart(2, '0') + '.' + millis.toString().padStart(3, '0');
}

function getTyreTempColor(temp) {
    if (temp < 40) return '#44ffff';
    if (temp < 80) return '#00ff88';
    if (temp < 100) return '#ffff00';
    return '#ff4444';
}

function getSpeedColor(speed) {
    if (speed < 60) return COURSE_MAP_CONFIG.colors.trajectoryLow;
    if (speed < 120) return COURSE_MAP_CONFIG.colors.trajectoryMid;
    return COURSE_MAP_CONFIG.colors.trajectoryHigh;
}

// 3D回転更新関数
function updateRotation3D(pitch, yaw, roll) {
    if (!elements.rotationCube) return;

    var transform = 'rotateZ(' + roll + 'rad) rotateX(' + pitch + 'rad) rotateY(' + yaw + 'rad)';
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
