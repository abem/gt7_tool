/**
 * GT7 Telemetry Dashboard
 * WebSocket接続・メッセージ処理
 *
 * @module websocket
 * @depends constants.js (UPDATE_INTERVALS, WEBSOCKET_CONFIG)
 * @depends ui_components.js (elements, debugLog, updateSteeringGauge, cacheElements, getTyreTempColor)
 * @depends lap-manager.js (updateLapState, updateMaxSpeed)
 * @depends charts.js (timeCounter, timeData, speedData, rpmData, throttleData, brakeData,
 *                     speedChart, rpmChart, throttleChart, brakeChart, initCharts, updateAccelChart)
 * @depends steer-response.js (initSteerResponse, updateSteerResponse)
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
    lastRotationTs: 0,
    /** JSONパースエラー連続回数 */
    parseErrorCount: 0
};

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
 * シフトライトの表示を更新
 * @param {number} rpm - 現在のRPM
 * @param {number} maxRpm - 最大RPM
 */
function updateShiftLights(rpm, maxRpm) {
    if (!elements.shiftLights) return;
    
    const lights = elements.shiftLights.querySelectorAll('.shift-light');
    const rpmPct = (rpm / maxRpm) * 100;
    
    // シフトライトの閾値設定（RPM%で指定）
    // 8個のライト: 75%, 80%, 85%, 88%, 91%, 94%, 96%, 98%
    const thresholds = [75, 80, 85, 88, 91, 94, 96, 98];
    
    lights.forEach((light, index) => {
        light.className = 'shift-light'; // リセット
        
        if (rpmPct >= thresholds[index]) {
            if (index < 3) {
                light.classList.add('green');
            } else if (index < 6) {
                light.classList.add('yellow');
            } else {
                light.classList.add('red');
            }
        }
    });
}

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
    const gearEl = elements.gear;
    gearEl.textContent = gear === 0 ? 'R' : gear;
    
    // ギアに応じた色変更
    gearEl.classList.remove('reverse', 'low');
    if (gear === 0) {
        gearEl.classList.add('reverse');
    } else if (gear <= 2) {
        gearEl.classList.add('low');
    }
    
    // RPM
    const rpm = Math.round(data.rpm || 0);
    const maxRpm = data.max_rpm || 9000;
    const rpmPct = Math.min((rpm / maxRpm) * 100, 100);
    // #rpm-bar は現行UIには存在しない(RPMはシフトライト+rpm-textで表現)。存在時のみ更新。
    if (elements.rpmBar) {
        elements.rpmBar.style.width = rpmPct + '%';
        if (data.rpm_alert_min && rpm >= data.rpm_alert_min) {
            elements.rpmBar.style.background =
                rpm >= maxRpm ? COLORS.accentRed : COLORS.accentYellow;
        } else {
            elements.rpmBar.style.background = '';
        }
    }
    elements.rpmText.textContent = rpm + ' RPM';

    // シフトライト更新
    updateShiftLights(rpm, maxRpm);

    // ペダル（トップバー用）
    const throttle = Math.round(data.throttle_pct || 0);
    const brake = Math.round(data.brake_pct || 0);
    const clutch = Math.round((data.clutch || 0) * 100);

    elements.throttleBar.style.width = throttle + '%';
    elements.throttleValue.textContent = throttle + '%';
    elements.brakeBar.style.width = brake + '%';
    elements.brakeValue.textContent = brake + '%';
    
    // ペダルトレース更新
    if (typeof updatePedalTrace === 'function') {
        updatePedalTrace(throttle, brake);
    }
    
    // ペダル（左パネル詳細用）
    if (elements.throttleBarDetail) {
        elements.throttleBarDetail.style.width = throttle + '%';
    }
    if (elements.throttleValueDetail) {
        elements.throttleValueDetail.textContent = throttle + '%';
    }
    if (elements.brakeBarDetail) {
        elements.brakeBarDetail.style.width = brake + '%';
    }
    if (elements.brakeValueDetail) {
        elements.brakeValueDetail.textContent = brake + '%';
    }
    
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
    const FUEL_PCT_LOW = 15, FUEL_PCT_WARN = 30, FUEL_LAPS_CRITICAL = 3, FUEL_LAPS_WARN = 5;
    const currentFuel = data.current_fuel || 0;
    const capacity = data.fuel_capacity || 100;
    
    elements.fuel.textContent = currentFuel.toFixed(1);
    elements.fuelCapacity.textContent = capacity.toFixed(0);
    
    // 燃料バー更新
    const fuelBar = document.getElementById('fuel-bar');
    if (fuelBar) {
        const pct = Math.min(100, (currentFuel / capacity) * 100);
        fuelBar.style.width = pct + '%';
        
        // 残量に応じた色変更
        fuelBar.classList.remove('low', 'warning');
        if (pct < FUEL_PCT_LOW) {
            fuelBar.classList.add('low');
        } else if (pct < FUEL_PCT_WARN) {
            fuelBar.classList.add('warning');
        }
    }

    if (data.fuel_per_lap !== undefined) {
        elements.fuelPerLap.textContent = (data.fuel_per_lap || 0).toFixed(2);
    }
    if (data.fuel_laps_remaining !== undefined) {
        const lapsRemaining = data.fuel_laps_remaining;
        elements.fuelLapsRemaining.textContent = lapsRemaining || '--';
        
        // 残り周回数に応じた色変更
        if (elements.fuelLapsRemaining.style) {
            if (lapsRemaining < FUEL_LAPS_CRITICAL) {
                elements.fuelLapsRemaining.style.color = COLORS.accentRed;
            } else if (lapsRemaining < FUEL_LAPS_WARN) {
                elements.fuelLapsRemaining.style.color = COLORS.accentYellow;
            } else {
                elements.fuelLapsRemaining.style.color = COLORS.accentCyan;
            }
        }
    }
}

