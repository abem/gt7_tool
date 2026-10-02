/**
 * GT7 Telemetry Dashboard - REVIEW 区間レポート (#552 T5)
 *
 * AiM RaceStudio3 の Split Times Report / Channels Report に相当する表。
 * 走行距離を N 等分した仮想区間ごとに、A/B の区間タイム・最高速・最低速・最大ブレーキ・
 * 平均スロットルを並べ、どの区間で時間や速度を失っているかを数値で示す。
 * 表の行にカーソルを合わせると、TRACK MAP の該当区間が強調される(RaceStudio3 の
 * 「表の行を選ぶとマップ上のトレースが強調される」挙動に相当)。
 *
 * 前提と限界:
 *  - GT7 は実セクタータイムを送らないため、区間は距離の等分で、実コーナーとは無関係。
 *  - 差分(Δ)は、同一コースかつ走行距離差が 3% 以内の A/B のときだけ算出する。
 *    それ以外は各ラップを自身の距離で等分した値を並べ、Δ は「--」とする。
 *
 * 契約: review-view.js の reviewNotifyExtras() から srOnReviewCompare(a, b) が呼ばれる
 * 唯一のフック。IIFE で隔離し、公開するグローバルは srOnReviewCompare のみ。
 * 地図の強調は track-map.js の tmHighlightRange(i0, i1) を typeof ガード付きで呼ぶ。
 */
