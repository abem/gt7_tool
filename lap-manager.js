/**
 * GT7 Telemetry Dashboard
 * ラップタイム管理モジュール
 *
 * @module lap-manager
 * @depends ui_components.js (elements, formatLapTime)
 */

/* ================================================================
 *  ラップ状態管理
 * ================================================================ */
const lapState = {
    /** 現在のラップ番号 */
    currentLapNumber: 0,
    /** 前回のラップ番号 */
    lastLapNumber: 0,
    /** ベストラップタイム（ms） */
    bestLapTime: Infinity,
    /** ベストラップ番号 */
    bestLapNumber: 0,
    /** ラップタイム履歴 */
    lapTimes: [],
    /** 現在ラップのデータ */
    currentLapData: [],
    /** ベストラップのデータ */
    bestLapData: [],
    /** 最高速度 */
    maxSpeed: 0
};

/* ================================================================
 *  ラップリスト表示更新
 * ================================================================ */

/**
 * ラップタイムリストの表示を更新
 */
function updateLapList() {
    if (!elements.lapList) {
        return;
    }

    elements.lapList.innerHTML = '';

    lapState.lapTimes.forEach(function(lap) {
        const item = document.createElement('div');
        item.className = 'lap-history-item' + (lap.number === lapState.bestLapNumber ? ' best' : '');

        const delta = lap.time - lapState.bestLapTime;
        const deltaSign = delta > 0 ? '+' : '';
        const deltaClass = delta < 0 ? 'negative' : 'positive';

        item.innerHTML =
            '<span class="lap-hist-num">L' + lap.number + '</span>' +
            '<span class="lap-hist-time">' + formatLapTime(lap.time) + '</span>' +
            '<span class="lap-hist-delta ' + deltaClass + '">' +
            deltaSign + (delta / 1000).toFixed(3) + '</span>';

        elements.lapList.appendChild(item);
    });
}

/* ================================================================
 *  ラップデータ操作
 * ================================================================ */

/**
 * ラップデータを追加・更新
 * @param {number} lapNumber - ラップ番号
 * @param {number} lapTime - ラップタイム（ms）
 */
function addLapData(lapNumber, lapTime) {
    const idx = lapState.lapTimes.findIndex(function(l) {
        return l.number === lapNumber;
    });

    if (idx >= 0) {
        lapState.lapTimes[idx] = { number: lapNumber, time: lapTime };
    } else {
        lapState.lapTimes.push({ number: lapNumber, time: lapTime });
    }

    // ベストラップ更新
    if (lapTime > 0 && lapTime < lapState.bestLapTime) {
        lapState.bestLapTime = lapTime;
        lapState.bestLapNumber = lapNumber;
        lapState.bestLapData = lapState.currentLapData.slice();
    }

    updateLapList();
    elements.bestLapTime.textContent = formatLapTime(lapState.bestLapTime);
}

/**
 * ラップ状態をリセット
 */
function resetLapState() {
    lapState.currentLapNumber = 0;
    lapState.lastLapNumber = 0;
    lapState.bestLapTime = Infinity;
    lapState.bestLapNumber = 0;
    lapState.lapTimes = [];
    lapState.currentLapData = [];
    lapState.bestLapData = [];
    lapState.maxSpeed = 0;
}

/* ================================================================
 *  テレメトリデータからのラップ更新
 * ================================================================ */

/**
 * テレメトリデータに基づいてラップ状態を更新
 * @param {Object} data - テレメトリデータ
 * @param {number} timeCounter - 現在のタイムカウンター
 */
function updateLapState(data, timeCounter) {
    lapState.currentLapNumber = data.lap_count || 1;
    elements.currentLap.textContent =
        lapState.currentLapNumber + '/' + (data.total_laps || '--');

    // ラップ切り替え検出
    if (lapState.currentLapNumber > lapState.lastLapNumber && lapState.lastLapNumber > 0) {
        const lastTime = data.last_laptime;
        if (lastTime > 0) {
            addLapData(lapState.lastLapNumber, lastTime);
            elements.currentLapTime.textContent = formatLapTime(lastTime);
        }
        lapState.currentLapData = [];
    }
    lapState.lastLapNumber = lapState.currentLapNumber;

    // ラップデータ蓄積
    lapState.currentLapData.push({
        time: timeCounter,
        speed: data.speed_kmh || 0,
        rpm: data.rpm || 0,
        throttle: data.throttle_pct || 0,
        brake: data.brake_pct || 0
    });

    // 速度デルタ計算
    updateSpeedDelta(data);
}

/**
 * 速度デルタを更新
 * @param {Object} data - テレメトリデータ
 */
function updateSpeedDelta(data) {
    if (lapState.bestLapData.length === 0 || lapState.currentLapData.length === 0) {
        return;
    }

    const idx = Math.min(
        lapState.currentLapData.length - 1,
        lapState.bestLapData.length - 1
    );
    const delta = lapState.currentLapData[idx].speed - lapState.bestLapData[idx].speed;

    elements.lapDelta.textContent = (delta >= 0 ? '+' : '') + delta.toFixed(1) + ' km/h';
    elements.lapDelta.className = 'delta-value' + (delta < 0 ? ' negative' : '');
}

/**
 * 最高速度を更新
 * @param {number} speed - 現在速度（km/h）
 */
function updateMaxSpeed(speed) {
    if (speed > lapState.maxSpeed) {
        lapState.maxSpeed = speed;
        elements.maxSpeed.textContent = lapState.maxSpeed;
    }
}

/* ================================================================
 *  エクスポート（グローバル露出）
 * ================================================================ */
// グローバル変数として既存コードとの互換性を維持
var currentLapNumber = 0;
var lastLapNumber = 0;
var bestLapTime = Infinity;
var bestLapNumber = 0;
var lapTimes = [];
var currentLapData = [];
var bestLapData = [];
var maxSpeed = 0;
