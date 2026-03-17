/**
 * GT7 Telemetry Dashboard
 * テストモード（PS5なしでのデモデータ表示）
 *
 * @module test-mode
 * @depends constants.js (TEST_MODE_CONFIG)
 * @depends ui_components.js (elements, courseMapState, debugLog, updateSteeringGauge)
 * @depends websocket.js (packetCount)
 * @depends course-map.js (updateCourseMap, drawCourseMap)
 * @depends car-3d.js (updateCar3D, initCar3D, car3DState)
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
    resetCourseMap();
}

/**
 * テストモード時のUI状態を設定
 * @param {boolean} active - 有効状態
 */
function setTestModeUiState(active) {
    if (active) {
        elements.connectionStatus.textContent = TEST_MODE_CONFIG.status.text;
        elements.connectionStatus.style.background = TEST_MODE_CONFIG.status.background;
        elements.connectionStatus.style.color = TEST_MODE_CONFIG.status.color;
        return;
    }

    // 接続状態に応じた表示に戻す
    if (wsState.ws && wsState.ws.readyState === WebSocket.OPEN) {
        elements.connectionStatus.textContent = 'Connected';
        elements.connectionStatus.className = 'connected';
    } else {
        elements.connectionStatus.textContent = 'Disconnected';
        elements.connectionStatus.className = 'disconnected';
    }
    elements.connectionStatus.style.background = '';
    elements.connectionStatus.style.color = '';
}

/**
 * コースマップをリセット
 */
