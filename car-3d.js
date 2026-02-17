/**
 * GT7 Telemetry Dashboard
 * 3D車両モデル・姿勢ビジュアライゼーション
 * ミッドシップスポーツカー風デザイン
 *
 * 依存: Three.js (CDN r128)
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
    topViewCanvas: null,
    controls: null
};

var CAR_3D_CONFIG = {
    bodyWidth: 1.9,
    bodyLength: 4.3,
    bodyHeight: 1.12,
    wheelRadius: 0.42,
    wheelWidth: 0.28,
    frontAxle: 1.15,
    rearAxle: -1.35,
    groundClearance: 0.12,
    colors: {
        body: 0xcc0000,
        windows: 0x88ccff,
        tire: 0x1a1a1a,
        rim: 0xcccccc,
        hubCap: 0xddaa00,
        headlight: 0xffffee,
        taillight: 0xcc0000,
        intake: 0x080808,
        exhaust: 0x999999,
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

    // カメラ - フロント3/4ビュー（姿勢変化が見やすい角度）
    car3DState.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    car3DState.camera.position.set(5, 2.2, 3);
    car3DState.camera.lookAt(0, 0.4, 0);

    // OrbitControls初期化（失敗時はカメラ固定で動作継続）
    try {
        car3DState.controls = new THREE.OrbitControls(
            car3DState.camera,
            car3DState.renderer.domElement
        );
        car3DState.controls.enableDamping = true;
        car3DState.controls.dampingFactor = 0.05;
        car3DState.controls.target.set(0, 0.4, 0);
        car3DState.controls.update();
    } catch (e) {
        console.warn('[CAR_3D] OrbitControls initialization failed:', e);
        car3DState.controls = null;
    }

    // 環境光
    var ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    car3DState.scene.add(ambientLight);

    // メイン平行光源
    var directionalLight = new THREE.DirectionalLight(0xffffff, 0.9);
    directionalLight.position.set(5, 8, 4);
    car3DState.scene.add(directionalLight);

    // フィルライト（反対側から柔らかく）
    var fillLight = new THREE.DirectionalLight(0x8888ff, 0.25);
    fillLight.position.set(-3, 1, -2);
    car3DState.scene.add(fillLight);

    // グリッド
    var gridHelper = new THREE.GridHelper(20, 20, CAR_3D_CONFIG.colors.gridLines, CAR_3D_CONFIG.colors.grid);
    car3DState.scene.add(gridHelper);

    // 車両モデル構築
    car3DState.carGroup = new THREE.Group();
    buildCarModel(car3DState.carGroup);
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
        if (car3DState.controls) {
            car3DState.controls.update();
        }
        if (car3DState.renderer && car3DState.scene && car3DState.camera) {
            car3DState.renderer.render(car3DState.scene, car3DState.camera);
        }
    }
    animate();

    debugLog('CAR_3D', 'Initialized 3D car model');
}

/* ================================================================
 *  車両モデル構築
 * ================================================================ */
