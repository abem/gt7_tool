/**
 * CAR ATTITUDE — 3D 車モデル表示（#644）
 *
 * Three.js（r147 UMD、three.min.js）+ GLTFLoader で `/car.glb`（Tripo で生成した車。models/car.glb、
 * git 管理外）を描き、car-3d.js の Canvas2D（サスペンションの針金図）の背面に重ねる。
 * 次のどれかなら何もしない（Canvas2D の表示がそのまま残る＝従来どおり）:
 *   - Three.js / GLTFLoader が読み込まれていない
 *   - WebGL が使えない、またはソフトウェア描画しかない（`?car3d=1` を付けたときだけソフトウェア描画も許す）
 *   - `/car.glb` が取得できない（404 等）
 *   - URL に `?car3d=0`
 *
 * カメラは car-3d.js の投影（ATTITUDE_2D.camYaw / camPitch / scale / horizonY、平行投影）に合わせた
 * 平行投影なので、針金の車輪と 3D の車体が同じ座標系に乗る。
 *
 * car-3d.js からの呼び出し口（typeof ガード付きの 1 行ずつ）:
 *   gtCarModelInit(container, canvas2d)                  初期化（例外を投げない）
 *   gtCarModelUpdate(pitch, yaw, roll, steering, susp)   姿勢の更新（rad）
 * 状態: gtCarModelState.active（描いているか）、.reason（描かない理由。デバッグ用）
 *
 * 座標系（車体ローカル, 無次元）: x=右, y=上, z=前（car-3d.js と同じ）
 * @depends three.min.js, GLTFLoader.js, car-3d.js (ATTITUDE_2D, car3DState)
 */

var gtCarModelState = {
    active: false,
    reason: '',
    renderer: null,
    scene: null,
    camera: null,
    body: null,            // 姿勢を与えるグループ（モデルの親）
    container: null,
    canvas2d: null,
    pitch: 0, roll: 0,
    animationId: null,
    resizeObserver: null
};

