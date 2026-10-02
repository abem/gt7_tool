/**
 * GT7 Telemetry Dashboard - REVIEW コーナー別レポート (#561)
 *
 * Coach Dave Delta の Auto Insights(コーナーを局面に分けて基準ラップと比較し、
 * 「Turn 3 で 5m 早くブレーキ」のような文章にする)、Track Titan(最も早く違いが出た操作から、
 * 下流の損失へつなげる)、gt7dashboard(速度の谷からコーナー一覧を作る)を参考に、
 * A/B のコーナーごとに、ブレーキ位置・掛け方・最低速度・スロットルを入れる位置を比べ、
 * 損失の大きい順に「どの操作の違いが、どこにつながったか」を文章で示す。
 *
 * 前提と限界:
 *  - 記録されたラップには、速度・スロットル・ブレーキ・位置・時刻しかない。舵角・ブレーキ圧・
 *    タイヤの情報は無いため、ステアリングの入れ方やロックは扱えない。
 *  - コーナーは、A/B の速度の平均の「谷」から検出する(平均を使うのは、A/B を入れ替えても
 *    同じコーナー・逆向きの結果になるため)。GT7 にコーナー定義は無く、実際のコーナー名とは無関係。
 *  - 原因の連鎖は、操作の違いを走行順に並べた規則ベースの説明で、因果の証明ではない。
 *  - 同一コースで走行距離差 3% 以内の A/B のときだけ算出する(review-view.js の共通判定)。
 *
 * CONSISTENCY(#562): 同じコース・同じ車種の直近の周回(最大12本、走行距離が A と3%以内)を読み込み、
 * 同じコーナーごとに、ブレーキ位置・最低速度・スロットルを入れる位置・コーナータイムの標準偏差を求める
 * (VRS・Delta の「毎周のばらつき」、gt7dashboard の「ベストラップ間の速度のばらつき」を参考に、
 * ラップ全体の一貫性σでは見えない「どのコーナーで毎周ばらつくか」を示す)。結果は、
 * トラックマップの STABILITY の色分け(track-map.js の tmSetStability)にも使う。
 * コーナーは、読み込んだ全周回の速度の平均の谷から検出する(周回の並びに依存しない)。
 *
 * 契約: review-view.js の reviewNotifyExtras() から crOnReviewCompare(a, b) が呼ばれる唯一のフック。
 * IIFE で隔離し、公開するグローバルは crOnReviewCompare のみ。
 * 行の強調は track-map.js の tmHighlightRange(i0, i1) を typeof ガード付きで呼ぶ。
 */
