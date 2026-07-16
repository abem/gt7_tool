/**
 * GT7 Telemetry Dashboard
 * 距離基準ラップ解析機構（実テレメトリソフト級の比較解析）
 *
 * 実テレメトリソフト(snipem/gt7dashboard, SimHub, Coach Dave Delta, MoTeC)が
 * 提供する「距離基準のラップ比較」をフロント計算のみで再現するモジュール。
 *   - 距離索引: position_x/z の弦長積算による「トラック距離」導出
 *   - ライブ・タイムデルタ: 同一距離でのベスト通過タイム秒差(#lap-delta/#delta-bar-*)
 *   - 推定ラップタイム: refLap.totalTime + liveDelta の全周外挿 + PB判定(#est-lap-time)
 *   - 距離軸チャート供給: 現在ラップ speed + ベスト speed 重畳 / タイムデルタ(charts.js C 実装)
 *   - 入力ゾーン分類: analysisOnFrame が毎フレーム呼ぶ classifyZone / peaks・valleys
 *   - レースエンジニア通知: トップスピード/PB/燃料/残周回/ファイナルラップの一過性トースト
 *
 * バックエンド(main.py/decoder.py)は不変。全て既存デコード済みフィールドから計算する。
 *
 * @module telemetry-analysis
 * @depends constants.js  (未直接参照だが読込順を保証)
 * @depends ui_components.js (formatLapTime)
 * @depends charts.js (initAnalysisCharts, renderAnalysisCharts — C 実装, typeof ガードで呼出)
 *
 * 全公開関数はグローバル function 宣言(巻き上げ)。呼出側は typeof fn === 'function' でガードする。
 */

/* ================================================================
 *  定数
 * ================================================================ */
const STEP = 10;               // 距離グリッド[m]
const DISCONTINUITY_M = 120;   // 1フレーム弦長がこれ超=瞬間移動として距離加算スキップ
                               //  (demoTrajectoryの点間50-94mを通し、pit/respawnテレポート200m+を除外)
const MAX_DELTA_S = 1.5;       // デルタバー飽和[s]
const DELTA_NEUTRAL_S = 0.05;  // ライブデルタ中立帯[s](|Δ|<この値=クラス無し/中立)
const ZONE_THRESH = 5;         // 入力ゾーン閾値[%]
const SMOOTH_W = 5;            // ピーク検出平滑窓
const MIN_PROM = 15;           // ピーク顕著性[km/h]
const MIN_SPEED_MS = 3;        // 空転判定の下限速度[m/s]
const TOPSPEED_MARGIN = 1;     // 新トップスピード発火マージン[km/h]
const CHART_CADENCE_MS = 100;  // 解析チャート再描画スロットル(10fps)
const WHEEL_SPEED_K = 2 * Math.PI; // ホイール回転数→周速の厳密換算(1回転=2πr)。|rps|*radius*K [m/s]。
                                   // 任意係数ではない: 変更すると updateGrip の slip 比(1.0=グリップ)の物理的意味が崩れる。
const PROM_WINDOW = 8;         // ピーク顕著性評価窓(±8サンプル=±80m)
const LAP_CLOCK_GAP_S = 2.0;   // ラップ内クロック: サンプル間dtがこれ以上は記録中断として
                               // 加算しない(review-view.js REVIEW_TIME_GAP_S / main.py
                               // LAP_DURATION_GAP_S と同じ値・同じ意味。#128是正)

/* ================================================================
 *  状態(単一オブジェクト)
 * ================================================================ */
