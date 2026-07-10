/**
 * STEER RESPONSE — 舵角 vs 実際の旋回（アンダー/オーバーステアの図解）
 *
 * 「ステアをこれだけ切ったら、車は本当はどれだけ曲がっているか」を上から見た図で示す。
 *   - 狙い(commanded): ステア角から求めた中立ステア時の走行ライン（弧）
 *   - 実際(actual):     ヨーレート ω から求めた実際の走行ライン（弧, κ=ω/v は幾何的に厳密）
 *   実際の弧が狙いより緩い→アンダーステア / きつい→オーバーステア。
 *
 * 中立基準ゲイン: ω_exp = v · δsw / NEUTRAL_L。NEUTRAL_L は実テレメトリ(≈61)由来の
 *   フリート中央値。線形領域(低横G)で車ごとに緩く自動較正する。
 *
 * データの根拠(gt7data 実測): wheel_rotation は「ステアリングホイール角(±π rad)」で
 *   前輪切れ角ではない。ヨーレートとは符号一致(corr +0.76)。κ_act=ω/v は前提不要で厳密。
 *
 * Canvas2D・依存なし・プレーンスクリプト。読み込み時に自動初期化（car-3d.js と同方式）。
 */

var STEER_RESP = {
    neutralL: 61,          // 中立操舵ゲイン基準（ω_exp = v·δsw/neutralL）実測中央値・車ごとに自動較正
    calibAlpha: 0.008,     // 自動較正 EMA 係数（0で固定）
    calibClamp: [25, 130], // neutralL の許容範囲
    calibSpeedMin: 6,      // 較正サンプルの速度下限 (m/s)
    calibSpeedMax: 28,     // 較正サンプルの速度上限 (m/s)。低速側=よりキネマティック=幾何ゲインを学習
    minSpeed: 4,           // m/s 未満は判定停止（低速は幾何が支配的・意味薄）
    minSteer: 0.05,        // rad 未満のステアは直進扱い
    pathMeters: 46,        // 弧を描く前方距離(m 相当)
    curveGain: 1.0,        // 曲率の表示倍率（1=素の幾何）
    smooth: 0.25           // 表示平滑化(EMA)
};

var STEER_COLORS = {
    bg: '#0E1319',
    grid: 'rgba(255,255,255,0.05)',
    ref: 'rgba(255,255,255,0.22)',
    car: '#C6CDD6',
    cmd: '#3D9BFF',                 // 狙い（ステア）
    cmdFill: 'rgba(61,155,255,0.10)',
    act: '#EC835A',                // 実際
    under: '#FAB219',              // アンダー（黄）
    over: '#D84B4F',               // オーバー（赤）
    neutral: '#1F9E57',            // ニュートラル（緑）
    text: '#F2F5F8',
    textDim: '#8A93A0'
};

var steerRespState = {
    initialized: false,
    canvas: null, ctx: null,
    W: 0, H: 0, dpr: 1,
    resizeObserver: null, animationId: null,
    steer: 0,      // ステアリングホイール角 (rad)
    yaw: 0,        // ヨーレート (rad/s)
    speed: 0,      // m/s
    latG: 0,       // 横G (m/s^2)
    // 平滑化表示値
    sCmdK: 0, sActK: 0, sBal: 0,
    needsRender: true
};

function srFiniteOr0(v) { v = +v; return isFinite(v) ? v : 0; }

/**
 * 毎フレーム更新（websocket.js / test-mode.js から）
 * @param {number} steerRad ステアリングホイール角 (rad, data.wheel_rotation)
 * @param {number} yawRadS  ヨーレート (rad/s, data.angular_velocity_y)
 * @param {number} speedMs  速度 (m/s)
 * @param {number} latG     横加速度 (m/s^2, data.body_accel_sway)
 */
function updateSteerResponse(steerRad, yawRadS, speedMs, latG) {
    var s = steerRespState;
    s.steer = srFiniteOr0(steerRad);
    s.yaw = srFiniteOr0(yawRadS);
    s.speed = Math.max(0, srFiniteOr0(speedMs));
    s.latG = srFiniteOr0(latG);

    // 低速側(≈キネマティック領域)の緩い旋回で車固有の中立(幾何)ゲインを自動較正する。
    //  - 低〜中速に限定＝スリップが小さく幾何ゲインに近い（高速のアンダーステア分を基準に混ぜない）。
    //  - TEST MODE の合成データでは較正しない（実走基準を汚さないため）。
    var C = STEER_RESP;
    var inTest = (typeof testModeActive !== 'undefined') && testModeActive;
    if (!inTest && C.calibAlpha > 0 &&
        s.speed > C.calibSpeedMin && s.speed < C.calibSpeedMax &&
        Math.abs(s.steer) > 0.06 && Math.abs(s.yaw) > 0.02 && s.steer * s.yaw > 0 &&
        Math.abs(s.latG) < 0.5 * 9.81) {
        var obs = Math.abs(s.steer) * s.speed / Math.abs(s.yaw);   // δsw·v/ω = 低速実効(幾何)ゲイン
        if (isFinite(obs) && obs > 0) {
            var g = C.neutralL + (obs - C.neutralL) * C.calibAlpha;
            C.neutralL = Math.max(C.calibClamp[0], Math.min(C.calibClamp[1], g));
        }
    }
    s.needsRender = true;
}

