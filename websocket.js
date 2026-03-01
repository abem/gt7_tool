/**
 * GT7 Telemetry Dashboard
 * WebSocket接続・メッセージ処理
 *
 * @module websocket
 * @depends constants.js (UPDATE_INTERVALS, WEBSOCKET_CONFIG)
 * @depends ui_components.js (elements, debugLog, updateRotation3D, updateSteeringGauge)
 * @depends lap-manager.js (updateLapState, updateMaxSpeed)
 * @depends charts.js (timeCounter, timeData, speedData, rpmData, throttleData, brakeData,
 *                     speedChart, rpmChart, throttleChart, brakeChart, initCharts, updateAccelChart)
 * @depends course-map.js (initCourseMap, updateCourseMap)
 * @depends car-3d.js (initCar3D, updateCar3D)
 */

/* ================================================================
 *  モジュール状態
 * ================================================================ */
const wsState = {
    /** WebSocketインスタンス */
    ws: null,
    /** 再接続遅延（ms） */
    reconnectDelay: WEBSOCKET_CONFIG.reconnectDelayInitial,
    /** 再接続タイマー */
    reconnectTimer: null,
    /** パケット受信数 */
    packetCount: 0,
    /** 最新メッセージ */
    latestMessage: null,
    /** 処理スケジュール済みフラグ */
    processingScheduled: false,
    /** 前回UI更新時刻 */
    lastUiTs: 0,
    /** 前回チャート更新時刻 */
    lastChartsTs: 0,
    /** 前回マップ更新時刻 */
    lastMapTs: 0,
    /** 前回回転更新時刻 */
    lastRotationTs: 0
};

/* ================================================================
 *  回転矢印表示
 * ================================================================ */

/**
 * 回転角に応じた矢印を取得
 * @param {number} angle - 角度（ラジアン）
 * @returns {string} 矢印文字
 */
function getRotationArrow(angle) {
    if (angle > 0.1) return '↑';
    if (angle < -0.1) return '↓';
    return '→';
}

/**
 * 回転矢印表示を更新
 * @param {number} pitch - ピッチ角
 * @param {number} yaw - ヨー角
 * @param {number} roll - ロール角
 */
function updateRotationArrows(pitch, yaw, roll) {
    if (!elements.pitchIndicator) {
        return;
    }
    elements.pitchIndicator.textContent = getRotationArrow(pitch);
    elements.yawIndicator.textContent = getRotationArrow(yaw);
    elements.rollIndicator.textContent = getRotationArrow(roll);
}

/* ================================================================
 *  ギア比表示
 * ================================================================ */

/**
 * ギア比表示をレンダリング
 * @param {number[]} ratios - ギア比配列
 * @param {number} currentGear - 現在のギア
 */
function renderGearRatios(ratios, currentGear) {
    if (!elements.gearRatios || !ratios) {
        return;
    }

    let html = '';
    for (let i = 0; i < ratios.length; i++) {
        if (ratios[i] === 0) {
            continue;
        }
        const isActive = (i + 1) === currentGear;
        html += '<div class="gear-ratio-item' + (isActive ? ' active' : '') + '">' +
            '<span class="gear-ratio-num">' + (i + 1) + '</span>' +
            '<span class="gear-ratio-val">' + ratios[i].toFixed(3) + '</span>' +
            '</div>';
    }
    elements.gearRatios.innerHTML = html;
}

/* ================================================================
 *  UI更新関数
 * ================================================================ */

/**
 * 車両状態の表示を更新
 * @param {Object} data - テレメトリデータ
 */
