/**
 * CAR ATTITUDE — 2D (Canvas2D) 姿勢 + サスペンション可視化
 *
 * WebGL/Three.js を使わず Canvas2D だけで、ロール/ピッチ/ヨーの姿勢と 4輪サスペンションの
 * 伸縮をアイソメトリック（クォータービュー）で図示する。GPU 無し・リモートデスクトップ・
 * どのブラウザでも必ず描画される。
 *
 * 旧 WebGL 版と互換の口を提供:
 *   - initCar3D()                              : 初期化（例外を投げない）
 *   - updateCar3D(pitch, yaw, roll, rpm, steering, susp) : 毎フレーム更新
 *   - car3DState.initialized                   : 初期化フラグ（test-mode.js が参照）
 *
 * 座標系（車体ローカル, 無次元）: x=右, y=上, z=前
 * @depends ui_components.js (debugLog)
 */

var car3DState = {
    initialized: false,
    canvas: null,
    ctx: null,
    W: 0, H: 0, dpr: 1,
    // 最新姿勢（ラジアン）
    pitch: 0, yaw: 0, roll: 0, steering: 0,
    susp: [0, 0, 0, 0],           // FL, FR, RL, RR（生値。単位は問わない=相対表示）
    animationId: null,
    needsRender: true,
    resizeObserver: null,
    pitchEl: null, rollEl: null, yawEl: null,
    webglFailed: false            // 互換のため保持（未使用）
};

// 車体・カメラ寸法（無次元）
var ATTITUDE_2D = {
    halfLen: 1.55,     // z 半分（前後）
    halfWid: 0.82,     // x 半分（左右）
    bodyBottom: 0.42,  // 車体下面の高さ
    bodyTop: 1.02,     // 車体上面の高さ
    cabinTop: 1.30,    // ルーフ高さ
    wheelR: 0.36,      // タイヤ半径
    strutBase: 0.30,   // サスペンション基準長（車体下面→ホイール中心）
    strutTravel: 0.42, // サス偏差の最大振れ幅（描画）
    camPitch: 0.50,    // カメラ見下ろし角（rad, ~29°）
    camYaw: -0.66,     // カメラ方位角（rad, ~-38°）
    scale: 46,         // px/unit（init でフィット調整）
    horizonY: 0.60     // 地面基準線の縦位置（キャンバス高さ比）
};

var ATTITUDE_COLORS = {
    grid: 'rgba(120,140,170,0.20)',
    gridAxis: 'rgba(120,140,170,0.38)',
    bodyTop: '#2E7DD1',
    bodySide: '#255FA0',
    bodyFront: '#5AA0E6',
    cabin: 'rgba(150,200,255,0.30)',
    edge: 'rgba(210,230,255,0.85)',
    wheel: '#12161C',
    wheelRim: 'rgba(200,215,235,0.85)',
    strutCompress: '#E8563B', // 縮み（荷重大）
    strutNeutral: '#4CD07D',
    strutExtend: '#43A6FF'     // 伸び（荷重小）
};

function initCar3D() {
    if (car3DState.initialized) return;

    var container = document.getElementById('car-3d-view');
    if (!container) {
        console.error('[ATTITUDE_2D] Container #car-3d-view not found');
        return;
    }

    var canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    container.appendChild(canvas);

    car3DState.canvas = canvas;
    car3DState.ctx = canvas.getContext('2d');
    car3DState.pitchEl = document.getElementById('car-3d-pitch');
    car3DState.rollEl  = document.getElementById('car-3d-roll');
    car3DState.yawEl   = document.getElementById('car-3d-yaw');

    resizeAttitude2D();
    car3DState.resizeObserver = new ResizeObserver(resizeAttitude2D);
    car3DState.resizeObserver.observe(container);

    // 旧WebGL版の名残で空だった「TOP VIEW」枠は不要になったので非表示にして詰める
    var topView = document.querySelector('.car-top-view-container');
    if (topView) topView.style.display = 'none';
    // PITCH/ROLL/YAW はキャンバス上に直接描くため、DOM の数値行は非表示（カード高が狭い環境での重なり防止）
    var info = document.querySelector('.car-3d-info');
    if (info) info.style.display = 'none';

    car3DState.initialized = true;
    if (typeof debugLog === 'function') debugLog('ATTITUDE_2D', 'Initialized 2D attitude view');
    renderLoop();
}

function resizeAttitude2D() {
    var c = car3DState.canvas;
    if (!c) return;
    var rect = c.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    var dpr = window.devicePixelRatio || 1;
    car3DState.W = w;
    car3DState.H = h;
    car3DState.dpr = dpr;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    car3DState.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 車体（全長約 5 単位）が収まるよう自動スケール
    ATTITUDE_2D.scale = Math.min(w / 5.4, h / 3.4);
    car3DState.needsRender = true;
}

