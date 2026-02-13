/**
 * GT7 Telemetry Dashboard
 * 3D車両モデル・姿勢ビジュアライゼーション
 *
 * 依存: Three.js (CDN)
 *       ui_components.js (debugLog)
 */

var car3DState = {
    scene: null,
    camera: null,
    renderer: null,
    carGroup: null,
    carBody: null,
    windows: [],
    wheels: [],
    initialized: false,
    animationId: null,
    pitch: 0,
    yaw: 0,
    roll: 0,
    topViewContext: null,
    topViewCanvas: null
};

var CAR_3D_CONFIG = {
    bodyWidth: 1.8,
    bodyLength: 4.2,
    bodyHeight: 1.2,
    wheelRadius: 0.35,
    wheelWidth: 0.25,
    colors: {
        body: 0x00ff88,
        windows: 0x444444,
        wheels: 0x333333,
        grid: 0x1a1a2e,
        gridLines: 0x2a2a3e
    }
};

function initCar3D() {
    if (car3DState.initialized) return;

    var container = document.getElementById('car-3d-view');
    if (!container) {
        console.error('[CAR_3D] Container element not found');
        return;
    }

    var width = container.clientWidth;
    var height = container.clientHeight;

    if (width === 0 || height === 0) {
        width = 400;
        height = 200;
    }

    // シーン
    car3DState.scene = new THREE.Scene();
    car3DState.scene.background = new THREE.Color(CAR_3D_CONFIG.colors.grid);

    // レンダラー
    car3DState.renderer = new THREE.WebGLRenderer({ antialias: true });
    car3DState.renderer.setSize(width, height);
    car3DState.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(car3DState.renderer.domElement);

    // カメラ - サイドビュー（横長表示）
    car3DState.camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
    car3DState.camera.position.set(6, 1.5, 0);
    car3DState.camera.lookAt(0, 0, 0);

    // 環境光
    var ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    car3DState.scene.add(ambientLight);

    // 平行光
    var directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 10, 5);
    car3DState.scene.add(directionalLight);

    // グリッド
    var gridHelper = new THREE.GridHelper(20, 20, CAR_3D_CONFIG.colors.gridLines, CAR_3D_CONFIG.colors.grid);
    car3DState.scene.add(gridHelper);

    // 車両モデル
    car3DState.carGroup = new THREE.Group();

    // ボディ
    var bodyGeometry = new THREE.BoxGeometry(
        CAR_3D_CONFIG.bodyLength,
        CAR_3D_CONFIG.bodyHeight,
        CAR_3D_CONFIG.bodyWidth
    );
    var bodyMaterial = new THREE.MeshPhongMaterial({
        color: CAR_3D_CONFIG.colors.body,
        shininess: 100
    });
    car3DState.carBody = new THREE.Mesh(bodyGeometry, bodyMaterial);
    car3DState.carBody.position.y = CAR_3D_CONFIG.wheelRadius + CAR_3D_CONFIG.bodyHeight / 2;
    car3DState.carGroup.add(car3DState.carBody);

    // ウィンドウ（キャビン上部）
    var windowGeometry = new THREE.BoxGeometry(
        CAR_3D_CONFIG.bodyLength * 0.4,
        CAR_3D_CONFIG.bodyHeight * 0.5,
        CAR_3D_CONFIG.bodyWidth * 0.95
    );
    var windowMaterial = new THREE.MeshPhongMaterial({
        color: CAR_3D_CONFIG.colors.windows,
        transparent: true,
        opacity: 0.6,
        shininess: 100
    });
    var windowMesh = new THREE.Mesh(windowGeometry, windowMaterial);
    windowMesh.position.set(-0.3, CAR_3D_CONFIG.wheelRadius + CAR_3D_CONFIG.bodyHeight + CAR_3D_CONFIG.bodyHeight * 0.25, 0);
    car3DState.windows.push(windowMesh);
    car3DState.carGroup.add(windowMesh);

    // タイヤ
    var halfLength = CAR_3D_CONFIG.bodyLength / 2 - 0.4;
    var halfWidth = CAR_3D_CONFIG.bodyWidth / 2 + CAR_3D_CONFIG.wheelWidth / 2;
    var wheelY = CAR_3D_CONFIG.wheelRadius;

    var wheelPositions = [
        { x:  halfLength, y: wheelY, z:  halfWidth },  // FR
        { x:  halfLength, y: wheelY, z: -halfWidth },  // FL
        { x: -halfLength, y: wheelY, z:  halfWidth },  // RR
        { x: -halfLength, y: wheelY, z: -halfWidth }   // RL
    ];

    var wheelGeometry = new THREE.CylinderGeometry(
        CAR_3D_CONFIG.wheelRadius,
        CAR_3D_CONFIG.wheelRadius,
        CAR_3D_CONFIG.wheelWidth,
        32
    );
    var wheelMaterial = new THREE.MeshPhongMaterial({
        color: CAR_3D_CONFIG.colors.wheels
    });

    wheelPositions.forEach(function(pos) {
        var wheel = new THREE.Mesh(wheelGeometry, wheelMaterial);
        wheel.position.set(pos.x, pos.y, pos.z);
        wheel.rotation.x = Math.PI / 2;
        car3DState.wheels.push(wheel);
        car3DState.carGroup.add(wheel);
    });

    // ヘッドライト
    var lightGeo = new THREE.BoxGeometry(0.05, 0.15, 0.3);
    var lightMat = new THREE.MeshPhongMaterial({ color: 0xffff00, emissive: 0xaaaa00 });
    var lightL = new THREE.Mesh(lightGeo, lightMat);
    lightL.position.set(CAR_3D_CONFIG.bodyLength / 2, CAR_3D_CONFIG.wheelRadius + CAR_3D_CONFIG.bodyHeight * 0.5, 0.5);
    car3DState.carGroup.add(lightL);
    var lightR = new THREE.Mesh(lightGeo, lightMat);
    lightR.position.set(CAR_3D_CONFIG.bodyLength / 2, CAR_3D_CONFIG.wheelRadius + CAR_3D_CONFIG.bodyHeight * 0.5, -0.5);
    car3DState.carGroup.add(lightR);

    // 車両グループをシーンに追加
    car3DState.scene.add(car3DState.carGroup);

    // リサイズ監視
    var resizeObserver = new ResizeObserver(function() {
        if (container && car3DState.renderer && car3DState.camera) {
            var w = container.clientWidth;
            var h = container.clientHeight;
            if (w > 0 && h > 0) {
                car3DState.camera.aspect = w / h;
                car3DState.camera.updateProjectionMatrix();
                car3DState.renderer.setSize(w, h);
            }
        }
    });
    resizeObserver.observe(container);

    car3DState.initialized = true;

    // レンダーループ開始
    function animate() {
        car3DState.animationId = requestAnimationFrame(animate);
        if (car3DState.renderer && car3DState.scene && car3DState.camera) {
            car3DState.renderer.render(car3DState.scene, car3DState.camera);
        }
    }
    animate();

    debugLog('CAR_3D', 'Initialized 3D car model');
}

function updateCar3D(pitch, yaw, roll) {
    if (!car3DState.initialized || !car3DState.carGroup) return;

    car3DState.pitch = pitch || 0;
    car3DState.yaw = yaw || 0;
    car3DState.roll = roll || 0;

    // carGroup全体を回転
    car3DState.carGroup.rotation.x = car3DState.pitch;
    car3DState.carGroup.rotation.y = car3DState.yaw;
    car3DState.carGroup.rotation.z = car3DState.roll;

    // CAR ATTITUDEカード内の数値表示を更新
    var pitchEl = document.getElementById('car-3d-pitch');
    var rollEl = document.getElementById('car-3d-roll');
    var yawEl = document.getElementById('car-3d-yaw');
    if (pitchEl) pitchEl.textContent = (pitch * 180 / Math.PI).toFixed(2) + '\u00B0';
    if (rollEl) rollEl.textContent = (roll * 180 / Math.PI).toFixed(2) + '\u00B0';
    if (yawEl) yawEl.textContent = (yaw * 180 / Math.PI).toFixed(2) + '\u00B0';
}