function updateVehicleState(data) {
    // 速度
    const speed = Math.round(data.speed_kmh || 0);
    elements.speed.textContent = speed;
    updateMaxSpeed(speed);

    // ギア
    const gear = data.gear || 0;
    elements.gear.textContent = gear === 0 ? 'R' : gear;
    if (data.suggested_gear != null && data.suggested_gear !== gear) {
        elements.suggestedGear.textContent = '\u2192' + data.suggested_gear;
    } else {
        elements.suggestedGear.textContent = '';
    }

    // ステアリング回転
    if (data.wheel_rotation !== undefined) {
        const deg = (data.wheel_rotation * 180 / Math.PI).toFixed(1);
        elements.wheelRotation.textContent = deg + '\u00B0';
    }

    // RPM
    const rpm = Math.round(data.rpm || 0);
    const maxRpm = data.max_rpm || 9000;
    const rpmPct = Math.min((rpm / maxRpm) * 100, 100);
    elements.rpmBar.style.width = rpmPct + '%';

    if (data.rpm_alert_min && rpm >= data.rpm_alert_min) {
        elements.rpmBar.style.background =
            rpm >= maxRpm ? COLORS.accentRed : COLORS.accentYellow;
    } else {
        elements.rpmBar.style.background = '';
    }
    elements.rpmText.textContent = rpm + ' RPM';

    // ペダル
    const throttle = Math.round(data.throttle_pct || 0);
    const brake = Math.round(data.brake_pct || 0);
    const clutch = Math.round((data.clutch || 0) * 100);

    elements.throttleBar.style.width = throttle + '%';
    elements.throttleValue.textContent = throttle + '%';
    elements.brakeBar.style.width = brake + '%';
    elements.brakeValue.textContent = brake + '%';
    elements.clutchBar.style.width = clutch + '%';
    elements.clutchValue.textContent = clutch + '%';

    // フィルタ後入力
    if (data.throttle_filtered_pct !== undefined) {
        elements.throttleFilteredBar.style.width =
            Math.round(data.throttle_filtered_pct) + '%';
    }
    if (data.brake_filtered_pct !== undefined) {
        elements.brakeFilteredBar.style.width =
            Math.round(data.brake_filtered_pct) + '%';
    }

    // ブースト・油圧
    elements.boost.textContent = ((data.boost || 0) * 100).toFixed(0);
    elements.oilPressure.textContent = (data.oil_pressure || 0).toFixed(1);

    // ギア比
    if (data.gear_ratios) {
        renderGearRatios(data.gear_ratios, gear);
    }

    // クラッチ詳細
    if (data.clutch_engagement !== undefined) {
        elements.clutchEngagement.textContent = (data.clutch_engagement || 0).toFixed(3);
    }
    if (data.clutch_gearbox_rpm !== undefined) {
        elements.clutchGearboxRpm.textContent = Math.round(data.clutch_gearbox_rpm || 0);
    }

    // トランスミッション最大速度
    if (data.transmission_max_speed !== undefined) {
        elements.transMaxSpeed.textContent = Math.round(data.transmission_max_speed * 3.6);
    }

    // 車種ID・パッケージID
    if (data.car_id) {
        elements.carId.textContent = data.car_id;
    }
    if (data.package_id !== undefined) {
        elements.pkgId.textContent = data.package_id;
    }

    // フラグ表示
    if (data.flags) {
        renderFlags(data.flags);
    }
}

/**
 * フラグ表示をレンダリング
 * @param {Object} flags - フラグオブジェクト
 */
function renderFlags(flags) {
    const flagParts = [];
    if (flags.tcs_active) flagParts.push('<span class="flag-on">TCS</span>');
    if (flags.asm_active) flagParts.push('<span class="flag-on">ASM</span>');
    if (flags.rev_limiter) flagParts.push('<span class="flag-warn">REV</span>');
    if (flags.hand_brake) flagParts.push('<span class="flag-warn">P-BRK</span>');
    if (flags.lights) flagParts.push('<span class="flag-info">LIGHT</span>');
    if (flags.has_turbo) flagParts.push('<span class="flag-info">TURBO</span>');
    elements.flagsBar.innerHTML = flagParts.join('');
}

/**
 * 燃料状態の表示を更新
 * @param {Object} data - テレメトリデータ
 */
function updateFuelState(data) {
    elements.fuel.textContent = (data.current_fuel || 0).toFixed(1);
    elements.fuelCapacity.textContent = (data.fuel_capacity || 0).toFixed(0);

    if (data.fuel_per_lap !== undefined) {
        elements.fuelPerLap.textContent = (data.fuel_per_lap || 0).toFixed(2);
    }
    if (data.fuel_laps_remaining !== undefined) {
        elements.fuelLapsRemaining.textContent = data.fuel_laps_remaining || '--';
    }
}

