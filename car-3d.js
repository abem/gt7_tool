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
    controls: null,
    pitchEl: null,
    rollEl: null,
    yawEl: null,
    lastRenderTs: 0,
    renderInterval: 1000 / 30,
    needsRender: true,

    // 演出効果用状態
    targetPitch: 0,        // 増幅後の目標ピッチ
    targetRoll: 0,         // 増幅後の目標ロール
    displayPitch: 0,       // 現在の表示ピッチ
    displayRoll: 0,        // 現在の表示ロール
    pitchVelocity: 0,      // バウンス用ピッチ速度
    rollVelocity: 0,       // バウンス用ロール速度
    currentRpm: 0,         // 微振動用RPM
    lastUpdateTime: 0,     // Δt計算用

    // ステアリング用状態
    steeringAngle: 0,      // 現在のステアリング角（ラジアン）
    displaySteering: 0     // 表示用ステアリング角（補間済み）
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

/* ================================================================
 *  演出効果設定（増幅・バウンス・慣性・微振動）
 * ================================================================ */
var EXAGGERATION_CONFIG = {
    // 全体有効/無効
    enabled: true,

    // 増幅設定
    amplification: {
        pitch: 2.5,    // ピッチ増幅倍率
        roll: 2.0      // ロール増幅倍率
    },

    // バウンス（バネ）設定
    bounce: {
        enabled: true,
        stiffness: 150,   // バネ係数（大きいほど素早く追従）
        damping: 12       // 減衰係数（大きいほどオーバーシュート抑える）
    },

    // 慣性（遅延）設定
    inertia: {
        enabled: true,
        lerpFactor: 0.15  // 補間係数（0.01 ~ 1.0、小さいほど遅れる）
    },

    // 微振動設定
    vibration: {
        enabled: true,
        baseAmplitude: 0.003,     // 基本振動振幅
        rpmMultiplier: 0.000008,  // RPM連動係数
        frequency: 30             // 振動周波数（Hz）
    },

    // ステアリング（舵角）設定
    steering: {
        amplification: 1.5,       // 舵角増幅倍率（視覚的に分かりやすく）
        lerpFactor: 0.2           // 補間係数（滑らかに追従）
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
    car3DState.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
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
        car3DState.controls.addEventListener('change', function() {
            car3DState.needsRender = true;
        });
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
                car3DState.needsRender = true;
            }
        }
    });
    resizeObserver.observe(container);

    car3DState.initialized = true;
    car3DState.lastUpdateTime = performance.now();

    // DOM要素キャッシュ（updateCar3D で毎回 getElementById を呼ばないよう初期化時に保持）
    car3DState.pitchEl = document.getElementById('car-3d-pitch');
    car3DState.rollEl  = document.getElementById('car-3d-roll');
    car3DState.yawEl   = document.getElementById('car-3d-yaw');

    // レンダーループ開始
    function animate(now) {
        car3DState.animationId = requestAnimationFrame(animate);
        if (!car3DState.renderer || !car3DState.scene || !car3DState.camera) {
            return;
        }
        if (now === undefined) {
            now = performance.now();
        }

        // 演出効果の継続更新（バウンス・慣性）
        updateExaggerationEffects(now);

        var elapsed = now - car3DState.lastRenderTs;
        if (car3DState.needsRender && elapsed >= car3DState.renderInterval) {
            car3DState.needsRender = false;
            if (car3DState.controls) {
                car3DState.controls.update();
            }
            car3DState.renderer.render(car3DState.scene, car3DState.camera);
            car3DState.lastRenderTs = now;
        }
    }
    animate(performance.now());

    debugLog('CAR_3D', 'Initialized 3D car model');
}

/* ================================================================
 *  車両モデル構築
 * ================================================================ */
function buildCarModel(carGroup) {
    buildCarBody(carGroup);
    buildWindows(carGroup);
    buildAeroAndIntakes(carGroup);
    buildWheels(carGroup);
    buildLights(carGroup);
    buildRearDetails(carGroup);
}

