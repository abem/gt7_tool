/**
 * GT7 Telemetry Dashboard
 * ラップタイム予測フロント統合(#434 P5 Stage3)
 *
 * @module laptime-predict
 * @depends race-metrics.js (rmParseLapText — #current-lap の厳格パース関数を再利用)
 *
 * 設計方針(予備調査報告2026-08-02・計承認済み):
 *   - ライブ経路JS(websocket.js/telemetry.py/decoder.py)は完全無改変。
 *     course.id取得のみ、websocket.jsの既存条件ブロック(要素がある時だけ動作)へ
 *     data属性書込みを1行追加(新規受信経路ではない)。
 *   - 本モジュールは独自タイマーで既存DOM表示値を定期サンプリングする読み取り専用の
 *     設計(race-metrics.js M-4 #146と同じ方針)。ラップ内累積平均・距離はDOM値
 *     (#speed/#throttle-value/#brake-value/#fl-temp〜#rr-temp/#pos-x/#pos-z)から
 *     自前で算出する(既存グローバルに保持されていないため)。
 *   - progress(進行度)は距離ベース(采指示2026-08-02): 同コース×車種の参照ラップの
 *     総距離を既存の/api/laps・/api/laps/{file}(fields射影)から一度だけ取得しキャッシュ、
 *     現在ラップの累積距離との比で算出する。バックエンドAPI(main.py)は無改変。
 */

/* ================================================================
 *  設定・状態
 * ================================================================ */

const LP_SAMPLE_INTERVAL_MS = 250;   // ラップ内累積平均のサンプリング間隔
const LP_PREDICT_TICK_MS = 1000;     // API呼び出し周期(race-metrics.js M-4と同じ1Hz)
const LP_DISCONTINUITY_M = 120;      // review-view.js/telemetry-analysis.js等と同じ瞬間移動閾値
const LP_REFERENCE_CANDIDATE_LIMIT = 30; // 参照距離探索時の候補ラップ上限(car_id絞り込み後)

const lpState = {
    currentLapNumber: null,
    lastPos: null,             // {x, z} 直前サンプルの位置(累積距離計算用)
    cumDistance: 0,            // 現在ラップの累積距離(m)
    speedSum: 0, speedCount: 0, maxSpeed: 0,
    throttleSum: 0, throttleCount: 0,
    brakeSum: 0, brakeCount: 0,
    tyreTempSum: 0, tyreTempCount: 0,
    referenceDistanceCache: {},   // key: `${courseId}__${carId}` -> 距離(m)。確定値のみ格納
    referenceDistanceFetching: {},// key -> true(取得中、重複fetch防止)
    _els: null,
};

function lpEnsureEls() {
    if (!lpState._els) {
        lpState._els = {
            predictValue: document.getElementById('rm-predict-value'),
            predictMeta: document.getElementById('rm-predict-meta'),
        };
    }
    return lpState._els;
}

/* ================================================================
 *  ラップ内累積平均・累積距離のサンプリング(独自タイマー、DOM読み取り専用)
 * ================================================================ */

function lpResetLapAccumulators() {
    lpState.lastPos = null;
    lpState.cumDistance = 0;
    lpState.speedSum = 0; lpState.speedCount = 0; lpState.maxSpeed = 0;
    lpState.throttleSum = 0; lpState.throttleCount = 0;
    lpState.brakeSum = 0; lpState.brakeCount = 0;
    lpState.tyreTempSum = 0; lpState.tyreTempCount = 0;
}

/** DOM要素のtextContentを数値抽出する(単位記号混在可、例 "70%" -> 70)。非数値はNaN。 */
function lpParseNumericText(el) {
    if (!el) return NaN;
    const v = parseFloat(el.textContent);
    return v;
}