/**
 * タイヤ状態の表示を更新
 * @param {Object} data - テレメトリデータ
 */
function updateTyreState(data) {
    // サスペンション
    if (data.susp_height) {
        elements.flSusp.textContent = (data.susp_height[0] * 1000).toFixed(0);
        elements.frSusp.textContent = (data.susp_height[1] * 1000).toFixed(0);
        elements.rlSusp.textContent = (data.susp_height[2] * 1000).toFixed(0);
        elements.rrSusp.textContent = (data.susp_height[3] * 1000).toFixed(0);
    }

    // タイヤ温度
    if (data.tyre_temp) {
        const temps = data.tyre_temp;
        elements.flTemp.textContent = Math.round(temps[0]);
        elements.frTemp.textContent = Math.round(temps[1]);
        elements.rlTemp.textContent = Math.round(temps[2]);
        elements.rrTemp.textContent = Math.round(temps[3]);
        elements.flTemp.style.color = getTyreTempColor(temps[0]);
        elements.frTemp.style.color = getTyreTempColor(temps[1]);
        elements.rlTemp.style.color = getTyreTempColor(temps[2]);
        elements.rrTemp.style.color = getTyreTempColor(temps[3]);
    }

    // ホイール回転速度
    if (data.wheel_rps) {
        const rps = data.wheel_rps;
        elements.flRps.textContent = Math.abs(rps[0] || 0).toFixed(1);
        elements.frRps.textContent = Math.abs(rps[1] || 0).toFixed(1);
        elements.rlRps.textContent = Math.abs(rps[2] || 0).toFixed(1);
        elements.rrRps.textContent = Math.abs(rps[3] || 0).toFixed(1);
    }

    // タイヤ半径
    if (data.tyre_radius) {
        elements.flRadius.textContent = (data.tyre_radius[0] || 0).toFixed(3);
        elements.frRadius.textContent = (data.tyre_radius[1] || 0).toFixed(3);
        elements.rlRadius.textContent = (data.tyre_radius[2] || 0).toFixed(3);
        elements.rrRadius.textContent = (data.tyre_radius[3] || 0).toFixed(3);
    }

    // 路面法線
    elements.roadPlaneX.textContent = (data.road_plane_x || 0).toFixed(3);
    elements.roadPlaneY.textContent = (data.road_plane_y || 0).toFixed(3);
    elements.roadPlaneZ.textContent = (data.road_plane_z || 0).toFixed(3);
    elements.roadPlaneDist.textContent = (data.road_plane_distance || 0).toFixed(3);

    // 車体加速度
    if (data.body_accel_sway !== undefined) {
        elements.bodySway.textContent = (data.body_accel_sway || 0).toFixed(3);
        elements.bodyHeave.textContent = (data.body_accel_heave || 0).toFixed(3);
        elements.bodySurge.textContent = (data.body_accel_surge || 0).toFixed(3);
    }

    // トルクベクタリング
    if (data.torque_vector) {
        elements.torque1.textContent = data.torque_vector[0].toFixed(2);
        elements.torque2.textContent = data.torque_vector[1].toFixed(2);
        elements.torque3.textContent = data.torque_vector[2].toFixed(2);
        elements.torque4.textContent = data.torque_vector[3].toFixed(2);
    }
    if (data.energy_recovery !== undefined) {
        elements.energyRecovery.textContent = (data.energy_recovery || 0).toFixed(2);
    }
}

/**
 * 位置情報の表示を更新
 * @param {Object} data - テレメトリデータ
 */