const analysisState = {
    initialized: false,          // lazy-init(DOMキャッシュ+ボタン配線+initAnalysisCharts)済フラグ
    lastLapNumber: 0,
    lastX: null, lastZ: null,    // 直前位置(距離弦長用)
    // ラップ内経過クロック[s](#128是正)。current_laptime(0x80)は実際には
    // ゲーム内時刻進行でありラップ経過時間ではない(#127診断で確定)ため、
    // 受信 timestamp のクランプ付き累積で自前計時する(P1-3 REVIEW実証方式)。
    // TEST MODE合成フレームは timestamp を持たないため current_laptime 差分に
    // フォールバックする(デモは正しいラップ内msを合成する。test-mode.js:435)。
    lapClockS: 0,                // 現在ラップの経過秒
    _clockPrevTsMs: null,        // 直前サンプルの受信時刻[ms](ライブ経路)
    _clockPrevCltMs: null,       // 直前サンプルの current_laptime[ms](TEST MODE経路)
    _lastDtS: 0,                 // 当フレームで加算したdt[s](距離の速度積分フォールバック用)
    lastChartTs: 0,
    _liveDelta: 0,               // 直近ライブデルタ[s](推定ラップが再利用)
    curLap: { samples: [], cumDist: 0 },
    // samples 要素: {dist, t, speed, throttle, brake, x, z, gear, zone}
    refLap: null,                // {dist[],time[],speed[],throttle[],brake[],x[],z[],N,totalDist,totalTime,peaks[],valleys[]} or null
    lapTimesMs: [],              // 一貫性σ用の確定ラップタイム履歴
    notif: {
        queue: [], topSpeed: 0, topSpeedFired: false,
        prevFuelPct: 100, firedFuel: { 50: false, 20: false, 10: false },
        firedLaps: { 15: false, 10: false, 5: false, 2: false }, finalFired: false,
        prevBest: Infinity
    },
    els: {}                      // 自前 getElementById キャッシュ(lapDelta,barNeg,barPos,estLap,feed,gripStatus,consistency)
};

/* ================================================================
 *  小ユーティリティ
 * ================================================================ */

/**
 * 線形補間
 * @param {number} a - 始点
 * @param {number} b - 終点
 * @param {number} f - 補間係数(0-1)
 * @returns {number}
 */
function lerpA(a, b, f) {
    return a + (b - a) * f;
}

/**
 * デルタバー2本の同時更新ヘルパー。
 * onEl 側: width=pct + .active 付与(pct が '0%' でも付与＝従来挙動)。
 * offEl 側: width='0%' + .active 除去。
 * 全消灯は onEl=null で off 側だけ適用する。
 * @param {Element|null} onEl - 点灯側バー(null なら off 側のみ)
 * @param {Element|null} offEl - 消灯側バー
 * @param {string} pct - 点灯側の width(例 '42%')
 */
function setDeltaBar(onEl, offEl, pct) {
    if (onEl) {
        onEl.style.width = pct;
        onEl.classList.add('active');
    }
    if (offEl) {
        offEl.style.width = '0%';
        offEl.classList.remove('active');
    }
}

/* ================================================================
 *  初期化・リセット
 * ================================================================ */

/**
 * ライブデルタ表示(#lap-delta / #delta-bar-*)を初期状態へ戻す共通処理。
 */
function clearDeltaUI() {
    const els = analysisState.els;
    if (els.lapDelta) {
        els.lapDelta.textContent = '--';
        els.lapDelta.className = 'delta-value';
    }
    setDeltaBar(null, els.barNeg, '0%');
    setDeltaBar(null, els.barPos, '0%');
}

/**
 * 状態を全初期化する。
 * セッション/コース変更・lap_count逆行・TESTストップ時に呼ぶ。
 */
function resetAnalysis() {
    analysisState.lastLapNumber = 0;
    analysisState.lastX = null;
    analysisState.lastZ = null;
    analysisState.lapClockS = 0;
    analysisState._clockPrevTsMs = null;
    analysisState._clockPrevCltMs = null;
    analysisState._lastDtS = 0;
    analysisState.lastChartTs = 0;
    analysisState._liveDelta = 0;
    analysisState.curLap = { samples: [], cumDist: 0 };
    analysisState.refLap = null;
    analysisState.lapTimesMs = [];

    // 通知の残存トーストを撤去してフラグを全 false へ
    analysisState.notif.queue.forEach(function(item) {
        if (item.el && item.el.parentNode) {
            item.el.parentNode.removeChild(item.el);
        }
    });
    analysisState.notif.queue = [];
    analysisState.notif.topSpeed = 0;
    analysisState.notif.topSpeedFired = false;
    analysisState.notif.prevFuelPct = 100;
    analysisState.notif.firedFuel = { 50: false, 20: false, 10: false };
    analysisState.notif.firedLaps = { 15: false, 10: false, 5: false, 2: false };
    analysisState.notif.finalFired = false;
    analysisState.notif.prevBest = Infinity;

    // UI 初期化(存在ガード)
    const els = analysisState.els;
    clearDeltaUI();
    if (els.estLap) {
        els.estLap.textContent = '--:--.---';
        els.estLap.classList.remove('tentative', 'pb');
    }

    // 解析チャートを空データでクリア
    if (typeof renderAnalysisCharts === 'function') {
        renderAnalysisCharts({ xs: [0], curSpeed: [null], refSpeed: [null], delta: [null] });
    }
}