/**
 * タイヤ温度に応じたCSSクラスを取得
 * @param {number} temp - タイヤ温度
 * @returns {string} CSSクラス名
 */
function getTyreTempClass(temp) {
    if (temp < TYRE_TEMP.COLD_THRESHOLD) return 'cold';
    if (temp < TYRE_TEMP.OPTIMAL_HIGH) return 'optimal';
    if (temp < TYRE_TEMP.HOT_THRESHOLD) return 'warm';
    return 'hot';
}

/**
 * タイヤ温度バーを更新
 * @param {string} position - タイヤ位置（fl, fr, rl, rr）
 * @param {number} temp - 温度
 */
function updateTyreTempBar(position, temp) {
    const bar = document.getElementById(position + '-temp-bar');
    if (!bar) return;
    
    // 温度を0-120°Cの範囲でバー幅に変換（120°C = 100%）
    const maxTemp = 120;
    const minTemp = 20;
    const pct = Math.min(100, Math.max(0, ((temp - minTemp) / (maxTemp - minTemp)) * 100));
    
    bar.style.width = pct + '%';
    bar.className = 'tyre-temp-bar ' + getTyreTempClass(temp);
}

/**
 * タイヤ状態の表示を更新
 * @param {Object} data - テレメトリデータ
 */
function updateTyreState(data) {
    var TYRE_CORNERS = ['fl', 'fr', 'rl', 'rr'];

    // サスペンション
    if (data.susp_height) {
        TYRE_CORNERS.forEach(function(p, i) {
            elements[p + 'Susp'].textContent = (data.susp_height[i] * 1000).toFixed(0);
        });
    }

    // タイヤ温度
    if (data.tyre_temp) {
        const temps = data.tyre_temp;
        TYRE_CORNERS.forEach(function(p, i) {
            elements[p + 'Temp'].textContent = Math.round(temps[i]);
            elements[p + 'Temp'].style.color = getTyreTempColor(temps[i]);
            // 温度バー更新
            updateTyreTempBar(p, temps[i]);
        });
    }

    // ホイール回転速度
    if (data.wheel_rps) {
        const rps = data.wheel_rps;
        TYRE_CORNERS.forEach(function(p, i) {
            elements[p + 'Rps'].textContent = Math.abs(rps[i] || 0).toFixed(1);
        });
    }

    // タイヤ半径
    if (data.tyre_radius) {
        TYRE_CORNERS.forEach(function(p, i) {
            elements[p + 'Radius'].textContent = (data.tyre_radius[i] || 0).toFixed(3);
        });
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
        
        // 重心点(CAR ATTITUDE)へ G を反映（sway = 横G, surge = 縦G）
        if (typeof setCarGForce === 'function') {
            setCarGForce(
                data.body_accel_sway || 0,
                data.body_accel_surge || 0
            );
        }
    }
}

/**
 * セクタータイムの色を決定（実テレメトリ／テストモード共通の正準版）
 * @param {number} current - 現在のセクタータイム
 * @param {number} best - ベストセクタータイム（<=0/未設定なら '' を返す）
 * @returns {string} CSSクラス名（'purple'|'green'|'yellow'|'red'|''）
 */
function getSectorClass(current, best) {
    const SECTOR_GREEN_THRESH = 0.1;
    const SECTOR_YELLOW_THRESH = 0.3;
    if (!best || best <= 0) return '';
    const diff = current - best;
    if (diff < 0) return 'purple';  // 新ベスト
    if (diff < SECTOR_GREEN_THRESH) return 'green';  // ベストに近い
    if (diff < SECTOR_YELLOW_THRESH) return 'yellow'; // 普通
    return 'red';  // 遅い
}

/**
 * セクター表示を更新
 * @param {Object} data - テレメトリデータ
 */