// ─── メインボディ（サイドプロファイル → 押し出し）───
function buildCarBody(carGroup) {
    var L = CAR_3D_CONFIG.bodyLength;
    var H = CAR_3D_CONFIG.bodyHeight;
    var gc = CAR_3D_CONFIG.groundClearance;
    var HL = L / 2;
    var bodyW = CAR_3D_CONFIG.bodyWidth * 0.92;

    var bodyShape = new THREE.Shape();
    bodyShape.moveTo(-HL, gc);
    bodyShape.lineTo(HL - 0.30, gc);
    bodyShape.quadraticCurveTo(HL - 0.05, gc, HL, gc + 0.16);
    bodyShape.lineTo(HL, 0.42);
    bodyShape.quadraticCurveTo(HL - 0.20, 0.46, 1.50, 0.55);
    bodyShape.quadraticCurveTo(1.00, 0.63, 0.50, 0.72);
    bodyShape.lineTo(-0.15, H - 0.04);
    bodyShape.quadraticCurveTo(-0.35, H, -0.55, H);
    bodyShape.lineTo(-0.85, H - 0.02);
    bodyShape.quadraticCurveTo(-1.05, 0.93, -1.25, 0.82);
    bodyShape.lineTo(-1.80, 0.78);
    bodyShape.lineTo(-HL + 0.05, 0.76);
    bodyShape.lineTo(-HL, 0.68);
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
}

// ─── ウインドウ ───
function buildWindows(carGroup) {
    var bodyW = CAR_3D_CONFIG.bodyWidth * 0.92;
    var bh = bodyW / 2;
    var bevelT = 0.05;
    var bevelS = 0.04;

    // フロント/リア用マテリアル（薄板クワッドのため depthTest:false でボディ上に描画）
    var winBackMat = new THREE.MeshBasicMaterial({
        color: 0x080810,
        side: THREE.FrontSide,
        depthTest: false,
        depthWrite: false
    });
    var winGlassMat = new THREE.MeshPhongMaterial({
        color: CAR_3D_CONFIG.colors.windows,
        transparent: false,
        opacity: 1,
        shininess: 200,
        specular: new THREE.Color(0xaaaaaa),
        emissive: new THREE.Color(0x112838),
        side: THREE.FrontSide,
        depthTest: false,
        depthWrite: false
    });

    // フロントウインドシールド（薄板クワッド）
    var gw  = bh * 0.85;
    var gwT = bh * 0.70;
    var wsGeo = new THREE.BufferGeometry();
    wsGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
         0.48, 0.73, -gw,
         0.48, 0.73,  gw,
        -0.13, 1.06,  gwT,
        -0.13, 1.06, -gwT
    ]), 3));
    wsGeo.setIndex([0, 2, 1,  0, 3, 2]);
    wsGeo.computeVertexNormals();

    var wsBack = new THREE.Mesh(wsGeo, winBackMat);
    wsBack.renderOrder = 1;
    carGroup.add(wsBack);
    var wsMesh = new THREE.Mesh(wsGeo, winGlassMat);
    wsMesh.renderOrder = 2;
    car3DState.windows.push(wsMesh);
    carGroup.add(wsMesh);

    // リアウインドウ（薄板クワッド）
    var rw  = bh * 0.78;
    var rwB = bh * 0.68;
    var rwGeo = new THREE.BufferGeometry();
    rwGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        -0.87, 1.07, -rw,
        -0.87, 1.07,  rw,
        -1.20, 0.85,  rwB,
        -1.20, 0.85, -rwB
    ]), 3));
    rwGeo.setIndex([0, 2, 1,  0, 3, 2]);
    rwGeo.computeVertexNormals();

    var rwBack = new THREE.Mesh(rwGeo, winBackMat.clone());
    rwBack.renderOrder = 1;
    carGroup.add(rwBack);
    var rwMesh = new THREE.Mesh(rwGeo, winGlassMat.clone());
    rwMesh.renderOrder = 2;
    car3DState.windows.push(rwMesh);
    carGroup.add(rwMesh);

    // サイドウインドウ（ExtrudeGeometryでボディと同一ベベル — 深度が完全一致）
    var swShape = new THREE.Shape();
    swShape.moveTo(0.47, 0.73);
    swShape.lineTo(-0.13, 1.05);
    swShape.quadraticCurveTo(-0.33, 1.08, -0.55, 1.08);
    swShape.lineTo(-0.85, 1.06);
    swShape.quadraticCurveTo(-1.03, 0.92, -1.21, 0.82);
    swShape.lineTo(0.47, 0.73);

    var swGeo = new THREE.ExtrudeGeometry(swShape, {
        depth: bodyW,
        bevelEnabled: true,
        bevelThickness: bevelT,
        bevelSize: bevelS,
        bevelSegments: 3
    });
    swGeo.translate(0, 0, -bodyW / 2);

    var sideBackMat = new THREE.MeshBasicMaterial({
        color: 0x081018,
        depthTest: true,
        depthWrite: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4
    });
    var sideGlassMat = new THREE.MeshPhongMaterial({
        color: CAR_3D_CONFIG.colors.windows,
        transparent: false,
        opacity: 1,
        shininess: 200,
        specular: new THREE.Color(0xaaaaaa),
        emissive: new THREE.Color(0x1a3848),
        depthTest: true,
        depthWrite: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -8
    });

    var swBackMesh = new THREE.Mesh(swGeo, sideBackMat);
    swBackMesh.renderOrder = 3;
    carGroup.add(swBackMesh);
    var swGlassMesh = new THREE.Mesh(swGeo, sideGlassMat);
    swGlassMesh.renderOrder = 4;
    car3DState.windows.push(swGlassMesh);
    carGroup.add(swGlassMesh);
}