/**
 * 初回のみ DOM をキャッシュし、ボタン配線・解析チャート初期化を行う(lazy-init)。
 * 既存 initPedalTrace と同じく「初回 analysisOnFrame 時」に実行。
 */
function ensureAnalysisInit() {
    if (analysisState.initialized) {
        return;
    }

    analysisState.els = {
        lapDelta: document.getElementById('lap-delta'),
        barNeg: document.getElementById('delta-bar-negative'),
        barPos: document.getElementById('delta-bar-positive'),
        estLap: document.getElementById('est-lap-time'),
        feed: document.getElementById('race-engineer-feed'),
        gripStatus: document.getElementById('grip-status'),
        consistency: document.getElementById('consistency-stat')
    };

    // 距離軸解析チャート初期化(C 実装・冪等・要素欠落時は内部でスキップ)
    if (typeof initAnalysisCharts === 'function') {
        initAnalysisCharts();
    }

    // 通知フィードの top をヘッダー実高に追随させる(初期化時 + resize 時)
    positionEngineerFeed();
    window.addEventListener('resize', positionEngineerFeed);

    analysisState.initialized = true;
}

/**
 * 通知フィード(.engineer-feed)の top をヘッダー実高 + 8px に合わせる。
 * ヘッダーまたはフィードが無ければ何もしない。resize でも再計算される。
 */
function positionEngineerFeed() {
    const feed = analysisState.els.feed;
    const header = document.querySelector('.header');
    if (!feed || !header) {
        return;
    }
    feed.style.top = (header.getBoundingClientRect().bottom + 8) + 'px';
}

/* ================================================================
 *  毎フレーム入口
 * ================================================================ */

/**
 * 唯一の毎フレーム入口。websocket.js / test-mode.js から 1 行で配線される。
 * 距離積分の精度確保のため非スロットルで毎処理フレーム呼ぶ(チャート再描画のみ内部スロットル)。
 * @param {Object} data - テレメトリデータ(ライブ or 合成)
 */
function analysisOnFrame(data) {
    if (!data) {
        return;
    }

    ensureAnalysisInit();

    const lap = data.lap_count || 0;

    // (b) lap_count 逆行 → セッション/コース変更とみなし自動リセット
    if (lap < analysisState.lastLapNumber) {
        resetAnalysis();
        analysisState.lastLapNumber = lap;
        return;
    }

    // (c) ラップ切替 → 直前ラップを確定し curLap を初期化
    if (lap > analysisState.lastLapNumber && analysisState.lastLapNumber > 0) {
        onLapComplete(analysisState.lastLapNumber, data.last_laptime);
        analysisState.curLap = { samples: [], cumDist: 0 };
        analysisState.lastX = null;
        analysisState.lastZ = null;
        analysisState.lapClockS = 0;   // 新ラップの計時を0から開始(#128)
    } else if (lap >= 1 && analysisState.lastLapNumber < 1) {
        // (c') レース開始(lap_count 0/-1 → 1以上)。完了ラップは無いが、
        // ラップ計時と距離・サンプルはここが起点(#128)。メニュー/グリッド滞在中に
        // 進んだクロック・距離を最初のラップへ持ち越さない。
        analysisState.curLap = { samples: [], cumDist: 0 };
        analysisState.lastX = null;
        analysisState.lastZ = null;
        analysisState.lapClockS = 0;
    }
    analysisState.lastLapNumber = lap;

    // (c2) ラップ内クロック更新(#128: 時間軸の唯一のソース)
    updateLapClock(data);

    // (d) 距離索引更新
    updateDistanceIndex(data);

    // (e) サンプル収集(計測中のみ。lap_count>=1 = コース上でラップ進行中。
    //     旧ゲート current_laptime>0 は 0x80 がゲーム内時刻のため実走行で常時true
    //     となり判定になっていなかった(#127診断)。TEST MODE も lap_count>=1)
    if ((data.lap_count || 0) >= 1) {
        analysisState.curLap.samples.push({
            dist: analysisState.curLap.cumDist,
            t: analysisState.lapClockS,
            speed: data.speed_kmh || 0,
            throttle: data.throttle_pct || 0,
            brake: data.brake_pct || 0,
            x: data.position_x,
            z: data.position_z,
            gear: data.gear || 0,
            zone: classifyZone(data.throttle_pct || 0, data.brake_pct || 0)
        });
    }

    // (f-i) 各表示更新
    updateLiveDelta(data);
    updateEstimatedLap(data);
    checkEngineer(data);
    updateGrip(data);

    // (j) 解析チャート再描画(100ms スロットル)
    const now = performance.now();
    if (now - analysisState.lastChartTs >= CHART_CADENCE_MS) {
        analysisState.lastChartTs = now;
        if (typeof renderAnalysisCharts === 'function') {
            renderAnalysisCharts(getAnalysisChartData());
        }
    }
}

