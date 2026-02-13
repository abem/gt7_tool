/**
 * GT7 Telemetry Dashboard
 * WebSocket接続・メッセージ処理・ラップ管理
 *
 * 依存: ui_components.js (elements, formatLapTime, getTyreTempColor, debugLog)
 *       charts.js (timeData, speedData, rpmData, throttleData, brakeData, timeCounter,
 *                  speedChart, rpmChart, throttleChart, brakeChart, updateAccelChart)
 *       course-map.js (updateCourseMap, initCourseMap)
 */

var ws = null;
var packetCount = 0;
var maxSpeed = 0;
var currentLapNumber = 0;
var lastLapNumber = 0;
var bestLapTime = Infinity;
var bestLapNumber = 0;
var lapTimes = [];
var currentLapData = [];
var bestLapData = [];
function updateLapList() {
    if (!elements.lapList) return;
    elements.lapList.innerHTML = '';
    lapTimes.forEach(function(lap) {
        var item = document.createElement('div');
        item.className = 'lap-history-item' + (lap.number === bestLapNumber ? ' best' : '');
        var delta = lap.time - bestLapTime;
        var deltaSign = delta > 0 ? '+' : '';
        var deltaClass = delta < 0 ? 'negative' : 'positive';
        item.innerHTML =
            '<span class="lap-hist-num">L' + lap.number + '</span>' +
            '<span class="lap-hist-time">' + formatLapTime(lap.time) + '</span>' +
            '<span class="lap-hist-delta ' + deltaClass + '">' + deltaSign + (delta / 1000).toFixed(3) + '</span>';
        elements.lapList.appendChild(item);
    });
}

function addLapData(lapNumber, lapTime) {
    var idx = lapTimes.findIndex(function(l) { return l.number === lapNumber; });
    if (idx >= 0) {
        lapTimes[idx] = { number: lapNumber, time: lapTime };
    } else {
        lapTimes.push({ number: lapNumber, time: lapTime });
    }
    if (lapTime > 0 && lapTime < bestLapTime) {
        bestLapTime = lapTime;
        bestLapNumber = lapNumber;
        bestLapData = currentLapData.slice();
    }
    updateLapList();
    elements.bestLapTime.textContent = formatLapTime(bestLapTime);
}

function renderGearRatios(ratios, currentGear) {
    if (!elements.gearRatios || !ratios) return;
    var html = '';
    for (var i = 0; i < ratios.length; i++) {
        if (ratios[i] === 0) continue;
        var isActive = (i + 1) === currentGear;
        html += '<div class="gear-ratio-item' + (isActive ? ' active' : '') + '">' +
            '<span class="gear-ratio-num">' + (i + 1) + '</span>' +
            '<span class="gear-ratio-val">' + ratios[i].toFixed(3) + '</span>' +
            '</div>';
    }
    elements.gearRatios.innerHTML = html;
}