function resetCourseMap() {
    testTrajectoryIndex = 0;
    courseMapState.trajectory = [];
    courseMapState.currentPosition = { x: 0, y: 0, z: 0 };
    drawCourseMap();
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
 * デモフレームをレンダリング
 * @param {Object} point - 軌跡ポイント
 * @param {Object} demoInputs - デモ入力データ
 */
function renderDemoFrame(point, demoInputs) {
    const t = testTrajectoryIndex;
    
    // 速度・ギア・RPM表示
    elements.speed.textContent = Math.round(point.speed);
    const gearEl = elements.gear;
    gearEl.textContent = demoInputs.gear;
    gearEl.classList.remove('reverse', 'low');
    if (demoInputs.gear <= 2) gearEl.classList.add('low');
    
    const rpmPct = (demoInputs.rpm / 9000 * 100);
    elements.rpmBar.style.width = rpmPct + '%';
    elements.rpmText.textContent = Math.round(demoInputs.rpm) + ' RPM';
    
    // シフトライト更新
    if (typeof updateShiftLights === 'function') {
        updateShiftLights(demoInputs.rpm, 9000);
    }

    // ペダル表示（トップバー）
    elements.throttleBar.style.width = demoInputs.throttle + '%';
    elements.throttleValue.textContent = Math.round(demoInputs.throttle) + '%';
    elements.brakeBar.style.width = demoInputs.brake + '%';
    elements.brakeValue.textContent = Math.round(demoInputs.brake) + '%';
    
    // ペダル表示（左パネル詳細）
    if (elements.throttleBarDetail) {
        elements.throttleBarDetail.style.width = demoInputs.throttle + '%';
    }
    if (elements.throttleValueDetail) {
        elements.throttleValueDetail.textContent = Math.round(demoInputs.throttle) + '%';
    }
    if (elements.brakeBarDetail) {
        elements.brakeBarDetail.style.width = demoInputs.brake + '%';
    }
    if (elements.brakeValueDetail) {
        elements.brakeValueDetail.textContent = Math.round(demoInputs.brake) + '%';
    }
    elements.clutchBar.style.width = demoInputs.clutch + '%';
    elements.clutchValue.textContent = Math.round(demoInputs.clutch) + '%';
    
    // ペダルトレース更新
    if (typeof updatePedalTrace === 'function') {
        updatePedalTrace(demoInputs.throttle, demoInputs.brake);
    }
    
    // エンジンデータ
    elements.boost.textContent = Math.round(demoInputs.boost * 100);
    elements.oilPressure.textContent = demoInputs.oilPressure.toFixed(1);

    // 位置表示
    elements.posX.textContent = point.x.toFixed(1);
    elements.posY.textContent = '0.0';
    elements.posZ.textContent = point.z.toFixed(1);

    // タイヤデータ
    const tyreData = getDemoTyreData();
    if (elements.flTemp) elements.flTemp.textContent = Math.round(tyreData.temps[0]);
    if (elements.frTemp) elements.frTemp.textContent = Math.round(tyreData.temps[1]);
    if (elements.rlTemp) elements.rlTemp.textContent = Math.round(tyreData.temps[2]);
    if (elements.rrTemp) elements.rrTemp.textContent = Math.round(tyreData.temps[3]);
    
    // タイヤ温度バー更新
    if (typeof updateTyreTempBar === 'function') {
        updateTyreTempBar('fl', tyreData.temps[0]);
        updateTyreTempBar('fr', tyreData.temps[1]);
        updateTyreTempBar('rl', tyreData.temps[2]);
        updateTyreTempBar('rr', tyreData.temps[3]);
    }
    
    // サスペンション
    if (elements.flSusp) elements.flSusp.textContent = Math.round(tyreData.susp[0]);
    if (elements.frSusp) elements.frSusp.textContent = Math.round(tyreData.susp[1]);
    if (elements.rlSusp) elements.rlSusp.textContent = Math.round(tyreData.susp[2]);
    if (elements.rrSusp) elements.rrSusp.textContent = Math.round(tyreData.susp[3]);
    
    // 燃料データ
    const fuelData = getDemoFuelData();
    elements.fuel.textContent = fuelData.current.toFixed(1);
    elements.fuelCapacity.textContent = fuelData.capacity;
    elements.fuelPerLap.textContent = fuelData.perLap.toFixed(2);
    elements.fuelLapsRemaining.textContent = fuelData.lapsRemaining;
    
    // 燃料バー更新
    const fuelBar = document.getElementById('fuel-bar');
    if (fuelBar) {
        const pct = (fuelData.current / fuelData.capacity) * 100;
        fuelBar.style.width = pct + '%';
        fuelBar.classList.remove('low', 'warning');
        if (pct < 15) fuelBar.classList.add('low');
        else if (pct < 30) fuelBar.classList.add('warning');
    }
    
    // G-Forceデータ
    const gforceData = getDemoGForceData();
    if (elements.bodySway) elements.bodySway.textContent = gforceData.sway.toFixed(3);
    if (elements.bodyHeave) elements.bodyHeave.textContent = gforceData.heave.toFixed(3);
    if (elements.bodySurge) elements.bodySurge.textContent = gforceData.surge.toFixed(3);
    
    // G-Forceメーター更新
    if (typeof updateGForceMeter === 'function') {
        updateGForceMeter(gforceData.sway, gforceData.surge);
    }
    
    // セクターデータ（デモ）
    if (elements.sector1) {
        const s1 = 20 + Math.sin(t * 0.02) * 2 + Math.random() * 0.5;
        elements.sector1.textContent = s1.toFixed(3);
        elements.sector1.className = 'sector-value ' + getSectorClass(s1, 20);
    }
    if (elements.sector2) {
        const s2 = 25 + Math.cos(t * 0.02) * 3 + Math.random() * 0.5;
        elements.sector2.textContent = s2.toFixed(3);
        elements.sector2.className = 'sector-value ' + getSectorClass(s2, 25);
    }
    if (elements.sector3) {
        const s3 = 18 + Math.sin(t * 0.03) * 2 + Math.random() * 0.5;
        elements.sector3.textContent = s3.toFixed(3);
        elements.sector3.className = 'sector-value ' + getSectorClass(s3, 18);
    }

    // 3Dモデル更新
    const demoOrientation = getDemoOrientation();
    const demoSteering = getDemoSteering();
    updateCar3D(
        demoOrientation.pitch,
        demoOrientation.yaw,
        demoOrientation.roll,
        demoInputs.rpm,
        demoSteering
    );

    // 舵角メーター更新
    updateSteeringGauge(demoSteering);

    // コースマップ更新（heading付き）
    updateCourseMap(point.x, 0, point.z, point.speed, demoOrientation.yaw);
}

/**
 * セクタータイムの色を決定（テストモード用）
 */
function getSectorClass(current, best) {
    const diff = current - best;
    if (diff < 0) return 'purple';
    if (diff < 0.3) return 'green';
    if (diff < 0.6) return 'yellow';
    return 'red';
}