/**
 * ラップ内経過クロックを更新する(#128是正)。
 * dt のソースは受信 timestamp(ライブ経路。main.py:258 が必ず付与)を優先し、
 * timestamp が無いフレーム(TEST MODE合成)のみ current_laptime 差分に
 * フォールバックする(デモは正しいラップ内msを合成する)。
 * dt >= LAP_CLOCK_GAP_S は記録中断(タブ非活性・メニュー等)、paused フレームは
 * ゲーム内一時停止として、いずれも加算しない(真のラップタイマーの挙動)。
 * @param {Object} data - テレメトリデータ(ライブ or 合成)
 */
function updateLapClock(data) {
    let dt = 0;
    if (data.timestamp) {
        const ts = Date.parse(data.timestamp);
        if (!isNaN(ts)) {
            if (analysisState._clockPrevTsMs != null) {
                dt = (ts - analysisState._clockPrevTsMs) / 1000;
            }
            analysisState._clockPrevTsMs = ts;
        }
    } else if (data.current_laptime != null) {
        if (analysisState._clockPrevCltMs != null) {
            dt = (data.current_laptime - analysisState._clockPrevCltMs) / 1000;
        }
        analysisState._clockPrevCltMs = data.current_laptime;
    }

    const paused = !!(data.flags && data.flags.paused);
    if (dt > 0 && dt < LAP_CLOCK_GAP_S && !paused) {
        analysisState.lapClockS += dt;
        analysisState._lastDtS = dt;
    } else {
        analysisState._lastDtS = 0;
    }
}

/**
 * 距離索引を更新する。
 * position が有れば弦長積算、無ければ速度積分でフォールバック。
 * DISCONTINUITY_M 超の弦長(pit/respawn/warp)と paused フレームは加算スキップ。
 * @param {Object} data - テレメトリデータ
 */
function updateDistanceIndex(data) {
    if (data.position_x != null && data.position_z != null) {
        if (analysisState.lastX != null) {
            const seg = Math.hypot(
                data.position_x - analysisState.lastX,
                data.position_z - analysisState.lastZ
            );
            const paused = !!(data.flags && data.flags.paused);
            if (seg <= DISCONTINUITY_M && !paused) {
                analysisState.curLap.cumDist += seg;
            }
        }
        analysisState.lastX = data.position_x;
        analysisState.lastZ = data.position_z;
    } else {
        // フォールバック速度積分(dt はラップ内クロックが当フレームで加算した実dt。
        // 旧実装の current_laptime 差分は 0x80=ゲーム内時刻のため誤り。#128是正)
        const dt = analysisState._lastDtS;
        if (dt > 0) {
            analysisState.curLap.cumDist += (data.speed_ms || 0) * dt;
        }
    }
}

/* ================================================================
 *  ラップ確定・リサンプル
 * ================================================================ */

/**
 * ラップ確定時にベスト更新判定・リファレンスラップ生成・PB通知を行う。
 * @param {number} lapNumber - 確定したラップ番号
 * @param {number} lastLaptimeMs - 確定ラップタイム(ms)
 */
function onLapComplete(lapNumber, lastLaptimeMs) {
    if (!(lastLaptimeMs > 0) || analysisState.curLap.samples.length <= 2) {
        return;
    }

    const isBest = !analysisState.refLap ||
        (lastLaptimeMs < analysisState.refLap.totalTime * 1000);

    if (isBest) {
        const r = resampleByDist(analysisState.curLap.samples, STEP);
        r.totalTime = lastLaptimeMs / 1000;
        r.totalDist = analysisState.curLap.cumDist;
        detectPeaksValleys(r);
        analysisState.refLap = r;
    }

    if (lastLaptimeMs < analysisState.notif.prevBest) {
        pushNotification('PERSONAL BEST', formatLapTime(lastLaptimeMs), 'pb');
        analysisState.notif.prevBest = lastLaptimeMs;
    }

    // 一貫性σ(任意/low)
    analysisState.lapTimesMs.push(lastLaptimeMs);
    updateConsistency();
}