// ─── エアロ・インテーク・スカート ───
function buildAeroAndIntakes(carGroup) {
    var W = CAR_3D_CONFIG.bodyWidth;
    var gc = CAR_3D_CONFIG.groundClearance;
    var HL = CAR_3D_CONFIG.bodyLength / 2;
    var bodyW = W * 0.92;

    var intakeMat = new THREE.MeshPhongMaterial({ color: CAR_3D_CONFIG.colors.intake });
    var intakeGeo = new THREE.BoxGeometry(0.50, 0.16, 0.03);
    [-1, 1].forEach(function(side) {
        var intake = new THREE.Mesh(intakeGeo, intakeMat);
        intake.position.set(-0.55, 0.48, side * (bodyW / 2 + 0.05));
        carGroup.add(intake);
    });

    var darkMat = new THREE.MeshPhongMaterial({ color: 0x111111 });
    var splitterGeo = new THREE.BoxGeometry(0.18, 0.025, W * 1.02);
    var splitter = new THREE.Mesh(splitterGeo, darkMat);
    splitter.position.set(HL - 0.05, gc - 0.01, 0);
    carGroup.add(splitter);

    var skirtGeo = new THREE.BoxGeometry(2.2, 0.035, 0.025);
    [-1, 1].forEach(function(side) {
        var skirt = new THREE.Mesh(skirtGeo, darkMat);
        skirt.position.set(-0.10, gc + 0.02, side * W / 2);
        carGroup.add(skirt);
    });
}

// ─── ヘッドライト・テールライト ───
function buildLights(carGroup) {
    var HL = CAR_3D_CONFIG.bodyLength / 2;

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
}

