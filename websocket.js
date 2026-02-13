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

    // RPM
    var rpm = Math.round(data.rpm || 0);
    var maxRpm = data.max_rpm || 9000;
    var rpmPct = Math.min((rpm / maxRpm) * 100, 100);
    rpmData.shift();
    rpmData.push(rpm);
    elements.rpmBar.style.width = rpmPct + '%';
    elements.rpmText.textContent = rpm + ' RPM';

    // ペダル
    var throttle = Math.round(data.throttle_pct || 0);
    var brake = Math.round(data.brake_pct || 0);
    throttleData.shift();
    throttleData.push(throttle);
    brakeData.shift();
    brakeData.push(brake);
    elements.throttleBar.style.width = throttle + '%';
    elements.throttleValue.textContent = throttle + '%';
    elements.brakeBar.style.width = brake + '%';
    elements.brakeValue.textContent = brake + '%';

    // 燃料・ブースト
    elements.fuel.textContent = (data.current_fuel || 0).toFixed(1);
    elements.boost.textContent = ((data.boost || 0) * 100).toFixed(0);

    // 位置
    elements.posX.textContent = (data.position_x || 0).toFixed(1);
    elements.posY.textContent = (data.position_y || 0).toFixed(1);
    elements.posZ.textContent = (data.position_z || 0).toFixed(1);

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

    // タイヤ空気圧
    if (data.tyre_pressure) {
        var pressures = data.tyre_pressure;
        elements.flPressure.textContent = (pressures[0] || 0).toFixed(1);
        elements.frPressure.textContent = (pressures[1] || 0).toFixed(1);
        elements.rlPressure.textContent = (pressures[2] || 0).toFixed(1);
        elements.rrPressure.textContent = (pressures[3] || 0).toFixed(1);
    }

    // ホイール回転速度
    if (data.wheel_rps) {
        var rps = data.wheel_rps;
        elements.flRps.textContent = Math.abs(rps[0] || 0).toFixed(1);
        elements.frRps.textContent = Math.abs(rps[1] || 0).toFixed(1);
        elements.rlRps.textContent = Math.abs(rps[2] || 0).toFixed(1);
        elements.rrRps.textContent = Math.abs(rps[3] || 0).toFixed(1);
    }

    // 車種ID
    if (data.car_id) {
        elements.carId.textContent = data.car_id;
    }

    elements.packets.textContent = packetCount;

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