function updatePositionText(data) {
    // 位置
    elements.posX.textContent = (data.position_x || 0).toFixed(1);
    elements.posY.textContent = (data.position_y || 0).toFixed(1);
    elements.posZ.textContent = (data.position_z || 0).toFixed(1);

    // 速度ベクトル
    elements.velX.textContent = (data.velocity_x || 0).toFixed(1);
    elements.velY.textContent = (data.velocity_y || 0).toFixed(1);
    elements.velZ.textContent = (data.velocity_z || 0).toFixed(1);

    // 回転
    elements.rotPitch.textContent = (data.rotation_pitch || 0).toFixed(3);
    elements.rotYaw.textContent = (data.rotation_yaw || 0).toFixed(3);
    elements.rotRoll.textContent = (data.rotation_roll || 0).toFixed(3);

    // 角速度
    if (elements.angX) elements.angX.textContent = (data.angular_velocity_x || 0).toFixed(3);
    if (elements.angY) elements.angY.textContent = (data.angular_velocity_y || 0).toFixed(3);
    if (elements.angZ) elements.angZ.textContent = (data.angular_velocity_z || 0).toFixed(3);
    if (elements.pitchRate) elements.pitchRate.textContent = (data.angular_velocity_x || 0).toFixed(3);
    if (elements.yawRate) elements.yawRate.textContent = (data.angular_velocity_y || 0).toFixed(3);
    if (elements.rollRate) elements.rollRate.textContent = (data.angular_velocity_z || 0).toFixed(3);

    // 方角・車体高さ
    elements.orientation.textContent = (data.orientation || 0).toFixed(3);
    elements.bodyHeight.textContent = (data.body_height || 0).toFixed(3);

    // 現在のラップ経過時間
    if (data.current_laptime !== undefined && data.current_laptime > 0) {
        elements.runningLapTime.textContent = formatLapTime(data.current_laptime);
    }

    // スタート順位
    if (data.pre_race_position != null && data.num_cars_pre_race != null) {
        elements.racePosition.textContent =
            'P' + data.pre_race_position + '/' + data.num_cars_pre_race;
    } else if (data.pre_race_position != null) {
        elements.racePosition.textContent = 'P' + data.pre_race_position;
    }

    // コース名
    if (data.course && data.course.name && data.course.id !== 'unknown') {
        elements.courseName.textContent = data.course.name;
    }
}

/**
 * チャート状態の表示を更新
 * @param {Object} data - テレメトリデータ
 */
function updateChartState(data) {
    // 加速度
    updateAccelChart(data.accel_g || 0, data.accel_decel || 0);
    elements.accelG.textContent = (data.accel_g || 0).toFixed(2);
    elements.accelDecel.textContent = (data.accel_decel || 0).toFixed(2);

    // チャートデータ更新
    timeData.shift();
    timeData.push(timeCounter++);

    const speed = Math.round(data.speed_kmh || 0);
    speedData.shift();
    speedData.push(speed);

    const rpm = Math.round(data.rpm || 0);
    rpmData.shift();
    rpmData.push(rpm);

    const throttle = Math.round(data.throttle_pct || 0);
    const brake = Math.round(data.brake_pct || 0);
    throttleData.shift();
    throttleData.push(throttle);
    brakeData.shift();
    brakeData.push(brake);

    // チャート再描画
    if (speedChart) speedChart.setData([timeData, speedData]);
    if (rpmChart) rpmChart.setData([timeData, rpmData]);
    if (throttleChart) throttleChart.setData([timeData, throttleData]);
    if (brakeChart) brakeChart.setData([timeData, brakeData]);
}

/* ================================================================
 *  テレメトリメッセージ処理
 * ================================================================ */

/**
 * テレメトリメッセージを処理
 * @param {Object} data - パース済みテレメトリデータ
 * @param {number} nowTs - 現在のタイムスタンプ
 */