/**
 * サンプル列を距離グリッドで等間隔リサンプルする。
 * dist 昇順走査で各グリッド境界 k*step を線形補間。境界外は端点クランプ。
 * @param {Array} samples - {dist,t,speed,throttle,brake,x,z,...} の配列(dist昇順)
 * @param {number} step - 距離グリッド[m]
 * @returns {Object} {dist[],time[],speed[],throttle[],brake[],x[],z[],N}
 */
function resampleByDist(samples, step) {
    const out = { dist: [], time: [], speed: [], throttle: [], brake: [], x: [], z: [], N: 0 };
    if (!samples || samples.length === 0) {
        return out;
    }

    const lastDist = samples[samples.length - 1].dist || 0;
    const N = Math.floor(lastDist / step) + 1;
    let si = 0;

    for (let k = 0; k < N; k++) {
        const d = k * step;
        // samples[si].dist <= d <= samples[si+1].dist となるよう si を進める
        while (si < samples.length - 2 && samples[si + 1].dist < d) {
            si++;
        }
        const a = samples[si];
        const b = samples[Math.min(si + 1, samples.length - 1)];
        const span = b.dist - a.dist;
        let frac = span > 0 ? (d - a.dist) / span : 0;
        if (frac < 0) frac = 0;
        if (frac > 1) frac = 1;

        out.dist.push(d);
        out.time.push(lerpA(a.t, b.t, frac));
        out.speed.push(lerpA(a.speed, b.speed, frac));
        out.throttle.push(lerpA(a.throttle, b.throttle, frac));
        out.brake.push(lerpA(a.brake, b.brake, frac));
        out.x.push(lerpA(a.x, b.x, frac));
        out.z.push(lerpA(a.z, b.z, frac));
    }
    out.N = N;
    return out;
}

/**
 * リファレンスラップの指定距離における通過タイムを O(1) で線形補間する。
 * @param {number} d - トラック距離[m]
 * @returns {number} 通過タイム[s]
 */
function refTimeAtDist(d) {
    const rl = analysisState.refLap;
    if (!rl || !rl.time || rl.time.length === 0) {
        return 0;
    }
    const N = rl.time.length;
    if (N === 1) {
        return rl.time[0];
    }
    let i = Math.floor(d / STEP);
    if (i < 0) i = 0;
    if (i > N - 2) i = N - 2;
    let frac = (d - i * STEP) / STEP;
    if (frac < 0) frac = 0;
    if (frac > 1) frac = 1;
    return rl.time[i] + (rl.time[i + 1] - rl.time[i]) * frac;
}

/**
 * speed[] の平滑後に局所最大(peaks=直線/トップスピード)・局所最小(valleys=コーナー)を抽出。
 * サンプル<窓幅 は空配列。x/z を格納しコースマップのマーカーに用いる。
 * @param {Object} refLap - resampleByDist の戻り値(speed[],x[],z[] を含む)
 */
function detectPeaksValleys(refLap) {
    refLap.peaks = [];
    refLap.valleys = [];

    const sp = refLap.speed;
    const n = sp ? sp.length : 0;
    if (n < SMOOTH_W) {
        return;
    }

    // 移動平均(窓 SMOOTH_W)
    const sm = new Array(n);
    const half = Math.floor(SMOOTH_W / 2);
    for (let i = 0; i < n; i++) {
        let sum = 0, cnt = 0;
        for (let j = i - half; j <= i + half; j++) {
            if (j >= 0 && j < n) {
                sum += sp[j];
                cnt++;
            }
        }
        sm[i] = sum / cnt;
    }

    for (let m = 1; m < n - 1; m++) {
        if (sm[m] >= sm[m - 1] && sm[m] > sm[m + 1]) {
            if (localProminence(sm, m, 'max') > MIN_PROM) {
                refLap.peaks.push({ x: refLap.x[m], z: refLap.z[m] });
            }
        } else if (sm[m] <= sm[m - 1] && sm[m] < sm[m + 1]) {
            if (localProminence(sm, m, 'min') > MIN_PROM) {
                refLap.valleys.push({ x: refLap.x[m], z: refLap.z[m] });
            }
        }
    }
}

