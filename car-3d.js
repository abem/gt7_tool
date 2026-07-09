/**
 * CAR ATTITUDE — 2D (Canvas2D) 姿勢 + サスペンション可視化
 *
 * WebGL/Three.js を使わず Canvas2D だけで、ロール/ピッチ/ヨーの姿勢と 4輪サスペンションを
 * 「針金（ワイヤーフレーム）」でアイソメトリック（クォータービュー）に図示する。各輪はダブル
 * ウィッシュボーン（上下Aアーム＋アップライト＋コイルオーバー）を線で表現し、サス伸縮を色で示す。
 * GPU 無し・リモートデスクトップ・どのブラウザでも必ず描画される。
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

// シャシー/サス寸法・カメラ（無次元, 車体ローカル: x=右, y=上, z=前）
var ATTITUDE_2D = {
    halfLen: 1.55,      // z 半分（前後・シャシー全長）
    halfWid: 0.62,      // x 半分（左右レール間）
    railY: 0.64,        // メインレール高さ
    hoopTop: 1.20,      // ロールフープ頂点高さ
    wheelR: 0.34,       // タイヤ半径
    // ダブルウィッシュボーン諸元
    cornerZ: 0.80,      // 車輪の z 位置（halfLen 比）
    armSpan: 0.60,      // レール→ホイールの横スパン（アーム張り出し）
    pivotSpread: 0.30,  // 内側ピボットの前後スパン（Aアーム）
    hubY: 0.42,         // 中立時ハブ高さ
    ubjRise: 0.24,      // アップライト上端（ハブより上）
    lbjDrop: 0.22,      // アップライト下端（ハブより下）
    strutTravel: 0.34,  // サス偏差でハブが上下する最大量
    camPitch: 0.52,     // カメラ見下ろし角（rad）
    camYaw: -0.66,      // カメラ方位角（rad）
    scale: 46,          // px/unit（init でフィット調整）
    horizonY: 0.58      // 基準線の縦位置（キャンバス高さ比）
};

var ATTITUDE_COLORS = {
    grid: 'rgba(120,140,170,0.18)',
    gridAxis: 'rgba(120,140,170,0.36)',
    frame: 'rgba(140,160,190,0.55)',      // シャシー細線
    frameHoop: 'rgba(175,200,235,0.80)',  // ロールフープ/コックピット枠
    arm: 'rgba(180,196,220,0.92)',        // ウィッシュボーン（アーム）
    upright: 'rgba(212,226,248,0.96)',    // アップライト/ハブキャリア
    pivot: 'rgba(150,170,200,0.90)',      // ピボット節点
    hub: '#0E1319',
    tyre: 'rgba(155,172,196,0.60)',       // タイヤ輪郭（細線）
    tyreFill: 'rgba(10,14,20,0.28)',
    strutCompress: '#E8563B',             // 縮み（荷重大, 赤）
    strutNeutral: '#5AD08A',
    strutExtend: '#43A6FF'                // 伸び（荷重小, 青）
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
    if (!car3DState.ctx) {
        // Canvas2D すら使えない極端な環境。契約どおり例外は投げず、静かに中止する（二重生成も防ぐ）。
        console.error('[ATTITUDE_2D] 2D context unavailable');
        container.removeChild(canvas);
        car3DState.canvas = null;
        return;
    }
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
    if (!c || !car3DState.ctx) return;
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
    // 車体（トラック幅＋前後長）が収まるよう自動スケール
    ATTITUDE_2D.scale = Math.min(w / 5.2, h / 3.6);
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
// 数値以外（undefined/NaN/±Infinity/文字列）を 0 に落とす。姿勢が NaN だと投影全体が NaN 化し、
// キャンバスが無音のまま真っ白になる（moveTo/lineTo が NaN で描画されない）のを防ぐ。
function finiteOr0(v) {
    v = +v;
    return isFinite(v) ? v : 0;
}

function updateCar3D(pitch, yaw, roll, rpm, steering, susp) {
    car3DState.pitch = finiteOr0(pitch);
    car3DState.yaw = finiteOr0(yaw);
    car3DState.roll = finiteOr0(roll);
    car3DState.steering = finiteOr0(steering);
    if (susp && susp.length >= 4) {
        car3DState.susp = [finiteOr0(susp[0]), finiteOr0(susp[1]), finiteOr0(susp[2]), finiteOr0(susp[3])];
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

// ── 針金（ワイヤーフレーム）描画ヘルパー ──────────────────────

// 投影済み2点間に線
function wire(a, b, width, col) {
    var ctx = car3DState.ctx;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.lineWidth = width; ctx.strokeStyle = col; ctx.stroke();
}
// 節点（ピボット/ボールジョイント）
function node(p, r, col) {
    var ctx = car3DState.ctx;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
}

// スペースフレーム風シャシー（針金）。車体姿勢で回転する。
function drawChassis() {
    var ctx = car3DState.ctx;
    var W = ATTITUDE_2D.halfWid, L = ATTITUDE_2D.halfLen, RY = ATTITUDE_2D.railY, HT = ATTITUDE_2D.hoopTop;
    ctx.lineCap = 'round';

    // メイン2本レール（左右）
    wire(projLocal(-W, RY, -L), projLocal(-W, RY, L), 2, ATTITUDE_COLORS.frame);
    wire(projLocal( W, RY, -L), projLocal( W, RY, L), 2, ATTITUDE_COLORS.frame);
    // クロスメンバー（前後バルクヘッド＋中間2本）
    [-L, -L * 0.35, L * 0.35, L].forEach(function (z) {
        wire(projLocal(-W, RY, z), projLocal(W, RY, z), 1.5, ATTITUDE_COLORS.frame);
    });
    // ノーズ（前方に収束）→ 前後の向きが分かる
    var nose = projLocal(0, RY, L * 1.28);
    wire(projLocal(-W, RY, L), nose, 1.5, ATTITUDE_COLORS.frame);
    wire(projLocal( W, RY, L), nose, 1.5, ATTITUDE_COLORS.frame);

    // ロールフープ（コックピット枠）: 主フープ + 前方ステー
    var zc = -L * 0.12;
    var hL = projLocal(-W, RY, zc), hR = projLocal(W, RY, zc);
    var tL = projLocal(-W * 0.72, HT, zc), tR = projLocal(W * 0.72, HT, zc);
    wire(hL, tL, 2, ATTITUDE_COLORS.frameHoop);
    wire(hR, tR, 2, ATTITUDE_COLORS.frameHoop);
    wire(tL, tR, 2, ATTITUDE_COLORS.frameHoop);
    wire(tL, projLocal(-W * 0.8, RY + 0.05, L * 0.5), 1.5, ATTITUDE_COLORS.frameHoop);
    wire(tR, projLocal( W * 0.8, RY + 0.05, L * 0.5), 1.5, ATTITUDE_COLORS.frameHoop);
    ctx.lineCap = 'butt';
}

// 1コーナー分のダブルウィッシュボーン幾何（車体ローカル→投影）
// susp 並びは FL, FR, RL, RR
function computeCorner(i) {
    var A = ATTITUDE_2D, W = A.halfWid, L = A.halfLen;
    var sx = (i % 2 === 0) ? -1 : 1;             // FL,RL=左(-1) / FR,RR=右(+1)
    var cz = (i < 2 ? 1 : -1) * L * A.cornerZ;   // FL,FR=前(+) / RL,RR=後(-)
    var norm = suspNorm()[i];
    var travel = norm * A.strutTravel;           // 伸び(norm>0)→ハブ下降（車体から離れる）
    var hubY = A.hubY - travel;

    var wheelX = sx * (W + A.armSpan);
    var bjX = sx * (W + A.armSpan * 0.80);       // ボールジョイントはハブより僅か内側
    var railX = sx * W;

    // ばね下（アップライト/ハブ/ボールジョイント）: travel で上下
    var ubj = [bjX, hubY + A.ubjRise, cz];
    var lbj = [bjX, hubY - A.lbjDrop, cz];
    var hub = [wheelX, hubY, cz];
    // ばね上（内側ピボット）: 車体固定（中立ハブ高さ基準で水平アーム）
    var uF = [railX, A.hubY + A.ubjRise, cz + A.pivotSpread];
    var uR = [railX, A.hubY + A.ubjRise, cz - A.pivotSpread];
    var lF = [railX, A.hubY - A.lbjDrop, cz + A.pivotSpread];
    var lR = [railX, A.hubY - A.lbjDrop, cz - A.pivotSpread];
    // コイルオーバー: 下アーム(ばね下)→シャシー上部(ばね上)。長さが伸縮の指標。
    var sprTop = [sx * W * 0.55, A.hubY + A.ubjRise + 0.50, cz];
    var sprBot = [sx * (W + A.armSpan * 0.45), hubY - A.lbjDrop * 0.35, cz];

    var wr = rotateAttitude(hub[0], hub[1], hub[2]); // 接地点（水平面）
    var P = function (q) { return projLocal(q[0], q[1], q[2]); };
    var pHub = P(hub);
    return {
        i: i, norm: norm, col: strutColor(norm), depth: pHub.depth,
        ubj: P(ubj), lbj: P(lbj), hub: pHub,
        uF: P(uF), uR: P(uR), lF: P(lF), lR: P(lR),
        sprTop: P(sprTop), sprBot: P(sprBot),
        ground: project(wr[0], 0, wr[2])
    };
}

// コイルばね（スクリーン空間のジグザグ; 端で振幅0）
function drawSpring(a, b, col) {
    var ctx = car3DState.ctx;
    var dx = b.x - a.x, dy = b.y - a.y;
    var len = Math.hypot(dx, dy) || 1;
    var nx = -dy / len, ny = dx / len;           // 単位法線
    var coils = 6, seg = 48, amp = Math.min(7, len * 0.16);
    ctx.beginPath();
    for (var k = 0; k <= seg; k++) {
        var t = k / seg;
        var off = Math.sin(t * coils * Math.PI * 2) * amp * Math.sin(Math.PI * t);
        var px = a.x + dx * t + nx * off;
        var py = a.y + dy * t + ny * off;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.lineWidth = 2.4; ctx.strokeStyle = col; ctx.lineCap = 'round'; ctx.stroke(); ctx.lineCap = 'butt';
}

// ホイール（針金: タイヤ輪郭＋サス色リム＋スポーク）
function drawWheelWire(c) {
    var ctx = car3DState.ctx;
    var r = ATTITUDE_2D.wheelR * ATTITUDE_2D.scale;
    var cx = c.hub.x, cy = c.hub.y, rx = r * 0.60, ry = r;
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = ATTITUDE_COLORS.tyreFill; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = ATTITUDE_COLORS.tyre; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(cx, cy, rx * 0.55, ry * 0.55, 0, 0, Math.PI * 2);
    ctx.lineWidth = 2.2; ctx.strokeStyle = c.col; ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = ATTITUDE_COLORS.tyre;
    for (var s = 0; s < 4; s++) {
        var ang = s * Math.PI / 4;
        ctx.beginPath(); ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(ang) * rx * 0.55, cy + Math.sin(ang) * ry * 0.55); ctx.stroke();
    }
    node(c.hub, 2.5, ATTITUDE_COLORS.hub);
}

// 1コーナー（上下ウィッシュボーン＋アップライト＋コイルオーバー＋ホイール）
function drawCorner(c) {
    var ctx = car3DState.ctx;
    ctx.lineCap = 'round';
    // 下ウィッシュボーン（Aアーム）
    wire(c.lF, c.lbj, 2.6, ATTITUDE_COLORS.arm);
    wire(c.lR, c.lbj, 2.6, ATTITUDE_COLORS.arm);
    // 上ウィッシュボーン
    wire(c.uF, c.ubj, 2.2, ATTITUDE_COLORS.arm);
    wire(c.uR, c.ubj, 2.2, ATTITUDE_COLORS.arm);
    // アップライト（ナックル）＋ハブキャリア
    wire(c.ubj, c.lbj, 3, ATTITUDE_COLORS.upright);
    wire({ x: (c.ubj.x + c.lbj.x) / 2, y: (c.ubj.y + c.lbj.y) / 2 }, c.hub, 2.4, ATTITUDE_COLORS.upright);
    // コイルオーバー（サス色）
    drawSpring(c.sprBot, c.sprTop, c.col);
    ctx.lineCap = 'butt';
    // 節点
    node(c.uF, 2, ATTITUDE_COLORS.pivot); node(c.uR, 2, ATTITUDE_COLORS.pivot);
    node(c.lF, 2, ATTITUDE_COLORS.pivot); node(c.lR, 2, ATTITUDE_COLORS.pivot);
    node(c.sprTop, 2.4, ATTITUDE_COLORS.pivot);
    node(c.ubj, 2.4, c.col); node(c.lbj, 2.4, c.col);
    // ホイール
    drawWheelWire(c);
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

    var corners = [0, 1, 2, 3].map(computeCorner);

    // 接地影（最下層）
    var r = ATTITUDE_2D.wheelR * ATTITUDE_2D.scale;
    corners.forEach(function (c) {
        ctx.beginPath();
        ctx.ellipse(c.ground.x, c.ground.y, r * 0.66, r * 0.26, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fill();
    });

    drawChassis();
    // 奥→手前でコーナーを描く（針金なので厳密でなくてよいが自然な重なりに）
    corners.slice().sort(function (a, b) { return a.depth - b.depth; }).forEach(drawCorner);

    drawLegend();
    drawReadout();
}

function renderLoop() {
    car3DState.animationId = requestAnimationFrame(renderLoop);
    if (!car3DState.needsRender) return;
    car3DState.needsRender = false;
    render();
}

// ページ読み込み時に自動初期化する。WebSocket 接続や TEST MODE を待たずに、まず中立姿勢の図を
// 必ず表示する（未接続でも「何も出ない」を防ぐ）。initCar3D は initialized ガードで冪等。
function autoInitCar3D() {
    if (document.getElementById('car-3d-view')) initCar3D();
}
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInitCar3D);
    } else {
        autoInitCar3D();
    }
}