// 現在の狙い/実際の曲率とバランスを算出（表示前の平滑化なし版）
function computeSteerMetrics() {
    var s = steerRespState, C = STEER_RESP;
    var v = s.speed;
    var active = v >= C.minSpeed;
    // 実際の曲率 κ_act = ω / v （幾何的に厳密。方向は ω 符号）
    var kAct = (v > 0.5) ? (s.yaw / v) : 0;
    // 狙いの曲率 κ_cmd = δsw / L_eff / v * v = δsw/L_eff … 中立ヨーレート ω_exp=v·δsw/L → κ_cmd=ω_exp/v=δsw/L
    var kCmd = s.steer / C.neutralL;
    // 有効ステアがごく小さいときは直進
    if (Math.abs(s.steer) < C.minSteer) kCmd = 0;
    // バランス = 実際ヨーレート / 期待ヨーレート（>1 オーバー / <1 アンダー）。旋回時のみ。
    var wExp = v * kCmd;             // 期待ヨーレート(signed)
    var bal = 0, ratio = 1, mode = 'neutral';
    if (active && Math.abs(wExp) > 0.03) {
        if (wExp * s.yaw < 0) {
            // 逆位相（スピン/カウンター）→ 強オーバー扱い。ヨー=0(直進プラウ)はここに含めない
            ratio = 2; mode = 'over';
        } else {
            ratio = Math.abs(s.yaw) / Math.abs(wExp);
            mode = ratio < 0.9 ? 'under' : (ratio > 1.1 ? 'over' : 'neutral');
        }
        // bal: -1(強アンダー)..0(中立)..+1(強オーバー) 相当（log スケール）
        bal = Math.max(-1, Math.min(1, Math.log(ratio) / Math.log(2)));
    }
    return { active: active, kAct: kAct, kCmd: kCmd, wExp: wExp, ratio: ratio, bal: bal, mode: mode };
}

/* ── 初期化・リサイズ・描画ループ（car-3d.js と同方式） ────────────── */

function initSteerResponse() {
    var s = steerRespState;
    if (s.initialized) return;
    var container = document.getElementById('steer-response-view');
    if (!container) { return; }
    var canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    container.appendChild(canvas);
    s.canvas = canvas;
    s.ctx = canvas.getContext('2d');
    if (!s.ctx) { container.removeChild(canvas); s.canvas = null; return; }
    resizeSteerResponse();
    s.resizeObserver = new ResizeObserver(resizeSteerResponse);
    s.resizeObserver.observe(container);
    s.initialized = true;
    steerRenderLoop();
}

function resizeSteerResponse() {
    var s = steerRespState, c = s.canvas;
    if (!c || !s.ctx) return;
    var rect = c.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    var dpr = window.devicePixelRatio || 1;
    s.W = w; s.H = h; s.dpr = dpr;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    s.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    s.needsRender = true;
}

// 曲率 κ の弧を、原点(車)から上向きに ds ずつ積分して描く（0=直進, +で右へ）
function steerPath(ox, oy, kappa, pxPerM, color, width, dash) {
    var ctx = steerRespState.ctx, C = STEER_RESP;
    var k = kappa * C.curveGain;
    var ds = 0.5;                       // m 刻み
    var n = Math.floor(C.pathMeters / ds);
    var x = 0, y = 0, hd = -Math.PI / 2; // 進行方向: 上(-90°)
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    for (var i = 0; i < n; i++) {
        hd += k * ds;                   // κ>0 で時計回り(右)へ
        x += Math.cos(hd) * ds;
        y += Math.sin(hd) * ds;
        var px = ox + x * pxPerM, py = oy + y * pxPerM;
        ctx.lineTo(px, py);
    }
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (dash) ctx.setLineDash(dash); else ctx.setLineDash([]);
    ctx.stroke();
    ctx.setLineDash([]);
}

function drawCarGlyph(ctx, cx, cy, scale) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = STEER_COLORS.car;
    ctx.strokeStyle = STEER_COLORS.car;
    ctx.lineWidth = 1.2;
    var w = 9 * scale, l = 16 * scale;
    // 上向きの矢印風車体
    ctx.beginPath();
    ctx.moveTo(0, -l);
    ctx.lineTo(w, l * 0.7);
    ctx.lineTo(0, l * 0.4);
    ctx.lineTo(-w, l * 0.7);
    ctx.closePath();
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
}