/**
 * 局所顕著性(prominence)を ±PROM_WINDOW 内の最小/最大との差で近似する。
 * @param {number[]} arr - 平滑済み速度配列
 * @param {number} i - 対象インデックス
 * @param {string} type - 'max' | 'min'
 * @returns {number} 顕著性[km/h]
 */
function localProminence(arr, i, type) {
    const a = Math.max(0, i - PROM_WINDOW);
    const b = Math.min(arr.length - 1, i + PROM_WINDOW);
    if (type === 'max') {
        let minSide = arr[i];
        for (let j = a; j <= b; j++) {
            if (arr[j] < minSide) minSide = arr[j];
        }
        return arr[i] - minSide;
    }
    let maxSide = arr[i];
    for (let k = a; k <= b; k++) {
        if (arr[k] > maxSide) maxSide = arr[k];
    }
    return maxSide - arr[i];
}

/**
 * 入力ゾーンを分類する。analysisOnFrame から毎フレーム呼ばれる。
 * @param {number} throttle - スロットル率[%]
 * @param {number} brake - ブレーキ率[%]
 * @returns {string} 'brake' | 'throttle' | 'coast'
 */
function classifyZone(throttle, brake) {
    if (brake > ZONE_THRESH && brake >= throttle) return 'brake';
    if (throttle > ZONE_THRESH) return 'throttle';
    return 'coast';
}

/* ================================================================
 *  ライブ・タイムデルタ / 推定ラップ
 * ================================================================ */

/**
 * ライブ・タイムデルタを更新し #lap-delta / #delta-bar-* を秒差表示に強化する。
 * バー極性の契約: 速い(liveDelta<0)=negative.active(緑) / 遅い=positive.active(赤)。
 * @param {Object} data - テレメトリデータ
 */
function updateLiveDelta(data) {
    const els = analysisState.els;
    const rl = analysisState.refLap;

    if (!rl) {
        clearDeltaUI();
        analysisState._liveDelta = 0;
        return;
    }

    let curDist = analysisState.curLap.cumDist;
    if (curDist > rl.totalDist) {
        curDist = rl.totalDist;
    }
    // 現在時刻はラップ内クロック(#128是正。旧 current_laptime はゲーム内時刻で誤り)
    const liveDelta = analysisState.lapClockS - refTimeAtDist(curDist);
    analysisState._liveDelta = liveDelta;

    if (els.lapDelta) {
        els.lapDelta.textContent = (liveDelta >= 0 ? '+' : '') + liveDelta.toFixed(2) + 's';
        // 3状態デルタ契約: |Δ|<0.05s または基準ラップ未成立=クラス無し(中立) /
        // 速い(Δ<=-0.05s)=.faster / 遅い(Δ>=+0.05s)=.slower。
        // (基準未成立時は関数冒頭の clearDeltaUI が 'delta-value' 素のまま=中立にする)
        let deltaCls = '';
        if (liveDelta <= -DELTA_NEUTRAL_S) {
            deltaCls = ' faster';
        } else if (liveDelta >= DELTA_NEUTRAL_S) {
            deltaCls = ' slower';
        }
        els.lapDelta.className = 'delta-value' + deltaCls;
    }

    const n = Math.max(-1, Math.min(1, liveDelta / MAX_DELTA_S));
    const pct = (Math.abs(n) * 100) + '%';
    if (liveDelta < 0) {
        // 速い → negative バー(緑)
        setDeltaBar(els.barNeg, els.barPos, pct);
    } else {
        // 遅い/オンペース → positive バー(赤)
        setDeltaBar(els.barPos, els.barNeg, pct);
    }
}

/**
 * 推定ラップタイム(全周外挿)を更新し #est-lap-time に反映する。
 * progress<0.05 は表示せず、<0.20 は .tentative(減光)、session-best 予測は .pb(紫)。
 * @param {Object} data - テレメトリデータ
 */
