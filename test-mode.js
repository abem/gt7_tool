/**
 * GT7 Telemetry Dashboard
 * テストモード（PS5なしでのデモデータ表示）
 *
 * @module test-mode
 * @depends constants.js (TEST_MODE_CONFIG)
 * @depends ui_components.js (elements, debugLog)
 * @depends websocket.js (wsState, handleTelemetryMessage)
 * @depends steer-response.js (initSteerResponse, updateSteerResponse, STEER_RESP)
 * @depends car-3d.js (initCar3D, car3DState)
 * @depends lap-manager.js (resetLapState)
 */

/* ================================================================
 *  テストモード状態
 * ================================================================ */
/** テストモード有効フラグ */
let testModeActive = false;
/** テストモード更新間隔（ms） */
let testModeInterval = null;
/** テスト軌跡インデックス */
let testTrajectoryIndex = 0;
let demoPrevSpeedMs = null;   // surge(m/s^2) 導出用の前フレーム速度

/* ================================================================
 *  デモ軌跡データ
 * ================================================================ */
const demoTrajectory = [
    {x: 0, z: -300, speed: 80},
    {x: 50, z: -280, speed: 120},
    {x: 100, z: -240, speed: 160},
    {x: 150, z: -180, speed: 200},
    {x: 200, z: -100, speed: 220},
    {x: 240, z: -20, speed: 200},
    {x: 260, z: 60, speed: 180},
    {x: 250, z: 140, speed: 150},
    {x: 220, z: 200, speed: 120},
    {x: 170, z: 230, speed: 100},
    {x: 110, z: 240, speed: 90},
    {x: 50, z: 230, speed: 100},
    {x: -20, z: 200, speed: 130},
    {x: -80, z: 150, speed: 170},
    {x: -120, z: 80, speed: 200},
    {x: -140, z: 0, speed: 190},
    {x: -130, z: -80, speed: 160},
    {x: -90, z: -150, speed: 130},
    {x: -40, z: -220, speed: 110},
    {x: 0, z: -280, speed: 90}
];

/* ================================================================
 *  初期化
 * ================================================================ */

/**
 * テストモードを初期化
 */
function initTestMode() {
    const btn = document.getElementById('test-mode-btn');
    if (!btn) {
        return;
    }

    btn.addEventListener('click', function() {
        testModeActive = !testModeActive;
        updateTestModeButton(btn, testModeActive);

        if (testModeActive) {
            ensureCar3DInitialized();
            // チャート/STEER RESPONSE はライブでは ws.onopen 内で初期化されるが、
            // TEST MODE(オフライン)では onopen が発火しないためここで初期化する。
            // いずれも内部フラグで冪等なので二重初期化にはならない。
            if (typeof initCharts === 'function') initCharts();
            if (typeof initSteerResponse === 'function') initSteerResponse();
            startTestMode();
        } else {
            stopTestMode();
        }
    });
}

/**
 * テストモードボタンの表示を更新
 * @param {HTMLElement} btn - ボタン要素
 * @param {boolean} active - 有効状態
 */
function updateTestModeButton(btn, active) {
    btn.classList.toggle('active', active);
    btn.textContent = active ? 'STOP TEST' : 'TEST MODE';
}

 /**
 * 3Dモデルが初期化されていることを保証
 */
function ensureCar3DInitialized() {
    if (!car3DState.initialized) {
        initCar3D();
    }
}

 /**
 * テストモードを開始
 */
function startTestMode() {
    debugLog('TEST', 'Test mode enabled');
    testTrajectoryIndex = 0;
    setTestModeUiState(true);

    testModeInterval = setInterval(function() {
        if (!testModeActive) {
            clearInterval(testModeInterval);
            return;
        }

        const point = demoTrajectory[testTrajectoryIndex % demoTrajectory.length];
        testTrajectoryIndex++;

        const demoInputs = getDemoInputs();
        renderDemoFrame(point, demoInputs);
        wsState.packetCount++;
    }, TEST_MODE_CONFIG.intervalMs);
}

/**
 * テストモードを停止
 */
function stopTestMode() {
    debugLog('TEST', 'Test mode disabled');
    clearInterval(testModeInterval);
    testModeInterval = null;
    setTestModeUiState(false);
    testTrajectoryIndex = 0;
    demoPrevSpeedMs = null;

    // 再テスト時にクリーンスタートするため解析状態もリセット
    if (typeof resetAnalysis === 'function') {
        resetAnalysis();
    }

    // ラップ状態もリセット。合成パケットが handleTelemetryMessage 経由で
    // updateLapState/updateMaxSpeed を駆動するため、デモの偽 BEST/ラップ履歴/最高速が
    // ライブ復帰後に残留する回帰をここで防ぐ。
    if (typeof resetLapState === 'function') {
        resetLapState();
    }
}

