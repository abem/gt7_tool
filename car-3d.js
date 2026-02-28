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
        gridLines: 0x2a2a3e,
        // 追加カラー
        carbon: 0x1a1a1a,
        chrome: 0xffffff,
        caliper: 0xffcc00,
        mirror: 0x111111,
        pillar: 0x0a0a0a,
        lens: 0x88ccff
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
 *  車両モデル構築（リデザイン版）
 * ================================================================ */
function buildCarModel(carGroup) {
    buildCarBody(carGroup);
    buildHoodAndRoof(carGroup);
    buildPillars(carGroup);
    buildWindows(carGroup);
    buildSideMirrors(carGroup);
    buildAeroAndIntakes(carGroup);
    buildCanards(carGroup);
    buildWheels(carGroup);
    buildLights(carGroup);
    buildRearDetails(carGroup);
}

// ─── メインボディ（ロワーボディ）───
function buildCarBody(carGroup) {
    var L = CAR_3D_CONFIG.bodyLength;
    var H = CAR_3D_CONFIG.bodyHeight;
    var gc = CAR_3D_CONFIG.groundClearance;
    var HL = L / 2;
    var bodyW = CAR_3D_CONFIG.bodyWidth * 0.92;

    // ロワーボディ（サイドスカート領域まで）
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

// ─── ボンネット・ルーフ（別パーツ化）───
function buildHoodAndRoof(carGroup) {
    var bodyW = CAR_3D_CONFIG.bodyWidth * 0.92;
    var H = CAR_3D_CONFIG.bodyHeight;

    var bodyMat = new THREE.MeshPhongMaterial({
        color: CAR_3D_CONFIG.colors.body,
        shininess: 140,
        specular: new THREE.Color(0x666666)
    });

    // ボンネット（フラットな面）
    var hoodGeo = new THREE.BoxGeometry(0.8, 0.03, bodyW * 0.85);
    var hood = new THREE.Mesh(hoodGeo, bodyMat);
    hood.position.set(1.35, 0.57, 0);
    hood.rotation.z = -0.08;
    carGroup.add(hood);

    // NACAダクト（ボンネット上）
    var nacaMat = new THREE.MeshPhongMaterial({ color: CAR_3D_CONFIG.colors.carbon });
    var nacaGeo = new THREE.BoxGeometry(0.25, 0.02, 0.08);
    [-0.25, 0.25].forEach(function(z) {
        var naca = new THREE.Mesh(nacaGeo, nacaMat);
        naca.position.set(1.20, 0.60, z);
        carGroup.add(naca);
    });

    // ルーフ（キャビン上部）
    var roofGeo = new THREE.BoxGeometry(0.6, 0.03, bodyW * 0.7);
    var roof = new THREE.Mesh(roofGeo, bodyMat);
    roof.position.set(-0.55, H + 0.02, 0);
    carGroup.add(roof);
}

// ─── ピラー（A/B/Cピラー）───
function buildPillars(carGroup) {
    var bodyW = CAR_3D_CONFIG.bodyWidth * 0.92;
    var pillarMat = new THREE.MeshPhongMaterial({ color: CAR_3D_CONFIG.colors.pillar });

    // Aピラー（フロントガラス枠）
    var aPillarGeo = new THREE.BoxGeometry(0.04, 0.35, 0.04);
    [-1, 1].forEach(function(side) {
        var aPillar = new THREE.Mesh(aPillarGeo, pillarMat);
        aPillar.position.set(0.35, 0.90, side * (bodyW / 2 - 0.02));
        aPillar.rotation.z = -0.35;
        carGroup.add(aPillar);
    });

    // Bピラー（サイドウインドウ間）
    var bPillarGeo = new THREE.BoxGeometry(0.03, 0.30, 0.04);
    [-1, 1].forEach(function(side) {
        var bPillar = new THREE.Mesh(bPillarGeo, pillarMat);
        bPillar.position.set(-0.55, 1.05, side * (bodyW / 2 - 0.02));
        carGroup.add(bPillar);
    });

    // Cピラー（リアウインドウ枠）
    var cPillarGeo = new THREE.BoxGeometry(0.04, 0.25, 0.04);
    [-1, 1].forEach(function(side) {
        var cPillar = new THREE.Mesh(cPillarGeo, pillarMat);
        cPillar.position.set(-1.05, 0.95, side * (bodyW / 2 - 0.02));
        cPillar.rotation.z = 0.4;
        carGroup.add(cPillar);
    });
}

// ─── サイドミラー ───
function buildSideMirrors(carGroup) {
    var W = CAR_3D_CONFIG.bodyWidth;
    var bodyW = W * 0.92;

    var mirrorMat = new THREE.MeshPhongMaterial({ color: CAR_3D_CONFIG.colors.body });
    var glassMat = new THREE.MeshPhongMaterial({
        color: 0x334455,
        shininess: 200,
        specular: new THREE.Color(0x666666)
    });

    [-1, 1].forEach(function(side) {
        var mirrorGroup = new THREE.Group();

        // ミラーハウジング
        var housingGeo = new THREE.BoxGeometry(0.12, 0.06, 0.08);
        var housing = new THREE.Mesh(housingGeo, mirrorMat);
        mirrorGroup.add(housing);

        // ミラー面（ガラス）
        var glassGeo = new THREE.PlaneGeometry(0.10, 0.05);
        var glass = new THREE.Mesh(glassGeo, glassMat);
        glass.position.z = side * 0.041;
        glass.rotation.y = side * -0.2;
        mirrorGroup.add(glass);

        // ステム（支え）
        var stemGeo = new THREE.CylinderGeometry(0.015, 0.012, 0.08, 8);
        var stem = new THREE.Mesh(stemGeo, mirrorMat);
        stem.position.set(-0.04, -0.06, 0);
        stem.rotation.z = 0.3;
        mirrorGroup.add(stem);

        mirrorGroup.position.set(0.70, 0.85, side * (bodyW / 2 + 0.08));
        carGroup.add(mirrorGroup);
    });
}

// ─── カナード（フロントバンパー）───
function buildCanards(carGroup) {
    var HL = CAR_3D_CONFIG.bodyLength / 2;
    var W = CAR_3D_CONFIG.bodyWidth;

    var canardMat = new THREE.MeshPhongMaterial({ color: CAR_3D_CONFIG.colors.carbon });

    // カナード形状（三角形の翼）
    var canardShape = new THREE.Shape();
    canardShape.moveTo(0, 0);
    canardShape.lineTo(0.15, 0);
    canardShape.lineTo(0.08, 0.06);
    canardShape.lineTo(0, 0);

    var canardGeo = new THREE.ExtrudeGeometry(canardShape, {
        depth: 0.02,
        bevelEnabled: false
    });

    [-1, 1].forEach(function(side) {
        var canard = new THREE.Mesh(canardGeo, canardMat);
        canard.position.set(HL - 0.05, 0.18, side * (W / 2 - 0.05));
        canard.rotation.y = side * 0.3;
        canard.rotation.x = 0.1;
        carGroup.add(canard);
    });
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

// ─── ヘッドライト・テールライト（LED化）───
function buildLights(carGroup) {
    var HL = CAR_3D_CONFIG.bodyLength / 2;
    var W = CAR_3D_CONFIG.bodyWidth;

    // === ヘッドライト（LEDプロジェクター風）===
    [-1, 1].forEach(function(side) {
        var lightGroup = new THREE.Group();

        // ライトハウジング
        var housingMat = new THREE.MeshPhongMaterial({ color: 0x111111 });
        var housingGeo = new THREE.BoxGeometry(0.08, 0.15, 0.35);
        var housing = new THREE.Mesh(housingGeo, housingMat);
        lightGroup.add(housing);

        // レンズカバー（半透明）
        var lensMat = new THREE.MeshPhongMaterial({
            color: CAR_3D_CONFIG.colors.lens,
            transparent: true,
            opacity: 0.6,
            shininess: 200
        });
        var lensGeo = new THREE.PlaneGeometry(0.32, 0.13);
        var lens = new THREE.Mesh(lensGeo, lensMat);
        lens.position.x = 0.041;
        lens.rotation.y = Math.PI / 2;
        lightGroup.add(lens);

        // LEDプロジェクター（メイン）
        var ledMat = new THREE.MeshPhongMaterial({
            color: 0xffffff,
            emissive: 0xffffcc,
            emissiveIntensity: 0.8
        });
        var ledGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.02, 16);
        var ledMain = new THREE.Mesh(ledGeo, ledMat);
        ledMain.rotation.z = Math.PI / 2;
        ledMain.position.set(0.03, 0.02, side * 0.08);
        lightGroup.add(ledMain);

        // デイライト（細長いLEDストリップ）
        var drlMat = new THREE.MeshPhongMaterial({
            color: 0xffffff,
            emissive: 0xaaccff,
            emissiveIntensity: 0.5
        });
        var drlGeo = new THREE.BoxGeometry(0.02, 0.015, 0.25);
        var drl = new THREE.Mesh(drlGeo, drlMat);
        drl.position.set(0.035, -0.05, 0);
        lightGroup.add(drl);

        // ターンシグナル（オレンジ）
        var signalMat = new THREE.MeshPhongMaterial({
            color: 0xff8800,
            emissive: 0x663300
        });
        var signalGeo = new THREE.BoxGeometry(0.02, 0.03, 0.06);
        var signal = new THREE.Mesh(signalGeo, signalMat);
        signal.position.set(0.035, 0.05, side * 0.14);
        lightGroup.add(signal);

        lightGroup.position.set(HL + 0.02, 0.42, side * (W / 2 - 0.18));
        carGroup.add(lightGroup);
    });

    // === テールライト（LEDストリップ風）===
    [-1, 1].forEach(function(side) {
        var tailGroup = new THREE.Group();

        // ライトハウジング
        var housingMat = new THREE.MeshPhongMaterial({ color: 0x111111 });
        var housingGeo = new THREE.BoxGeometry(0.06, 0.08, 0.35);
        var housing = new THREE.Mesh(housingGeo, housingMat);
        tailGroup.add(housing);

        // LEDストリップ（メイン）
        var ledMat = new THREE.MeshPhongMaterial({
            color: 0xff0000,
            emissive: 0xff0000,
            emissiveIntensity: 0.6
        });
        var ledGeo = new THREE.BoxGeometry(0.02, 0.04, 0.30);
        var led = new THREE.Mesh(ledGeo, ledMat);
        led.position.x = -0.031;
        tailGroup.add(led);

        // リフレクター（反射板風）
        var reflectMat = new THREE.MeshPhongMaterial({
            color: 0x330000,
            shininess: 100,
            specular: new THREE.Color(0x440000)
        });
        var reflectGeo = new THREE.PlaneGeometry(0.28, 0.06);
        var reflect = new THREE.Mesh(reflectGeo, reflectMat);
        reflect.position.x = -0.032;
        reflect.rotation.y = Math.PI / 2;
        tailGroup.add(reflect);

        // バックランプ（白・内側）
        var backupMat = new THREE.MeshPhongMaterial({
            color: 0xffffff,
            emissive: 0xaaaaaa
        });
        var backupGeo = new THREE.BoxGeometry(0.02, 0.03, 0.05);
        var backup = new THREE.Mesh(backupGeo, backupMat);
        backup.position.set(-0.031, -0.02, -side * 0.12);
        tailGroup.add(backup);

        tailGroup.position.set(-HL - 0.01, 0.52, side * (W / 2 - 0.18));
        carGroup.add(tailGroup);
    });
}

// ─── グリル・ディフューザー・エキゾースト・ルーバー・ウイング ───
function buildRearDetails(carGroup) {
    var HL = CAR_3D_CONFIG.bodyLength / 2;
    var bodyW = CAR_3D_CONFIG.bodyWidth * 0.92;
    var W = CAR_3D_CONFIG.bodyWidth;

    var intakeMat = new THREE.MeshPhongMaterial({ color: CAR_3D_CONFIG.colors.intake });
    var carbonMat = new THREE.MeshPhongMaterial({ color: CAR_3D_CONFIG.colors.carbon });

    // === フロントグリル（メッシュ化）===
    var grillFrameGeo = new THREE.BoxGeometry(0.02, 0.15, 0.70);
    var grillFrame = new THREE.Mesh(grillFrameGeo, intakeMat);
    grillFrame.position.set(HL + 0.01, 0.22, 0);
    carGroup.add(grillFrame);

    // メッシュ（横棒）
    var meshMat = new THREE.MeshPhongMaterial({ color: 0x222222 });
    var meshGeo = new THREE.BoxGeometry(0.015, 0.008, 0.65);
    for (var i = 0; i < 8; i++) {
        var meshBar = new THREE.Mesh(meshGeo, meshMat);
        meshBar.position.set(HL + 0.02, 0.14 + i * 0.015, 0);
        carGroup.add(meshBar);
    }

    // === リアディフューザー（カーボン風）===
    var diffGeo = new THREE.BoxGeometry(0.04, 0.10, 0.80);
    var diff = new THREE.Mesh(diffGeo, carbonMat);
    diff.position.set(-HL - 0.02, 0.18, 0);
    carGroup.add(diff);

    // ディフューザーフィン
    var finGeo = new THREE.BoxGeometry(0.03, 0.08, 0.008);
    [-0.30, -0.15, 0, 0.15, 0.30].forEach(function(z) {
        var fin = new THREE.Mesh(finGeo, carbonMat);
        fin.position.set(-HL - 0.03, 0.15, z);
        fin.rotation.x = 0.2;
        carGroup.add(fin);
    });

    // === エキゾースト（オーバル型クアッド）===
    var exhMat = new THREE.MeshPhongMaterial({
        color: 0x888888,
        shininess: 150,
        specular: new THREE.Color(0x444444)
    });
    var exhInMat = new THREE.MeshPhongMaterial({ color: 0x111111 });

    [-0.28, -0.15, 0.15, 0.28].forEach(function(z) {
        var exhGroup = new THREE.Group();
        // 外側（オーバル）
        var exhOuterGeo = new THREE.CylinderGeometry(0.035, 0.038, 0.10, 12);
        var exhOuter = new THREE.Mesh(exhOuterGeo, exhMat);
        exhOuter.rotation.z = Math.PI / 2;
        exhGroup.add(exhOuter);
        // 内側（黒）
        var exhInnerGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.03, 12);
        var exhInner = new THREE.Mesh(exhInnerGeo, exhInMat);
        exhInner.rotation.z = Math.PI / 2;
        exhInner.position.x = -0.04;
        exhGroup.add(exhInner);

        exhGroup.position.set(-HL - 0.06, 0.19, z);
        carGroup.add(exhGroup);
    });

    // === エンジンカバーのルーバー（ミッドエンジンの吸気口）===
    var louverMat = new THREE.MeshPhongMaterial({ color: CAR_3D_CONFIG.colors.carbon });
    var louverGeo = new THREE.BoxGeometry(0.30, 0.008, bodyW * 0.55);
    for (var j = 0; j < 4; j++) {
        var louver = new THREE.Mesh(louverGeo, louverMat);
        louver.position.set(-1.40 - j * 0.10, 0.79, 0);
        louver.rotation.z = 0.05;
        carGroup.add(louver);
    }

    // === リアウイング支柱 ===
    var stayGeo = new THREE.BoxGeometry(0.03, 0.22, 0.03);
    var stayMat = new THREE.MeshPhongMaterial({ color: CAR_3D_CONFIG.colors.carbon });
    [-0.55, 0.55].forEach(function(z) {
        var stay = new THREE.Mesh(stayGeo, stayMat);
        stay.position.set(-HL + 0.15, 0.88, z);
        carGroup.add(stay);
    });

    // === リアウイング翼面 ===
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
        shininess: 140,
        specular: new THREE.Color(0x444444)
    });
    var wing = new THREE.Mesh(wingGeo, wingMat);
    wing.position.set(-HL + 0.08, 0.97, 0);
    carGroup.add(wing);

    // ウイングエンドプレート
    var endplateGeo = new THREE.BoxGeometry(0.18, 0.08, 0.01);
    var endplateMat = new THREE.MeshPhongMaterial({ color: CAR_3D_CONFIG.colors.carbon });
    [-0.63, 0.63].forEach(function(z) {
        var endplate = new THREE.Mesh(endplateGeo, endplateMat);
        endplate.position.set(-HL + 0.17, 0.98, z);
        carGroup.add(endplate);
    });
}

