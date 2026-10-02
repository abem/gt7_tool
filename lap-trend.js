/**
 * GT7 Telemetry Dashboard - REVIEW ラップタイム推移 (#552 T3)
 *
 * RaceChrono / Pi Toolbox の Strategy 解析に相当する、「同じコース・同じ車種でラップタイムが
 * 走るごとにどう推移したか」のグラフ。選択中の A(なければ B)と同一コース・同一車種で、
 * 走行距離が近い(±3%)ラップだけを、記録の古い順に並べる。途中で切れた記録や別ルートの
 * 走行は距離で除外する(理論ベスト・区間レポートと同じ判定)。
 *
 * 外れ値(#553): 距離は揃っていてもタイムが極端に遅い周回(コースアウト・スピン・ピットイン等)は、
 * 中央値の OUTLIER_RATIO 倍を超えるものを外れ値として、平均・ばらつきから除外する。グラフの
 * 縦軸は外れ値を除いた範囲に合わせ、外れ値はグラフ上端に○で表示する(実際のタイムはホバーで確認)。
 *
 * 設計:
 *  - 新規 API・バックエンド変更なし。既存の /api/laps/{file}?every=60(約 20KB・軽量)を
 *    最大 40 本、3 並列で取得する。ラップタイム(meta.laptime_ms_approx)は every に依存しない。
 *  - 負荷を避けるため、ボタンを押したときだけ読み込む(自動では取得しない)。
 *  - review-view.js の reviewNotifyExtras() から ltOnReviewCompare(a, b) が呼ばれる唯一の
 *    フック。IIFE で隔離し、公開するグローバルは ltOnReviewCompare のみ。
 */