/**
 * テストモード時のUI状態を設定
 * @param {boolean} active - 有効状態
 */
function setTestModeUiState(active) {
    // 見た目はインライン style ではなく .test-mode クラスで表現する
    // （#connection-status.test-mode の CSS 定義はスタイル担当側）。
    const conn = elements.connectionStatus;
    if (active) {
        conn.textContent = TEST_MODE_CONFIG.status.text;
        conn.classList.add('test-mode');
        return;
    }

    // 接続状態に応じた表示に戻す（className 再代入で test-mode も外れる）
    conn.classList.remove('test-mode');
    if (wsState.ws && wsState.ws.readyState === WebSocket.OPEN) {
        // 段階表示の契約を維持: テレメトリ未処理なら 'Connected (no data)' に戻す
        // (TEST MODE 中はライブ遮断ガードにより liveDataSeen は昇格しない)
        conn.textContent = wsState.liveDataSeen ? 'Connected' : 'Connected (no data)';
        conn.className = 'connected';
    } else {
        conn.textContent = 'Disconnected';
        conn.className = 'disconnected';
    }
}

/* ================================================================
 *  デモデータ生成
 * ================================================================ */

/**
 * デモ入力データを取得
 * @returns {Object} デモ入力データ
 */
function getDemoInputs() {
    const t = testTrajectoryIndex;
    
    // リアルなパターンを生成
    const throttleBase = 60 + Math.sin(t * 0.05) * 40;
    const brakeBase = Math.max(0, Math.sin(t * 0.1 + 2) * 50);
    
    return {
        rpm: 3000 + Math.sin(t * 0.03) * 3000 + Math.random() * 500,
        gear: Math.floor((t % 60) / 10) + 1,  // 10フレームごとにギアアップ
        throttle: Math.max(0, Math.min(100, throttleBase)),
        brake: Math.max(0, Math.min(100, brakeBase)),
        clutch: t % 60 < 2 ? 100 : 0,  // ギアチェンジ時のみ
        boost: Math.random() * 0.3,
        oilPressure: 2.5 + Math.random() * 0.5
    };
}

/**
 * デモタイヤデータを取得
 * @returns {Object} タイヤデータ
 */
function getDemoTyreData() {
    const t = testTrajectoryIndex;
    const baseTemp = 70 + Math.sin(t * 0.02) * 15;
    
    return {
        temps: [
            baseTemp + Math.random() * 10,
            baseTemp + Math.random() * 10,
            baseTemp - 5 + Math.random() * 10,
            baseTemp - 5 + Math.random() * 10
        ],
        rps: [
            10 + Math.random() * 5,
            10 + Math.random() * 5,
            10 + Math.random() * 5,
            10 + Math.random() * 5
        ],
        susp: [
            50 + Math.sin(t * 0.1) * 20,
            50 + Math.cos(t * 0.1) * 20,
            55 + Math.sin(t * 0.12) * 15,
            55 + Math.cos(t * 0.12) * 15
        ]
    };
}

/**
 * デモ燃料データを取得
 * @returns {Object} 燃料データ
 */
function getDemoFuelData() {
    const t = testTrajectoryIndex;
    return {
        current: Math.max(5, 50 - t * 0.01),
        capacity: 100,
        perLap: 2.5 + Math.random() * 0.5,
        lapsRemaining: Math.floor((50 - t * 0.01) / 2.5)
    };
}

/**
 * デモG-Forceデータを取得
 * @returns {Object} G-Forceデータ
 */
function getDemoGForceData() {
    const t = testTrajectoryIndex;
    return {
        sway: Math.sin(t * 0.15) * 0.8 + Math.random() * 0.2,  // 横G
        surge: Math.cos(t * 0.1) * 0.5 + Math.random() * 0.1,  // 縦G
        heave: Math.sin(t * 0.2) * 0.2 + Math.random() * 0.05  // 上下G
    };
}

/**
 * デモ姿勢角を取得
 * @returns {Object} 姿勢データ
 */
function getDemoOrientation() {
    return {
        pitch: Math.sin(testTrajectoryIndex * 0.1) * 0.3,
        yaw: testTrajectoryIndex * 0.05,
        roll: Math.cos(testTrajectoryIndex * 0.08) * 0.2
    };
}

/**
 * デモステアリング角を取得
 * @returns {number} ステアリング角（ラジアン）
 */
function getDemoSteering() {
    // 現実的な角度（最大±15度程度）
    const baseSteering = Math.sin(testTrajectoryIndex * 0.15) * 0.25;
    const quickTurn = Math.sin(testTrajectoryIndex * 0.4) * 0.05;
    return baseSteering + quickTurn;
}