(function () {
    var MODEL_URL = '/car.glb';
    var CAR_LENGTH = 3.3;          // 針金の前後ホイールベース(halfLen*cornerZ*2=2.48)より少し長い全長（無次元）
    var PIVOT_Y = 0.34;            // 姿勢の回転中心の高さ(車輪の中心＝針金の wheelR)。小さな角度では地面で回すのと
                                   // ほぼ同じ見え方(反対側が少し格子より下がるのは残る。気になれば接地点を毎フレーム y=0 に合わせる)
    var CAM_DISTANCE = 20;         // 平行投影なので距離は見え方に影響しない（near/far の都合だけ）

    function urlFlag() {
        var m = /[?&]car3d=([01])/.exec(window.location.search || '');
        return m ? m[1] : null;
    }

    function webglAvailable(allowSoftware) {
        try {
            var c = document.createElement('canvas');
            var opts = { failIfMajorPerformanceCaveat: !allowSoftware };
            return !!(c.getContext('webgl2', opts) || c.getContext('webgl', opts));
        } catch (e) {
            return false;
        }
    }

    function giveUp(reason) {
        gtCarModelState.reason = reason;
        if (typeof debugLog === 'function') debugLog('CAR3D', 'model view disabled: ' + reason);
    }

    // car-3d.js の平行投影（project()）と同じ向き・同じ尺度のカメラにする
    function updateCamera() {
        var s = gtCarModelState;
        if (!s.camera || typeof ATTITUDE_2D === 'undefined' || typeof car3DState === 'undefined') return;
        var W = car3DState.W || 1, H = car3DState.H || 1, scale = ATTITUDE_2D.scale || 46;
        var cam = s.camera;
        cam.left = -W / 2 / scale;
        cam.right = W / 2 / scale;
        cam.top = H * ATTITUDE_2D.horizonY / scale;
        cam.bottom = -H * (1 - ATTITUDE_2D.horizonY) / scale;
        cam.updateProjectionMatrix();
        // 視線: project() は世界を camYaw だけ回し、camPitch だけ見下ろす。手前(depth 大)は +z1 側
        var yaw = ATTITUDE_2D.camYaw, p = ATTITUDE_2D.camPitch;
        var dx = -Math.cos(p) * Math.sin(yaw), dy = Math.sin(p), dz = Math.cos(p) * Math.cos(yaw);
        cam.position.set(dx * CAM_DISTANCE, dy * CAM_DISTANCE, dz * CAM_DISTANCE);
        cam.up.set(0, 1, 0);
        cam.lookAt(0, 0, 0);
        if (s.renderer) {
            s.renderer.setSize(W, H, false);
        }
    }

    function fitModel(root) {
        var box = new THREE.Box3().setFromObject(root);
        var size = new THREE.Vector3(); box.getSize(size);
        var center = new THREE.Vector3(); box.getCenter(center);
        // 水平方向の長い方を車の前後(z)に向ける
        if (size.x > size.z) {
            root.rotation.y = Math.PI / 2;
            box = new THREE.Box3().setFromObject(root); box.getSize(size); box.getCenter(center);
        }
        var k = CAR_LENGTH / Math.max(size.z, 1e-6);
        root.scale.multiplyScalar(k);
        box = new THREE.Box3().setFromObject(root); box.getCenter(center);
        root.position.x -= center.x;
        root.position.z -= center.z;
        root.position.y -= box.min.y;          // タイヤの底を地面(y=0)に置く
    }

    function renderLoop() {
        var s = gtCarModelState;
        s.animationId = requestAnimationFrame(renderLoop);
        if (!s.active || !s.renderer) return;
        if (s.body) {
            // 姿勢: 機首上げ(pitch>0)は x 軸の負回転、右ロール(roll>0)は z 軸の負回転（右手系）
            s.body.rotation.x = -s.pitch;
            s.body.rotation.z = -s.roll;
        }
        s.renderer.render(s.scene, s.camera);
    }

    function gtCarModelInit(container, canvas2d) {
        var s = gtCarModelState;
        if (s.active || s.reason) return;
        try {
            var flag = urlFlag();
            if (flag === '0') return giveUp('disabled by ?car3d=0');
            if (typeof THREE === 'undefined' || !THREE.GLTFLoader) return giveUp('three.js not loaded');
            if (!container || !canvas2d) return giveUp('no container');
            if (!webglAvailable(flag === '1')) return giveUp('webgl unavailable');

            var renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
            renderer.setPixelRatio(window.devicePixelRatio || 1);     // 2D 側(resizeAttitude2D)と同じ解像度
            renderer.outputEncoding = THREE.sRGBEncoding;
            renderer.toneMapping = THREE.ACESFilmicToneMapping;
            renderer.setClearColor(0x000000, 0);
            var el = renderer.domElement;
            el.className = 'car-3d-model-canvas';
            el.style.position = 'absolute';
            el.style.left = '0'; el.style.top = '0';
            el.style.zIndex = '0';
            el.style.pointerEvents = 'none';
            // DOM へはモデルの読み込みに成功してから挿す(404 のときに空のキャンバスを残さない)

            var scene = new THREE.Scene();
            scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a2230, 0.9));
            var key = new THREE.DirectionalLight(0xffffff, 1.4);
            key.position.set(3, 7, 5);
            scene.add(key);
            var fill = new THREE.DirectionalLight(0x9fb8ff, 0.5);
            fill.position.set(-4, 3, -3);
            scene.add(fill);

            var camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
            // 地面の格子: car-3d.js の drawGround(n=4, step=0.9)と同じ範囲・間隔。表示中は 2D 側が描かない
            var grid = new THREE.GridHelper(7.2, 8, 0x788caa, 0x788caa);
            grid.material.transparent = true;
            grid.material.opacity = 0.28;
            grid.position.y = -0.005;
            scene.add(grid);
            var body = new THREE.Group();
            body.position.y = PIVOT_Y;        // 回転中心を車輪の高さに置く(モデルはその分下げる)
            scene.add(body);

            s.renderer = renderer; s.scene = scene; s.camera = camera; s.body = body;
            s.container = container; s.canvas2d = canvas2d;
            updateCamera();
            s.resizeObserver = new ResizeObserver(updateCamera);
            s.resizeObserver.observe(container);

            new THREE.GLTFLoader().load(MODEL_URL, function (gltf) {
                try {
                    fitModel(gltf.scene);
                    gltf.scene.position.y -= PIVOT_Y;
                    body.add(gltf.scene);
                    canvas2d.style.position = 'relative';
                    canvas2d.style.zIndex = '1';
                    container.insertBefore(el, canvas2d);
                    s.active = true;
                    updateCamera();
                    if (!s.animationId) renderLoop();
                    if (typeof debugLog === 'function') debugLog('CAR3D', 'model loaded: ' + MODEL_URL);
                } catch (e) {
                    teardown('model fit failed: ' + e);
                }
            }, undefined, function (err) {
                teardown('model not available (' + ((err && err.message) || MODEL_URL) + ')');
            });
        } catch (e) {
            teardown('init failed: ' + e);
        }
    }

    function teardown(reason) {
        var s = gtCarModelState;
        s.active = false;
        if (s.animationId) { cancelAnimationFrame(s.animationId); s.animationId = null; }
        if (s.resizeObserver) { try { s.resizeObserver.disconnect(); } catch (e) { /* ignore */ } s.resizeObserver = null; }
        if (s.renderer) {
            try {
                if (s.renderer.domElement && s.renderer.domElement.parentNode) {
                    s.renderer.domElement.parentNode.removeChild(s.renderer.domElement);
                }
                s.renderer.dispose();
            } catch (e) { /* ignore */ }
            s.renderer = null;
        }
        s.scene = null; s.camera = null; s.body = null;
        if (s.canvas2d) { s.canvas2d.style.position = ''; s.canvas2d.style.zIndex = ''; }
        giveUp(reason);
    }

    function gtCarModelUpdate(pitch, yaw, roll, steering, susp) {
        var s = gtCarModelState;
        s.pitch = (typeof pitch === 'number' && isFinite(pitch)) ? pitch : 0;
        s.roll = (typeof roll === 'number' && isFinite(roll)) ? roll : 0;
        // yaw は固定のクォータービューを保つため使わない。steering / susp は針金側が表現する
    }

    window.gtCarModelInit = gtCarModelInit;
    window.gtCarModelUpdate = gtCarModelUpdate;
})();