(function() {
    'use strict';

    // ---- コーナー検出 ----
    const SMOOTH_HALF = 1;         // 速度の平滑化: 前後1点の平均(3点)
    const VALLEY_HALF = 5;         // 谷の判定: 前後5点(=±50m)で最小
    const LOOK_BACK = 40;          // 突出度の探索範囲(400m)
    const PROMINENCE_KMH = 12;     // 谷の突出度(前後の速度の山との差の小さい方)の下限
    const MERGE_POINTS = 6;        // この距離(60m)以内の谷は、低い方だけ残す
    // ---- 操作の指標 ----
    const BRAKE_ON_PCT = 10;       // ブレーキ開始とみなす踏力
    const RATE_PEAK_MIN_PCT = 30;  // 立ち上がりの傾きを求めるピークの下限
    const RATE_MIN_DT_S = 0.05;    // 傾きの時間差の下限(ゼロ割防止)
    const THROTTLE_ON_PCT = 30;    // スロットルを入れたとみなす開度
    const EXIT_AHEAD_POINTS = 10;  // 立ち上がり速度: 最低速度の位置から100m先
    // ---- 文章化の閾値(これ未満の差は「同じ」とみなす) ----
    const MIN_LOSS_S = 0.03;
    const DIFF_POS_M = 5;
    const DIFF_RELEASE_M = 8;
    const DIFF_THROTTLE_M = 8;
    const DIFF_SPEED_KMH = 2;
    const DIFF_PEAK_PCT = 15;
    const TOP_LOSSES = 3;
    // ---- CONSISTENCY(#562) ----
    const CONS_MAX_LAPS = 12;      // 使う周回の上限(A/B を含む)
    const CONS_COLLECT = 16;       // 除外の前に集める周回の上限(ラップタイム外れ値を除いたあと、CONS_MAX_LAPS まで使う)
    const CONS_LAPTIME_TOL = 0.10; // ラップタイムが中央値から±10%超の周回(アウトラップ・接触等)は、ばらつきの集計から除く
    const CONS_MIN_LAPS = 3;       // これ未満は算出しない
    const CONS_MAX_TRY = 40;       // 読み込みを試みる候補の上限(複数周回の記録・別コース等を飛ばす分を含む)
    const CONS_MIN_VALUES = 3;     // 標準偏差を求めるのに必要な値の数
    // この値のばらつき(σ)を「ばらつき大(1.0)」の基準にする。目安の値で、実データの周回(ペースの揃わない
    // 練習走行を含む)の分布に合わせた経験則。安定は基準の約1/3未満、普通は約2/3未満。
    const BAD_BRAKE_M = 30;
    const BAD_SPEED_KMH = 12;
    const BAD_THROTTLE_M = 45;
    const LEVEL_OK = 0.34;
    const LEVEL_BAD = 0.67;

    const state = { pinned: -1, a: null, b: null, consToken: 0, consBusy: false, consRows: [], consPinned: -1 };

    function byId(id) {
        return document.getElementById(id);
    }

    function comparable(a, b) {
        return typeof reviewComparable === 'function'
            ? reviewComparable(a, b)
            : { ok: false, reason: 'no-data', da: 0, db: 0 };
    }

    /* ================================================================
     *  コーナー検出(純関数)
     * ================================================================ */

    function argmax(arr, i0, i1) {
        let best = i0;
        for (let i = i0; i <= i1; i++) {
            if (arr[i] > arr[best]) {
                best = i;
            }
        }
        return best;
    }

    /**
     * A/B の速度の平均から、コーナー(速度の谷)と、それぞれの区間 [start, end] を求める。
     * @returns {Array<{apex:number, start:number, end:number}>} グリッド添字
     */
    function detectCorners(ra, rb, n) {
        const vm = new Array(n);
        for (let k = 0; k < n; k++) {
            vm[k] = (ra.speed[k] + rb.speed[k]) / 2;
        }
        const vs = new Array(n);
        for (let k = 0; k < n; k++) {
            let s = 0;
            let c = 0;
            for (let j = Math.max(0, k - SMOOTH_HALF); j <= Math.min(n - 1, k + SMOOTH_HALF); j++) {
                s += vm[j];
                c++;
            }
            vs[k] = s / c;
        }
        // 谷の候補(前後 VALLEY_HALF 点で最小、同値は先の点)
        let cand = [];
        for (let k = VALLEY_HALF; k <= n - 1 - VALLEY_HALF; k++) {
            let isMin = true;
            for (let j = k - VALLEY_HALF; j <= k + VALLEY_HALF; j++) {
                if (vs[j] < vs[k] || (vs[j] === vs[k] && j < k)) {
                    isMin = false;
                    break;
                }
            }
            if (!isMin) {
                continue;
            }
            const left = vs[argmax(vs, Math.max(0, k - LOOK_BACK), k)];
            const right = vs[argmax(vs, k, Math.min(n - 1, k + LOOK_BACK))];
            if (Math.min(left, right) - vs[k] >= PROMINENCE_KMH) {
                cand.push(k);
            }
        }
        // 近すぎる谷は、低い方だけ残す
        const apexes = [];
        cand.forEach(function(k) {
            const last = apexes.length ? apexes[apexes.length - 1] : -1;
            if (last >= 0 && k - last <= MERGE_POINTS) {
                if (vs[k] < vs[last]) {
                    apexes[apexes.length - 1] = k;
                }
            } else {
                apexes.push(k);
            }
        });
        // 区間: 谷と谷の間の速度の山で区切る(端は、谷の前後 LOOK_BACK 点の山)
        const out = [];
        for (let i = 0; i < apexes.length; i++) {
            const a = apexes[i];
            const start = i === 0
                ? argmax(vs, Math.max(0, a - LOOK_BACK), a)
                : argmax(vs, apexes[i - 1] + 1, a);
            out.push({ apex: a, start: start, end: 0 });
        }
        for (let i = 0; i < out.length; i++) {
            out[i].end = i + 1 < out.length
                ? out[i + 1].start
                : argmax(vs, out[i].apex, Math.min(n - 1, out[i].apex + LOOK_BACK));
            if (out[i].end <= out[i].apex) {
                out[i].end = Math.min(n - 1, out[i].apex + 1);
            }
        }
        return out;
    }

    /* ================================================================
     *  1ラップ・1コーナーの操作の指標(純関数)
     * ================================================================ */

    function cornerMetrics(r, c) {
        const s = c.start;
        const e = c.end;
        // ブレーキ: 区間の開始から谷まで(この区間のブレーキ)
        let bi = -1;
        let peak = 0;
        let peakIdx = -1;
        for (let k = s; k <= c.apex; k++) {
            if (bi < 0 && r.brake[k] >= BRAKE_ON_PCT) {
                bi = k;
            }
            if (r.brake[k] > peak) {
                peak = r.brake[k];
                peakIdx = k;
            }
        }
        const braked = bi >= 0;
        let rate = null;
        if (braked && peak >= RATE_PEAK_MIN_PCT) {
            let k90 = -1;
            for (let k = bi; k <= c.apex; k++) {
                if (r.brake[k] >= 0.9 * peak) {
                    k90 = k;
                    break;
                }
            }
            // 最初の点(10m刻み)で、すでにピークの90%を超えている場合は、立ち上がりが速すぎて測れない(--)
            const rise = 0.9 * peak - r.brake[bi];
            if (k90 >= 0 && rise > 0) {
                rate = rise / Math.max(r.time[k90] - r.time[bi], RATE_MIN_DT_S);
            }
        }
        let release = null;
        if (braked && peakIdx >= 0) {
            for (let k = peakIdx + 1; k <= e; k++) {
                if (r.brake[k] < BRAKE_ON_PCT) {
                    release = r.dist[k];
                    break;
                }
            }
        }
        // 最低速度: 区間の中の最小(このラップ自身の位置)
        let mi = s;
        for (let k = s; k <= e; k++) {
            if (r.speed[k] < r.speed[mi]) {
                mi = k;
            }
        }
        // スロットルを入れる位置: このラップの最低速度の位置より後で、最初に開度が閾値を超えた点
        let ti = -1;
        for (let k = mi; k <= e; k++) {
            if (r.throttle[k] >= THROTTLE_ON_PCT) {
                ti = k;
                break;
            }
        }
        return {
            brakePos: braked ? r.dist[bi] : null,
            brakePeak: peak,
            brakeRate: rate,
            releasePos: release,
            minSpeed: r.speed[mi],
            throttlePos: ti >= 0 ? r.dist[ti] : null,
            exitSpeed: r.speed[Math.min(e, mi + EXIT_AHEAD_POINTS)],
            time: r.time[e] - r.time[s]
        };
    }

    /* ================================================================
     *  文章化(純関数)
     * ================================================================ */

    /**
     * A と B の指標の差を、走行の順(ブレーキ位置→ブレーキの強さ→ブレーキを離す位置→最低速度→
     * スロットル→立ち上がり速度)に並べた、短い文の断片の配列にする。A 視点(A が B より…)。
     */
    function causeChain(x, y) {
        const out = [];
        const num = function(v) { return Math.round(Math.abs(v)); };
        if (x.brakePos != null && y.brakePos != null) {
            const d = x.brakePos - y.brakePos;
            if (Math.abs(d) >= DIFF_POS_M) {
                out.push('ブレーキが ' + num(d) + ' m ' + (d > 0 ? '遅い' : '早い'));
            }
        } else if ((x.brakePos == null) !== (y.brakePos == null)) {
            out.push(x.brakePos == null ? 'ブレーキを使っていない(B は使っている)' : 'ブレーキを使っている(B は使っていない)');
        }
        const dp = x.brakePeak - y.brakePeak;
        if (x.brakePos != null && y.brakePos != null && Math.abs(dp) >= DIFF_PEAK_PCT) {
            out.push('ブレーキが ' + (dp > 0 ? '強い' : '弱い') + ' (' + (dp > 0 ? '+' : '−') + num(dp) + '%)');
        }
        if (x.releasePos != null && y.releasePos != null) {
            const d = x.releasePos - y.releasePos;
            if (Math.abs(d) >= DIFF_RELEASE_M) {
                out.push('ブレーキを離すのが ' + num(d) + ' m ' + (d > 0 ? '遅い' : '早い'));
            }
        }
        const dv = x.minSpeed - y.minSpeed;
        if (Math.abs(dv) >= DIFF_SPEED_KMH) {
            out.push('最低速度 ' + (dv > 0 ? '+' : '−') + num(dv) + ' km/h');
        }
        if (x.throttlePos != null && y.throttlePos != null) {
            const d = x.throttlePos - y.throttlePos;
            if (Math.abs(d) >= DIFF_THROTTLE_M) {
                out.push('スロットルが ' + num(d) + ' m ' + (d > 0 ? '遅い' : '早い'));
            }
        }
        const de = x.exitSpeed - y.exitSpeed;
        if (Math.abs(de) >= DIFF_SPEED_KMH) {
            out.push('立ち上がり速度 ' + (de > 0 ? '+' : '−') + num(de) + ' km/h');
        }
        return out;
    }

    function signed(v, digits) {
        return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(digits);
    }

    /**
     * 全コーナーの比較行を作る。
     * @returns {Array} [{n, apexM, i0, i1, a, b, dt, chain}]  dt = A−B [s](正は A が遅い)
     */
    function analyze(a, b) {
        const ra = a.res;
        const rb = b.res;
        const n = Math.min(ra.time.length, rb.time.length);
        const corners = detectCorners(ra, rb, n);
        return corners.map(function(c, i) {
            const x = cornerMetrics(ra, c);
            const y = cornerMetrics(rb, c);
            return {
                n: i + 1, apexM: ra.dist[c.apex], i0: c.start, i1: c.end,
                a: x, b: y, dt: x.time - y.time, chain: causeChain(x, y)
            };
        });
    }

    function sentence(row) {
        return 'T' + row.n + ' (' + signed(row.dt, 2) + ' s): ' +
            (row.chain.length ? row.chain.join(' → ') : '明確な操作の差はありません(走行ラインなどの差の可能性)');
    }

    /* ================================================================
     *  描画
     * ================================================================ */

    function setText(id, text) {
        const el = byId(id);
        if (el) {
            el.textContent = text;
        }
    }

    function clearAll() {
        const t = byId('cr-table');
        if (t) {
            t.textContent = '';
        }
        const l = byId('cr-advice');
        if (l) {
            l.textContent = '';
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

    function pair(av, bv, digits) {
        const f = function(v) { return v == null ? '--' : v.toFixed(digits); };
        return f(av) + ' / ' + f(bv);
    }

    function addAdvice(text, cls) {
        const li = document.createElement('li');
        li.textContent = text;
        if (cls) {
            li.className = cls;
        }
        byId('cr-advice').appendChild(li);
    }

    function render(a, b) {
        clearAll();
        state.pinned = -1;
        highlight(-1, -1);
        if (!a || !b || !a.res || !b.res) {
            setText('cr-summary', 'A/B の2本を選択すると、コーナーごとの操作の違いを表示します');
            return;
        }
        const cmp = comparable(a, b);
        if (!cmp.ok) {
            const why = {
                'course-diff': 'コースが異なるため',
                'course-unknown': 'コース情報が無いため(旧形式・インポート等)',
                'dist-diff': '走行距離が異なるため(A ' + Math.round(cmp.da) + ' m / B ' + Math.round(cmp.db) + ' m)'
            }[cmp.reason] || 'データが揃わないため';
            setText('cr-summary', 'コーナー別の比較は算出しません: ' + why);
            return;
        }
        const rows = analyze(a, b);
        if (!rows.length) {
            setText('cr-summary', 'コーナー(速度の谷)を検出できませんでした(直線的なコース・短いラップ等)');
            return;
        }
        const losses = rows.filter(function(r) { return r.dt >= MIN_LOSS_S; })
            .sort(function(p, q) { return q.dt - p.dt; });
        const gains = rows.filter(function(r) { return r.dt <= -MIN_LOSS_S; })
            .sort(function(p, q) { return p.dt - q.dt; });
        setText('cr-summary',
            rows.length + ' コーナーを検出(速度の谷から。実際のコーナー名とは無関係)。' +
            'A が損しているコーナーを、操作の違いを走行順に並べて示します。');
        losses.slice(0, TOP_LOSSES).forEach(function(r) { addAdvice(sentence(r), 'cr-loss'); });
        if (!losses.length) {
            addAdvice('A が B より 0.03 s 以上遅いコーナーはありません', '');
        }
        if (gains.length) {
            addAdvice('得: ' + sentence(gains[0]), 'cr-gain');
        }

        const table = byId('cr-table');
        const thead = document.createElement('thead');
        const hr = document.createElement('tr');
        ['コーナー', '位置 (m)', 'Δ (A−B) s', 'ブレーキ位置 A/B', 'ブレーキ最大 % A/B', '踏み込み %/s A/B',
            '最低速 A/B', 'スロットル位置 A/B', '立上り速度 A/B'].forEach(function(h) {
            const th = document.createElement('th');
            th.textContent = h;
            hr.appendChild(th);
        });
        thead.appendChild(hr);
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        rows.forEach(function(r) {
            const tr = document.createElement('tr');
            tr.tabIndex = 0;
            tr.setAttribute('data-cr-i0', r.i0);
            tr.setAttribute('data-cr-i1', r.i1);
            tr.title = sentence(r);
            cell(tr, 'T' + r.n);
            cell(tr, String(Math.round(r.apexM)));
            cell(tr, signed(r.dt, 2), r.dt <= -MIN_LOSS_S ? 'rm-gain' : (r.dt >= MIN_LOSS_S ? 'rm-loss' : ''));
            cell(tr, pair(r.a.brakePos, r.b.brakePos, 0));
            cell(tr, pair(r.a.brakePeak, r.b.brakePeak, 0));
            cell(tr, pair(r.a.brakeRate, r.b.brakeRate, 0));
            cell(tr, pair(r.a.minSpeed, r.b.minSpeed, 0));
            cell(tr, pair(r.a.throttlePos, r.b.throttlePos, 0));
            cell(tr, pair(r.a.exitSpeed, r.b.exitSpeed, 0));
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
    }

    function rowRange(tr) {
        return [Number(tr.getAttribute('data-cr-i0')), Number(tr.getAttribute('data-cr-i1'))];
    }

    /* ================================================================
     *  CONSISTENCY(#562): 直近の周回のコーナーごとのばらつき
     * ================================================================ */

    /** 標準偏差(標本、n-1)。値が CONS_MIN_VALUES 未満なら null。null は無視する。 */
    function stdev(values) {
        const v = values.filter(function(x) { return x != null && isFinite(x); });
        if (v.length < CONS_MIN_VALUES) {
            return null;
        }
        const m = v.reduce(function(s, x) { return s + x; }, 0) / v.length;
        const ss = v.reduce(function(s, x) { return s + (x - m) * (x - m); }, 0);
        return Math.sqrt(ss / (v.length - 1));
    }

    /**
     * ラップタイムが中央値から±CONS_LAPTIME_TOL 超の周回を除く(アウトラップ・接触・スピン等で、
     * 「毎周のばらつき」ではなく別の走りになっているため)。A/B は、比較の起点なので必ず残す。
     * ラップタイムが無い周回は残す。
     */
    function dropLapTimeOutliers(entries, keep) {
        const times = entries.map(function(e) { return e.meta && e.meta.laptime_ms_approx; })
            .filter(function(t) { return t > 0; });
        if (times.length < 3) {
            return entries;
        }
        const med = gtMedian(times);
        return entries.filter(function(e) {
            const t = e.meta && e.meta.laptime_ms_approx;
            return keep.indexOf(e) >= 0 || !(t > 0) || Math.abs(t - med) / med <= CONS_LAPTIME_TOL;
        });
    }

    /** 全周回の速度の平均から、共通のコーナーを検出する。 */
    function commonCorners(entries) {
        const n = Math.min.apply(null, entries.map(function(e) { return e.res.speed.length; }));
        const mean = new Array(n);
        for (let k = 0; k < n; k++) {
            let s = 0;
            entries.forEach(function(e) { s += e.res.speed[k]; });
            mean[k] = s / entries.length;
        }
        return detectCorners({ speed: mean }, { speed: mean }, n);
    }

    /**
     * コーナーごとのばらつきを求める(純関数)。
     * @returns {Array} [{n, apexM, i0, i1, sdBrake, sdSpeed, sdThrottle, sdTime, level, nLaps}]
     */
    function consistency(entries) {
        const corners = commonCorners(entries);
        const dist = entries[0].res.dist;
        return corners.map(function(c, i) {
            const ms = entries.map(function(e) { return cornerMetrics(e.res, c); });
            const sdBrake = stdev(ms.map(function(m) { return m.brakePos; }));
            const sdSpeed = stdev(ms.map(function(m) { return m.minSpeed; }));
            const sdThrottle = stdev(ms.map(function(m) { return m.throttlePos; }));
            const sdTime = stdev(ms.map(function(m) { return m.time; }));
            const parts = [];
            if (sdBrake != null) parts.push(sdBrake / BAD_BRAKE_M);
            if (sdSpeed != null) parts.push(sdSpeed / BAD_SPEED_KMH);
            if (sdThrottle != null) parts.push(sdThrottle / BAD_THROTTLE_M);
            // score: 各要素の σ を「ばらつき大」の基準で割った最大値(順位付け用、上限なし)。level: 色分け用に 0〜1 へ丸めた値
            const score = parts.length ? Math.max.apply(null, parts) : null;
            return {
                n: i + 1, apexM: dist[c.apex], i0: c.start, i1: c.end,
                sdBrake: sdBrake, sdSpeed: sdSpeed, sdThrottle: sdThrottle, sdTime: sdTime,
                score: score, level: score == null ? null : Math.min(1, score),
                nLaps: entries.length
            };
        });
    }

    function levelText(level) {
        return level == null ? '--' : (level < LEVEL_OK ? '安定' : (level < LEVEL_BAD ? '普通' : 'ばらつき大'));
    }

    function levelClass(level) {
        return level == null ? '' : (level < LEVEL_OK ? 'rm-gain' : (level < LEVEL_BAD ? '' : 'rm-loss'));
    }

    /** 最もばらつく要素の名前(文章用)。 */
    function worstFactor(r) {
        const cands = [
            ['ブレーキ位置', r.sdBrake, BAD_BRAKE_M, 'm'],
            ['最低速度', r.sdSpeed, BAD_SPEED_KMH, 'km/h'],
            ['スロットルを入れる位置', r.sdThrottle, BAD_THROTTLE_M, 'm']
        ].filter(function(c) { return c[1] != null; });
        if (!cands.length) {
            return null;
        }
        cands.sort(function(p, q) { return q[1] / q[2] - p[1] / p[2]; });
        return cands[0][0] + ' σ ' + cands[0][1].toFixed(cands[0][3] === 'm' ? 0 : 1) + ' ' + cands[0][3];
    }

    function setConsStatus(text) {
        setText('cr-cons-status', text);
    }

    function clearCons() {
        state.consToken++;
        state.consBusy = false;
        state.consRows = [];
        state.consPinned = -1;
        const t = byId('cr-cons-table');
        if (t) {
            t.textContent = '';
        }
        const l = byId('cr-cons-advice');
        if (l) {
            l.textContent = '';
        }
        if (typeof tmSetStability === 'function') {
            tmSetStability(null);
        }
    }

    function updateConsButton() {
        const btn = byId('cr-cons-load');
        if (!btn) {
            return;
        }
        const usable = !!(state.a && state.b && comparable(state.a, state.b).ok && rowsPresent());
        btn.disabled = state.consBusy || !usable;
    }

    function rowsPresent() {
        const t = byId('cr-table');
        return !!(t && t.querySelector('tbody tr'));
    }

    function renderCons(rows, nLaps, a) {
        const table = byId('cr-cons-table');
        table.textContent = '';
        const advice = byId('cr-cons-advice');
        advice.textContent = '';
        const ranked = rows.filter(function(r) { return r.score != null; })
            .sort(function(p, q) { return q.score - p.score; });
        ranked.slice(0, 3).filter(function(r) { return r.level >= LEVEL_OK; }).forEach(function(r) {
            const li = document.createElement('li');
            li.className = 'cr-loss';
            li.textContent = 'T' + r.n + ': 毎周ばらつく — ' + worstFactor(r) + '（' + levelText(r.level) + '）';
            advice.appendChild(li);
        });
        if (!advice.children.length) {
            const li = document.createElement('li');
            li.textContent = 'どのコーナーも、ばらつきは小さい範囲です（' + nLaps + ' 周）';
            advice.appendChild(li);
        }
        const thead = document.createElement('thead');
        const hr = document.createElement('tr');
        ['コーナー', '位置 (m)', 'ブレーキ位置 σ (m)', '最低速 σ (km/h)', 'スロットル位置 σ (m)', 'コーナータイム σ (s)', '安定度'].forEach(function(h) {
            const th = document.createElement('th');
            th.textContent = h;
            hr.appendChild(th);
        });
        thead.appendChild(hr);
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        const f = function(v, d) { return v == null ? '--' : v.toFixed(d); };
        rows.forEach(function(r) {
            const tr = document.createElement('tr');
            tr.tabIndex = 0;
            tr.setAttribute('data-cc-i0', r.i0);
            tr.setAttribute('data-cc-i1', r.i1);
            cell(tr, 'T' + r.n);
            cell(tr, String(Math.round(r.apexM)));
            cell(tr, f(r.sdBrake, 1));
            cell(tr, f(r.sdSpeed, 1));
            cell(tr, f(r.sdThrottle, 1));
            cell(tr, f(r.sdTime, 3));
            cell(tr, levelText(r.level), levelClass(r.level));
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        // トラックマップの色分け用: A(主ライン)の距離グリッド index ごとの不安定度
        const levels = new Array(a.res.dist.length).fill(null);
        rows.forEach(function(r) {
            for (let i = r.i0; i <= r.i1 && i < levels.length; i++) {
                levels[i] = r.level;
            }
        });
        if (typeof tmSetStability === 'function') {
            tmSetStability(levels, true);
        }
    }

    /** 同じコース・車種の直近の周回を読み込み、コーナーごとのばらつきを求める。 */
    async function loadConsistency() {
        const a = state.a;
        const b = state.b;
        if (!a || !b || state.consBusy || typeof reviewFetchDetail !== 'function') {
            return;
        }
        clearCons();
        const token = state.consToken;
        state.consBusy = true;
        updateConsButton();
        const carId = a.meta && a.meta.car_id;
        const laps = (typeof reviewState !== 'undefined' && reviewState.laps ? reviewState.laps : [])
            .filter(function(l) { return String(l.car_id) === String(carId); });
        const entries = [a, b];
        const seen = { };
        seen[a.meta.file] = true;
        seen[b.meta.file] = true;
        let tried = 0;
        for (let i = 0; i < laps.length && entries.length < CONS_COLLECT && tried < CONS_MAX_TRY; i++) {
            if (seen[laps[i].file]) {
                continue;
            }
            tried++;
            setConsStatus('周回を読み込み中… ' + entries.length + ' / ' + CONS_COLLECT + ' 周（候補 ' + tried + ' 件を確認）');
            let e = null;
            try {
                e = await reviewFetchDetail(laps[i].file);
            } catch (err) {
                e = null;
            }
            if (token !== state.consToken) {
                return;       // A/B が変わった・再読み込みされた: 古い結果は捨てる
            }
            seen[laps[i].file] = true;
            // 同じコースで、走行距離が A と3%以内の周回だけ(複数周回の記録・途中切れ・別コースを除く)
            if (e && e.res && e.res.time && comparable(a, e).ok) {
                entries.push(e);
            }
        }
        state.consBusy = false;
        if (token !== state.consToken) {
            return;
        }
        updateConsButton();
        // 取得に失敗した候補があると、REVIEW 一覧の「読込中…」が残るため、消す
        const listStatus = byId('review-list-status');
        if (listStatus && /読込中…$/.test(listStatus.textContent)) {
            listStatus.textContent = '';
        }
        const collected = entries.length;
        // ラップタイムの外れ値を除き、新しい順に最大 CONS_MAX_LAPS 周を使う(A/B は先頭にあり、必ず残る)
        const used = dropLapTimeOutliers(entries, [a, b]).slice(0, CONS_MAX_LAPS);
        if (used.length < CONS_MIN_LAPS) {
            setConsStatus('同じコース・車種で比較できる周回が ' + used.length + ' 本しかないため、算出しません（最低 ' +
                CONS_MIN_LAPS + ' 周。走行距離が A と3%以内・ラップタイムが中央値から±' + Math.round(CONS_LAPTIME_TOL * 100) +
                '%以内の周回が対象）');
            return;
        }
        const rows = consistency(used);
        state.consRows = rows;
        if (!rows.length) {
            setConsStatus('コーナー(速度の谷)を検出できませんでした');
            return;
        }
        setConsStatus(used.length + ' 周（同じコース・車種、走行距離が A と3%以内、ラップタイムが中央値から±' +
            Math.round(CONS_LAPTIME_TOL * 100) + '%以内。新しい順に最大 ' + CONS_MAX_LAPS + ' 周' +
            (collected > used.length ? '。アウトラップ等 ' + (collected - used.length) + ' 周を除外' : '') +
            '）から、' + rows.length + ' コーナーのばらつきを算出しました。σ が大きいほど、毎周ばらつきます。' +
            'トラックマップの STABILITY に色分けを反映しました。');
        renderCons(rows, used.length, a);
    }

    function init() {
        const table = byId('cr-table');
        if (!table) {
            return;
        }
        render(null, null);
        gtBindRowHighlight(table, {
            getPinned: function() { return state.pinned; },
            setPinned: function(i) { state.pinned = i; },
            rangeOf: rowRange,
            highlight: highlight,
            pinnedClass: 'cr-pinned'
        });
        // CONSISTENCY(#562)
        const btn = byId('cr-cons-load');
        if (btn) {
            btn.addEventListener('click', loadConsistency);
            updateConsButton();
        }
        const ct = byId('cr-cons-table');
        if (ct) {
            gtBindRowHighlight(ct, {
                getPinned: function() { return state.consPinned; },
                setPinned: function(i) { state.consPinned = i; },
                rangeOf: function(tr) {
                    return [Number(tr.getAttribute('data-cc-i0')), Number(tr.getAttribute('data-cc-i1'))];
                },
                highlight: highlight,
                pinnedClass: 'cr-pinned'
            });
        }
    }

    /** review-view.js から呼ばれる唯一のフック。a/b は reviewFetchDetail の戻り値(無ければ null)。 */
    window.crOnReviewCompare = function(a, b) {
        a = a || null;
        b = b || null;
        // 重ね書きの追加・解除など、A/B が変わらない再通知では、描き直さない
        // (固定した行と、地図の強調を、失わないため)
        if (a === state.a && b === state.b && byId('cr-table') && byId('cr-table').children.length) {
            return;
        }
        state.a = a;
        state.b = b;
        clearCons();
        setConsStatus(a && b
            ? '「ばらつきを読み込む」で、同じコース・車種の直近の周回から、コーナーごとのばらつきを算出します'
            : '');
        render(a, b);
        updateConsButton();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