function handleTelemetryMessage(data) {
    packetCount++;

    currentLapNumber = data.lap_count || 1;
    elements.currentLap.textContent = currentLapNumber + '/' + (data.total_laps || '--');

    // ラップ切り替え検出
    if (currentLapNumber > lastLapNumber && lastLapNumber > 0) {
        var lastTime = data.last_laptime;
        if (lastTime > 0) {
            addLapData(lastLapNumber, lastTime);
            elements.currentLapTime.textContent = formatLapTime(lastTime);
        }
        currentLapData = [];
    }
    lastLapNumber = currentLapNumber;

    // ラップデータ蓄積
    currentLapData.push({
        time: timeCounter,
        speed: data.speed_kmh || 0,
        rpm: data.rpm || 0,
        throttle: data.throttle_pct || 0,
        brake: data.brake_pct || 0
    });

    // 速度デルタ（ベストラップ同地点との速度差）
    if (bestLapData.length > 0 && currentLapData.length > 0) {
        var idx = Math.min(currentLapData.length - 1, bestLapData.length - 1);
        var delta = currentLapData[idx].speed - bestLapData[idx].speed;
        elements.lapDelta.textContent = (delta >= 0 ? '+' : '') + delta.toFixed(1) + ' km/h';
        elements.lapDelta.className = 'delta-value' + (delta < 0 ? ' negative' : '');
    }

    // 加速度
    updateAccelChart(data.accel_g || 0, data.accel_decel || 0);
    elements.accelG.textContent = (data.accel_g || 0).toFixed(2);
    elements.accelDecel.textContent = (data.accel_decel || 0).toFixed(2);

    // チャートデータ更新
    timeData.shift();
    timeData.push(timeCounter++);

    var speed = Math.round(data.speed_kmh || 0);
    speedData.shift();
    speedData.push(speed);
    elements.speed.textContent = speed;
    if (speed > maxSpeed) {
        maxSpeed = speed;
        elements.maxSpeed.textContent = maxSpeed;
    }

    // ギア
    var gear = data.gear || 0;
    elements.gear.textContent = gear === 0 ? 'R' : gear;
    if (data.suggested_gear != null && data.suggested_gear !== gear) {
        elements.suggestedGear.textContent = '\u2192' + data.suggested_gear;
    } else {
        elements.suggestedGear.textContent = '';
    }

    // ステアリング回転
    if (data.wheel_rotation !== undefined) {
        var deg = (data.wheel_rotation * 180 / Math.PI).toFixed(1);
        elements.wheelRotation.textContent = deg + '\u00B0';
    }

    // RPM (パケットからの実際のmax_rpmを使用)
    var rpm = Math.round(data.rpm || 0);
    var maxRpm = data.max_rpm || 9000;
    var rpmPct = Math.min((rpm / maxRpm) * 100, 100);
    rpmData.shift();
    rpmData.push(rpm);
    elements.rpmBar.style.width = rpmPct + '%';
    if (data.rpm_alert_min && rpm >= data.rpm_alert_min) {
        elements.rpmBar.style.background = rpm >= maxRpm ? '#ff4444' : '#ffd700';
    } else {
        elements.rpmBar.style.background = '';
    }
    elements.rpmText.textContent = rpm + ' RPM';

    // ペダル
    var throttle = Math.round(data.throttle_pct || 0);
    var brake = Math.round(data.brake_pct || 0);
    var clutch = Math.round((data.clutch || 0) * 100);
    throttleData.shift();
    throttleData.push(throttle);
    brakeData.shift();
    brakeData.push(brake);
    elements.throttleBar.style.width = throttle + '%';
    elements.throttleValue.textContent = throttle + '%';
    elements.brakeBar.style.width = brake + '%';
    elements.brakeValue.textContent = brake + '%';
    elements.clutchBar.style.width = clutch + '%';
    elements.clutchValue.textContent = clutch + '%';

    // フィルタ後入力（TCS/ABS補正後）
    if (data.throttle_filtered_pct !== undefined) {
        elements.throttleFilteredBar.style.width = Math.round(data.throttle_filtered_pct) + '%';
    }
    if (data.brake_filtered_pct !== undefined) {
        elements.brakeFilteredBar.style.width = Math.round(data.brake_filtered_pct) + '%';
    }

    // 燃料
    elements.fuel.textContent = (data.current_fuel || 0).toFixed(1);
    elements.fuelCapacity.textContent = (data.fuel_capacity || 0).toFixed(0);
    if (data.fuel_per_lap !== undefined) {
        elements.fuelPerLap.textContent = (data.fuel_per_lap || 0).toFixed(2);
    }
    if (data.fuel_laps_remaining !== undefined) {
        elements.fuelLapsRemaining.textContent = data.fuel_laps_remaining || '--';
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
    elements.angX.textContent = (data.angular_velocity_x || 0).toFixed(3);
    elements.angY.textContent = (data.angular_velocity_y || 0).toFixed(3);
    elements.angZ.textContent = (data.angular_velocity_z || 0).toFixed(3);
    elements.pitchRate.textContent = (data.angular_velocity_x || 0).toFixed(3);
    elements.yawRate.textContent = (data.angular_velocity_y || 0).toFixed(3);
    elements.rollRate.textContent = (data.angular_velocity_z || 0).toFixed(3);

    // 方角・車体高さ
    elements.orientation.textContent = (data.orientation || 0).toFixed(3);
    elements.bodyHeight.textContent = (data.body_height || 0).toFixed(3);

    // 現在のラップ経過時間
    if (data.current_laptime !== undefined && data.current_laptime > 0) {
        elements.runningLapTime.textContent = formatLapTime(data.current_laptime);
    }

    // スタート順位（レース前のみ有効）
    if (data.pre_race_position != null && data.num_cars_pre_race != null) {
        elements.racePosition.textContent = 'P' + data.pre_race_position + '/' + data.num_cars_pre_race;
    } else if (data.pre_race_position != null) {
        elements.racePosition.textContent = 'P' + data.pre_race_position;
    }

    // コース名
    if (data.course && data.course.name && data.course.id !== 'unknown') {
        elements.courseName.textContent = data.course.name;
    }

    // フラグ表示
    if (data.flags) {
        var flagParts = [];
        if (data.flags.tcs_active) flagParts.push('<span class="flag-on">TCS</span>');
        if (data.flags.asm_active) flagParts.push('<span class="flag-on">ASM</span>');
        if (data.flags.rev_limiter) flagParts.push('<span class="flag-warn">REV</span>');
        if (data.flags.hand_brake) flagParts.push('<span class="flag-warn">P-BRK</span>');
        if (data.flags.lights) flagParts.push('<span class="flag-info">LIGHT</span>');
        if (data.flags.has_turbo) flagParts.push('<span class="flag-info">TURBO</span>');
        elements.flagsBar.innerHTML = flagParts.join('');
    }

    // コースマップ
    if (data.position_x !== undefined && data.position_z !== undefined) {
        updateCourseMap(
            data.position_x,
            data.position_y || 0,
            data.position_z,
            data.speed_kmh || 0
        );
    }

    // サスペンション
    if (data.susp_height) {
        elements.flSusp.textContent = (data.susp_height[0] * 1000).toFixed(0);
        elements.frSusp.textContent = (data.susp_height[1] * 1000).toFixed(0);
        elements.rlSusp.textContent = (data.susp_height[2] * 1000).toFixed(0);
        elements.rrSusp.textContent = (data.susp_height[3] * 1000).toFixed(0);
    }

    // タイヤ温度
    if (data.tyre_temp) {
        var temps = data.tyre_temp;
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
        var rps = data.wheel_rps;
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

    // 車体加速度（Packet B拡張）
    if (data.body_accel_sway !== undefined) {
        elements.bodySway.textContent = (data.body_accel_sway || 0).toFixed(3);
        elements.bodyHeave.textContent = (data.body_accel_heave || 0).toFixed(3);
        elements.bodySurge.textContent = (data.body_accel_surge || 0).toFixed(3);
    }

    // トルクベクタリング・回生（Packet ~拡張）
    if (data.torque_vector) {
        elements.torque1.textContent = data.torque_vector[0].toFixed(2);
        elements.torque2.textContent = data.torque_vector[1].toFixed(2);
        elements.torque3.textContent = data.torque_vector[2].toFixed(2);
        elements.torque4.textContent = data.torque_vector[3].toFixed(2);
    }
    if (data.energy_recovery !== undefined) {
        elements.energyRecovery.textContent = (data.energy_recovery || 0).toFixed(2);
    }

    // 車種ID・パッケージID
    if (data.car_id) {
        elements.carId.textContent = data.car_id;
    }
    if (data.package_id !== undefined) {
        elements.pkgId.textContent = data.package_id;
    }

    // チャート再描画
    if (speedChart) speedChart.setData([timeData, speedData]);
    if (rpmChart) rpmChart.setData([timeData, rpmData]);
    if (throttleChart) throttleChart.setData([timeData, throttleData]);
    if (brakeChart) brakeChart.setData([timeData, brakeData]);
}

function connectWebSocket() {
    var wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = wsProtocol + '//' + window.location.host + '/ws';

    ws = new WebSocket(wsUrl);

    ws.onopen = function() {
        console.log('Connected to GT7 Bridge');
        elements.connectionStatus.textContent = 'Connected';
        elements.connectionStatus.className = 'connected';
        initCharts();
        initCourseMap();
    };

    ws.onerror = function(error) {
        console.error('WebSocket Error:', error);
    };

    ws.onclose = function() {
        console.log('Disconnected');
        elements.connectionStatus.textContent = 'Disconnected';
        elements.connectionStatus.className = 'disconnected';
    };

    ws.onmessage = function(event) {
        try {
            var data = JSON.parse(event.data);
            handleTelemetryMessage(data);
        } catch (e) {
            console.error('WebSocket message error:', e);
        }
    };
}
