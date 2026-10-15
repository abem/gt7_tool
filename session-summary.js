/**
 * GT7 Telemetry Dashboard - REVIEW「今日の走行」まとめ (#629)
 *
 * 一覧の絞り込み(日付・車種)または A の周回から「日 × 車種」を決め、その日の周回を集めて、
 *  - 周回数・ベスト・中央値・ばらつき(σ。中央値の SS_OUTLIER_RATIO 倍超は外れ値として除く。lap-trend と同じ規則)
 *  - 前回のセッション(同じ車種・同じコースの、直前の日)とのベスト・中央値の差
 *  - ベスト周回に対して、平均的に時間を失っている上位 SS_TOP コーナー(TCS / ABS の作動した周回数つき)
 * を 1 つのカードに出す。コーナーの検出は corner-report.js の CONSISTENCY と同じ規則
 * (周回の平均速度の谷)で、独立した Python 実装(tests/e2e/corner_common.py)と突き合わせている。
 *
 * 取得は reviewFetchDetail(キャッシュ付き)を使い、1 セッションあたり SS_MAX_LAPS 周まで。
 * IIFE で隔離。公開は無し(ボタンから動く)。既存の id・関数は変えない。
 */
(function() {
    'use strict';

    const SS_MAX_LAPS = 16;          // 1 セッションで読み込む周回の上限
    const SS_MAX_TRY = 40;           // 読み込みを試みる候補の上限(別コース・複数周回の記録を飛ばす分を含む)
    const SS_MIN_LAPS = 3;           // これ未満の周回では統計を出さない
    const SS_OUTLIER_RATIO = 1.3;    // 中央値のこの倍を超える周回は外れ値(lap-trend.js と同じ)
    const SS_OUTLIER_MIN = 4;        // 外れ値を判定するのに要る周回数
    const SS_DIST_TOL = 0.03;        // 走行距離が中央値から±3%超の周回は別物(複数周回・途中切れ)
    const SS_TOP = 3;                // 時間を失っているコーナーの上位
    const SS_MIN_LOSS_S = 0.03;      // これ未満の損失は挙げない
    // コーナー検出(corner-report.js と同じ)
    const SMOOTH_HALF = 1, VALLEY_HALF = 5, LOOK_BACK = 40, PROMINENCE_KMH = 12, MERGE_POINTS = 6;

    const state = { token: 0, busy: false };

    function byId(id) {
        return document.getElementById(id);
    }

    function setStatus(text) {
        const el = byId('ss-status');
        if (el) {
            el.textContent = text;
        }
    }

    function fmt(ms) {
        return typeof formatLapTime === 'function' ? formatLapTime(Math.round(ms)) : (ms / 1000).toFixed(3) + 's';
    }

    function fmtDiff(ms) {
        const s = ms / 1000;
        return (s > 0 ? '+' : s < 0 ? '−' : '±') + Math.abs(s).toFixed(3) + 's';
    }

    /* ---------------- セッションの決定 ---------------- */

    /** 対象の日と車種: 一覧の絞り込み > A の周回 > 一覧の先頭(最新)。 */
    function pickSession() {
        const laps = (typeof reviewState !== 'undefined' && reviewState.laps) ? reviewState.laps : [];
        if (!laps.length) {
            return null;
        }
        const dateSel = byId('review-filter-date');
        const carSel = byId('review-filter-car');
        let day = dateSel && dateSel.value ? dateSel.value : null;
        let car = carSel && carSel.value ? carSel.value : null;
        const a = reviewState.selA ? reviewState.lapsByFile[reviewState.selA] : null;
        if (!day && a) {
            day = a.recorded_at.slice(0, 10);
        }
        if (!car && a) {
            car = String(a.car_id);
        }
        if (!day) {
            day = laps[0].recorded_at.slice(0, 10);
        }
        if (!car) {
            const first = laps.filter(function(l) { return l.recorded_at.slice(0, 10) === day; })[0];
            car = first ? String(first.car_id) : String(laps[0].car_id);
        }
        return { day: day, car: car };
    }

    function lapsOf(day, car) {
        return reviewState.laps.filter(function(l) {
            return l.recorded_at.slice(0, 10) === day && String(l.car_id) === car;
        });
    }

    /** 直前のセッション(同じ車種で、day より前の日のうち周回が SS_MIN_LAPS 以上ある最新の日)。 */
    function previousDay(day, car) {
        const counts = {};
        reviewState.laps.forEach(function(l) {
            const d = l.recorded_at.slice(0, 10);
            if (d < day && String(l.car_id) === car) {
                counts[d] = (counts[d] || 0) + 1;
            }
        });
        const days = Object.keys(counts).filter(function(d) { return counts[d] >= SS_MIN_LAPS; }).sort();
        return days.length ? days[days.length - 1] : null;
    }

    /* ---------------- 取得と絞り込み ---------------- */

    async function collect(laps, token) {
        const entries = [];
        let tried = 0;
        for (let i = 0; i < laps.length && entries.length < SS_MAX_LAPS && tried < SS_MAX_TRY; i++) {
            tried++;
            let e = null;
            try {
                e = await reviewFetchDetail(laps[i].file);
            } catch (err) {
                e = null;
            }
            if (token !== state.token) {
                return null;
            }
            if (e && e.res && e.res.time && e.res.time.length > 3 && e.meta && !e.meta.multi_course &&
                e.meta.course && e.meta.laptime_ms_approx > 0) {
                e._lapMs = e.meta.laptime_ms_approx;
                e._file = laps[i].file;
                entries.push(e);
            }
            setStatus('周回を読み込み中… ' + entries.length + ' 周(候補 ' + tried + ' 件を確認)');
        }
        return entries;
    }

    /** 多数派のコースで、走行距離が中央値の±3%以内の周回だけ残す。 */
    function filterSession(entries) {
        if (!entries.length) {
            return { entries: [], course: null };
        }
        const counts = {};
        entries.forEach(function(e) { counts[e.meta.course.id] = (counts[e.meta.course.id] || 0) + 1; });
        const course = Object.keys(counts).sort(function(p, q) { return counts[q] - counts[p]; })[0];
        let same = entries.filter(function(e) { return e.meta.course.id === course; });
        const medDist = gtMedian(same.map(function(e) { return e.res.totalDist || e.res.dist[e.res.dist.length - 1]; }));
        same = same.filter(function(e) {
            const d = e.res.totalDist || e.res.dist[e.res.dist.length - 1];
            return Math.abs(d - medDist) / medDist <= SS_DIST_TOL;
        });
        return { entries: same, course: course };
    }

    /* ---------------- 統計 ---------------- */

    function stats(entries) {
        const all = entries.map(function(e) { return e._lapMs; });
        let kept = entries;
        if (all.length >= SS_OUTLIER_MIN) {
            const med = gtMedian(all);
            kept = entries.filter(function(e) { return e._lapMs <= med * SS_OUTLIER_RATIO; });
        }
        const ms = kept.map(function(e) { return e._lapMs; });
        const n = ms.length;
        const mean = ms.reduce(function(s, v) { return s + v; }, 0) / n;
        const varr = ms.reduce(function(s, v) { return s + (v - mean) * (v - mean); }, 0) / n;   // 母標準偏差(lap-trend と同じ)
        const best = kept.reduce(function(b, e) { return e._lapMs < b._lapMs ? e : b; });
        return { n: n, outliers: entries.length - n, best: best, bestMs: best._lapMs, median: gtMedian(ms), sigma: Math.sqrt(varr), kept: kept };
    }

    /* ---------------- コーナー(corner-report.js と同じ規則) ---------------- */

    function detectCorners(speed) {
        const n = speed.length;
        const vs = new Array(n);
        for (let k = 0; k < n; k++) {
            let s = 0, c = 0;
            for (let j = Math.max(0, k - SMOOTH_HALF); j <= Math.min(n - 1, k + SMOOTH_HALF); j++) { s += speed[j]; c++; }
            vs[k] = s / c;
        }
        const cand = [];
        for (let k = VALLEY_HALF; k < n - VALLEY_HALF; k++) {
            let isMin = true;
            for (let j = k - VALLEY_HALF; j <= k + VALLEY_HALF; j++) {
                if (j !== k && (vs[j] < vs[k] || (vs[j] === vs[k] && j < k))) { isMin = false; break; }
            }
            if (!isMin) continue;
            let left = -Infinity, right = -Infinity;
            for (let j = Math.max(0, k - LOOK_BACK); j <= k; j++) left = Math.max(left, vs[j]);
            for (let j = k; j <= Math.min(n - 1, k + LOOK_BACK); j++) right = Math.max(right, vs[j]);
            if (Math.min(left, right) - vs[k] >= PROMINENCE_KMH) cand.push(k);
        }
        const ap = [];
        cand.forEach(function(k) {
            if (ap.length && k - ap[ap.length - 1] <= MERGE_POINTS) {
                if (vs[k] < vs[ap[ap.length - 1]]) ap[ap.length - 1] = k;
            } else {
                ap.push(k);
            }
        });
        const argmax = function(lo, hi) {
            let best = lo;
            for (let i = lo; i <= hi; i++) { if (vs[i] > vs[best]) best = i; }
            return best;
        };
        const out = ap.map(function(a, i) {
            return { apex: a, start: i === 0 ? argmax(Math.max(0, a - LOOK_BACK), a) : argmax(ap[i - 1] + 1, a), end: 0 };
        });
        out.forEach(function(c, i) {
            c.end = i + 1 < out.length ? out[i + 1].start : argmax(c.apex, Math.min(n - 1, c.apex + LOOK_BACK));
            if (c.end <= c.apex) c.end = Math.min(n - 1, c.apex + 1);
        });
        return out;
    }

    function cornerLosses(kept, best) {
        const n = Math.min.apply(null, kept.map(function(e) { return e.res.speed.length; }));
        const mean = new Array(n);
        for (let k = 0; k < n; k++) {
            let s = 0;
            kept.forEach(function(e) { s += e.res.speed[k]; });
            mean[k] = s / kept.length;
        }
        const corners = detectCorners(mean);
        const others = kept.filter(function(e) { return e !== best; });
        const dist = best.res.dist;
        return corners.map(function(c, i) {
            const bestT = best.res.time[c.end] - best.res.time[c.start];
            const losses = others.map(function(e) { return (e.res.time[c.end] - e.res.time[c.start]) - bestT; });
            const avg = losses.length ? losses.reduce(function(s, v) { return s + v; }, 0) / losses.length : 0;
            const d0 = dist[c.start], d1 = dist[c.end];
            const tcs = kept.filter(function(e) { return e.aids && overlap(e.aids.tcs, d0, d1) > 0; }).length;
            const abs = kept.filter(function(e) { return e.aids && overlap(e.aids.abs, d0, d1) > 0; }).length;
            return { n: i + 1, apexM: dist[c.apex], avgLossS: avg, nLaps: others.length, tcs: tcs, abs: abs };
        });
    }

    function overlap(ranges, d0, d1) {
        let total = 0;
        (ranges || []).forEach(function(r) { total += Math.max(0, Math.min(r[1], d1) - Math.max(r[0], d0)); });
        return total;
    }

    /* ---------------- 描画 ---------------- */

    function render(sess, course, st, prev, corners) {
        const box = byId('ss-stats');
        const list = byId('ss-corners');
        if (!box || !list) {
            return;
        }
        const c = st.best.meta.course || {};
        const courseName = c.name_ja || c.name_en || course;
        const rows = [
            ['セッション', sess.day + ' ・ CAR ' + sess.car + (course ? ' ・ ' + (courseName || course) : '')],
            ['周回数', st.n + ' 周' + (st.outliers ? '(外れ値 ' + st.outliers + ' 周を除外)' : '')],
            ['ベスト', fmt(st.bestMs) + (prev ? '（前回 ' + fmt(prev.bestMs) + '、' + fmtDiff(st.bestMs - prev.bestMs) + '）' : '')],
            ['中央値', fmt(st.median) + (prev ? '（前回 ' + fmt(prev.median) + '、' + fmtDiff(st.median - prev.median) + '）' : '')],
            ['ばらつき σ', st.sigma >= 1000 ? (st.sigma / 1000).toFixed(2) + 's' : (st.sigma / 1000).toFixed(3) + 's'],
            ['前回', prev ? prev.day + '（' + prev.n + ' 周）' : '同じ車種・コースの前のセッションなし']
        ];
        box.innerHTML = '';
        const table = document.createElement('table');
        table.id = 'ss-table';
        rows.forEach(function(r) {
            const tr = document.createElement('tr');
            const th = document.createElement('th'); th.textContent = r[0];
            const td = document.createElement('td'); td.textContent = r[1];
            tr.appendChild(th); tr.appendChild(td); table.appendChild(tr);
        });
        box.appendChild(table);
        list.innerHTML = '';
        const top = corners.filter(function(c) { return c.avgLossS >= SS_MIN_LOSS_S; })
            .sort(function(p, q) { return q.avgLossS - p.avgLossS; }).slice(0, SS_TOP);
        if (!top.length) {
            const li = document.createElement('li');
            li.textContent = corners.length ? 'ベストに対して平均 ' + SS_MIN_LOSS_S + 's 以上失っているコーナーはありません'
                : 'コーナーを検出できませんでした';
            list.appendChild(li);
            return;
        }
        top.forEach(function(c) {
            const li = document.createElement('li');
            li.textContent = 'コーナー ' + c.n + '（' + Math.round(c.apexM) + 'm 付近）: ベスト比 平均 +' + c.avgLossS.toFixed(2) +
                's（' + c.nLaps + ' 周）' + (c.tcs ? ' ・ TCS ' + c.tcs + ' 周' : '') + (c.abs ? ' ・ ABS ' + c.abs + ' 周' : '');
            list.appendChild(li);
        });
    }

    function clear() {
        const box = byId('ss-stats');
        const list = byId('ss-corners');
        if (box) box.innerHTML = '';
        if (list) list.innerHTML = '';
    }

    /* ---------------- 実行 ---------------- */

    async function load() {
        if (state.busy || typeof reviewFetchDetail !== 'function' || typeof reviewState === 'undefined') {
            return;
        }
        const sess = pickSession();
        if (!sess) {
            setStatus('一覧がまだ読み込まれていません');
            return;
        }
        const token = ++state.token;
        state.busy = true;
        clear();
        try {
            const cur = await collect(lapsOf(sess.day, sess.car), token);
            if (!cur) return;
            const f = filterSession(cur);
            if (f.entries.length < SS_MIN_LAPS) {
                setStatus(sess.day + ' ・ CAR ' + sess.car + ': 揃った周回が ' + f.entries.length + ' 周で、まとめを出すには ' + SS_MIN_LAPS + ' 周必要です');
                return;
            }
            const st = stats(f.entries);
            let prev = null;
            const pday = previousDay(sess.day, sess.car);
            if (pday) {
                setStatus('前回のセッション(' + pday + ')を読み込み中…');
                const pe = await collect(lapsOf(pday, sess.car), token);
                if (!pe) return;
                const pf = filterSession(pe);
                if (pf.course === f.course && pf.entries.length >= SS_MIN_LAPS) {
                    const ps = stats(pf.entries);
                    prev = { day: pday, n: ps.n, bestMs: ps.bestMs, median: ps.median };
                }
            }
            const corners = cornerLosses(st.kept, st.best);
            render(sess, f.course, st, prev, corners);
            setStatus('');
        } finally {
            if (token === state.token) {
                state.busy = false;
            }
        }
    }

    function init() {
        const btn = byId('ss-load');
        if (btn) {
            btn.addEventListener('click', load);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