/* ================================================================
 *  ホイール構築（Y字5スポーク + キャリパー）
 * ================================================================ */
function buildWheels(carGroup) {
    var wR = CAR_3D_CONFIG.wheelRadius;
    var wW = CAR_3D_CONFIG.wheelWidth;
    var W = CAR_3D_CONFIG.bodyWidth;

    var halfWidth = W / 2 + wW * 0.05;

    var positions = [
        { x: CAR_3D_CONFIG.frontAxle,  y: wR, z:  halfWidth, s:  1, front: true },
        { x: CAR_3D_CONFIG.frontAxle,  y: wR, z: -halfWidth, s: -1, front: true },
        { x: CAR_3D_CONFIG.rearAxle,   y: wR, z:  halfWidth, s:  1, front: false },
        { x: CAR_3D_CONFIG.rearAxle,   y: wR, z: -halfWidth, s: -1, front: false }
    ];

    var tireMat = new THREE.MeshPhongMaterial({ color: CAR_3D_CONFIG.colors.tire });
    var tireGeo = new THREE.CylinderGeometry(wR, wR, wW, 32);

    // タイヤサイドウォール
    var swTubeR = 0.04;
    var swTorusR = wR - swTubeR;
    var sidewallGeo = new THREE.TorusGeometry(swTorusR, swTubeR, 8, 32);
    var sidewallMat = new THREE.MeshPhongMaterial({ color: 0x222222 });

    // リムマテリアル
    var rimMat = new THREE.MeshPhongMaterial({
        color: CAR_3D_CONFIG.colors.rim,
        shininess: 180,
        specular: new THREE.Color(0x888888)
    });

    // リムベース（円盤）
    var rimR = wR * 0.70;
    var rimBaseGeo = new THREE.CircleGeometry(rimR, 32);

    // リムバレル（外周リング）
    var rimBarrelGeo = new THREE.TorusGeometry(rimR, 0.02, 8, 32);

    // Y字スポーク（5本）
    var spokeMat = new THREE.MeshPhongMaterial({
        color: 0x444444,
        shininess: 100
    });

    // ハブキャップ
    var hubR = wR * 0.12;
    var hubGeo = new THREE.CylinderGeometry(hubR, hubR, 0.02, 16);
    var hubMat = new THREE.MeshPhongMaterial({
        color: CAR_3D_CONFIG.colors.hubCap,
        shininess: 150
    });

    // ブレーキディスク（ドリルドローター風）
    var brakeR = rimR * 0.85;
    var brakeGeo = new THREE.RingGeometry(0.08, brakeR, 32);
    var brakeMat = new THREE.MeshPhongMaterial({
        color: 0x666666,
        shininess: 60,
        side: THREE.DoubleSide
    });

    // ブレーキキャリパー
    var caliperGeo = new THREE.BoxGeometry(0.12, 0.08, 0.04);
    var caliperMat = new THREE.MeshPhongMaterial({
        color: CAR_3D_CONFIG.colors.caliper,
        shininess: 120
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

        // ブレーキディスク
        var brake = new THREE.Mesh(brakeGeo, brakeMat);
        brake.position.z = (wW / 2 - 0.03) * pos.s;
        wheelGroup.add(brake);

        // ブレーキキャリパー（外側上部）
        var caliper = new THREE.Mesh(caliperGeo, caliperMat);
        caliper.position.set(0, wR * 0.5, (wW / 2 - 0.015) * pos.s);
        wheelGroup.add(caliper);

        // リムベース
        var rimBase = new THREE.Mesh(rimBaseGeo, rimMat);
        rimBase.position.z = (wW / 2 + 0.005) * pos.s;
        if (pos.s < 0) rimBase.rotation.y = Math.PI;
        wheelGroup.add(rimBase);

        // リムバレル
        var rimBarrel = new THREE.Mesh(rimBarrelGeo, rimMat);
        rimBarrel.position.z = (wW / 2 + 0.005) * pos.s;
        wheelGroup.add(rimBarrel);

        // Y字スポーク（5本）
        for (var i = 0; i < 5; i++) {
            var angle = (i / 5) * Math.PI * 2;
            var spokeGroup = new THREE.Group();

            // メインスポーク
            var mainSpokeGeo = new THREE.BoxGeometry(0.03, rimR - hubR - 0.02, 0.015);
            var mainSpoke = new THREE.Mesh(mainSpokeGeo, spokeMat);
            mainSpoke.position.y = (rimR - hubR) / 2 + hubR;
            spokeGroup.add(mainSpoke);

            // Y字分岐（左右）
            var branchGeo = new THREE.BoxGeometry(0.02, 0.08, 0.01);
            [-1, 1].forEach(function(side) {
                var branch = new THREE.Mesh(branchGeo, spokeMat);
                branch.position.set(side * 0.04, rimR - 0.12, 0);
                branch.rotation.z = side * 0.4;
                spokeGroup.add(branch);
            });

            spokeGroup.rotation.z = angle;
            spokeGroup.position.z = (wW / 2 + 0.008) * pos.s;
            if (pos.s < 0) spokeGroup.rotation.y = Math.PI;
            wheelGroup.add(spokeGroup);
        }

        // ハブキャップ
        var hub = new THREE.Mesh(hubGeo, hubMat);
        hub.rotation.x = Math.PI / 2;
        hub.position.z = (wW / 2 + 0.015) * pos.s;
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
