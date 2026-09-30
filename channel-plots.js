/**
 * GT7 Telemetry Dashboard - REVIEW 散布図・チャンネル分布 (#555 T6/T7)
 *
 * 実レース用解析ソフトの標準表示(McLaren ATLAS の Scatterplot / Histogram、
 * AiM RaceStudio3 の Scatter / Histogram)に相当する2つの表示を、A/B の比較データから描く。
 *  - SCATTER: 任意の2チャンネル(X/Y)の散布図。A=青・B=緑。例: 速度と縦加速度、ブレーキとタイム差。
 *  - HISTOGRAM: 1チャンネルの分布(サンプルの割合[%])。A=青・B=緑の棒を並べる。
 *    例: スロットル・ブレーキの使い方の分布、使用ギアの分布。
 *
 * 前提と限界:
 *  - 記録されたラップのチャンネルは、速度・スロットル・ブレーキ・ギア・位置・時刻のみ
 *    (舵角・ブレーキ圧・タイヤ温度などは含まれない)。このため軸に選べるのは、これらと、
 *    そこから求めた「距離」「縦加速度」「タイム差(A−B)」に限られる。
 *  - 散布図は距離10m刻みの点(距離で均等)、分布は記録サンプル(時間で均等)から作る。
 *  - タイム差は、同一コースで走行距離差が 3% 以内の A/B のときだけ使える(review-view.js の共通判定)。
 *
 * 契約: review-view.js の reviewNotifyExtras() から cpOnReviewCompare(a, b) が呼ばれる唯一のフック。
 * IIFE で隔離し、公開するグローバルは cpOnReviewCompare のみ。
 */