function updateEstimatedLap(data) {
    const EST_MIN_PROGRESS = 0.05;
    const EST_TENTATIVE_PROGRESS = 0.20;

    const els = analysisState.els;
    if (!els.estLap) {
        return;
    }

    const rl = analysisState.refLap;
    if (!rl) {
        els.estLap.textContent = '--:--.---';
        els.estLap.classList.remove('tentative', 'pb');
        return;
    }

    const progress = rl.totalDist > 0 ? (analysisState.curLap.cumDist / rl.totalDist) : 0;
    const estimated = rl.totalTime + analysisState._liveDelta;
    if (!isFinite(estimated) || estimated <= 0) {
        return;
    }

    els.estLap.classList.remove('tentative', 'pb');

    if (progress < EST_MIN_PROGRESS) {
        els.estLap.textContent = '--:--.---';
        return;
    }

    els.estLap.textContent = formatLapTime(Math.round(estimated * 1000));
    if (progress < EST_TENTATIVE_PROGRESS) {
        els.estLap.classList.add('tentative');
    }
    if (estimated * 1000 < rl.totalTime * 1000) {
        els.estLap.classList.add('pb');
    }
}

/* ================================================================
 *  レースエンジニア通知
 * ================================================================ */

/**
 * 通知をキューへ push し描画する。最大3件(超過は最古を除去)。
 * @param {string} label - ラベル
 * @param {string|number} value - 値
 * @param {string} severity - good|warning|serious|critical|pb
 */
function pushNotification(label, value, severity) {
    const MAX_NOTIFICATIONS = 3;
    const q = analysisState.notif.queue;
    q.push({
        label: label,
        value: (value == null) ? '' : String(value),
        severity: severity || 'good',
        ts: performance.now(),
        el: null
    });
    while (q.length > MAX_NOTIFICATIONS) {
        const removed = q.shift();
        if (removed && removed.el && removed.el.parentNode) {
            removed.el.parentNode.removeChild(removed.el);
        }
    }
    renderNotifications();
}

/**
 * 通知キューを #race-engineer-feed に描画する(フェードイン/4秒後自動撤去)。
 */
function renderNotifications() {
    const NOTIF_TTL_MS = 4000;
    const NOTIF_FADE_MS = 300;

    const feed = analysisState.els.feed;
    if (!feed) {
        return;
    }

    analysisState.notif.queue.forEach(function(item) {
        if (item.el) {
            return; // 既描画
        }

        const div = document.createElement('div');
        div.className = 'engineer-alert ' + item.severity;

        const label = document.createElement('span');
        label.className = 'ea-label';
        label.textContent = item.label;

        const val = document.createElement('span');
        val.className = 'ea-value';
        val.textContent = item.value;

        div.appendChild(label);
        div.appendChild(val);
        feed.appendChild(div);
        item.el = div;

        // フェードイン(opacity:0 の初期描画後に .show)
        requestAnimationFrame(function() {
            requestAnimationFrame(function() {
                div.classList.add('show');
            });
        });

        // 4秒後に .show 解除 → トランジション後 remove
        setTimeout(function() {
            div.classList.remove('show');
            setTimeout(function() {
                if (div.parentNode) {
                    div.parentNode.removeChild(div);
                }
                const idx = analysisState.notif.queue.indexOf(item);
                if (idx >= 0) {
                    analysisState.notif.queue.splice(idx, 1);
                }
            }, NOTIF_FADE_MS);
        }, NOTIF_TTL_MS);
    });
}

/**
 * 各閾値クロスを fired フラグで1回だけ発火(新トップスピード/燃料/残周回/ファイナルラップ)。
 * PB は onLapComplete 側で発火する。
 * @param {Object} data - テレメトリデータ
 */
function checkEngineer(data) {
    const notif = analysisState.notif;

    // (a) 新トップスピード(起動直後の連発抑止で最初の数値だけ記録)
    const sp = data.speed_kmh || 0;
    if (sp > notif.topSpeed + TOPSPEED_MARGIN && notif.topSpeed > 0) {
        pushNotification('TOP SPEED', Math.round(sp) + ' km/h', 'good');
    }
    if (sp > notif.topSpeed) {
        notif.topSpeed = sp;
    }

    // (b) 燃料 50/20/10% クロス
    const cap = data.fuel_capacity;
    if (cap > 0) {
        const pct = (data.current_fuel / cap) * 100;
        [50, 20, 10].forEach(function(th) {
            if (notif.prevFuelPct > th && pct <= th && !notif.firedFuel[th]) {
                notif.firedFuel[th] = true;
                pushNotification('FUEL', th + '%',
                    th <= 10 ? 'critical' : th <= 20 ? 'serious' : 'warning');
            }
        });
        notif.prevFuelPct = pct;
    }

    // (c) 残周回 / ファイナルラップ
    if (data.total_laps > 0) {
        const rem = data.total_laps - data.lap_count;
        [15, 10, 5, 2].forEach(function(th) {
            if (rem === th && !notif.firedLaps[th]) {
                notif.firedLaps[th] = true;
                pushNotification('LAPS LEFT', th, th <= 2 ? 'serious' : 'warning');
            }
        });
        if (data.lap_count === data.total_laps && !notif.finalFired) {
            notif.finalFired = true;
            pushNotification('FINAL LAP', '', 'critical');
        }
    }
}