function buildCarModel(carGroup) {
    var L = CAR_3D_CONFIG.bodyLength;    // 4.3
    var W = CAR_3D_CONFIG.bodyWidth;     // 1.9
    var H = CAR_3D_CONFIG.bodyHeight;    // 1.12
    var wR = CAR_3D_CONFIG.wheelRadius;  // 0.42
    var gc = CAR_3D_CONFIG.groundClearance; // 0.12
    var HL = L / 2;                      // 2.15
    var bodyW = W * 0.92;               // ボディ押し出し幅

    // ─── メインボディ（サイドプロファイル → 押し出し）───
    var bodyShape = new THREE.Shape();

    // 後方底部スタート（時計回り）
    bodyShape.moveTo(-HL, gc);
    // 底部ライン
    bodyShape.lineTo(HL - 0.30, gc);
    // フロントバンパー（丸みを帯びて上昇）
    bodyShape.quadraticCurveTo(HL - 0.05, gc, HL, gc + 0.16);
    // フロントフェイス（低いノーズ）
    bodyShape.lineTo(HL, 0.42);
    // フード前半（緩やかに上昇）
    bodyShape.quadraticCurveTo(HL - 0.20, 0.46, 1.50, 0.55);
    // フード後半（ウインドシールドへ）
    bodyShape.quadraticCurveTo(1.00, 0.63, 0.50, 0.72);
    // ウインドシールド（深いレーキ角）
    bodyShape.lineTo(-0.15, H - 0.04);
    // ルーフ前端（カーブ）
    bodyShape.quadraticCurveTo(-0.35, H, -0.55, H);
    // ルーフ
    bodyShape.lineTo(-0.85, H - 0.02);
    // リアウインドウ（急傾斜）
    bodyShape.quadraticCurveTo(-1.05, 0.93, -1.25, 0.82);
    // エンジンカバー（ミッドエンジン配置）
    bodyShape.lineTo(-1.80, 0.78);
    // リアリップ
    bodyShape.lineTo(-HL + 0.05, 0.76);
    bodyShape.lineTo(-HL, 0.68);
    // リアフェイス → クローズ
    bodyShape.lineTo(-HL, gc);

    var bodyGeo = new THREE.ExtrudeGeometry(bodyShape, {
        depth: bodyW,
        bevelEnabled: true,
        bevelThickness: 0.05,
        bevelSize: 0.04,
        bevelSegments: 3
    });
    bodyGeo.translate(0, 0, -bodyW / 2);

    var bodyMat = new THREE.MeshPhongMaterial({
        color: CAR_3D_CONFIG.colors.body,
        shininess: 140,
        specular: new THREE.Color(0x666666)
    });

    car3DState.carBody = new THREE.Mesh(bodyGeo, bodyMat);
    carGroup.add(car3DState.carBody);

    // ─── ウインドウ（ガラス面を水色で描画）───
    // ボディと同幅で押し出し、polygonOffsetで手前に描画させる
    var winShape = new THREE.Shape();
    winShape.moveTo(0.47, 0.73);
    winShape.lineTo(-0.15, H - 0.05);
    winShape.quadraticCurveTo(-0.35, H - 0.01, -0.55, H - 0.01);
    winShape.lineTo(-0.85, H - 0.03);
    winShape.quadraticCurveTo(-1.03, 0.94, -1.22, 0.83);
    winShape.lineTo(0.47, 0.73);

    var winGeo = new THREE.ExtrudeGeometry(winShape, {
        depth: bodyW,
        bevelEnabled: false
    });
    winGeo.translate(0, 0, -bodyW / 2);

    var winMat = new THREE.MeshPhongMaterial({
        color: CAR_3D_CONFIG.colors.windows,
        transparent: true,
        opacity: 0.88,
        shininess: 200,
        specular: new THREE.Color(0xaaaaaa),
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4
    });

    var windowMesh = new THREE.Mesh(winGeo, winMat);
    windowMesh.renderOrder = 1;
    car3DState.windows.push(windowMesh);
    carGroup.add(windowMesh);

    // ─── サイドエアインテーク（横長スリット）───
    var intakeMat = new THREE.MeshPhongMaterial({ color: CAR_3D_CONFIG.colors.intake });
    var intakeGeo = new THREE.BoxGeometry(0.50, 0.16, 0.03);
    [-1, 1].forEach(function(side) {
        var intake = new THREE.Mesh(intakeGeo, intakeMat);
        intake.position.set(-0.55, 0.48, side * (bodyW / 2 + 0.05));
        carGroup.add(intake);
    });

    // ─── フロントスプリッター ───
    var splitterGeo = new THREE.BoxGeometry(0.18, 0.025, W * 1.02);
    var darkMat = new THREE.MeshPhongMaterial({ color: 0x111111 });
    var splitter = new THREE.Mesh(splitterGeo, darkMat);
    splitter.position.set(HL - 0.05, gc - 0.01, 0);
    carGroup.add(splitter);

    // ─── サイドスカート ───
    var skirtGeo = new THREE.BoxGeometry(2.2, 0.035, 0.025);
    [-1, 1].forEach(function(side) {
        var skirt = new THREE.Mesh(skirtGeo, darkMat);
        skirt.position.set(-0.10, gc + 0.02, side * W / 2);
        carGroup.add(skirt);
    });

    // ─── ホイール ───
    buildWheels(carGroup);

    // ─── ヘッドライト（丸型ポップアップ風）───
    var hlMat = new THREE.MeshPhongMaterial({
        color: CAR_3D_CONFIG.colors.headlight,
        emissive: 0x888866,
        transparent: true,
        opacity: 0.9
    });
    var hlGeo = new THREE.CircleGeometry(0.10, 16);
    [-0.52, 0.52].forEach(function(z) {
        var hl = new THREE.Mesh(hlGeo, hlMat);
        hl.position.set(HL + 0.055, 0.38, z);
        hl.rotation.y = Math.PI / 2;
        carGroup.add(hl);
    });

    // ─── テールライト（丸型4灯）───
    var tlMat = new THREE.MeshPhongMaterial({
        color: CAR_3D_CONFIG.colors.taillight,
        emissive: 0x880000
    });
    var tlGeo = new THREE.CircleGeometry(0.08, 16);
    [-0.42, -0.24, 0.24, 0.42].forEach(function(z) {
        var tl = new THREE.Mesh(tlGeo, tlMat);
        tl.position.set(-HL - 0.005, 0.54, z);
        tl.rotation.y = -Math.PI / 2;
        carGroup.add(tl);
    });

    // ─── フロントグリル / インテーク ───
    var grillGeo = new THREE.BoxGeometry(0.02, 0.13, 0.65);
    var grill = new THREE.Mesh(grillGeo, intakeMat);
    grill.position.set(HL + 0.01, 0.22, 0);
    carGroup.add(grill);

    // ─── リアディフューザー ───
    var diffGeo = new THREE.BoxGeometry(0.02, 0.10, 0.75);
    var diff = new THREE.Mesh(diffGeo, intakeMat);
    diff.position.set(-HL - 0.01, 0.20, 0);
    carGroup.add(diff);

    // ─── エキゾースト（クアッド出し）───
    var exhMat = new THREE.MeshPhongMaterial({
        color: CAR_3D_CONFIG.colors.exhaust,
        shininess: 120
    });
    var exhGeo = new THREE.CylinderGeometry(0.032, 0.036, 0.12, 12);
    [-0.26, -0.15, 0.15, 0.26].forEach(function(z) {
        var exh = new THREE.Mesh(exhGeo, exhMat);
        exh.position.set(-HL - 0.06, 0.19, z);
        exh.rotation.z = Math.PI / 2;
        carGroup.add(exh);
    });

    // ─── エンジンカバーのルーバー（ミッドエンジンの吸気口）───
    var louverMat = new THREE.MeshPhongMaterial({ color: 0x111111 });
    var louverGeo = new THREE.BoxGeometry(0.30, 0.008, bodyW * 0.55);
    for (var i = 0; i < 4; i++) {
        var louver = new THREE.Mesh(louverGeo, louverMat);
        louver.position.set(-1.40 - i * 0.10, 0.79, 0);
        louver.rotation.z = 0.05;
        carGroup.add(louver);
    }

    // ─── リアウイング ───
    // ウイング支柱
    var stayGeo = new THREE.BoxGeometry(0.03, 0.22, 0.03);
    var stayMat = new THREE.MeshPhongMaterial({ color: 0x222222 });
    [-0.55, 0.55].forEach(function(z) {
        var stay = new THREE.Mesh(stayGeo, stayMat);
        stay.position.set(-HL + 0.15, 0.88, z);
        carGroup.add(stay);
    });
    // ウイング翼面
    var wingShape = new THREE.Shape();
    wingShape.moveTo(0, 0);
    wingShape.lineTo(0.22, -0.01);
    wingShape.lineTo(0.20, 0.03);
    wingShape.lineTo(0, 0.025);
    wingShape.lineTo(0, 0);

    var wingGeo = new THREE.ExtrudeGeometry(wingShape, {
        depth: 1.25,
        bevelEnabled: true,
        bevelThickness: 0.005,
        bevelSize: 0.005,
        bevelSegments: 1
    });
    wingGeo.translate(0, 0, -1.25 / 2);

    var wingMat = new THREE.MeshPhongMaterial({
        color: CAR_3D_CONFIG.colors.body,
        shininess: 120,
        specular: new THREE.Color(0x444444)
    });
    var wing = new THREE.Mesh(wingGeo, wingMat);
    wing.position.set(-HL + 0.08, 0.97, 0);
    carGroup.add(wing);
}