function handleTelemetryMessage(data, nowTs) {
    const now = nowTs || performance.now();

    const doUi = (now - wsState.lastUiTs) >= UPDATE_INTERVALS.UI;
    const doCharts = (now - wsState.lastChartsTs) >= UPDATE_INTERVALS.CHART;
    const doMap = (now - wsState.lastMapTs) >= UPDATE_INTERVALS.MAP;
    const doRotation = (now - wsState.lastRotationTs) >= UPDATE_INTERVALS.ROTATION;

    if (doUi) {
        updateLapState(data, timeCounter);
        updateVehicleState(data);
        updateFuelState(data);
        updateTyreState(data);
        updatePositionText(data);
        wsState.lastUiTs = now;
    }

    // 3Dモデル更新
    updateCar3D(
        data.rotation_pitch || 0,
        data.rotation_yaw || 0,
        data.rotation_roll || 0,
        data.rpm || 0,
        data.wheel_rotation || 0
    );

    if (doRotation) {
        updateRotation3D(
            data.rotation_pitch || 0,
            data.rotation_yaw || 0,
            data.rotation_roll || 0
        );
        updateRotationArrows(
            data.rotation_pitch || 0,
            data.rotation_yaw || 0,
            data.rotation_roll || 0
        );
        updateSteeringGauge(data.wheel_rotation || 0);
        wsState.lastRotationTs = now;
    }

    if (doMap && data.position_x !== undefined && data.position_z !== undefined) {
        updateCourseMap(
            data.position_x,
            data.position_y || 0,
            data.position_z,
            data.speed_kmh || 0
        );
        wsState.lastMapTs = now;
    }

    if (doCharts) {
        updateChartState(data);
        wsState.lastChartsTs = now;
    }
}

/* ================================================================
 *  WebSocket接続管理
 * ================================================================ */

/**
 * WebSocket接続を確立
 */
function connectWebSocket() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = wsProtocol + '//' + window.location.host + '/ws';

    wsState.ws = new WebSocket(wsUrl);

    wsState.ws.onopen = function() {
        console.log('Connected to GT7 Bridge');
        elements.connectionStatus.textContent = 'Connected';
        elements.connectionStatus.className = 'connected';
        wsState.reconnectDelay = WEBSOCKET_CONFIG.reconnectDelayInitial;
        initCharts();
        initCourseMap();
        initCar3D();
    };

    wsState.ws.onerror = function(error) {
        console.error('WebSocket Error:', error);
    };

    wsState.ws.onclose = function() {
        console.log('Disconnected');
        elements.connectionStatus.textContent = 'Reconnecting...';
        elements.connectionStatus.className = 'disconnected';
        scheduleReconnect();
    };

    wsState.ws.onmessage = function(event) {
        wsState.packetCount++;
        wsState.latestMessage = event.data;
        scheduleTelemetryProcessing();
    };
}

/**
 * テレメトリ処理をスケジュール
 */
function scheduleTelemetryProcessing() {
    if (wsState.processingScheduled) {
        return;
    }
    wsState.processingScheduled = true;
    requestAnimationFrame(processTelemetryFrame);
}

/**
 * テレメトリフレームを処理
 * @param {number} now - 現在のタイムスタンプ
 */
function processTelemetryFrame(now) {
    wsState.processingScheduled = false;

    if (!wsState.latestMessage) {
        return;
    }

    const raw = wsState.latestMessage;
    wsState.latestMessage = null;

    try {
        const data = JSON.parse(raw);
        handleTelemetryMessage(data, now);
    } catch (e) {
        console.error('WebSocket message error:', e);
    }
}

/**
 * 再接続をスケジュール
 */
function scheduleReconnect() {
    if (wsState.reconnectTimer) {
        return;
    }

    console.log('Reconnecting in ' + (wsState.reconnectDelay / 1000) + 's...');

    wsState.reconnectTimer = setTimeout(function() {
        wsState.reconnectTimer = null;
        connectWebSocket();
    }, wsState.reconnectDelay);

    wsState.reconnectDelay = Math.min(
        wsState.reconnectDelay * WEBSOCKET_CONFIG.reconnectDelayMultiplier,
        WEBSOCKET_CONFIG.reconnectDelayMax
    );
}

/* ================================================================
 *  グローバル露出（後方互換性）
 * ================================================================ */
var ws = null;
var reconnectDelay = 2000;
var maxReconnectDelay = 30000;
var reconnectTimer = null;
var packetCount = 0;
var latestMessage = null;
var processingScheduled = false;
var lastUiTs = 0;
var lastChartsTs = 0;
var lastMapTs = 0;
var lastRotationTs = 0;
var UI_UPDATE_INTERVAL = 1000 / 30;
var CHART_UPDATE_INTERVAL = 1000 / 20;
var MAP_UPDATE_INTERVAL = 1000 / 10;
var ROTATION_UPDATE_INTERVAL = 1000 / 30;
