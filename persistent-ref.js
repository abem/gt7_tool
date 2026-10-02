/**
 * GT7 Telemetry Dashboard - 過去の自己ベストを、走り始めから基準にするライブのデルタ (#563)
 *
 * RaceLab の Head to Head(基準との差)、Coach Dave Delta・VRS の基準ラップにならい、
 * ライブのタイムデルタ・推定ラップタイムの基準を、その日の走行内のベストだけでなく、
 * 過去に記録した同じコース・同じ車種の最速の周回にする。セッションを始めた直後の数周でも、
 * 「自己ベストとの差」が出る。
 *
 * 仕組み(ライブの受信・描画の経路には触れない):
 *  - 1秒ごとに、車種ID・コースIDの表示(DOM)を見て、組み合わせが分かったら、過去の周回を探す。
 *    ラップ一覧(/api/laps?car_id=…)から、新しい順に最大 MAX_TRY 件の概要(every=60、1Hz)を取り、
 *    同じコースで、ラップタイム・走行距離が妥当な周回のうち、最速のものを選ぶ。
 *      妥当: 走行距離が、候補の中央値から±5%以内(途中で切れた記録・複数周回を含む記録を除く)、
 *            ラップタイムが、中央値の70%以上(途中切れの記録が「最速」にならないように)。
 *      候補が3周未満なら、中央値が頼りにならないため、使わない(従来どおり、その日のベスト)。
 *  - 選んだ周回は、REVIEW と同じ距離グリッドの系列(reviewBuildSeries / resampleByDist)に直し、
 *    analysisState.refLap(ライブのデルタ・推定ラップの基準)に、その日のベストより速い場合だけ入れる。
 *    その日に、これを上回るラップが出れば、従来どおり onLapComplete が基準を更新する。
 *  - resetAnalysis() などで基準が消えても、次の1秒で入れ直す。
 * 表示: DELTA VS BEST カードに、基準の由来と、オン・オフの切替(設定は localStorage)。
 *
 * 限界: 過去の周回のラップタイムは、記録のタイムスタンプからの概算(laptime_ms_approx)で、
 *       ゲームの表示するタイムと1%程度ずれ得る。REVIEW の表示中は、何もしない。
 *
 * 契約: このファイルはグローバルを公開しない(IIFE)。telemetry-analysis.js の analysisState.refLap を、
 * 上記の条件でのみ書き換える。
 */
