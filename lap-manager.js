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
    /** 最高速度 */
    maxSpeed: 0
};

/* ================================================================
 *  ラップ状態リセット
 * ================================================================ */

/**
 * ラップ状態と関連 DOM を初期状態へ戻す。
 *
 * TEST MODE 停止時（test-mode.js stopTestMode）に呼ばれ、合成パケットが
 * 作ったデモの偽 BEST/ラップ履歴/最高速がライブ復帰後に残留する回帰を防ぐ。
 * ※ R1 で削除された同名関数は「どこからも呼ばれない死んだコード」だったが、
 *    本実装は stopTestMode から実際に呼ばれる別物である。
 */
function resetLapState() {
    lapState.currentLapNumber = 0;
    lapState.lastLapNumber = 0;
    lapState.bestLapTime = Infinity;
    lapState.bestLapNumber = 0;
    lapState.lapTimes = [];
    lapState.maxSpeed = 0;

    if (elements.currentLap) elements.currentLap.textContent = '--/--';
    if (elements.runningLapTime) elements.runningLapTime.textContent = '--:--.---';
    if (elements.currentLapTime) elements.currentLapTime.textContent = '--:--.---';
    if (elements.bestLapTime) elements.bestLapTime.textContent = '--:--.---';
    if (elements.lapList) elements.lapList.innerHTML = '';
    if (elements.maxSpeed) elements.maxSpeed.textContent = '--';
    // デモの pre_race_position (P3/16) はレース開始後のライブでは null 送信のため
    // 上書きされない。ここで消さないと偽グリッド順位がセッション中残留する。
    if (elements.racePosition) elements.racePosition.textContent = '--';
}

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

    lapState.lapTimes.forEach((lap) => {
        const item = document.createElement('div');
        item.className = 'lap-history-item' + (lap.number === lapState.bestLapNumber ? ' best' : '');

        const delta = lap.time - lapState.bestLapTime;
        const deltaSign = delta > 0 ? '+' : '';
        const deltaClass = delta < 0 ? 'faster' : 'slower';  // styles.css の .lap-hist-delta.faster/.slower と対

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
    const idx = lapState.lapTimes.findIndex((l) => {
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
    }

    updateLapList();
    elements.bestLapTime.textContent = formatLapTime(lapState.bestLapTime);
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
    }
    lapState.lastLapNumber = lapState.currentLapNumber;

    // 速度デルタ計算
    updateSpeedDelta(data);
}

/**
 * 速度デルタを更新（no-op化）
 *
 * #lap-delta / #delta-bar-* の書込は telemetry-analysis.js の updateLiveDelta に一本化した
 * （距離基準の「対ベスト秒差」= 実テレメトリソフト級のライブ・タイムデルタへ役割強化）。
 * ここで書き込むと後勝ちの二重書込・競合になるため当該 DOM 書込は行わない。
 * addLapData（ラップ履歴）は updateLapState 側で温存。
 *
 * @param {Object} data - テレメトリデータ
 */
function updateSpeedDelta(data) {
    // no-op: デルタ表示は telemetry-analysis.js (analysisOnFrame → updateLiveDelta) が担当。
    return;
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
