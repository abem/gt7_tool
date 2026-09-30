/**
 * GT7 Telemetry Dashboard - REVIEW トラックマップ (#552 T1)
 *
 * MoTeC i2 の Track Report / AiM RaceStudio3 の Track Map に相当する表示。
 * 走行ライン上に速度・ブレーキ・スロットルをグラデーションで重ね、制動点や
 * 加速区間を空間的に把握する。A ラップは色分けの太線、B ラップは白の破線で重ねる。
 *
 * 契約:
 *  - データは review-view.js が距離グリッドへリサンプル済みの {x[], z[], speed[],
 *    brake[], throttle[], dist[]} (reviewFetchDetail の res)。新規のテレメトリ取得・
 *    API・バックエンド変更は無い。
 *  - review-view.js からは reviewNotifyExtras() 経由で tmOnReviewCompare(a, b) が
 *    呼ばれる(race-metrics.js の rmOnReviewCompare と同型)。segment-report.js の表の行から
 *    tmHighlightRange(i0, i1) で区間を強調する。
 *  - 全体を IIFE で隔離し、公開するグローバルは tmOnReviewCompare・tmHighlightRange・tmSetStability のみ
 *    (プレーン <script>・単一グローバルスコープの制約、名前衝突の回避)。
 */
(function() {
    'use strict';

    const MODES = {
        speed:    { label: 'SPEED',    unit: 'km/h', key: 'speed' },
        brake:    { label: 'BRAKE',    unit: '%',    key: 'brake' },
        throttle: { label: 'THROTTLE', unit: '%',    key: 'throttle' },
        // #562: コーナーごとのばらつき(corner-report.js が tmSetStability で与える)。0=安定〜1=ばらつき大
        stability: { label: 'STABILITY', unit: '', key: null }
    };

    const GAP_FACTOR = 4;          // 隣接点の距離が grid の何倍を超えたら線を切るか(データ欠落・ワープ対策)
    const MIN_CANVAS_H = 240;      // canvas 高さの下限/上限[CSS px]
    const MAX_CANVAS_H = 460;
    const CANVAS_ASPECT = 0.7;     // 高さ/幅
    const LEGEND_H = 30;           // 下部の凡例領域[CSS px]
    const PAD = 14;                // 描画領域の余白[CSS px]
    const LINE_A = 4;              // A(色分け)の線幅
    const LINE_B = 1.5;            // B(白)の線幅
    const HOVER_RADIUS = 28;       // ホバー判定の最大距離[CSS px]

    const state = {
        a: null,
        b: null,
        mode: 'speed',
        hover: -1,                 // 主ライン上のホバー中サンプル index
        range: null,               // 強調する区間 [i0, i1](segment-report.js から。null=なし)
        stability: null,           // #562: 距離グリッド index ごとの不安定度(0〜1、コーナー外は null)。null=未算出
        geom: null,                // 直近描画の幾何(ホバー判定用)
        lastW: 0
    };

    function byId(id) {
        return document.getElementById(id);
    }

    /** 有効な位置列を持つラップだけを返す。 */
    function usable(entry) {
        const r = entry && entry.res;
        if (!r || !r.x || !r.z || r.x.length < 2) {
            return null;
        }
        return r;
    }

    /** 速度: 青(遅い)→赤(速い)。 */
    function speedColor(t) {
        const clamped = Math.max(0, Math.min(1, t));
        return 'hsl(' + Math.round(240 - 240 * clamped) + ',85%,55%)';
    }

    /** ブレーキ/スロットル: グレー→指定色。 */
    function blendColor(t, to) {
        const clamped = Math.max(0, Math.min(1, t));
        const from = [75, 85, 99];
        const c = [0, 1, 2].map(function(i) {
            return Math.round(from[i] + (to[i] - from[i]) * clamped);
        });
        return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
    }

    /** ばらつき: 緑(安定)→黄→赤(ばらつき大)。 */
    function stabilityColor(t) {
        const clamped = Math.max(0, Math.min(1, t));
        return 'hsl(' + Math.round(120 - 120 * clamped) + ',80%,50%)';
    }

    function colorFor(mode, t) {
        if (mode === 'stability') {
            return stabilityColor(t);
        }
        if (mode === 'brake') {
            return blendColor(t, [239, 68, 68]);
        }
        if (mode === 'throttle') {
            return blendColor(t, [34, 197, 94]);
        }
        return speedColor(t);
    }

    /** 凡例に使う min/max。ブレーキ/スロットルは 0〜100% 固定、速度は主ラインの実測範囲。 */
    function metricRange(mode, r) {
        if (mode === 'stability') {
            return { min: 0, max: 1 };
        }
        if (mode !== 'speed') {
            return { min: 0, max: 100 };
        }
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < r.speed.length; i++) {
            const v = r.speed[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
        if (!isFinite(lo) || hi - lo < 1) {
            return { min: lo || 0, max: (lo || 0) + 1 };
        }
        return { min: lo, max: hi };
    }

    /** 描画対象全体のバウンディングボックス。位置が全て同一/未記録なら null。 */
    function bounds(list) {
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        list.forEach(function(r) {
            for (let i = 0; i < r.x.length; i++) {
                const x = r.x[i];
                const z = r.z[i];
                if (!isFinite(x) || !isFinite(z)) {
                    continue;
                }
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (z < minZ) minZ = z;
                if (z > maxZ) maxZ = z;
            }
        });
        if (!isFinite(minX) || (maxX - minX < 1 && maxZ - minZ < 1)) {
            return null;
        }
        return { minX: minX, maxX: maxX, minZ: minZ, maxZ: maxZ };
    }

    function drawMessage(ctx, w, h, text) {
        ctx.fillStyle = '#8b95a5';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, w / 2, h / 2);
    }

    /** 凡例(色バーと min/max)を canvas 下部へ描く。 */
    function drawLegend(ctx, w, h, mode, range) {
        // 「最小値 ▬▬(色バー)▬▬ 最大値」の並び。文字幅を実測して重ならないよう配置する。
        const unit = MODES[mode].unit;
        const stab = mode === 'stability';
        const minText = stab ? '安定' : Math.round(range.min) + ' ' + unit;
        const maxText = stab
            ? (state.stability ? 'ばらつき大' : 'ばらつき大(未算出: CORNER REPORT で読み込む)')
            : Math.round(range.max) + ' ' + unit;
        const y0 = h - LEGEND_H + 10;
        ctx.font = '11px sans-serif';
        const minW = ctx.measureText(minText).width;
        const maxW = ctx.measureText(maxText).width;
        const gap = 8;
        const barW = Math.max(40, Math.min(180, w - PAD * 2 - minW - maxW - gap * 2));
        const barX = PAD + minW + gap;

        ctx.fillStyle = '#c2c9d4';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(minText, PAD, y0 + 4);
        const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
        for (let i = 0; i <= 10; i++) {
            grad.addColorStop(i / 10, colorFor(mode, i / 10));
        }
        ctx.fillStyle = grad;
        ctx.fillRect(barX, y0, barW, 8);
        ctx.fillStyle = '#c2c9d4';
        ctx.fillText(maxText, barX + barW + gap, y0 + 4);
    }

    function render() {
        const canvas = byId('tm-canvas');
        if (!canvas) {
            return;
        }
        const wrap = canvas.parentNode;
        const cssW = Math.floor(wrap.clientWidth);
        if (cssW < 40) {
            return; // 非表示(REVIEW 以外)中は描かない
        }
        state.lastW = cssW;
        const cssH = Math.max(MIN_CANVAS_H, Math.min(MAX_CANVAS_H, Math.round(cssW * CANVAS_ASPECT)));
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
            canvas.width = Math.round(cssW * dpr);
            canvas.height = Math.round(cssH * dpr);
        }
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';

        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        state.geom = null;

        const ra = usable(state.a);
        const rb = usable(state.b);
        if (!ra && !rb) {
            drawMessage(ctx, cssW, cssH, state.a || state.b
                ? '位置データがありません'
                : 'A/B のラップを選択すると走行ラインを表示します');
            return;
        }

        const box = bounds([ra, rb].filter(Boolean));
        if (!box) {
            drawMessage(ctx, cssW, cssH, '位置データがありません');
            return;
        }

        const plotW = cssW - PAD * 2;
        const plotH = cssH - PAD * 2 - LEGEND_H;
        const dx = Math.max(box.maxX - box.minX, 1);
        const dz = Math.max(box.maxZ - box.minZ, 1);
        const scale = Math.min(plotW / dx, plotH / dz);
        const offX = PAD + (plotW - dx * scale) / 2;
        const offY = PAD + (plotH - dz * scale) / 2;
        // x は右、z は上(画面 y は反転)
        const toX = function(x) { return offX + (x - box.minX) * scale; };
        const toY = function(z) { return offY + (box.maxZ - z) * scale; };

        const gridM = ra && ra.dist.length > 1 ? ra.dist[1] - ra.dist[0]
            : (rb && rb.dist.length > 1 ? rb.dist[1] - rb.dist[0] : 5);
        const gapPx = Math.max(gridM * scale * GAP_FACTOR, 6);

        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // 主ライン: A(なければ B)を色分けで描く
        const main = ra || rb;
        const mode = state.mode;
        const range = metricRange(mode, main);
        const key = MODES[mode].key;
        const pts = [];
        ctx.lineWidth = ra ? LINE_A : LINE_B + 1;
        for (let i = 0; i < main.x.length; i++) {
            pts.push({ x: toX(main.x[i]), y: toY(main.z[i]) });
        }
        // 区間の強調(表の行ホバー時): 主ラインの下に太い半透明の白を敷く
        if (state.range && state.range[0] >= 0) {
            const r0 = Math.max(0, state.range[0]);
            const r1 = Math.min(pts.length - 1, state.range[1]);
            const prevWidth = ctx.lineWidth;
            ctx.strokeStyle = 'rgba(255,255,255,0.45)';
            ctx.lineWidth = LINE_A + 8;
            ctx.beginPath();
            for (let i = r0; i <= r1; i++) {
                if (i === r0 || Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) > gapPx) {
                    ctx.moveTo(pts[i].x, pts[i].y);
                } else {
                    ctx.lineTo(pts[i].x, pts[i].y);
                }
            }
            ctx.stroke();
            ctx.lineWidth = prevWidth;
        }
        for (let i = 1; i < pts.length; i++) {
            if (Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) > gapPx) {
                continue;
            }
            if (mode === 'stability') {
                // コーナー外・未算出の区間は、中立のグレー
                const s0 = state.stability ? state.stability[i - 1] : null;
                const s1 = state.stability ? state.stability[i] : null;
                ctx.strokeStyle = (s0 == null || s1 == null) ? 'rgb(75,85,99)' : stabilityColor((s0 + s1) / 2);
            } else {
                const v = (main[key][i] + main[key][i - 1]) / 2;
                ctx.strokeStyle = colorFor(mode, (v - range.min) / (range.max - range.min));
            }
            ctx.beginPath();
            ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
            ctx.lineTo(pts[i].x, pts[i].y);
            ctx.stroke();
        }

        // B: 白の破線(A の上に重ね、A と重なる区間でも見え、A の色も読めるようにする)
        if (rb) {
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.lineWidth = LINE_B;
            // 破線にして、A の色分けが透けて読めるようにする
            ctx.setLineDash([5, 4]);
            ctx.beginPath();
            let pen = false;
            for (let i = 0; i < rb.x.length; i++) {
                const px = toX(rb.x[i]);
                const py = toY(rb.z[i]);
                if (pen && Math.hypot(px - toX(rb.x[i - 1]), py - toY(rb.z[i - 1])) > gapPx) {
                    pen = false;
                }
                if (pen) {
                    ctx.lineTo(px, py);
                } else {
                    ctx.moveTo(px, py);
                    pen = true;
                }
            }
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // 記録開始位置
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#c2c9d4';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText('START', pts[0].x + 6, pts[0].y - 4);

        // ホバー中の点
        if (state.hover >= 0 && state.hover < pts.length) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(pts[state.hover].x, pts[state.hover].y, 7, 0, Math.PI * 2);
            ctx.stroke();
        }

        drawLegend(ctx, cssW, cssH, mode, range);
        state.geom = { pts: pts, main: main, mainIsA: !!ra };
    }

    function updateReadout() {
        const out = byId('tm-readout');
        if (!out) {
            return;
        }
        const g = state.geom;
        if (!g || state.hover < 0) {
            out.textContent = '線にカーソルを合わせると、その地点の値を表示します';
            return;
        }
        const i = state.hover;
        const m = g.main;
        const parts = [
            (g.mainIsA ? 'A' : 'B') + ' 距離 ' + Math.round(m.dist[i]).toLocaleString() + ' m',
            Math.round(m.speed[i]) + ' km/h',
            'ブレーキ ' + Math.round(m.brake[i]) + '%',
            'スロットル ' + Math.round(m.throttle[i]) + '%'
        ];
        const other = g.mainIsA ? usable(state.b) : null;
        if (other && i < other.speed.length) {
            parts.push('／ B ' + Math.round(other.speed[i]) + ' km/h');
        }
        out.textContent = parts.join(' ／ ');
    }

    function onPointerMove(ev) {
        const g = state.geom;
        if (!g) {
            return;
        }
        const rect = ev.currentTarget.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;
        let best = -1;
        let bestD = HOVER_RADIUS;
        for (let i = 0; i < g.pts.length; i++) {
            const d = Math.hypot(g.pts[i].x - mx, g.pts[i].y - my);
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        }
        if (best !== state.hover) {
            state.hover = best;
            render();
            updateReadout();
        }
    }

    function onPointerLeave() {
        if (state.hover !== -1) {
            state.hover = -1;
            render();
            updateReadout();
        }
    }

    function setMode(mode) {
        if (!MODES[mode]) {
            return;
        }
        state.mode = mode;
        document.querySelectorAll('[data-tm-mode]').forEach(function(btn) {
            btn.setAttribute('aria-pressed', btn.getAttribute('data-tm-mode') === mode ? 'true' : 'false');
        });
        render();
    }

    function init() {
        const canvas = byId('tm-canvas');
        if (!canvas) {
            return;
        }
        document.querySelectorAll('[data-tm-mode]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                setMode(btn.getAttribute('data-tm-mode'));
            });
        });
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerleave', onPointerLeave);
        // REVIEW への切替(display:none→表示)や幅変化で再描画する
        if (typeof ResizeObserver === 'function') {
            new ResizeObserver(function() {
                if (Math.floor(canvas.parentNode.clientWidth) !== state.lastW) {
                    render();
                }
            }).observe(canvas.parentNode);
        } else {
            window.addEventListener('resize', render);
        }
        render();
        updateReadout();
    }

    /**
     * review-view.js からの唯一のフック。A/B の詳細(res 付き)を受け取り再描画する。
     * @param {Object|null} a - {meta, res}
     * @param {Object|null} b - {meta, res}
     */
    window.tmOnReviewCompare = function(a, b) {
        state.a = a || null;
        state.b = b || null;
        state.hover = -1;
        state.range = null;   // 区間の強調も解除(segment-report.js の呼び出し順に依存しない)
        render();
        updateReadout();
    };

    /**
     * 区間 [i0, i1] を地図上で強調する(segment-report.js の表の行から)。
     * i0 < 0 で解除。インデックスは res の距離グリッド index(A 優先の主ラインと同一)。
     */
    window.tmHighlightRange = function(i0, i1) {
        state.range = (i0 >= 0 && i1 >= i0) ? [i0, i1] : null;
        render();
    };

    /**
     * コーナーごとのばらつき(#562)を、走行ラインの色分けに使う。
     * @param {Array<number|null>|null} levels - 距離グリッド index ごとの 0〜1(コーナー外は null)。null で解除
     * @param {boolean} [activate] - true なら STABILITY の色分けへ切り替える
     */
    window.tmSetStability = function(levels, activate) {
        state.stability = levels || null;
        if (activate && levels) {
            setMode('stability');
        } else {
            render();
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