/* ================================================================
 *  レンダリング
 * ================================================================ */

/**
 * デモフレームをレンダリング。
 *
 * 個別 DOM 書込や update* 直接呼出は行わず、decoder.py のキー名に忠実な
 * 「完全合成パケット」を1個組み立てて handleTelemetryMessage() を1回呼ぶ。
 * これにより TEST MODE の描画経路がライブ(WS 受信)と完全に同一化され、
 * ライブでしか埋まらない項目が TEST MODE で空のままになる問題を根治する。
 * （TEST MODE の更新間隔 200ms は UI/CHART/MAP/ROTATION の全スロットル閾値より
 *   長いため、毎フレーム全系統が更新される）
 *
 * @param {Object} point - 軌跡ポイント
 * @param {Object} demoInputs - デモ入力データ
 */
function renderDemoFrame(point, demoInputs) {
    const t = testTrajectoryIndex;
    const DEMO_MAX_RPM = 9000;

    // ── デモ物理（従来ロジックを温存し、値の詰め替えだけ行う）──
    const tyreData = getDemoTyreData();
    const fuelData = getDemoFuelData();
    const gforceData = getDemoGForceData();
    const demoOrientation = getDemoOrientation();
    const demoSteering = getDemoSteering();

    // 合成ラップ: demoTrajectory 20点 = 1周。周毎に短縮 → PB連発で通知/解析も検証
    const DEMO_LAP_SHORTEN_MS = 40;
    const lapLen = demoTrajectory.length;              // 20
    const stepMs = TEST_MODE_CONFIG.intervalMs;        // 200
    const lapNum = Math.floor(t / lapLen) + 1;
    const posInLap = t % lapLen;
    const lastLapMs = lapLen * stepMs - lapNum * DEMO_LAP_SHORTEN_MS;

    // 速度ベクトル: 軌跡差分の向き × 現在速度（m/s）。
    // t は呼出元でインクリメント済のため demoTrajectory[t % lapLen] が「次の点」。
    const nextPoint = demoTrajectory[t % lapLen];
    const dx = nextPoint.x - point.x;
    const dz = nextPoint.z - point.z;
    const dNorm = Math.hypot(dx, dz) || 1;
    const speedMs = point.speed / 3.6;

    // STEER RESPONSE デモ量（後段の上書き呼出でも使用）:
    //   弧が見えるようステア拡大、実/期待比を掃引してアンダー↔中立↔オーバーを一巡表示
    var demoSteerWheel = demoSteering * 6;                          // ステアホイール角相当（表示拡大）
    var demoV = Math.max(6, speedMs);                               // m/s
    var demoF = 0.8 + 0.5 * Math.sin(t * 0.03);                    // 実/期待比 0.3..1.3
    var demoYaw = (demoV * demoSteerWheel / STEER_RESP.neutralL) * demoF;
    var demoLatG = (demoSteering >= 0 ? 1 : -1) * (0.3 + 0.7 * Math.abs(Math.sin(t * 0.03))) * 9.81; // ±0.3..1.0g
    // 前後加速度は速度波形の微分から m/s^2 で導出(sway と単位を統一)。
    // 旧 getDemoGForceData の surge/heave は G スケールで sway(m/s^2)と16倍の不整合があった。
    var surgeMs2 = 0;
    if (demoPrevSpeedMs !== null) {
        surgeMs2 = (speedMs - demoPrevSpeedMs) / (stepMs / 1000);
        surgeMs2 = Math.max(-10, Math.min(10, surgeMs2));
    }
    demoPrevSpeedMs = speedMs;
    const heaveMs2 = (gforceData.heave || 0) * 9.81;

    // ── 完全合成パケット（キー名は decoder.py / main.py 付加フィールドに忠実）──
    const data = {
        // 速度
        speed_ms: speedMs,
        speed_kmh: point.speed,

        // エンジン
        rpm: demoInputs.rpm,
        max_rpm: DEMO_MAX_RPM,
        rpm_alert_min: 8000,

        // ギア・ペダル（throttle_pct/brake_pct は 0..100）
        gear: demoInputs.gear,
        throttle_pct: demoInputs.throttle,
        brake_pct: demoInputs.brake,
        throttle_filtered_pct: demoInputs.throttle,
        brake_filtered_pct: demoInputs.brake,

        // クラッチ（decoder は 0..1。既存デモ値は 0/100(%) のため /100 変換必須）
        clutch: demoInputs.clutch / 100,
        clutch_engagement: 1 - demoInputs.clutch / 100,
        clutch_gearbox_rpm: demoInputs.rpm,

        // ブースト・油圧
        boost: demoInputs.boost,
        oil_pressure: demoInputs.oilPressure,

        // 燃料（fuel_per_lap/fuel_laps_remaining は main.py 付加フィールド。
        //   1周目は 0 を送り、計測前 '--' → 計測開始の立ち上がり挙動もデモする）
        current_fuel: fuelData.current,
        fuel_capacity: fuelData.capacity,
        fuel_per_lap: lapNum > 1 ? fuelData.perLap : 0,
        fuel_laps_remaining: lapNum > 1 ? fuelData.lapsRemaining : 0,

        // タイヤ [FL, FR, RL, RR]
        tyre_temp: tyreData.temps,
        wheel_rps: tyreData.rps,
        tyre_radius: [0.33, 0.33, 0.34, 0.34],

        // サスペンション高さ（decoder はメートル。既存デモ値は表示単位(mm)のため /1000 必須。
        //   表示側 updateTyreState が *1000、updateCar3D もライブ同様メートルを受ける）
        susp_height: tyreData.susp.map(function(v) { return v / 1000; }),

        // 路面法線
        road_plane_x: 0.02 * Math.sin(t * 0.05),
        road_plane_y: 0.999,
        road_plane_z: 0.02 * Math.cos(t * 0.05),
        road_plane_distance: 0.15 + 0.02 * Math.sin(t * 0.07),

        // 位置・速度ベクトル
        position_x: point.x,
        position_y: 0,
        position_z: point.z,
        velocity_x: dx / dNorm * speedMs,
        velocity_y: 0,
        velocity_z: dz / dNorm * speedMs,

        // 回転・角速度（angular_velocity_y = 実ヨーレート → STEER RESPONSE のライブ経路が読む）
        rotation_pitch: demoOrientation.pitch,
        rotation_yaw: demoOrientation.yaw,
        rotation_roll: demoOrientation.roll,
        angular_velocity_x: 0,
        angular_velocity_y: demoYaw,
        angular_velocity_z: 0,

        // 方角（0..1）・車体高さ
        orientation: ((demoOrientation.yaw / (2 * Math.PI)) % 1 + 1) % 1,
        body_height: 0.12 + 0.01 * Math.sin(t * 0.1),

        // 舵角（生の demoSteering ラジアン。3D モデル・舵角メーターがライブ経路で読む）
        wheel_rotation: demoSteering,

        // 車体加速度（sway = 横G は STEER RESPONSE と整合する demoLatG を使用）
        body_accel_sway: demoLatG,
        body_accel_heave: heaveMs2,
        body_accel_surge: surgeMs2,

        // 加減速 G（main.py 付加フィールド。加速度チャートが読む）
        accel_g: surgeMs2 > 0 ? surgeMs2 / 9.81 : 0,      // main.py 契約は G 単位
        accel_decel: surgeMs2 < 0 ? -surgeMs2 / 9.81 : 0,

        // 車種
        car_id: 1234,
        package_id: 42,

        // ラップ
        lap_count: lapNum,
        total_laps: 5,
        current_laptime: posInLap * stepMs,               // 0..3800
        last_laptime: lapNum > 1 ? lastLapMs : -1,
        best_laptime: lapNum > 2 ? lastLapMs : -1,

        // スタート順位
        pre_race_position: 3,
        num_cars_pre_race: 16,

        // ギア比・トランスミッション（transmission_max_speed は m/s、表示側で *3.6）
        gear_ratios: [3.2, 2.1, 1.6, 1.3, 1.1, 0.9],
        transmission_max_speed: 78,

        // フラグ
        flags: {
            car_on_track: true,
            in_gear: true,
            has_turbo: true,
            rev_limiter: demoInputs.rpm >= DEMO_MAX_RPM * 0.97,
            tcs_active: demoInputs.throttle > 80 && Math.abs(demoLatG) > 8,
            asm_active: false,
            hand_brake: false,
            lights: false
        }
    };

    // ライブと同一の単一入口。UI/解析/DRIVE/3D/チャート/STEER RESPONSE 全系統が
    // ライブ受信時と同じ経路・同じ変換で更新される。
    handleTelemetryMessage(data, performance.now());

    // STEER RESPONSE デモ上書き（意図的な直後の再呼出）:
    // デモ仕様は「舵角×6 の誇張弧」で軌跡を見せること。handleTelemetryMessage 内の
    // ライブ経路は生の wheel_rotation(±0.3rad 程度)で描くため弧が小さすぎる。
    // doMap スロットル(100ms) < TEST 間隔(200ms) なので内部呼出は毎フレーム発火し、
    // この上書きは常に有効（内部呼出→本呼出の順で後勝ち）。
    updateSteerResponse(demoSteerWheel, demoYaw, demoV, demoLatG);
}