function lpSampleTick() {
    // ラップ境界検知(#current-lapの厳格パース、race-metrics.jsのrmParseLapTextを再利用)
    const curLapEl = document.getElementById('current-lap');
    const lap = curLapEl && typeof rmParseLapText === 'function'
        ? rmParseLapText(curLapEl.textContent) : null;
    if (lap && lap.cur !== lpState.currentLapNumber) {
        lpResetLapAccumulators();
        lpState.currentLapNumber = lap.cur;
    }

    const speed = lpParseNumericText(document.getElementById('speed'));
    if (!isNaN(speed)) {
        lpState.speedSum += speed;
        lpState.speedCount++;
        if (speed > lpState.maxSpeed) {
            lpState.maxSpeed = speed;
        }
    }

    const throttle = lpParseNumericText(document.getElementById('throttle-value'));
    if (!isNaN(throttle)) {
        lpState.throttleSum += throttle;
        lpState.throttleCount++;
    }

    const brake = lpParseNumericText(document.getElementById('brake-value'));
    if (!isNaN(brake)) {
        lpState.brakeSum += brake;
        lpState.brakeCount++;
    }

    let tyreSum = 0, tyreN = 0;
    ['fl-temp', 'fr-temp', 'rl-temp', 'rr-temp'].forEach(function(id) {
        const v = lpParseNumericText(document.getElementById(id));
        if (!isNaN(v)) {
            tyreSum += v;
            tyreN++;
        }
    });
    if (tyreN > 0) {
        lpState.tyreTempSum += (tyreSum / tyreN);
        lpState.tyreTempCount++;
    }

    const posX = lpParseNumericText(document.getElementById('pos-x'));
    const posZ = lpParseNumericText(document.getElementById('pos-z'));
    if (!isNaN(posX) && !isNaN(posZ)) {
        if (lpState.lastPos) {
            const dx = posX - lpState.lastPos.x;
            const dz = posZ - lpState.lastPos.z;
            const chord = Math.sqrt(dx * dx + dz * dz);
            if (chord <= LP_DISCONTINUITY_M) {
                lpState.cumDistance += chord;
            }
        }
        lpState.lastPos = { x: posX, z: posZ };
    }
}

/* ================================================================
 *  参照距離の取得(同コース×車種の過去ラップから距離を1回だけ取得しキャッシュ、
 *  既存の /api/laps・/api/laps/{file}(fields射影で軽量化)のみ使用。main.py無改変)
 * ================================================================ */

/** ラップ詳細サンプル配列(position_x/position_z)から累積距離(m)を算出する。 */
function lpComputeDistanceFromSamples(samples) {
    let dist = 0, prev = null;
    samples.forEach(function(s) {
        if (s.position_x == null || s.position_z == null) {
            return;
        }
        if (prev) {
            const dx = s.position_x - prev[0];
            const dz = s.position_z - prev[1];
            const chord = Math.sqrt(dx * dx + dz * dz);
            if (chord <= LP_DISCONTINUITY_M) {
                dist += chord;
            }
        }
        prev = [s.position_x, s.position_z];
    });
    return dist;
}

/**
 * 同一コース×車種の参照ラップ総距離を取得する(セッション内キャッシュ、1回のみ検索)。
 *
 * /api/laps一覧にコースIDでの絞り込みが無いため、car_idで絞った候補
 * (直近最大LP_REFERENCE_CANDIDATE_LIMIT件)を順に、position_x/position_zのみを
 * fields射影で軽量取得し、meta.course.idが一致する最初の1件を採用する。
 * 「ベストラップ」ではなく「最初に見つかった同コースのラップ」を採用する簡略化を
 * 行っている(コース周長はペースに依存せずほぼ一定のため、代表性への影響は小さいと
 * 判断。完了報告に明記)。
 */