/**
 * 姿勢・サスの更新（旧 WebGL 版と互換のシグネチャ + susp 追加）
 * @param {number} pitch    ピッチ角（rad）
 * @param {number} yaw      ヨー角（rad）
 * @param {number} roll     ロール角（rad）
 * @param {number} rpm      （未使用・互換のため）
 * @param {number} steering ステア角（rad, 前輪を切る）
 * @param {number[]} susp   4輪サスペンション値 [FL,FR,RL,RR]（相対表示なので単位不問）
 */
function updateCar3D(pitch, yaw, roll, rpm, steering, susp) {
    car3DState.pitch = pitch || 0;
    car3DState.yaw = yaw || 0;
    car3DState.roll = roll || 0;
    car3DState.steering = steering || 0;
    if (susp && susp.length >= 4) {
        car3DState.susp = [susp[0] || 0, susp[1] || 0, susp[2] || 0, susp[3] || 0];
    }
    // 数値読み出し（旧版と同じ DOM を更新）
    if (car3DState.pitchEl) car3DState.pitchEl.textContent = (car3DState.pitch * 180 / Math.PI).toFixed(2) + '°';
    if (car3DState.rollEl)  car3DState.rollEl.textContent  = (car3DState.roll  * 180 / Math.PI).toFixed(2) + '°';
    if (car3DState.yawEl)   car3DState.yawEl.textContent   = (car3DState.yaw   * 180 / Math.PI).toFixed(2) + '°';
    car3DState.needsRender = true;
}

// ── 3D → 2D 投影 ─────────────────────────────────────────────

// 車体姿勢による回転（ヨー→ピッチ→ロールの順）
function rotateAttitude(x, y, z) {
    var p = car3DState.pitch, r = car3DState.roll, yw = car3DState.yaw;
    // yaw（y軸まわり）
    var cy = Math.cos(yw), sy = Math.sin(yw);
    var x1 = x * cy + z * sy, z1 = -x * sy + z * cy, y1 = y;
    // pitch（x軸まわり）: 機首上げ/下げ
    var cp = Math.cos(p), sp = Math.sin(p);
    var y2 = y1 * cp - z1 * sp, z2 = y1 * sp + z1 * cp, x2 = x1;
    // roll（z軸まわり）: 左右傾き
    var cr = Math.cos(r), sr = Math.sin(r);
    var x3 = x2 * cr - y2 * sr, y3 = x2 * sr + y2 * cr, z3 = z2;
    return [x3, y3, z3];
}

// 固定アイソメトリックカメラ → スクリーン座標（+ 奥行き）
function project(x, y, z) {
    var cyw = Math.cos(ATTITUDE_2D.camYaw), syw = Math.sin(ATTITUDE_2D.camYaw);
    var x1 = x * cyw + z * syw, z1 = -x * syw + z * cyw, y1 = y;
    var cpt = Math.cos(ATTITUDE_2D.camPitch), spt = Math.sin(ATTITUDE_2D.camPitch);
    var y2 = y1 * cpt - z1 * spt, z2 = y1 * spt + z1 * cpt;
    var s = ATTITUDE_2D.scale;
    return {
        x: car3DState.W / 2 + x1 * s,
        y: car3DState.H * ATTITUDE_2D.horizonY - y2 * s,
        depth: z2
    };
}

// 車体ローカル点（姿勢回転あり）を投影
function projLocal(x, y, z) {
    var w = rotateAttitude(x, y, z);
    return project(w[0], w[1], w[2]);
}

// 地面（水平・姿勢に依存しない基準）を投影
function projGround(x, y, z) {
    return project(x, y, z);
}

// ── 描画 ─────────────────────────────────────────────────────

function drawGround() {
    var ctx = car3DState.ctx;
    var n = 4, step = 0.9;
    ctx.lineWidth = 1;
    for (var i = -n; i <= n; i++) {
        var t = i * step;
        // z 方向の線
        var a = projGround(t, 0, -n * step), b = projGround(t, 0, n * step);
        ctx.strokeStyle = (i === 0) ? ATTITUDE_COLORS.gridAxis : ATTITUDE_COLORS.grid;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        // x 方向の線
        var c = projGround(-n * step, 0, t), d = projGround(n * step, 0, t);
        ctx.strokeStyle = (i === 0) ? ATTITUDE_COLORS.gridAxis : ATTITUDE_COLORS.grid;
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.stroke();
    }
}