/* ================================================================
 *  グリップ / 一貫性(任意/low・要素欠落時は no-op)
 * ================================================================ */

/**
 * ホイールスピン/ロックアップを検出し #grip-status に反映する(任意)。
 * @param {Object} data - テレメトリデータ
 */
function updateGrip(data) {
    const SLIP_SPIN = 1.10, SLIP_LOCK = 0.85, SPIN_THROTTLE_PCT = 50, LOCK_BRAKE_PCT = 20;

    const el = analysisState.els.gripStatus;
    if (!el) {
        return; // 要素が無ければ何もしない
    }

    const rps = data.wheel_rps;
    const rad = data.tyre_radius;
    const speedMs = data.speed_ms || 0;
    if (!rps || !rad || rps.length < 4 || rad.length < 4 || speedMs < MIN_SPEED_MS) {
        return;
    }

    // 全輪の最大周速(駆動輪不明のため最大採用)
    let maxSurface = 0;
    for (let i = 0; i < 4; i++) {
        const s = Math.abs(rps[i]) * (rad[i] || 0) * WHEEL_SPEED_K;
        if (s > maxSurface) maxSurface = s;
    }
    const slip = maxSurface / Math.max(speedMs, 1);

    let status = 'GRIP OK';
    let cls = 'ok';
    if (slip > SLIP_SPIN && (data.throttle_pct || 0) > SPIN_THROTTLE_PCT) {
        status = 'SPIN';
        cls = 'spin';
    } else if (slip < SLIP_LOCK && (data.brake_pct || 0) > LOCK_BRAKE_PCT) {
        status = 'LOCK';
        cls = 'lock';
    }
    el.textContent = status;
    el.className = 'grip-status ' + cls;
}

/**
 * 直近ラップタイムのσ(一貫性)を #consistency-stat に反映する(任意)。
 */
function updateConsistency() {
    const el = analysisState.els.consistency;
    if (!el) {
        return;
    }
    const arr = analysisState.lapTimesMs;
    if (arr.length < 2) {
        el.textContent = 'σ --';
        return;
    }
    const recent = arr.slice(-5);
    const mean = recent.reduce(function(a, b) { return a + b; }, 0) / recent.length;
    let varSum = 0;
    recent.forEach(function(v) { varSum += (v - mean) * (v - mean); });
    const sd = Math.sqrt(varSum / recent.length);
    el.textContent = 'σ ' + (sd / 1000).toFixed(2) + 's';
}

/* ================================================================
 *  解析チャート用データ供給
 * ================================================================ */

/**
 * 距離軸チャート(C の renderAnalysisCharts)へ渡す等長データを組み立てる。
 * 未確定区間は null(uPlot が gap 描画)。refLap==null の間は ref/delta を全 null。
 * @returns {Object} {xs[],curSpeed[],refSpeed[],delta[]}
 */
function getAnalysisChartData() {
    const rl = analysisState.refLap;
    const cur = resampleByDist(analysisState.curLap.samples, STEP);
    const curN = cur.N || 0;
    const refN = rl ? rl.time.length : 0;
    const N = Math.max(curN, refN, 1);
    const curDist = analysisState.curLap.cumDist;

    const xs = new Array(N);
    const curSpeed = new Array(N);
    const refSpeed = new Array(N);
    const delta = new Array(N);

    for (let k = 0; k < N; k++) {
        const d = k * STEP;
        xs[k] = d;

        curSpeed[k] = (k < curN && d <= curDist) ? cur.speed[k] : null;
        refSpeed[k] = (rl && k < refN) ? rl.speed[k] : null;

        if (rl && k < curN && k < refN && d <= curDist) {
            delta[k] = cur.time[k] - rl.time[k];
        } else {
            delta[k] = null;
        }
    }

    return { xs: xs, curSpeed: curSpeed, refSpeed: refSpeed, delta: delta };
}