(function() {
    'use strict';

    const SEGMENTS = 20;

    const state = { pinned: -1 };

    function byId(id) {
        return document.getElementById(id);
    }

    /**
     * A/B が同一コースで距離が近く、区間を対応づけられるか。
     * 判定は review-view.js の共通関数(コース情報が片方でも無い場合は不可)。
     */
    function comparable(a, b) {
        return typeof reviewComparable === 'function' ? reviewComparable(a, b).ok : false;
    }

    /**
     * 1 ラップの区間統計を返す。
     * @param {Object} r - res(dist/time/speed/throttle/brake の等間隔リサンプル列)
     * @param {number} n - 使用するサンプル数(区間の分割対象)
     */
    function segStats(r, n) {
        const out = [];
        for (let s = 0; s < SEGMENTS; s++) {
            const i0 = Math.floor((n - 1) * s / SEGMENTS);
            const i1 = Math.floor((n - 1) * (s + 1) / SEGMENTS);
            let vmax = -Infinity;
            let vmin = Infinity;
            let bmax = 0;
            let tsum = 0;
            let cnt = 0;
            for (let i = i0; i <= i1; i++) {
                if (r.speed[i] > vmax) vmax = r.speed[i];
                if (r.speed[i] < vmin) vmin = r.speed[i];
                if (r.brake[i] > bmax) bmax = r.brake[i];
                tsum += r.throttle[i];
                cnt++;
            }
            out.push({
                i0: i0,
                i1: i1,
                d0: r.dist[i0],
                d1: r.dist[i1],
                time: r.time[i1] - r.time[i0],
                vmax: vmax,
                vmin: vmin,
                bmax: bmax,
                thr: cnt ? tsum / cnt : 0
            });
        }
        return out;
    }

    function fmtS(v) {
        return v.toFixed(2);
    }

    function fmtPair(av, bv, digits) {
        const f = function(v) { return v == null ? '--' : v.toFixed(digits); };
        if (bv === undefined) {
            return f(av);
        }
        if (av === undefined) {
            return f(bv);
        }
        return f(av) + ' / ' + f(bv);
    }

    function clearTable() {
        const t = byId('sr-table');
        if (t) {
            t.textContent = '';
        }
    }

    function setSummary(text) {
        const el = byId('sr-summary');
        if (el) {
            el.textContent = text;
        }
    }

    function highlight(i0, i1) {
        if (typeof tmHighlightRange === 'function') {
            tmHighlightRange(i0, i1);
        }
    }

    function cell(tr, text, cls) {
        const td = document.createElement('td');
        td.textContent = text;
        if (cls) {
            td.className = cls;
        }
        tr.appendChild(td);
        return td;
    }

    function render(a, b) {
        clearTable();
        state.pinned = -1;
        highlight(-1, -1);
        const ra = a && a.res && a.res.time && a.res.time.length > SEGMENTS ? a.res : null;
        const rb = b && b.res && b.res.time && b.res.time.length > SEGMENTS ? b.res : null;
        if (!ra && !rb) {
            setSummary('A/B のラップを選択すると、区間ごとの数値を表示します');
            publishBounds(null, null, false);
            return;
        }

        const both = !!(ra && rb);
        const diffOk = both && comparable(a, b);
        const nCommon = both ? Math.min(ra.time.length, rb.time.length) : 0;
        const sa = ra ? segStats(ra, diffOk ? nCommon : ra.time.length) : null;
        const sb = rb ? segStats(rb, diffOk ? nCommon : rb.time.length) : null;
        const main = sa || sb;

        // 表本体
        const table = byId('sr-table');
        const thead = document.createElement('thead');
        const hr = document.createElement('tr');
        ['区間', '距離 (m)', 'タイム A', 'タイム B', 'Δ (A−B)', '最高速 A/B', '最低速 A/B', '最大ブレーキ A/B', '平均スロットル A/B']
            .forEach(function(h) {
                const th = document.createElement('th');
                th.textContent = h;
                hr.appendChild(th);
            });
        thead.appendChild(hr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        let worst = null;
        let best = null;
        for (let s = 0; s < SEGMENTS; s++) {
            const x = sa ? sa[s] : undefined;
            const y = sb ? sb[s] : undefined;
            const m = main[s];
            const tr = document.createElement('tr');
            tr.tabIndex = 0;
            tr.setAttribute('data-sr-i0', m.i0);
            tr.setAttribute('data-sr-i1', m.i1);
            cell(tr, String(s + 1));
            cell(tr, Math.round(m.d0) + '–' + Math.round(m.d1));
            cell(tr, x ? fmtS(x.time) : '--');
            cell(tr, y ? fmtS(y.time) : '--');
            if (diffOk) {
                const d = x.time - y.time;
                cell(tr, (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d).toFixed(2),
                    d < -0.005 ? 'rm-gain' : (d > 0.005 ? 'rm-loss' : ''));
                if (!worst || d > worst.d) worst = { d: d, s: s };
                if (!best || d < best.d) best = { d: d, s: s };
            } else {
                cell(tr, '--');
            }
            cell(tr, fmtPair(x && x.vmax, y && y.vmax, 0));
            cell(tr, fmtPair(x && x.vmin, y && y.vmin, 0));
            cell(tr, fmtPair(x && x.bmax, y && y.bmax, 0));
            cell(tr, fmtPair(x && x.thr, y && y.thr, 0));
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        publishBounds(sa, sb, diffOk);

        // 集約1行
        if (diffOk && worst && best) {
            setSummary(
                'A の最大の損失区間: 区間' + (worst.s + 1) + ' (' + (worst.d >= 0 ? '+' : '−') +
                Math.abs(worst.d).toFixed(2) + 's) ／ 最大の利得区間: 区間' + (best.s + 1) +
                ' (' + (best.d >= 0 ? '+' : '−') + Math.abs(best.d).toFixed(2) + 's)。' +
                '区間は距離の ' + SEGMENTS + ' 等分で、実際のコーナーとは無関係です。'
            );
        } else if (both) {
            setSummary('コース・走行距離が同一と確認できないため(異なる、またはコース情報が無い)、' +
                '差分(Δ)は表示しません。各ラップを自身の距離で ' + SEGMENTS + ' 等分した値を並べています。');
        } else {
            setSummary('片方のラップのみ選択中です。A/B の両方を選ぶと差分を表示します。');
        }
    }

    function rowRange(tr) {
        return [Number(tr.getAttribute('data-sr-i0')), Number(tr.getAttribute('data-sr-i1'))];
    }

    function init() {
        const table = byId('sr-table');
        if (!table) {
            return;
        }
        render(null, null);   // 初期表示(未選択の案内文)
        // ホバーで強調、クリック(タップ)で固定/解除(タッチ端末ではホバーが無いため)
        gtBindRowHighlight(table, {
            getPinned: function() { return state.pinned; },
            setPinned: function(i) { state.pinned = i; },
            rangeOf: rowRange,
            highlight: highlight,
            pinnedClass: 'sr-pinned'
        });
    }

    /**
     * review-view.js からの唯一のフック。
     * @param {Object|null} a - {meta, res}
     * @param {Object|null} b - {meta, res}
     */
    window.srOnReviewCompare = function(a, b) {
        render(a, b);
    };

    /** 区間の境界をチャートへ渡す(#565)。比較可能な A/B のときだけ表示し、それ以外は解除する。 */
    function publishBounds(sa, sb, diffOk) {
        if (typeof reviewSetSegmentBounds !== 'function') {
            return;
        }
        const main = sa || sb;
        if (!diffOk || !main) {
            reviewSetSegmentBounds(null);
            return;
        }
        const idx = [main[0].i0];
        main.forEach(function(s) { idx.push(s.i1); });
        reviewSetSegmentBounds(idx);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