function renderSteerResponse() {
    var s = steerRespState, ctx = s.ctx;
    if (!ctx) return;
    var W = s.W, H = s.H;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = STEER_COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    var m = computeSteerMetrics();
    // 平滑化
    var a = STEER_RESP.smooth;
    s.sCmdK += (m.kCmd - s.sCmdK) * a;
    s.sActK += (m.kAct - s.sActK) * a;
    s.sBal += (m.bal - s.sBal) * a;

    // 図の原点（車）: 下部中央。前方(上)に弧を伸ばす
    var ox = W * 0.5;
    var oy = H * 0.80;
    var forward = oy - H * 0.10;                 // 使える前方高さ
    var pxPerM = forward / STEER_RESP.pathMeters; // m→px

    // 直進基準（破線）
    ctx.strokeStyle = STEER_COLORS.ref;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 5]);
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox, oy - forward); ctx.stroke();
    ctx.setLineDash([]);

    // 弧: 狙い(cmd) と 実際(act)
    var balColor = s.sBal < -0.08 ? STEER_COLORS.under : (s.sBal > 0.08 ? STEER_COLORS.over : STEER_COLORS.neutral);
    if (m.active) {
        steerPath(ox, oy, s.sCmdK, pxPerM, STEER_COLORS.cmd, 2.4, [7, 5]);   // 狙い=破線青
        steerPath(ox, oy, s.sActK, pxPerM, STEER_COLORS.act, 3.2, null);      // 実際=実線オレンジ
    }

    // 車グリフ
    drawCarGlyph(ctx, ox, oy, Math.max(0.8, Math.min(W, H) / 180));

    // ── バランスバー（下部） UNDER ← ● → OVER ──
    var barY = H - 16, barX0 = W * 0.14, barX1 = W * 0.86, barW = barX1 - barX0;
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(barX0, barY); ctx.lineTo(barX1, barY); ctx.stroke();
    // 中央目盛
    ctx.strokeStyle = 'rgba(255,255,255,0.30)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(barX0 + barW / 2, barY - 6); ctx.lineTo(barX0 + barW / 2, barY + 6); ctx.stroke();
    // ニードル
    var nx = barX0 + barW * (0.5 + s.sBal * 0.5);
    ctx.fillStyle = balColor;
    ctx.beginPath(); ctx.arc(nx, barY, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = STEER_COLORS.textDim; ctx.font = '9px system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left'; ctx.fillText('アンダー', barX0, barY - 9);
    ctx.textAlign = 'right'; ctx.fillText('オーバー', barX1, barY - 9);

    // ── 数値・凡例 ──
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    var pad = 8;
    // 凡例
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = STEER_COLORS.cmd; ctx.fillText('― 狙い(ステア)', pad, pad);
    ctx.fillStyle = STEER_COLORS.act; ctx.fillText('― 実際(ヨー)', pad, pad + 13);

    // 右上の数値
    ctx.textAlign = 'right';
    var deg = function (r) { return (r * 180 / Math.PI); };
    var rAct = (Math.abs(m.kAct) > 1e-4) ? (1 / Math.abs(m.kAct)) : Infinity;
    ctx.fillStyle = STEER_COLORS.textDim; ctx.font = '10px system-ui, sans-serif';
    ctx.fillText('舵角 ' + deg(s.steer).toFixed(0) + '°', W - pad, pad);
    ctx.fillText('ヨー ' + deg(s.yaw).toFixed(0) + '°/s', W - pad, pad + 13);
    ctx.fillText('横G ' + (s.latG / 9.81).toFixed(2), W - pad, pad + 26);
    ctx.fillText('R ' + (isFinite(rAct) && rAct < 999 ? rAct.toFixed(0) + 'm' : '—'), W - pad, pad + 39);

    // ── 状態ラベル（中央） ──
    var label, lcol;
    if (!m.active) { label = '—'; lcol = STEER_COLORS.textDim; }
    else if (m.mode === 'under') { label = 'アンダー'; lcol = STEER_COLORS.under; }
    else if (m.mode === 'over') { label = 'オーバー'; lcol = STEER_COLORS.over; }
    else { label = 'ニュートラル'; lcol = STEER_COLORS.neutral; }
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = lcol; ctx.font = '600 14px system-ui, sans-serif';
    ctx.fillText(label, W * 0.5, H * 0.16);
    if (m.active && m.mode !== 'neutral') {
        var pct = Math.round(Math.abs(1 - m.ratio) * 100);
        ctx.fillStyle = STEER_COLORS.textDim; ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(pct + '%', W * 0.5, H * 0.16 + 13);
    }
}

function steerRenderLoop() {
    steerRespState.animationId = requestAnimationFrame(steerRenderLoop);
    steerRespState.needsRender = false;
    renderSteerResponse();
}

function autoInitSteerResponse() {
    if (document.getElementById('steer-response-view')) initSteerResponse();
}
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInitSteerResponse);
    } else {
        autoInitSteerResponse();
    }
}
