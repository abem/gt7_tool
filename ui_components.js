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
        rpmBar: document.getElementById('rpm-bar'),
        rpmText: document.getElementById('rpm-text'),
        throttleBar: document.getElementById('throttle-bar'),
        throttleValue: document.getElementById('throttle-value'),
        brakeBar: document.getElementById('brake-bar'),
        brakeValue: document.getElementById('brake-value'),
        fuel: document.getElementById('fuel'),
        boost: document.getElementById('boost'),
        posX: document.getElementById('pos-x'),
        posY: document.getElementById('pos-y'),
        posZ: document.getElementById('pos-z'),
        flTemp: document.getElementById('fl-temp'),
        frTemp: document.getElementById('fr-temp'),
        rlTemp: document.getElementById('rl-temp'),
        rrTemp: document.getElementById('rr-temp'),
        flPressure: document.getElementById('fl-pressure'),
        frPressure: document.getElementById('fr-pressure'),
        rlPressure: document.getElementById('rl-pressure'),
        rrPressure: document.getElementById('rr-pressure'),
        flRps: document.getElementById('fl-rps'),
        frRps: document.getElementById('fr-rps'),
        rlRps: document.getElementById('rl-rps'),
        rrRps: document.getElementById('rr-rps'),
        flSusp: document.getElementById('fl-susp'),
        frSusp: document.getElementById('fr-susp'),
        rlSusp: document.getElementById('rl-susp'),
        rrSusp: document.getElementById('rr-susp'),
        maxSpeed: document.getElementById('max-speed'),
        carId: document.getElementById('car-id'),
        packets: document.getElementById('packets'),
        accelG: document.getElementById('accel-g'),
        accelDecel: document.getElementById('accel-decel'),
        currentLap: document.getElementById('current-lap'),
        currentLapTime: document.getElementById('current-lap-time'),
        bestLapTime: document.getElementById('best-lap-time'),
        lapDelta: document.getElementById('lap-delta'),
        lapList: document.getElementById('lap-list'),
        connectionStatus: document.getElementById('connection-status')
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
