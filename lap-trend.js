/**
 * GT7 Telemetry Dashboard - REVIEW ラップタイム推移 (#552 T3)
 *
 * RaceChrono / Pi Toolbox の Strategy 解析に相当する、「同じコース・同じ車種でラップタイムが
 * 走るごとにどう推移したか」のグラフ。選択中の A(なければ B)と同一コース・同一車種で、
 * 走行距離が近い(±3%)ラップだけを、記録の古い順に並べる。途中で切れた記録や別ルートの
 * 走行は距離で除外する(理論ベスト・区間レポートと同じ判定)。
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
    const DIST_TOLERANCE = 0.03;   // 距離差の許容(theory-best.js と同じ)
    const DISCONTINUITY_M = 120;   // これを超える点間距離は位置の飛びとして距離加算しない
    const CHART_H = 220;

    const state = {
        a: null,
        b: null,
        key: null,        // 直近に描画したグループ(車種|コース)
        token: 0,         // 読み込みの世代ガード
        loading: false,
        chart: null,
        points: []        // 描画中の {file, t(ms), lapMs}
    };

    function byId(id) {
        return document.getElementById(id);
    }

    function courseId(entry) {
        const c = entry && entry.meta && entry.meta.course;
        return c ? (c.id || c.name_ja || c.name_en || null) : null;
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
        if (state.chart) {
            state.chart.destroy();
            state.chart = null;
        }
        state.points = [];
        setStats('');
        const ro = byId('lt-readout');
        if (ro) {
            ro.textContent = '';
        }
    }

    /** 詳細(間引き)サンプルから走行距離を概算する。 */
    function pathLength(samples) {
        let cum = 0;
        let lx = null;
        let lz = null;
        (samples || []).forEach(function(s) {
            if (s.position_x != null && s.position_z != null) {
                if (lx !== null) {
                    const seg = Math.hypot(s.position_x - lx, s.position_z - lz);
                    if (seg <= DISCONTINUITY_M) {
                        cum += seg;
                    }
                }
                lx = s.position_x;
                lz = s.position_z;
            }
        });
        return cum;
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
                    dist: pathLength(body.samples)
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
            scales: { x: { time: false }, y: { auto: true } },
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
                { stroke: 'rgba(194,201,212,0.7)', width: 1.25, points: { show: true, size: 6, fill: '#c2c9d4' } },
                { stroke: C.a, paths: function() { return null; }, points: { show: true, size: 11, fill: C.a, stroke: '#ffffff' } },
                { stroke: C.b, paths: function() { return null; }, points: { show: true, size: 11, fill: C.b, stroke: '#ffffff' } }
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
                        ? '#' + (i + 1) + ' ／ ' + new Date(p.recordedAt).toLocaleString() + ' ／ ' + fmt(p.lapMs)
                        : '';
                }]
            }
        };
        try {
            state.chart = new uPlot(opts, [[0], [null], [null], [null]], host);
        } catch (e) {
            console.error('[LAP_TREND]', e);
            state.chart = null;
        }
        if (state.chart && typeof ResizeObserver === 'function') {
            new ResizeObserver(function() {
                const w = Math.floor(host.clientWidth);
                if (state.chart && w > 0) {
                    state.chart.setSize({ width: w, height: CHART_H });
                }
            }).observe(host);
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
        const ys = points.map(function(p) { return p.lapMs / 1000; });
        const markFor = function(file) {
            return points.map(function(p, i) { return file && p.file === file ? ys[i] : null; });
        };
        chart.setData([xs, ys, markFor(aFile), markFor(bFile)]);
    }

    function load() {
        const base = baseEntry();
        if (!base || !base.res || !base.meta || state.loading) {
            return;
        }
        const key = groupKey(base);
        const car = base.meta.car_id;
        const course = courseId(base);
        const baseDist = base.res.totalDist;
        const token = ++state.token;
        state.loading = true;
        setButton(false, '読み込み中…');

        const lapsAll = (typeof reviewState !== 'undefined' && reviewState.laps) ? reviewState.laps : [];
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
            const ok = rows.filter(function(r) {
                return r.lapMs > 0 && r.course === course && baseDist &&
                    Math.abs(r.dist - baseDist) / Math.max(r.dist, baseDist) <= DIST_TOLERANCE;
            }).sort(function(x, y) { return x.recordedAt - y.recordedAt; });
            const excluded = rows.length - ok.length;
            if (ok.length < 2) {
                clearChart();
                state.key = key;
                setStatus('同一コース・同一車種で走行距離の揃ったラップが ' + ok.length +
                    ' 本のため、推移を描けません（取得 ' + rows.length + ' 本）');
                return;
            }
            draw(ok);
            state.key = key;
            const st = computeStats(ok.map(function(r) { return r.lapMs; }));
            setStats('n=' + st.n + ' ／ ベスト ' + fmt(st.best) + ' ／ 平均 ' + fmt(st.mean) +
                ' ／ ばらつき σ=' + (st.sigma / 1000).toFixed(2) + 's');
            setStatus('同一コース・同一車種の直近 ' + rows.length + ' 本のうち ' + ok.length +
                ' 本を表示（距離が揃わない ' + excluded + ' 本を除外）。青=A、緑=B。');
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