// サス偏差を -1..1 に正規化（相対表示: 単位に依存しない）
function suspNorm() {
    var s = car3DState.susp;
    var avg = (s[0] + s[1] + s[2] + s[3]) / 4;
    var dev = [s[0] - avg, s[1] - avg, s[2] - avg, s[3] - avg];
    var maxAbs = Math.max(Math.abs(dev[0]), Math.abs(dev[1]), Math.abs(dev[2]), Math.abs(dev[3]));
    if (maxAbs < 1e-6) return [0, 0, 0, 0];
    return [dev[0] / maxAbs, dev[1] / maxAbs, dev[2] / maxAbs, dev[3] / maxAbs];
}

function strutColor(norm) {
    // norm>0 = 伸び（荷重小, 青） / norm<0 = 縮み（荷重大, 赤）
    if (norm > 0.15) return ATTITUDE_COLORS.strutExtend;
    if (norm < -0.15) return ATTITUDE_COLORS.strutCompress;
    return ATTITUDE_COLORS.strutNeutral;
}

// 車体ボックス面（painter's algorithm で奥から）
function drawBody() {
    var ctx = car3DState.ctx;
    var W = ATTITUDE_2D.halfWid, L = ATTITUDE_2D.halfLen;
    var B = ATTITUDE_2D.bodyBottom, T = ATTITUDE_2D.bodyTop, C = ATTITUDE_2D.cabinTop;

    // 8 頂点（下面 0-3, 上面 4-7） + キャビン頂点
    var v = [
        [-W, B, -L], [W, B, -L], [W, B, L], [-W, B, L],     // 下面
        [-W, T, -L], [W, T, -L], [W, T, L], [-W, T, L]      // 上面
    ];
    // キャビン（中央やや後方の低い箱で「屋根」を表現）
    var cab = [
        [-W * 0.72, T, -L * 0.55], [W * 0.72, T, -L * 0.55], [W * 0.72, T, L * 0.35], [-W * 0.72, T, L * 0.35],
        [-W * 0.6, C, -L * 0.4], [W * 0.6, C, -L * 0.4], [W * 0.6, C, L * 0.2], [-W * 0.6, C, L * 0.2]
    ];

    var P = v.map(function (q) { return projLocal(q[0], q[1], q[2]); });
    var Pc = cab.map(function (q) { return projLocal(q[0], q[1], q[2]); });

    // 面定義（頂点index, 色）
    var faces = [
        { idx: [0, 1, 2, 3], col: ATTITUDE_COLORS.bodySide, src: v, top: false }, // 底
        { idx: [4, 5, 1, 0], col: ATTITUDE_COLORS.bodySide, src: v },             // 後
        { idx: [7, 6, 2, 3], col: ATTITUDE_COLORS.bodyFront, src: v },            // 前
        { idx: [4, 7, 3, 0], col: ATTITUDE_COLORS.bodySide, src: v },             // 左
        { idx: [5, 6, 2, 1], col: ATTITUDE_COLORS.bodySide, src: v },             // 右
        { idx: [4, 5, 6, 7], col: ATTITUDE_COLORS.bodyTop, src: v, top: true }    // 上
    ];

    // 各面の平均奥行きでソート（奥→手前）
    faces.forEach(function (f) {
        var d = 0;
        for (var k = 0; k < f.idx.length; k++) d += P[f.idx[k]].depth;
        f.d = d / f.idx.length;
    });
    faces.sort(function (a, b) { return a.d - b.d; });

    faces.forEach(function (f) {
        ctx.beginPath();
        for (var k = 0; k < f.idx.length; k++) {
            var pt = P[f.idx[k]];
            if (k === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
        }
        ctx.closePath();
        ctx.fillStyle = f.col;
        ctx.globalAlpha = 0.96;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = ATTITUDE_COLORS.edge;
        ctx.stroke();
    });

    // キャビン（半透明の屋根）
    ctx.beginPath();
    [4, 5, 6, 7].forEach(function (i, k) {
        var pt = Pc[i];
        if (k === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
    });
    ctx.closePath();
    ctx.fillStyle = ATTITUDE_COLORS.cabin;
    ctx.fill();
    ctx.strokeStyle = ATTITUDE_COLORS.edge;
    ctx.lineWidth = 1;
    ctx.stroke();
}

// 4輪 + サスペンションストラット + 接地影
function drawWheels() {
    var ctx = car3DState.ctx;
    var W = ATTITUDE_2D.halfWid, L = ATTITUDE_2D.halfLen, B = ATTITUDE_2D.bodyBottom;
    var norm = suspNorm();
    var r = ATTITUDE_2D.wheelR * ATTITUDE_2D.scale;

    // 車体コーナー（下面）: 並びは susp 配列順 FL, FR, RL, RR
    var corners = [
        [-W, B,  L], [W, B,  L],   // FL, FR
        [-W, B, -L], [W, B, -L]    // RL, RR
    ];

    var wheels = corners.map(function (c, i) {
        // サス偏差: 伸び(norm>0)ほどストラットが長い＝ホイールが車体から離れる
        var strut = ATTITUDE_2D.strutBase + norm[i] * ATTITUDE_2D.strutTravel;
        var wx = c[0], wy = c[1] - strut, wz = c[2];
        var wr = rotateAttitude(wx, wy, wz);           // ワールド座標
        return {
            i: i, norm: norm[i], col: strutColor(norm[i]),
            top: projLocal(c[0], c[1], c[2]),          // 取付点（車体コーナー）
            hub: projLocal(wx, wy, wz),                // ホイール中心
            ground: project(wr[0], 0, wr[2])           // 真下の接地点（水平面）
        };
    });
    wheels.sort(function (a, b) { return a.hub.depth - b.hub.depth; });

    // 接地影（先に全部）
    wheels.forEach(function (w) {
        ctx.beginPath();
        ctx.ellipse(w.ground.x, w.ground.y, r * 0.72, r * 0.30, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.30)';
        ctx.fill();
    });

    ctx.lineCap = 'round';
    wheels.forEach(function (w) {
        // ストラット（サス）: 太いバー＋白ハイライトで伸縮を色表現
        ctx.beginPath(); ctx.moveTo(w.top.x, w.top.y); ctx.lineTo(w.hub.x, w.hub.y);
        ctx.lineWidth = 7; ctx.strokeStyle = w.col; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(w.top.x, w.top.y); ctx.lineTo(w.hub.x, w.hub.y);
        ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.stroke();
        // 取付点マーカー
        ctx.beginPath(); ctx.arc(w.top.x, w.top.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = w.col; ctx.fill();

        // ホイール（投影円 ≒ 楕円） + サス色のリム
        ctx.beginPath();
        ctx.ellipse(w.hub.x, w.hub.y, r * 0.6, r, 0, 0, Math.PI * 2);
        ctx.fillStyle = ATTITUDE_COLORS.wheel; ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = w.col; ctx.stroke();
    });
    ctx.lineCap = 'butt';
}

// サス凡例（縮み=赤 / 伸び=青）
function drawLegend() {
    var ctx = car3DState.ctx;
    var y = car3DState.H - 12;
    ctx.font = '9px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    var items = [
        [ATTITUDE_COLORS.strutCompress, '縮み'],
        [ATTITUDE_COLORS.strutExtend, '伸び']
    ];
    var x = 8;
    items.forEach(function (it) {
        ctx.fillStyle = it[0];
        ctx.fillRect(x, y - 4, 14, 4);
        ctx.fillStyle = 'rgba(190,205,225,0.75)';
        ctx.fillText(it[1], x + 18, y - 1);
        x += 62;
    });
}

// PITCH / ROLL / YAW をキャンバス右上に描画
function drawReadout() {
    var ctx = car3DState.ctx;
    var deg = 180 / Math.PI;
    var rows = [
        ['PITCH', car3DState.pitch * deg],
        ['ROLL', car3DState.roll * deg],
        ['YAW', car3DState.yaw * deg]
    ];
    var x = car3DState.W - 10, y0 = 14;
    ctx.textBaseline = 'middle';
    rows.forEach(function (r, i) {
        var y = y0 + i * 17;
        ctx.textAlign = 'right';
        ctx.font = '700 13px "Segoe UI", system-ui, sans-serif';
        ctx.fillStyle = '#EAF1FA';
        ctx.fillText((r[1] >= 0 ? '+' : '') + r[1].toFixed(1) + '°', x, y);
        ctx.font = '700 9px "Segoe UI", system-ui, sans-serif';
        ctx.fillStyle = 'rgba(150,172,200,0.85)';
        ctx.fillText(r[0], x - 52, y);
    });
    ctx.textAlign = 'left';
}

function render() {
    var ctx = car3DState.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, car3DState.W, car3DState.H);
    drawGround();
    drawBody();
    drawWheels();   // 車体の後に描き、4輪すべて見えるようにする
    drawLegend();
    drawReadout();
}

function renderLoop() {
    car3DState.animationId = requestAnimationFrame(renderLoop);
    if (!car3DState.needsRender) return;
    car3DState.needsRender = false;
    render();
}