(function() {
    'use strict';

    const STORAGE_KEY = 'gt7.persistentRef';
    const TICK_MS = 1000;
    const LIST_LIMIT = 60;         // 一覧から見る件数
    const MAX_TRY = 20;            // 概要を取る周回の上限(サーバーの負荷を抑える)
    const MAX_FILE_BYTES = 40e6;   // これより大きい記録は、読み込みに時間がかかる(サーバーが全体を解析する)ため、候補にしない
    const RETRY_MS = 60000;        // 取得に失敗したとき、この間隔をあけて再試行する
    const MIN_CANDIDATES = 3;      // これ未満は、中央値が頼りにならないため使わない
    const DIST_TOLERANCE = 0.05;   // 走行距離の、中央値からの許容差
    const MIN_TIME_FRAC = 0.7;     // ラップタイムの下限(中央値に対する割合)

    const state = {
        enabled: true,
        key: null,          // 車種ID__コースID
        loading: false,
        token: 0,           // 古い応答を捨てるための世代
        cache: {},          // key -> {r, lapMs, recordedAt, file} | 'none'(該当なしが確定したときだけ)
        retryAt: {},        // key -> この時刻(performance.now)まで再試行しない(取得に失敗したとき)
        replaced: undefined // 基準を書き換える前の analysisState.refLap(オフにしたときに戻す)
    };

    function byId(id) {
        return document.getElementById(id);
    }

    /** 保存された設定(既定はオン。保存が無い・読めないときもオン)。 */
    function load() {
        return gtStorageGet(STORAGE_KEY) !== '0';
    }

    function save(on) {
        gtStorageSet(STORAGE_KEY, on ? '1' : '0');   // 保存できなくても、その場の切り替えは動く
    }

    /**
     * 候補(同じコースの周回)から、基準にする最速の周回を選ぶ(純関数)。
     * @param {Array} cands - [{file, lapMs, dist, recordedAt}]
     * @returns {Object|null}
     */
    function pickBest(cands) {
        if (cands.length < MIN_CANDIDATES) {
            return null;
        }
        const medDist = gtMedian(cands.map(function(c) { return c.dist; }));
        const medTime = gtMedian(cands.map(function(c) { return c.lapMs; }));
        const ok = cands.filter(function(c) {
            return Math.abs(c.dist - medDist) / medDist <= DIST_TOLERANCE && c.lapMs >= medTime * MIN_TIME_FRAC;
        });
        if (!ok.length) {
            return null;
        }
        return ok.reduce(function(best, c) { return c.lapMs < best.lapMs ? c : best; });
    }

    async function getJson(url) {
        const resp = await fetch(url);
        if (!resp.ok) {
            throw new Error('HTTP ' + resp.status);
        }
        return resp.json();
    }

    /** 選んだ周回を、ライブの基準(analysisState.refLap と同じ形式)に直す。 */
    async function buildRef(best) {
        if (typeof reviewBuildSeries !== 'function' || typeof resampleByDist !== 'function' ||
            typeof detectPeaksValleys !== 'function' || typeof STEP === 'undefined') {
            return null;
        }
        const body = await getJson('/api/laps/' + encodeURIComponent(best.file) + '?every=6');
        const series = reviewBuildSeries(body.samples);
        const r = resampleByDist(series.samples, STEP);
        if (!r || !r.time || r.time.length < 3) {
            return null;
        }
        r.totalTime = best.lapMs / 1000;
        r.totalDist = series.cumDist;
        detectPeaksValleys(r);
        return { r: r, lapMs: best.lapMs, recordedAt: best.recordedAt, file: best.file };
    }

    async function findBest(carId, courseId, token) {
        const list = await getJson('/api/laps?car_id=' + encodeURIComponent(carId) + '&limit=' + LIST_LIMIT);
        const laps = (list && list.laps) || [];
        const cands = [];
        let tried = 0;
        for (let i = 0; i < laps.length && tried < MAX_TRY; i++) {
            if (laps[i].size_bytes > MAX_FILE_BYTES) {
                continue;         // 巨大な記録は飛ばす
            }
            tried++;
            let body = null;
            try {
                body = await getJson('/api/laps/' + encodeURIComponent(laps[i].file) + '?every=60');
            } catch (e) {
                continue;
            }
            if (token !== state.token) {
                return undefined;         // 車種・コースが変わった: 古い結果は捨てる
            }
            const meta = body && body.meta;
            const lapMs = meta && meta.laptime_ms_approx;
            if (!meta || !meta.course || meta.course.id !== courseId || !(lapMs > 0)) {
                continue;
            }
            const dist = gtPathDistance(body.samples);
            if (dist > 0) {
                cands.push({ file: laps[i].file, lapMs: lapMs, dist: dist, recordedAt: laps[i].recorded_at || '' });
            }
        }
        const best = pickBest(cands);
        return best ? buildRef(best) : null;
    }

    function fmt(ms) {
        return typeof formatLapTime === 'function' ? formatLapTime(Math.round(ms)) : (ms / 1000).toFixed(3) + 's';
    }

    function setLabel(text) {
        const el = byId('ref-source');
        if (el) {
            el.textContent = text;
        }
    }

    function updateToggle() {
        const btn = byId('ref-persistent-toggle');
        if (btn) {
            btn.setAttribute('aria-pressed', state.enabled ? 'true' : 'false');
            btn.classList.toggle('active', state.enabled);
        }
    }

    /** 過去のベストを基準に入れる(その日のベストのほうが速いときは、入れない)。 */
    function apply(entry) {
        if (typeof analysisState === 'undefined') {
            return;
        }
        const cur = analysisState.refLap;
        if (cur === entry.r) {
            setLabel('基準: 過去のベスト ' + fmt(entry.lapMs) + (entry.recordedAt ? ' (' + entry.recordedAt.slice(0, 10) + ')' : ''));
            return;
        }
        if (!cur || entry.r.totalTime < cur.totalTime) {
            if (state.replaced === undefined) {
                state.replaced = cur;
            }
            analysisState.refLap = entry.r;
            setLabel('基準: 過去のベスト ' + fmt(entry.lapMs) + (entry.recordedAt ? ' (' + entry.recordedAt.slice(0, 10) + ')' : ''));
        } else {
            setLabel('基準: このセッションのベスト ' + fmt(cur.totalTime * 1000) + '（過去のベスト ' + fmt(entry.lapMs) + ' より速い）');
        }
    }

    /** オフにしたとき、こちらが入れた基準を外して、元(その日のベスト)へ戻す。 */
    function revert() {
        const entry = state.cache[state.key];
        if (typeof analysisState !== 'undefined' && entry && entry !== 'none' && analysisState.refLap === entry.r) {
            analysisState.refLap = state.replaced || null;
        }
        state.replaced = undefined;
        setLabel('');
    }

    function currentKey() {
        const carEl = byId('car-id');
        const courseEl = byId('course-name');
        const car = carEl ? carEl.textContent.trim() : '';
        const course = courseEl ? courseEl.dataset.courseId : '';
        return car && course ? { car: car, course: course, key: car + '__' + course } : null;
    }

    async function start(k) {
        state.loading = true;
        const token = state.token;
        setLabel('基準: 過去のベストを探しています…');
        let entry;
        try {
            entry = await findBest(k.car, k.course, token);
        } catch (e) {
            entry = 'error';
        }
        if (token !== state.token) {
            return;           // 車種・コースが変わった: 新しい読み込みの状態(loading)には触れない
        }
        state.loading = false;
        if (entry === undefined) {
            return;
        }
        if (entry === 'error') {
            // 一時的な失敗(通信・サーバー)は、「該当なし」として確定させず、期限をあけて再試行する
            state.retryAt[k.key] = performance.now() + RETRY_MS;
            setLabel('基準: このセッションのベスト（過去のベストを取得できません。しばらくして再試行します）');
            return;
        }
        state.cache[k.key] = entry || 'none';
        if (!entry) {
            setLabel('基準: このセッションのベスト（過去の該当なし）');
        }
    }

    function tick() {
        if (typeof analysisState === 'undefined' || !document.body || document.body.classList.contains('review-mode')) {
            return;
        }
        // TEST MODE は、合成データ(車種ID 1234 など、記録の無い組み合わせ)のため、対象外。
        // 記録済みラップの再生は、過去のベストとの比較に意味があるため、対象にする
        if (typeof testModeActive !== 'undefined' && testModeActive) {
            return;
        }
        const k = currentKey();
        if (!k) {
            return;
        }
        if (k.key !== state.key) {
            // 車種・コースが変わった: 新しい組み合わせのために、古い読み込みを捨てる
            if (state.key !== null && state.enabled) {
                revert();
            }
            state.key = k.key;
            state.token++;
            state.loading = false;
            state.replaced = undefined;
            setLabel('');
        }
        if (!state.enabled) {
            return;
        }
        const entry = state.cache[k.key];
        if (entry === 'none') {
            return;
        }
        // 基準が外部(resetAnalysis 等)で消えたときは、以前の退避(replaced)は古いため捨てる
        if (analysisState.refLap === null) {
            state.replaced = undefined;
        }
        if (entry) {
            apply(entry);
        } else if (!state.loading && !(state.retryAt[k.key] > performance.now())) {
            start(k);
        }
    }

    function init() {
        state.enabled = load();
        const btn = byId('ref-persistent-toggle');
        if (btn) {
            updateToggle();
            btn.addEventListener('click', function() {
                state.enabled = !state.enabled;
                save(state.enabled);
                updateToggle();
                if (state.enabled) {
                    tick();
                } else {
                    revert();
                }
            });
        }
        setInterval(tick, TICK_MS);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
