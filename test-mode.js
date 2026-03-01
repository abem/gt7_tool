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
        packetCount++;
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
    if (ws && ws.readyState === WebSocket.OPEN) {
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
    return {
        rpm: 3000 + Math.random() * 4000,
        gear: Math.floor(Math.random() * 6) + 1,
        throttle: Math.random() * 100,
        brake: Math.random() * 30
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
    // 速度・ギア・RPM表示
    elements.speed.textContent = Math.round(point.speed);
    elements.gear.textContent = demoInputs.gear;
    elements.rpmBar.style.width = (demoInputs.rpm / 9000 * 100) + '%';
    elements.rpmText.textContent = Math.round(demoInputs.rpm) + ' RPM';

    // ペダル表示
    elements.throttleBar.style.width = demoInputs.throttle + '%';
    elements.throttleValue.textContent = Math.round(demoInputs.throttle) + '%';
    elements.brakeBar.style.width = demoInputs.brake + '%';
    elements.brakeValue.textContent = Math.round(demoInputs.brake) + '%';

    // 位置表示
    elements.posX.textContent = point.x.toFixed(1);
    elements.posY.textContent = '0.0';
    elements.posZ.textContent = point.z.toFixed(1);

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

    // コースマップ更新
    updateCourseMap(point.x, 0, point.z, point.speed);
}
