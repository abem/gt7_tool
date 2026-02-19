/**
 * GT7 Telemetry Dashboard
 * テストモード（PS5なしでのデモデータ表示）
 *
 * 依存: ui_components.js (elements, courseMapState, debugLog)
 *       websocket.js (packetCount)
 *       course-map.js (updateCourseMap, drawCourseMap)
 *       car-3d.js (updateCar3D, initCar3D)
 */

var testModeActive = false;
var testModeInterval = null;
var testTrajectoryIndex = 0;

var demoTrajectory = [
    {x: 0, z: -300, speed: 80},   {x: 50, z: -280, speed: 120},
    {x: 100, z: -240, speed: 160}, {x: 150, z: -180, speed: 200},
    {x: 200, z: -100, speed: 220}, {x: 240, z: -20, speed: 200},
    {x: 260, z: 60, speed: 180},   {x: 250, z: 140, speed: 150},
    {x: 220, z: 200, speed: 120},  {x: 170, z: 230, speed: 100},
    {x: 110, z: 240, speed: 90},   {x: 50, z: 230, speed: 100},
    {x: -20, z: 200, speed: 130},  {x: -80, z: 150, speed: 170},
    {x: -120, z: 80, speed: 200},  {x: -140, z: 0, speed: 190},
    {x: -130, z: -80, speed: 160}, {x: -90, z: -150, speed: 130},
    {x: -40, z: -220, speed: 110}, {x: 0, z: -280, speed: 90}
];

function initTestMode() {
    var btn = document.getElementById('test-mode-btn');
    if (!btn) return;

    btn.addEventListener('click', function() {
        testModeActive = !testModeActive;
        btn.classList.toggle('active', testModeActive);
        btn.textContent = testModeActive ? 'STOP TEST' : 'TEST MODE';

        if (testModeActive) {
            // テストモード開始時に3Dモデルを初期化（まだ初期化されていない場合）
            if (!car3DState.initialized) {
                initCar3D();
            }
            startTestMode(btn);
        } else {
            stopTestMode();
        }
    });
}

function startTestMode(btn) {
    debugLog('TEST', 'Test mode enabled');
    testTrajectoryIndex = 0;

    elements.connectionStatus.textContent = 'TEST MODE';
    elements.connectionStatus.style.background = 'var(--accent-yellow)';
    elements.connectionStatus.style.color = '#000';

    testModeInterval = setInterval(function() {
        if (!testModeActive) {
            clearInterval(testModeInterval);
            return;
        }

        var point = demoTrajectory[testTrajectoryIndex % demoTrajectory.length];
        testTrajectoryIndex++;

        var demoRpm = 3000 + Math.random() * 4000;
        var demoGear = Math.floor(Math.random() * 6) + 1;
        var demoThrottle = Math.random() * 100;
        var demoBrake = Math.random() * 30;

        elements.speed.textContent = Math.round(point.speed);
        elements.gear.textContent = demoGear;
        elements.rpmBar.style.width = (demoRpm / 9000 * 100) + '%';
        elements.rpmText.textContent = Math.round(demoRpm) + ' RPM';
        elements.throttleBar.style.width = demoThrottle + '%';
        elements.throttleValue.textContent = Math.round(demoThrottle) + '%';
        elements.brakeBar.style.width = demoBrake + '%';
        elements.brakeValue.textContent = Math.round(demoBrake) + '%';
        elements.posX.textContent = point.x.toFixed(1);
        elements.posY.textContent = '0.0';
        elements.posZ.textContent = point.z.toFixed(1);

        // 3Dモデル更新（テスト用のランダムな姿勢）
        var demoPitch = (Math.sin(testTrajectoryIndex * 0.1) * 0.3).toFixed(3);
        var demoYaw = (testTrajectoryIndex * 0.05).toFixed(3);
        var demoRoll = (Math.cos(testTrajectoryIndex * 0.08) * 0.2).toFixed(3);
        updateCar3D(parseFloat(demoPitch), parseFloat(demoYaw), parseFloat(demoRoll));

        updateCourseMap(point.x, 0, point.z, point.speed);

        packetCount++;
    }, 200);
}

function stopTestMode() {
    debugLog('TEST', 'Test mode disabled');
    clearInterval(testModeInterval);

    // ws が接続中なら Connected、そうでなければ Disconnected
    elements.connectionStatus.textContent = (ws && ws.readyState === WebSocket.OPEN) ? 'Connected' : 'Disconnected';
    elements.connectionStatus.className = (ws && ws.readyState === WebSocket.OPEN) ? 'connected' : 'disconnected';
    elements.connectionStatus.style.background = '';
    elements.connectionStatus.style.color = '';

    testTrajectoryIndex = 0;
    courseMapState.trajectory = [];
    courseMapState.currentPosition = { x: 0, y: 0, z: 0 };
    drawCourseMap();
}