function updateSectors(data) {
    if (data.sector_1 !== undefined && elements.sector1) {
        elements.sector1.textContent = data.sector_1.toFixed(3);
        elements.sector1.className = 'sector-value ' + 
            getSectorClass(data.sector_1, data.best_sector_1);
    }
    if (data.sector_2 !== undefined && elements.sector2) {
        elements.sector2.textContent = data.sector_2.toFixed(3);
        elements.sector2.className = 'sector-value ' + 
            getSectorClass(data.sector_2, data.best_sector_2);
    }
    if (data.sector_3 !== undefined && elements.sector3) {
        elements.sector3.textContent = data.sector_3.toFixed(3);
        elements.sector3.className = 'sector-value ' + 
            getSectorClass(data.sector_3, data.best_sector_3);
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

    // コース名（COURSE MAP 廃止で #course-name は無い。要素があるときだけ更新）
    if (elements.courseName && data.course && data.course.name && data.course.id !== 'unknown') {
        elements.courseName.textContent = data.course.name;
    }
}

/**
 * チャート状態の表示を更新
 * @param {Object} data - テレメトリデータ
 */
function updateChartState(data) {
    // 加速度 (#accel-g/#accel-decel は現行UIには存在しない。加速度は accel-chart で表現。存在時のみ更新)
    updateAccelChart(data.accel_g || 0, data.accel_decel || 0);
    if (elements.accelG) elements.accelG.textContent = (data.accel_g || 0).toFixed(2);
    if (elements.accelDecel) elements.accelDecel.textContent = (data.accel_decel || 0).toFixed(2);

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
        updateSectors(data);
        wsState.lastUiTs = now;
    }

    // 距離基準ラップ解析(距離積分の精度確保のため非スロットルで毎処理フレーム呼ぶ。
    // チャート再描画は analysisOnFrame 内部で 100ms スロットル)
    if (typeof analysisOnFrame === 'function') {
        analysisOnFrame(data);
    }

    // DRIVE ビュー(有効時のみ内部で更新。analysisOnFrame の後 = 最新デルタを反映)
    if (doUi && typeof driveViewOnFrame === 'function') {
        driveViewOnFrame(data);
    }

    // 3Dモデル更新
    updateCar3D(
        data.rotation_pitch || 0,
        data.rotation_yaw || 0,
        data.rotation_roll || 0,
        data.rpm || 0,
        data.wheel_rotation || 0,
        data.susp_height
    );

    if (doRotation) {
        updateSteeringGauge(data.wheel_rotation || 0);
        wsState.lastRotationTs = now;
    }

    if (doMap) {
        // STEER RESPONSE: 舵角(ステアホイール角) vs 実ヨーレートでアンダー/オーバーを図示
        updateSteerResponse(
            data.wheel_rotation || 0,                            // ステア角 (rad)
            data.angular_velocity_y || 0,                        // 実ヨーレート (rad/s)
            (data.speed_ms != null ? data.speed_ms : (data.speed_kmh || 0) / 3.6),
            data.body_accel_sway || 0                            // 横G (m/s^2)
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
        initSteerResponse();
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
    const PARSE_ERROR_WARN = 5;
    const PARSE_ERROR_RECONNECT = 20;
    wsState.processingScheduled = false;

    if (!wsState.latestMessage) {
        return;
    }

    const raw = wsState.latestMessage;
    wsState.latestMessage = null;

    try {
        const data = JSON.parse(raw);
        wsState.parseErrorCount = 0;  // 成功時はリセット
        handleTelemetryMessage(data, now);
    } catch (e) {
        wsState.parseErrorCount++;
        console.error('WebSocket message error:', e);
        
        // 連続エラー時にユーザー通知
        if (wsState.parseErrorCount === PARSE_ERROR_WARN) {
            showConnectionError('データ受信エラーが続いています。PS5との接続を確認してください。');
        } else if (wsState.parseErrorCount >= PARSE_ERROR_RECONNECT) {
            showConnectionError('深刻な通信エラー。再接続を試みます...');
            wsState.parseErrorCount = 0;
            disconnectWebSocket();
            scheduleReconnect();
        }
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
 *  切断処理
 * ================================================================ */

/**
 * アクティブなWebSocket接続を閉じる
 */
function disconnectWebSocket() {
    if (wsState.reconnectTimer) {
        clearTimeout(wsState.reconnectTimer);
        wsState.reconnectTimer = null;
    }
    if (wsState.ws) {
        wsState.ws.close();
        wsState.ws = null;
    }
}

/**
 * 接続エラー表示
 */
function showConnectionError(message) {
    console.error('[WS] ' + message);
    if (elements.connectionStatus) {
        elements.connectionStatus.textContent = message;
        elements.connectionStatus.className = 'error';
    }
}

/* ================================================================
 *  初期化
 * ================================================================ */

document.addEventListener('DOMContentLoaded', function() {
    cacheElements();
    connectWebSocket();
});