(function() {
    'use strict';

    const MAX_LAPS = 40;           // 取得する最大ラップ数(直近から)
    const CONCURRENCY = 3;         // 同時取得数
    const FETCH_EVERY = 60;        // サンプル間引き(距離の概算には十分)
    // 距離差の許容は review-view.js の REVIEW_DIST_TOLERANCE を使う(未読込時の既定)
    const DIST_TOLERANCE_FALLBACK = 0.03;
    const CHART_H = 220;
    const OUTLIER_RATIO = 1.3;     // 中央値のこの倍率を超える周回を外れ値とする
    const OUTLIER_MIN_LAPS = 4;    // これ未満の本数では中央値が不安定なので判定しない
    const Y_PAD_RATIO = 0.08;      // 縦軸の上下余白(外れ値を除いた範囲に対する割合)

    const state = {
        a: null,
        b: null,
        key: null,        // 直近に描画したグループ(車種|コース)
        token: 0,         // 読み込みの世代ガード
        loading: false,
        yRange: null,     // 縦軸の範囲 [min, max](外れ値を除いた範囲。null=自動)
        ro: null,         // チャート幅の追随用 ResizeObserver(clearChart で disconnect)
        chart: null,
        points: []        // 描画中の {file, t(ms), lapMs}
    };

    function byId(id) {
        return document.getElementById(id);
    }

    /** コース識別子(review-view.js の共通関数。無い場合 null)。 */
    function courseId(entry) {
        return typeof reviewCourseId === 'function' ? reviewCourseId(entry) : null;
    }

    function fmt(ms) {
        return typeof formatLapTime === 'function' ? formatLapTime(Math.round(ms)) : (ms / 1000).toFixed(3) + 's';
    }

    function baseEntry() {
        return state.a || state.b;
    }

    function groupKey(entry) {
        if (!entry || !entry.meta) {
            return null;
        }
        return String(entry.meta.car_id) + '|' + (courseId(entry) || '');
    }

    function setStatus(text) {
        const el = byId('lt-status');
        if (el) {
            el.textContent = text;
        }
    }

    function setStats(text) {
        const el = byId('lt-stats');
        if (el) {
            el.textContent = text;
        }
    }

    function setButton(enabled, label) {
        const btn = byId('lt-load');
        if (btn) {
            btn.disabled = !enabled;
            if (label) {
                btn.textContent = label;
            }
        }
    }

    function clearChart() {
        if (state.ro) {
            state.ro.disconnect();
            state.ro = null;
        }
        if (state.chart) {
            state.chart.destroy();
            state.chart = null;
        }
        state.points = [];
        state.yRange = null;
        setStats('');
        const ro = byId('lt-readout');
        if (ro) {
            ro.textContent = '';
        }
    }

    function fetchLap(lap) {
        return fetch('/api/laps/' + encodeURIComponent(lap.file) + '?every=' + FETCH_EVERY)
            .then(function(res) {
                if (!res.ok) {
                    throw new Error('HTTP ' + res.status);
                }
                return res.json();
            })
            .then(function(body) {
                const m = body.meta || {};
                return {
                    file: lap.file,
                    recordedAt: Date.parse(lap.recorded_at) || 0,
                    lapMs: m.laptime_ms_approx || 0,
                    course: m.course ? (m.course.id || m.course.name_ja || m.course.name_en || null) : null,
                    dist: gtPathDistance(body.samples)   // 詳細(間引き)サンプルからの概算
                };
            });
    }

    /** 単純な並列プール(同時 CONCURRENCY 本)。完了した分から onProgress を呼ぶ。 */
    function runPool(items, worker, onProgress, isCancelled) {
        return new Promise(function(resolve) {
            const results = [];
            let next = 0;
            let active = 0;
            let done = 0;
            const pump = function() {
                while (active < CONCURRENCY && next < items.length && !isCancelled()) {
                    const item = items[next++];
                    active++;
                    worker(item).then(function(r) {
                        results.push(r);
                    }).catch(function() {
                        // 1 本の失敗は欠測として扱い、続行する
                    }).then(function() {
                        active--;
                        done++;
                        onProgress(done, items.length);
                        pump();
                    });
                }
                if (active === 0 && (next >= items.length || isCancelled())) {
                    resolve(results);
                }
            };
            pump();
        });
    }

    /**
     * 中央値の OUTLIER_RATIO 倍を超えるラップに outlier=true を付ける(本数が少ない場合は付けない)。
     * @returns {number} 外れ値の本数
     */
    function markOutliers(rows) {
        rows.forEach(function(r) { r.outlier = false; });
        if (rows.length < OUTLIER_MIN_LAPS) {
            return 0;
        }
        const median = gtMedian(rows.map(function(r) { return r.lapMs; }));
        let n = 0;
        rows.forEach(function(r) {
            if (r.lapMs > median * OUTLIER_RATIO) {
                r.outlier = true;
                n++;
            }
        });
        return n;
    }

    function computeStats(ms) {
        const n = ms.length;
        const mean = ms.reduce(function(s, v) { return s + v; }, 0) / n;
        const varr = ms.reduce(function(s, v) { return s + (v - mean) * (v - mean); }, 0) / n;
        return { n: n, best: Math.min.apply(null, ms), mean: mean, sigma: Math.sqrt(varr) };
    }

    function ensureChart(host) {
        if (state.chart) {
            return state.chart;
        }
        if (typeof uPlot !== 'function') {
            return null;
        }
        const C = typeof REVIEW_SERIES_COLORS !== 'undefined' ? REVIEW_SERIES_COLORS : { a: '#4C9AFF', b: '#3FB950' };
        const axisStroke = '#8b95a5';
        const grid = { stroke: 'rgba(255,255,255,0.06)', width: 1 };
        const opts = {
            width: Math.max(200, Math.floor(host.clientWidth)),
            height: CHART_H,
            pxAlign: 0,
            scales: {
                x: { time: false },
                y: { auto: true, range: function(u, dmin, dmax) { return state.yRange ? state.yRange : [dmin, dmax]; } }
            },
            axes: [
                { stroke: axisStroke, grid: grid, ticks: { show: false }, size: 26,
                  values: function(u, vals) { return vals.map(function(v) { return Number.isInteger(v) ? '#' + v : ''; }); } },
                { stroke: axisStroke, grid: grid, ticks: { show: false }, size: 64,
                  values: function(u, vals) { return vals.map(function(v) { return fmt(v * 1000); }); } }
            ],
            legend: { show: false },
            cursor: { drag: { x: false, y: false } },
            series: [
                {},
                { stroke: 'rgba(194,201,212,0.7)', width: 1.25, spanGaps: true, points: { show: true, size: 6, fill: '#c2c9d4' } },
                { stroke: C.a, paths: function() { return null; }, points: { show: true, size: 11, fill: C.a, stroke: '#ffffff' } },
                { stroke: C.b, paths: function() { return null; }, points: { show: true, size: 11, fill: C.b, stroke: '#ffffff' } },
                // 外れ値: 縦軸の上端に○で表示(実際のタイムはホバーで確認)
                { stroke: '#E8A13D', paths: function() { return null; }, points: { show: true, size: 9, fill: 'transparent', stroke: '#E8A13D', width: 2 } }
            ],
            hooks: {
                setCursor: [function(u) {
                    const ro = byId('lt-readout');
                    if (!ro) {
                        return;
                    }
                    const i = u.cursor.idx;
                    const p = i != null ? state.points[i] : null;
                    ro.textContent = p
                        ? '#' + (i + 1) + ' ／ ' + new Date(p.recordedAt).toLocaleString() + ' ／ ' + fmt(p.lapMs) +
                          (p.outlier ? ' ／ 外れ値(統計から除外)' : '')
                        : '';
                }]
            }
        };
        try {
            state.chart = new uPlot(opts, [[0], [null], [null], [null], [null]], host);
        } catch (e) {
            console.error('[LAP_TREND]', e);
            state.chart = null;
        }
        if (state.chart && typeof ResizeObserver === 'function') {
            // clearChart() で disconnect できるよう保持する(車種・コースを切り替えるたびに
            // 観測が積み上がらないように)
            state.ro = new ResizeObserver(function() {
                const w = Math.floor(host.clientWidth);
                if (state.chart && w > 0) {
                    state.chart.setSize({ width: w, height: CHART_H });
                }
            });
            state.ro.observe(host);
        }
        return state.chart;
    }

    function draw(points) {
        const host = byId('lt-chart');
        if (!host) {
            return;
        }
        state.points = points;
        const chart = ensureChart(host);
        if (!chart) {
            return;
        }
        // A/B のファイル名は review-view.js の選択状態から取る(詳細の meta には無い)
        const sel = typeof reviewState !== 'undefined' ? reviewState : {};
        const aFile = state.a ? sel.selA : null;
        const bFile = state.b ? sel.selB : null;
        const xs = points.map(function(_, i) { return i + 1; });
        const inl = points.filter(function(p) { return !p.outlier; }).map(function(p) { return p.lapMs / 1000; });
        let yMax = null;
        if (inl.length) {
            const lo = Math.min.apply(null, inl);
            const hi = Math.max.apply(null, inl);
            const pad = Math.max((hi - lo) * Y_PAD_RATIO, 0.5);
            state.yRange = [lo - pad, hi + pad];
            yMax = hi + pad;
        } else {
            state.yRange = null;
        }
        // 外れ値は縦軸の上端へ寄せて描く(範囲外で消えないように)
        const yOf = function(p) {
            const v = p.lapMs / 1000;
            return (yMax !== null && v > yMax) ? yMax : v;
        };
        const line = points.map(function(p) { return p.outlier ? null : p.lapMs / 1000; });
        const markFor = function(file) {
            return points.map(function(p) { return file && p.file === file ? yOf(p) : null; });
        };
        const outMarks = points.map(function(p) { return p.outlier ? yOf(p) : null; });
        chart.setData([xs, line, markFor(aFile), markFor(bFile), outMarks]);
    }

    function load() {
        const base = baseEntry();
        if (!base || !base.res || !base.meta || state.loading) {
            return;
        }
        const key = groupKey(base);
        const car = base.meta.car_id;
        const course = courseId(base);
        if (!course) {
            // コース情報が無い(旧形式・インポート等)と、同一コースの周回を特定できない
            clearChart();
            setStatus('コース情報が無いため(旧形式・インポート等)、推移を描けません');
            return;
        }
        const token = ++state.token;
        state.loading = true;
        setButton(false, '読み込み中…');

        const sel = typeof reviewState !== 'undefined' ? reviewState : {};
        const lapsAll = sel.laps || [];
        const target = lapsAll
            .filter(function(l) { return l.car_id === car; })
            .sort(function(x, y) { return (y.recorded_at || '') < (x.recorded_at || '') ? -1 : 1; })
            .slice(0, MAX_LAPS);
        if (target.length === 0) {
            state.loading = false;
            setButton(true, '推移を読み込む');
            setStatus('一覧に同じ車種のラップがありません');
            return;
        }

        runPool(target, fetchLap, function(done, total) {
            if (token === state.token) {
                setStatus('読み込み中 ' + done + ' / ' + total + '…');
            }
        }, function() { return token !== state.token; }).then(function(rows) {
            if (token !== state.token) {
                return; // 選択が変わった後の古い結果は捨てる
            }
            state.loading = false;
            setButton(true, '再読み込み');
            // 距離の基準: 完了時点の基準ラップ(読み込み中に同一グループ内で A を差し替えた場合に追随)の
            // 詳細表示の距離(every=6 相当)。every=60 の距離は、間引きによる弦長の縮み(実測0.3〜1.3%)が
            // 周回ごとに異なり、基準ラップ自身を every=60 で測って比べると、縮み方の差だけで許容(3%)の
            // 境界の周回が入れ替わる(実データで確認)ため、精度の高い詳細表示の距離を基準にする。
            const cur = baseEntry();
            const baseDist = (cur && cur.res && cur.res.totalDist) ? cur.res.totalDist : base.res.totalDist;
            const tol = typeof REVIEW_DIST_TOLERANCE === 'number' ? REVIEW_DIST_TOLERANCE : DIST_TOLERANCE_FALLBACK;
            const ok = rows.filter(function(r) {
                return r.lapMs > 0 && r.course === course && baseDist &&
                    Math.abs(r.dist - baseDist) / Math.max(r.dist, baseDist) <= tol;
            }).sort(function(x, y) { return x.recordedAt - y.recordedAt; });
            const excluded = rows.length - ok.length;
            if (ok.length < 2) {
                clearChart();
                state.key = key;
                setStatus('同一コース・同一車種で走行距離の揃ったラップが ' + ok.length +
                    ' 本のため、推移を描けません（取得 ' + rows.length + ' 本）');
                return;
            }
            const outliers = markOutliers(ok);
            draw(ok);
            state.key = key;
            const inliers = ok.filter(function(r) { return !r.outlier; });
            const st = computeStats(inliers.map(function(r) { return r.lapMs; }));
            setStats('n=' + st.n + ' ／ ベスト ' + fmt(st.best) + ' ／ 平均 ' + fmt(st.mean) +
                ' ／ ばらつき σ=' + (st.sigma / 1000).toFixed(2) + 's' +
                (outliers ? ' ／ 外れ値 ' + outliers + ' 本を除外' : ''));
            setStatus('同一コース・同一車種の直近 ' + rows.length + ' 本のうち ' + ok.length +
                ' 本を表示（距離が揃わない ' + excluded + ' 本を除外）。青=A、緑=B。' +
                (outliers ? ' 中央値の' + OUTLIER_RATIO + '倍を超える外れ値 ' + outliers +
                    ' 本（○、グラフ上端）は、平均・ばらつきから除外しています。' : ''));
        });
    }

    function init() {
        const btn = byId('lt-load');
        if (!btn) {
            return;
        }
        btn.addEventListener('click', load);
        setButton(false);
        setStatus('A/B のラップを選択すると、同じコース・車種の推移を読み込めます');
    }

    /**
     * review-view.js からの唯一のフック。
     * @param {Object|null} a - {meta, res}
     * @param {Object|null} b - {meta, res}
     */
    window.ltOnReviewCompare = function(a, b) {
        state.a = a || null;
        state.b = b || null;
        const base = baseEntry();
        if (!base) {
            state.token++;             // 進行中の読み込みを無効化
            state.loading = false;
            state.key = null;
            clearChart();
            setButton(false, '推移を読み込む');
            setStatus('A/B のラップを選択すると、同じコース・車種の推移を読み込めます');
            return;
        }
        // 車種・コースが変わったら古いグラフを消す(同一グループなら A/B マーカーだけ更新)
        const key = groupKey(base);
        if (state.key && key !== state.key) {
            state.token++;
            state.loading = false;
            clearChart();
            state.key = null;
            setStatus('車種またはコースが変わりました。「推移を読み込む」で再取得できます');
        } else if (state.key && state.points.length) {
            draw(state.points);
        }
        if (!state.loading) {
            setButton(true, state.key ? '再読み込み' : '推移を読み込む');
            if (!state.key) {
                setStatus('「推移を読み込む」で、同じコース・車種の直近ラップの推移を取得します');
            }
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