// ─── グリル・ディフューザー・エキゾースト・ルーバー・ウイング ───
function buildRearDetails(carGroup) {
    var HL = CAR_3D_CONFIG.bodyLength / 2;
    var bodyW = CAR_3D_CONFIG.bodyWidth * 0.92;

    var intakeMat = new THREE.MeshPhongMaterial({ color: CAR_3D_CONFIG.colors.intake });

    // フロントグリル
    var grillGeo = new THREE.BoxGeometry(0.02, 0.13, 0.65);
    var grill = new THREE.Mesh(grillGeo, intakeMat);
    grill.position.set(HL + 0.01, 0.22, 0);
    carGroup.add(grill);

    // リアディフューザー
    var diffGeo = new THREE.BoxGeometry(0.02, 0.10, 0.75);
    var diff = new THREE.Mesh(diffGeo, intakeMat);
    diff.position.set(-HL - 0.01, 0.20, 0);
    carGroup.add(diff);

    // エキゾースト（クアッド出し）
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

    // エンジンカバーのルーバー（ミッドエンジンの吸気口）
    var louverMat = new THREE.MeshPhongMaterial({ color: 0x111111 });
    var louverGeo = new THREE.BoxGeometry(0.30, 0.008, bodyW * 0.55);
    for (var i = 0; i < 4; i++) {
        var louver = new THREE.Mesh(louverGeo, louverMat);
        louver.position.set(-1.40 - i * 0.10, 0.79, 0);
        louver.rotation.z = 0.05;
        carGroup.add(louver);
    }

    // リアウイング支柱
    var stayGeo = new THREE.BoxGeometry(0.03, 0.22, 0.03);
    var stayMat = new THREE.MeshPhongMaterial({ color: 0x222222 });
    [-0.55, 0.55].forEach(function(z) {
        var stay = new THREE.Mesh(stayGeo, stayMat);
        stay.position.set(-HL + 0.15, 0.88, z);
        carGroup.add(stay);
    });

    // リアウイング翼面
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
 *  姿勢更新（pitch / yaw / roll / rpm / steering）
 *  演出効果（増幅・バウンス・慣性・微振動）を適用
 * ================================================================ */
function updateCar3D(pitch, yaw, roll, rpm, steering) {
    if (!car3DState.initialized || !car3DState.carGroup) return;

    // 元の値を保持（UI表示用）
    car3DState.pitch = pitch || 0;
    car3DState.yaw = yaw || 0;
    car3DState.roll = roll || 0;
    car3DState.currentRpm = rpm || 0;
    car3DState.steeringAngle = steering || 0;

    // 演出効果が無効な場合は直接適用
    if (!EXAGGERATION_CONFIG.enabled) {
        car3DState.carGroup.rotation.x = car3DState.pitch;
        car3DState.carGroup.rotation.y = 0;
        car3DState.carGroup.rotation.z = car3DState.roll;
        car3DState.needsRender = true;
    } else {
        // 増幅を適用して目標値を計算
        car3DState.targetPitch = applyAmplification(car3DState.pitch, 'pitch');
        car3DState.targetRoll = applyAmplification(car3DState.roll, 'roll');
        // 実際の回転は animate ループ内で updateExaggerationEffects() により更新
    }

    // CAR ATTITUDEカード内の数値表示を更新（元の値を表示）
    if (car3DState.pitchEl) car3DState.pitchEl.textContent = (pitch * 180 / Math.PI).toFixed(2) + '\u00B0';
    if (car3DState.rollEl)  car3DState.rollEl.textContent  = (roll  * 180 / Math.PI).toFixed(2) + '\u00B0';
    if (car3DState.yawEl)   car3DState.yawEl.textContent   = (yaw   * 180 / Math.PI).toFixed(2) + '\u00B0';
}

/* ================================================================
 *  演出効果関数
 * ================================================================ */

// 増幅適用
function applyAmplification(value, type) {
    var multiplier = 1;
    if (type === 'pitch') {
        multiplier = EXAGGERATION_CONFIG.amplification.pitch;
    } else if (type === 'roll') {
        multiplier = EXAGGERATION_CONFIG.amplification.roll;
    }
    return value * multiplier;
}

// 線形補間（lerp）
function lerp(current, target, factor) {
    return current + (target - current) * factor;
}

// バネ・ダンパーモデルによるバウンス計算
function applySpringDamper(current, target, velocity, dt) {
    var stiffness = EXAGGERATION_CONFIG.bounce.stiffness;
    var damping = EXAGGERATION_CONFIG.bounce.damping;

    // バネの力: 目標への復元力
    var springForce = stiffness * (target - current);
    // ダンパーの力: 速度に比例する抵抗
    var dampingForce = damping * velocity;

    // 加速度
    var acceleration = springForce - dampingForce;

    // 速度更新
    velocity += acceleration * dt;

    // 位置更新
    current += velocity * dt;

    return { value: current, velocity: velocity };
}

// 微振動生成
function generateVibration(rpm, time) {
    if (!EXAGGERATION_CONFIG.vibration.enabled) {
        return { x: 0, z: 0 };
    }

    var cfg = EXAGGERATION_CONFIG.vibration;
    var amp = cfg.baseAmplitude + rpm * cfg.rpmMultiplier;
    var freq = cfg.frequency;

    // 複数の周波数を組み合わせて自然な振動に
    var vibX = Math.sin(time * freq * 0.001 * 2 * Math.PI) * amp;
    var vibZ = Math.cos(time * freq * 0.001 * 2 * Math.PI * 1.3) * amp * 0.7;

    // 高周波成分追加
    vibX += Math.sin(time * freq * 0.001 * 5 * Math.PI) * amp * 0.3;
    vibZ += Math.cos(time * freq * 0.001 * 7 * Math.PI) * amp * 0.2;

    return { x: vibX, z: vibZ };
}

// アニメーションループ内で演出効果を更新
function updateExaggerationEffects(now) {
    if (!EXAGGERATION_CONFIG.enabled) return;
    if (!car3DState.carGroup) return;

    var dt = Math.min((now - car3DState.lastUpdateTime) / 1000, 0.1); // 最大100ms
    car3DState.lastUpdateTime = now;

    // バウンス効果（バネ・ダンパー）
    if (EXAGGERATION_CONFIG.bounce.enabled) {
        var pitchResult = applySpringDamper(
            car3DState.displayPitch,
            car3DState.targetPitch,
            car3DState.pitchVelocity,
            dt
        );
        car3DState.displayPitch = pitchResult.value;
        car3DState.pitchVelocity = pitchResult.velocity;

        var rollResult = applySpringDamper(
            car3DState.displayRoll,
            car3DState.targetRoll,
            car3DState.rollVelocity,
            dt
        );
        car3DState.displayRoll = rollResult.value;
        car3DState.rollVelocity = rollResult.velocity;
    } else {
        // バウンス無効なら慣性のみ
        car3DState.displayPitch = lerp(
            car3DState.displayPitch,
            car3DState.targetPitch,
            EXAGGERATION_CONFIG.inertia.enabled ? EXAGGERATION_CONFIG.inertia.lerpFactor : 1
        );
        car3DState.displayRoll = lerp(
            car3DState.displayRoll,
            car3DState.targetRoll,
            EXAGGERATION_CONFIG.inertia.enabled ? EXAGGERATION_CONFIG.inertia.lerpFactor : 1
        );
    }

    // ステアリング（前輪舵角）更新
    var targetSteering = car3DState.steeringAngle * EXAGGERATION_CONFIG.steering.amplification;
    car3DState.displaySteering = lerp(
        car3DState.displaySteering,
        targetSteering,
        EXAGGERATION_CONFIG.steering.lerpFactor
    );

    // 前輪（インデックス0, 1）に舵角を適用
    if (car3DState.wheels[0]) {
        car3DState.wheels[0].rotation.y = car3DState.displaySteering;
    }
    if (car3DState.wheels[1]) {
        car3DState.wheels[1].rotation.y = car3DState.displaySteering;
    }

    // 微振動
    var vibration = generateVibration(car3DState.currentRpm, now);

    // 最終的な回転を適用
    car3DState.carGroup.rotation.x = car3DState.displayPitch + vibration.x;
    car3DState.carGroup.rotation.y = 0;
    car3DState.carGroup.rotation.z = car3DState.displayRoll + vibration.z;

    car3DState.needsRender = true;
}