async function lpFetchReferenceDistance(courseId, carId) {
    const key = courseId + '__' + carId;
    if (lpState.referenceDistanceCache[key]) {
        return lpState.referenceDistanceCache[key];
    }
    if (lpState.referenceDistanceFetching[key]) {
        return null;
    }
    lpState.referenceDistanceFetching[key] = true;
    try {
        const listResp = await fetch(
            '/api/laps?car_id=' + encodeURIComponent(carId) + '&limit=' + LP_REFERENCE_CANDIDATE_LIMIT
        );
        if (!listResp.ok) {
            return null;
        }
        const listData = await listResp.json();
        const candidates = listData.laps || [];
        for (const cand of candidates) {
            const detailResp = await fetch(
                '/api/laps/' + encodeURIComponent(cand.file) + '?fields=position_x,position_z'
            );
            if (!detailResp.ok) {
                continue;
            }
            const detail = await detailResp.json();
            if (!detail.meta || !detail.meta.course || detail.meta.course.id !== courseId) {
                continue;
            }
            const dist = lpComputeDistanceFromSamples(detail.samples || []);
            if (dist > 0) {
                lpState.referenceDistanceCache[key] = dist;
                return dist;
            }
        }
        return null;
    } catch (e) {
        console.error('lpFetchReferenceDistance failed:', e);
        return null;
    } finally {
        lpState.referenceDistanceFetching[key] = false;
    }
}

/* ================================================================
 *  予測API呼び出し・表示更新(1Hzポーリング、race-metrics.js M-4と同じ頻度)
 * ================================================================ */

function lpShowNeutral(els) {
    els.predictValue.textContent = '--';
    if (els.predictMeta) {
        els.predictMeta.textContent = '';
    }
}

async function lpPredictTick() {
    const els = lpEnsureEls();
    if (!els.predictValue) {
        return;
    }

    const carIdEl = document.getElementById('car-id');
    const courseNameEl = document.getElementById('course-name');
    const carId = carIdEl ? carIdEl.textContent.trim() : '';
    const courseId = courseNameEl ? courseNameEl.dataset.courseId : '';

    if (!carId || !courseId || lpState.cumDistance <= 0 || lpState.speedCount === 0) {
        lpShowNeutral(els);
        return;
    }

    const refDistance = await lpFetchReferenceDistance(courseId, carId);
    if (!refDistance) {
        lpShowNeutral(els);
        return;
    }

    const progress = Math.min(1, Math.max(0, lpState.cumDistance / refDistance));
    const avgSpeed = lpState.speedCount > 0 ? lpState.speedSum / lpState.speedCount : 0;
    const avgThrottle = lpState.throttleCount > 0 ? lpState.throttleSum / lpState.throttleCount : 0;
    const avgBrake = lpState.brakeCount > 0 ? lpState.brakeSum / lpState.brakeCount : 0;
    const avgTyreTemp = lpState.tyreTempCount > 0 ? lpState.tyreTempSum / lpState.tyreTempCount : 0;

    const params = new URLSearchParams({
        course: courseId,
        car_id: carId,
        progress: progress.toFixed(4),
        avg_speed_kmh: avgSpeed.toFixed(2),
        max_speed_kmh: lpState.maxSpeed.toFixed(2),
        avg_throttle_pct: avgThrottle.toFixed(2),
        avg_brake_pct: avgBrake.toFixed(2),
        avg_tyre_temp: avgTyreTemp.toFixed(2),
    });

    try {
        const resp = await fetch('/api/predict/laptime?' + params.toString());
        if (resp.status === 404) {
            // 品質ゲート対象外・未学習の組み合わせ(采指示: 非表示のまま)
            lpShowNeutral(els);
            return;
        }
        if (!resp.ok) {
            lpShowNeutral(els);
            return;
        }
        const data = await resp.json();
        // predicted_laptime_msはAPI側でround(x, 1)された小数値のため、formatLapTime
        // (整数ms前提、millis = ms % 1000)へ渡す前に整数化する。
        const predictedMsInt = Math.round(data.predicted_laptime_ms);
        els.predictValue.textContent = typeof formatLapTime === 'function'
            ? formatLapTime(predictedMsInt)
            : (predictedMsInt / 1000).toFixed(3) + 's';
        if (els.predictMeta) {
            els.predictMeta.textContent = 'MAE ' + data.mae_pct.toFixed(2) + '% / n=' + data.n_laps;
        }
    } catch (e) {
        console.error('lpPredictTick fetch failed:', e);
        lpShowNeutral(els);
    }
}

/* ================================================================
 *  自己初期化
 * ================================================================ */

setInterval(lpSampleTick, LP_SAMPLE_INTERVAL_MS);
setInterval(lpPredictTick, LP_PREDICT_TICK_MS);