/* ================================================================
 *  ホイール構築（大径タイヤ + 5スポーク風リム）
 * ================================================================ */
function buildWheels(carGroup) {
    var wR = CAR_3D_CONFIG.wheelRadius;
    var wW = CAR_3D_CONFIG.wheelWidth;
    var W = CAR_3D_CONFIG.bodyWidth;

    var halfWidth = W / 2 + wW * 0.05;

    var positions = [
        { x: CAR_3D_CONFIG.frontAxle,  y: wR, z:  halfWidth, s:  1 },
        { x: CAR_3D_CONFIG.frontAxle,  y: wR, z: -halfWidth, s: -1 },
        { x: CAR_3D_CONFIG.rearAxle,   y: wR, z:  halfWidth, s:  1 },
        { x: CAR_3D_CONFIG.rearAxle,   y: wR, z: -halfWidth, s: -1 }
    ];

    var tireGeo = new THREE.CylinderGeometry(wR, wR, wW, 32);
    var tireMat = new THREE.MeshPhongMaterial({ color: CAR_3D_CONFIG.colors.tire });

    // タイヤサイドウォール表現（トーラス）
    var swTubeR = 0.04;
    var swTorusR = wR - swTubeR;
    var sidewallGeo = new THREE.TorusGeometry(swTorusR, swTubeR, 8, 32);
    var sidewallMat = new THREE.MeshPhongMaterial({ color: 0x222222 });

    // リムフェイス（5角形 = 5スポーク風）
    var rimR = wR * 0.70;
    var rimGeo = new THREE.CircleGeometry(rimR, 5);
    var rimMat = new THREE.MeshPhongMaterial({
        color: CAR_3D_CONFIG.colors.rim,
        shininess: 150,
        specular: new THREE.Color(0x666666)
    });

    // リムバレル（リム外周の銀リング）
    var rimBarrelGeo = new THREE.TorusGeometry(rimR, 0.018, 8, 32);

    // ハブキャップ（イエロー）
    var hubGeo = new THREE.CircleGeometry(wR * 0.14, 16);
    var hubMat = new THREE.MeshPhongMaterial({
        color: CAR_3D_CONFIG.colors.hubCap,
        shininess: 100
    });

    // ブレーキディスク（リム内側に見える銀ディスク）
    var brakeGeo = new THREE.CircleGeometry(rimR * 0.75, 24);
    var brakeMat = new THREE.MeshPhongMaterial({
        color: 0x888888,
        shininess: 80
    });

    positions.forEach(function(pos) {
        var wheelGroup = new THREE.Group();

        // タイヤ本体
        var tire = new THREE.Mesh(tireGeo, tireMat);
        tire.rotation.x = Math.PI / 2;
        wheelGroup.add(tire);

        // サイドウォール（外側）
        var sw = new THREE.Mesh(sidewallGeo, sidewallMat);
        sw.position.z = (wW / 2 - swTubeR * 0.5) * pos.s;
        wheelGroup.add(sw);

        // ブレーキディスク（外側、リムの奥に見える）
        var brake = new THREE.Mesh(brakeGeo, brakeMat);
        brake.position.z = (wW / 2 - 0.02) * pos.s;
        if (pos.s < 0) brake.rotation.y = Math.PI;
        wheelGroup.add(brake);

        // リムフェイス（外側）
        var rimFace = new THREE.Mesh(rimGeo, rimMat);
        rimFace.position.z = (wW / 2 + 0.003) * pos.s;
        if (pos.s < 0) rimFace.rotation.y = Math.PI;
        wheelGroup.add(rimFace);

        // リムバレル（外周リング）
        var rimBarrel = new THREE.Mesh(rimBarrelGeo, rimMat);
        rimBarrel.position.z = (wW / 2 + 0.003) * pos.s;
        wheelGroup.add(rimBarrel);

        // ハブキャップ
        var hub = new THREE.Mesh(hubGeo, hubMat);
        hub.position.z = (wW / 2 + 0.006) * pos.s;
        if (pos.s < 0) hub.rotation.y = Math.PI;
        wheelGroup.add(hub);

        wheelGroup.position.set(pos.x, pos.y, pos.z);
        car3DState.wheels.push(wheelGroup);
        carGroup.add(wheelGroup);
    });
}

/* ================================================================
 *  姿勢更新（pitch / yaw / roll）
 * ================================================================ */
function updateCar3D(pitch, yaw, roll) {
    if (!car3DState.initialized || !car3DState.carGroup) return;

    car3DState.pitch = pitch || 0;
    car3DState.yaw = yaw || 0;
    car3DState.roll = roll || 0;

    // carGroup全体を回転（yawは無視して常に0）
    car3DState.carGroup.rotation.x = car3DState.pitch;
    car3DState.carGroup.rotation.y = 0;
    car3DState.carGroup.rotation.z = car3DState.roll;

    // CAR ATTITUDEカード内の数値表示を更新
    var pitchEl = document.getElementById('car-3d-pitch');
    var rollEl = document.getElementById('car-3d-roll');
    var yawEl = document.getElementById('car-3d-yaw');
    if (pitchEl) pitchEl.textContent = (pitch * 180 / Math.PI).toFixed(2) + '\u00B0';
    if (rollEl) rollEl.textContent = (roll * 180 / Math.PI).toFixed(2) + '\u00B0';
    if (yawEl) yawEl.textContent = (yaw * 180 / Math.PI).toFixed(2) + '\u00B0';
}