(function() {
    'use strict';

    const HIST_BINS = 20;
    const CANVAS_H = 240;
    const PAD = { l: 46, r: 12, t: 10, b: 30 };
    const COLOR_A = '#3D9BFF';
    const COLOR_B = '#1F9E57';

    // 軸に選べるチャンネル。get(res, k, other, sign) は距離グリッド上の値(無ければ null)。
    // sign は、そのラップが A なら +1、B なら -1(タイム差は常に A−B で表すため)。
    const SCATTER_CHANNELS = [
        { key: 'speed', label: '速度 [km/h]', get: function(r, k) { return r.speed[k]; } },
        { key: 'throttle', label: 'スロットル [%]', get: function(r, k) { return r.throttle[k]; } },
        { key: 'brake', label: 'ブレーキ [%]', get: function(r, k) { return r.brake[k]; } },
        { key: 'dist', label: '距離 [m]', get: function(r, k) { return r.dist[k]; } },
        { key: 'accel', label: '縦加速度 [m/s²]', get: accelAt },
        { key: 'delta', label: 'タイム差 A−B [s]', needsPair: true, get: function(r, k, other, sign) {
            return (other && k < other.time.length) ? sign * (r.time[k] - other.time[k]) : null;
        } }
    ];
    // 分布に選べるチャンネル(記録サンプルから)
    const HIST_CHANNELS = [
        { key: 'throttle', label: 'スロットル [%]', min: 0, max: 100 },
        { key: 'brake', label: 'ブレーキ [%]', min: 0, max: 100 },
        { key: 'speed', label: '速度 [km/h]', min: 0, max: null },
        { key: 'gear', label: 'ギア', min: 0, max: null, integer: true }
    ];

    const state = {
        a: null, b: null,
        mode: 'scatter',
        x: 'speed', y: 'accel', h: 'throttle',
        ro: null
    };

    function byId(id) {
        return document.getElementById(id);
    }

    /** 縦加速度[m/s²]: 前後の格子点の速度差÷時間差(端は null)。 */
    function accelAt(r, k) {
        if (k <= 0 || k >= r.speed.length - 1) {
            return null;
        }
        const dt = r.time[k + 1] - r.time[k - 1];
        return dt > 0 ? (r.speed[k + 1] - r.speed[k - 1]) / 3.6 / dt : null;
    }

    function channel(list, key) {
        return list.filter(function(c) { return c.key === key; })[0] || list[0];
    }

    /** A/B が距離で対応づけられるか(review-view.js の共通判定)。 */
    function pairComparable() {
        return typeof reviewComparable === 'function' && reviewComparable(state.a, state.b).ok;
    }

    function cssVar(name, fallback) {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return v || fallback;
    }

    /* ---------------- 散布図 ---------------- */

    /** 1ラップ分の点 [{x, y}] と、相関係数(2点未満は null)。 */
    function scatterPoints(res, other, cx, cy, sign) {
        const pts = [];
        const n = res.dist.length;
        for (let k = 0; k < n; k++) {
            const x = cx.get(res, k, other, sign);
            const y = cy.get(res, k, other, sign);
            if (x != null && y != null && isFinite(x) && isFinite(y)) {
                pts.push({ x: x, y: y });
            }
        }
        return pts;
    }

    function pearson(pts) {
        const n = pts.length;
        if (n < 3) {
            return null;
        }
        let sx = 0, sy = 0;
        pts.forEach(function(p) { sx += p.x; sy += p.y; });
        const mx = sx / n, my = sy / n;
        let sxy = 0, sxx = 0, syy = 0;
        pts.forEach(function(p) {
            sxy += (p.x - mx) * (p.y - my);
            sxx += (p.x - mx) * (p.x - mx);
            syy += (p.y - my) * (p.y - my);
        });
        return (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : null;
    }

    /**
     * 軸の範囲。記録の途切れ付近などで出る少数の外れ値(例: 時間差がほぼ0の縦加速度)で、
     * 大半の点が潰れないよう、20点以上あるときは上下1%を除いた範囲(±25%の余白)にする。
     * 範囲外の点は描かず、件数を表示する。
     */
    function robustExtent(values) {
        const n = values.length;
        if (n < 20) {
            return extent(values);
        }
        const a = values.slice().sort(function(x, y) { return x - y; });
        const lo = a[Math.floor(0.01 * (n - 1))];
        const hi = a[Math.floor(0.99 * (n - 1))];
        const span = (hi - lo) || 1;
        return [lo - 0.25 * span, hi + 0.25 * span];
    }

    function extent(values) {
        let lo = Infinity, hi = -Infinity;
        values.forEach(function(v) {
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        });
        if (!isFinite(lo)) {
            return [0, 1];
        }
        if (hi === lo) {
            return [lo - 1, hi + 1];
        }
        const pad = (hi - lo) * 0.04;
        return [lo - pad, hi + pad];
    }

    function fmtTick(v) {
        const a = Math.abs(v);
        return a >= 100 ? String(Math.round(v)) : a >= 10 ? v.toFixed(0) : v.toFixed(1);
    }

    /* ---------------- 描画の共通部 ---------------- */

    function prepCanvas() {
        const canvas = byId('cp-canvas');
        const wrap = byId('cp-wrap');
        if (!canvas || !wrap || wrap.clientWidth <= 0) {
            return null;
        }
        const dpr = window.devicePixelRatio || 1;
        const w = wrap.clientWidth;
        canvas.style.width = w + 'px';
        canvas.style.height = CANVAS_H + 'px';
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(CANVAS_H * dpr);
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, CANVAS_H);
        return { ctx: ctx, w: w, h: CANVAS_H };
    }

    function drawAxes(c, xr, yr, xLabel, yLabel, xFmt) {
        const ctx = c.ctx;
        const grid = cssVar('--border-hairline', '#2a2f36');
        const text = cssVar('--text-secondary', '#9aa4ad');
        const pw = c.w - PAD.l - PAD.r;
        const ph = c.h - PAD.t - PAD.b;
        ctx.strokeStyle = grid;
        ctx.fillStyle = text;
        ctx.lineWidth = 1;
        ctx.font = '10px sans-serif';
        for (let i = 0; i <= 4; i++) {
            const gx = PAD.l + pw * i / 4;
            const gy = PAD.t + ph * i / 4;
            ctx.beginPath(); ctx.moveTo(gx, PAD.t); ctx.lineTo(gx, PAD.t + ph); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(PAD.l, gy); ctx.lineTo(PAD.l + pw, gy); ctx.stroke();
            ctx.textAlign = 'center';
            ctx.fillText((xFmt || fmtTick)(xr[0] + (xr[1] - xr[0]) * i / 4), gx, c.h - PAD.b + 13);
            ctx.textAlign = 'right';
            ctx.fillText(fmtTick(yr[1] - (yr[1] - yr[0]) * i / 4), PAD.l - 5, gy + 3);
        }
        ctx.textAlign = 'center';
        ctx.fillText(xLabel, PAD.l + pw / 2, c.h - 4);
        ctx.save();
        ctx.translate(11, PAD.t + ph / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(yLabel, 0, 0);
        ctx.restore();
        return { pw: pw, ph: ph };
    }

    function message(c, text) {
        c.ctx.fillStyle = cssVar('--text-muted', '#6b7580');
        c.ctx.font = '12px sans-serif';
        c.ctx.textAlign = 'center';
        c.ctx.fillText(text, c.w / 2, c.h / 2);
    }

    function setReadout(text) {
        const el = byId('cp-readout');
        if (el) {
            el.textContent = text;
        }
    }

    /* ---------------- 各モードの描画 ---------------- */

    function drawScatter() {
        const c = prepCanvas();
        if (!c) {
            return;
        }
        const ra = state.a && state.a.res;
        const rb = state.b && state.b.res;
        if (!ra && !rb) {
            message(c, 'A/B のラップを選択してください');
            setReadout('');
            return;
        }
        const cx = channel(SCATTER_CHANNELS, state.x);
        const cy = channel(SCATTER_CHANNELS, state.y);
        if ((cx.needsPair || cy.needsPair) && !pairComparable()) {
            message(c, 'タイム差は、同一コースで走行距離が近い A/B を選んだときだけ使えます');
            setReadout('');
            return;
        }
        const pa = ra ? scatterPoints(ra, rb, cx, cy, 1) : [];
        const pb = rb ? scatterPoints(rb, ra, cx, cy, -1) : [];
        const all = pa.concat(pb);
        if (!all.length) {
            message(c, '描画できる点がありません');
            setReadout('');
            return;
        }
        const xr = robustExtent(all.map(function(p) { return p.x; }));
        const yr = robustExtent(all.map(function(p) { return p.y; }));
        const inside = function(p) { return p.x >= xr[0] && p.x <= xr[1] && p.y >= yr[0] && p.y <= yr[1]; };
        const va = pa.filter(inside);
        const vb = pb.filter(inside);
        const dims = drawAxes(c, xr, yr, cx.label, cy.label);
        const ctx = c.ctx;
        const sx = function(v) { return PAD.l + (v - xr[0]) / (xr[1] - xr[0]) * dims.pw; };
        const sy = function(v) { return PAD.t + dims.ph - (v - yr[0]) / (yr[1] - yr[0]) * dims.ph; };
        [[vb, COLOR_B], [va, COLOR_A]].forEach(function(set) {
            ctx.fillStyle = set[1];
            ctx.globalAlpha = 0.55;
            set[0].forEach(function(p) {
                ctx.beginPath();
                ctx.arc(sx(p.x), sy(p.y), 2, 0, Math.PI * 2);
                ctx.fill();
            });
        });
        ctx.globalAlpha = 1;
        // 相関係数は、表示している点(範囲内)だけで求める
        const rA = pearson(va);
        const rB = pearson(vb);
        const fr = function(r) { return r == null ? '--' : (r >= 0 ? '+' : '') + r.toFixed(2); };
        const hidden = (pa.length - va.length) + (pb.length - vb.length);
        setReadout('A(青): ' + pa.length + '点 相関 r=' + fr(rA) + '  /  B(緑): ' + pb.length + '点 相関 r=' + fr(rB) +
            '  ※点は距離10mごと' + (hidden ? '。外れ値 ' + hidden + '点は範囲外のため非表示' : ''));
    }

    /** 記録サンプルから、チャンネルの分布(サンプル数の割合[%])を作る。 */
    function histogram(raw, ch, lo, hi, bins) {
        const counts = new Array(bins).fill(0);
        let n = 0;
        raw.forEach(function(s) {
            const v = s[ch.key];
            if (v == null || !isFinite(v)) {
                return;
            }
            let i = ch.integer ? Math.round(v) - lo : Math.floor((v - lo) / (hi - lo) * bins);
            i = Math.max(0, Math.min(bins - 1, i));
            counts[i]++;
            n++;
        });
        return { pct: counts.map(function(k) { return n ? k / n * 100 : 0; }), n: n };
    }

    function drawHistogram() {
        const c = prepCanvas();
        if (!c) {
            return;
        }
        const ea = state.a && state.a.raw;
        const eb = state.b && state.b.raw;
        if (!ea && !eb) {
            message(c, 'A/B のラップを選択してください');
            setReadout('');
            return;
        }
        const ch = channel(HIST_CHANNELS, state.h);
        const rows = [ea, eb].filter(Boolean);
        let lo = ch.min;
        let hi = ch.max;
        if (hi == null) {
            let mx = 0;
            rows.forEach(function(raw) {
                raw.forEach(function(s) { if (s[ch.key] > mx) mx = s[ch.key]; });
            });
            hi = ch.integer ? Math.max(mx, 1) : Math.max(20, Math.ceil(mx / 20) * 20);
        }
        const bins = ch.integer ? (hi - lo + 1) : HIST_BINS;
        const ha = ea ? histogram(ea, ch, lo, hi, bins) : null;
        const hb = eb ? histogram(eb, ch, lo, hi, bins) : null;
        let ymax = 5;
        [ha, hb].forEach(function(h) {
            if (h) h.pct.forEach(function(p) { if (p > ymax) ymax = p; });
        });
        ymax = Math.ceil(ymax / 5) * 5;
        // 横軸: 整数チャンネルは階級の中心=値、それ以外は範囲の端
        const xr = ch.integer ? [lo - 0.5, hi + 0.5] : [lo, hi];
        const dims = drawAxes(c, xr, [0, ymax], ch.label, '割合 [%]', ch.integer ? function(v) { return String(Math.round(v)); } : null);
        const ctx = c.ctx;
        const bw = dims.pw / bins;
        const draw = function(h, color, half, count) {
            if (!h) return;
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.85;
            h.pct.forEach(function(p, i) {
                const bh = p / ymax * dims.ph;
                const w = bw * 0.9 / count;
                const x = PAD.l + i * bw + bw * 0.05 + half * w;
                ctx.fillRect(x, PAD.t + dims.ph - bh, Math.max(1, w - 1), bh);
            });
            ctx.globalAlpha = 1;
        };
        const count = (ha ? 1 : 0) + (hb ? 1 : 0);
        draw(ha, COLOR_A, 0, count);
        draw(hb, COLOR_B, ha ? 1 : 0, count);
        setReadout('A(青): ' + (ha ? ha.n + 'サンプル' : '--') + '  /  B(緑): ' + (hb ? hb.n + 'サンプル' : '--') +
            '  ※記録サンプル(約10Hz)の割合。時間で均等');
    }

    function render() {
        if (state.mode === 'scatter') {
            drawScatter();
        } else {
            drawHistogram();
        }
    }

    /* ---------------- 操作 ---------------- */

    function fillSelect(sel, list, current) {
        sel.textContent = '';
        list.forEach(function(c) {
            const o = document.createElement('option');
            o.value = c.key;
            o.textContent = c.label;
            if (c.key === current) {
                o.selected = true;
            }
            sel.appendChild(o);
        });
    }

    function applyMode() {
        document.querySelectorAll('#cp-review-card .cp-tab').forEach(function(btn) {
            btn.setAttribute('aria-pressed', btn.dataset.cpMode === state.mode ? 'true' : 'false');
        });
        const sc = state.mode === 'scatter';
        byId('cp-scatter-controls').hidden = !sc;
        byId('cp-hist-controls').hidden = sc;
    }

    function init() {
        const card = byId('cp-review-card');
        if (!card) {
            return;
        }
        fillSelect(byId('cp-x'), SCATTER_CHANNELS, state.x);
        fillSelect(byId('cp-y'), SCATTER_CHANNELS, state.y);
        fillSelect(byId('cp-h'), HIST_CHANNELS, state.h);
        byId('cp-x').addEventListener('change', function(e) { state.x = e.target.value; render(); });
        byId('cp-y').addEventListener('change', function(e) { state.y = e.target.value; render(); });
        byId('cp-h').addEventListener('change', function(e) { state.h = e.target.value; render(); });
        card.querySelectorAll('.cp-tab').forEach(function(btn) {
            btn.addEventListener('click', function() {
                state.mode = btn.dataset.cpMode;
                applyMode();
                render();
            });
        });
        applyMode();
        // 幅の変化(REVIEW への切替・ウィンドウ幅)で再描画
        if (typeof ResizeObserver === 'function' && byId('cp-wrap')) {
            state.ro = new ResizeObserver(function() { render(); });
            state.ro.observe(byId('cp-wrap'));
        }
    }

    /** review-view.js から呼ばれる唯一のフック。a/b は reviewFetchDetail の戻り値(無ければ null)。 */
    window.cpOnReviewCompare = function(a, b) {
        state.a = a || null;
        state.b = b || null;
        render();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
