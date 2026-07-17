/**
 * GT7 Telemetry Dashboard - 全カード再生モード (Redmine #133/#134)
 *
 * 過去ラップ(gt7data記録)を既存の単一入口 handleTelemetryMessage() へ流し込み、
 * ライブと同じ全カード(約20枚)を時間/距離スクラバー付きで再生する。
 * 設計: docs/全カード再生詳細計画書_20260716.md(計最終承認済み)。
 *
 * 設計原則:
 *  - 既存トップレベルシンボル無改変。本ファイルの新規名は replay 接頭辞。
 *  - ライブWS受信・サーバ記録は再生中も継続(表示のみ排他)。排他は
 *    websocket.js processTelemetryFrame と steer-response.js 較正ガードの
 *    replayActive 参照(計2分岐)で実現(§5.1/§5.1.1)。
 *  - 終了時は stopTestMode と同じ復元列(resetAnalysis+resetLapState)。
 *
 * @module replay-mode
 * @depends websocket.js (handleTelemetryMessage), lap-manager.js (resetLapState,
 *          updateMaxSpeed), telemetry-analysis.js (resetAnalysis),
 *          review-view.js (一覧メタ=size_bytes 参照・v1縮退誘導)。全て typeof ガード。
 */

/* ================================================================
 *  定数
 * ================================================================ */

// 再生が要求するフィールド(フロント消費58種の機械抽出結果。再抽出コマンド:
//   grep -ohE 'data\.[a-z_0-9]+' *.js | sort -u   ※カード追加時はこの手順で追随)
const REPLAY_FIELDS = (
    'accel_decel,accel_g,angular_velocity_y,best_laptime,body_accel_heave,' +
    'body_accel_surge,body_accel_sway,body_height,boost,brake_filtered_pct,' +
    'brake_pct,car_id,clutch,clutch_engagement,clutch_gearbox_rpm,course,' +
    'current_fuel,current_laptime,flags,fuel_capacity,fuel_laps_remaining,' +
    'fuel_per_lap,gear,gear_ratios,lap_count,last_laptime,max_rpm,' +
    'num_cars_pre_race,oil_pressure,package_id,position_x,position_y,' +
    'position_z,pre_race_position,road_plane_distance,road_plane_x,' +
    'road_plane_y,road_plane_z,rotation_pitch,rotation_roll,rotation_yaw,' +
    'rpm,rpm_alert_min,speed_kmh,speed_ms,susp_height,throttle_filtered_pct,' +
    'throttle_pct,timestamp,total_laps,transmission_max_speed,tyre_radius,' +
    'tyre_temp,velocity_x,velocity_y,velocity_z,wheel_rotation,wheel_rps'
);

// 多段フォールバック閾値(生 size_bytes 基準。射影係数0.89の実測に基づく。§3.2)
const REPLAY_SIZE_LOWRATE_B = 34 * 1024 * 1024;   // 超過で 30Hz 上限(60Hz差替なし)
const REPLAY_SIZE_SEGMENT_B = 101 * 1024 * 1024;  // 超過で 10Hz+区間選択のみ

// 時間・距離索引(REVIEW/#128 と同一規則)
const REPLAY_TIME_GAP_S = 2.0;       // dt がこれ以上=記録中断(ギャップ)
const REPLAY_DISCONTINUITY_M = 120;  // 1フレーム弦長がこれ超=瞬間移動(距離加算スキップ)

const REPLAY_TICK_MS = 50;                    // 再生タイマ周期
const REPLAY_SPEEDS = [0.5, 1, 2, 4];         // 倍速の選択肢
const REPLAY_CHART_WINDOW = 1200;             // シーク時のチャート窓(CHART_POINTS と同値)

// ライブ表示排他フラグ。websocket.js:processTelemetryFrame と
// steer-response.js:較正ガード が typeof ガード付きで参照する(計2箇所)。
let replayActive = false;

/* ================================================================
 *  状態(単一オブジェクト)
 * ================================================================ */
const replayState = {
    file: null,
    meta: null,
    frames: [],        // 供給フレーム(現行バッファ)
    t: [],             // 各フレームの経過秒(クランプ累積)
    d: [],             // 各フレームの累積距離[m]
    gaps: [],          // ギャップ開始フレーム index の一覧
    segments: [],      // {start,end} 有効区間(ギャップで分割)
    rateLabel: '10Hz',
    tier: 'normal',    // 'normal' | 'lowrate' | 'segment'
    playing: false,
    speed: 1,
    playhead: 0,       // 再生位置[s](t軸)
    playIdx: 0,        // 次に供給するフレーム index
    timer: null,
    lastTickMs: 0,
    hqRequested: false,
    fromReview: false, // 入口が REVIEW だったか(終了時の復帰先)
    seq: 0,            // 起動世代(古い fetch 応答の破棄用)
    els: null
};

/* ================================================================
 *  DOM
 * ================================================================ */

function replayEnsureEls() {
    if (replayState.els) {
        return replayState.els;
    }
    replayState.els = {
        bar: document.getElementById('replay-bar'),
        title: document.getElementById('replay-title'),
        btnPlay: document.getElementById('replay-btn-play'),
        btnStepB: document.getElementById('replay-btn-step-b'),
        btnStepF: document.getElementById('replay-btn-step-f'),
        speed: document.getElementById('replay-speed'),
        scrubber: document.getElementById('replay-scrubber'),
        time: document.getElementById('replay-time'),
        segment: document.getElementById('replay-segment'),
        btnExit: document.getElementById('replay-btn-exit')
    };
    return replayState.els;
}

/* ================================================================
 *  索引構築
 * ================================================================ */

/**
 * フレーム列から時間・距離索引とギャップ/有効区間を構築する。
 * 時間: timestamp のクランプ付き累積秒(#128 と同一規則)。
 * 距離: position x/z の弦長積算(120mクランプ。REVIEW と同一規則)。
 * @param {Array} frames
 * @returns {{t:number[], d:number[], gaps:number[], segments:Array}}
 */
function replayBuildIndices(frames) {
    const t = new Array(frames.length);
    const d = new Array(frames.length);
    const gaps = [];
    let clock = 0;
    let dist = 0;
    let prevTs = null;
    let lastX = null;
    let lastZ = null;

    for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        if (f.timestamp) {
            const ts = Date.parse(f.timestamp);
            if (!isNaN(ts)) {
                if (prevTs !== null) {
                    const dt = (ts - prevTs) / 1000;
                    if (dt > 0 && dt < REPLAY_TIME_GAP_S) {
                        clock += dt;
                    } else if (dt >= REPLAY_TIME_GAP_S) {
                        gaps.push(i);
                    }
                }
                prevTs = ts;
            }
        }
        t[i] = clock;
        if (f.position_x != null && f.position_z != null) {
            if (lastX !== null) {
                const seg = Math.hypot(f.position_x - lastX, f.position_z - lastZ);
                if (seg <= REPLAY_DISCONTINUITY_M) {
                    dist += seg;
                }
            }
            lastX = f.position_x;
            lastZ = f.position_z;
        }
        d[i] = dist;
    }

    // 有効区間 = ギャップで分割した範囲(先頭は lap_count>=1 の最初のフレームから)
    let validStart = 0;
    while (validStart < frames.length && (frames[validStart].lap_count || 0) < 1) {
        validStart++;
    }
    const bounds = [validStart].concat(gaps.filter(function(g) { return g > validStart; }));
    const segments = [];
    for (let b = 0; b < bounds.length; b++) {
        const start = bounds[b];
        const end = (b + 1 < bounds.length) ? bounds[b + 1] - 1 : frames.length - 1;
        if (end > start + 1) {
            segments.push({ start: start, end: end });
        }
    }
    if (!segments.length && frames.length) {
        segments.push({ start: 0, end: frames.length - 1 });
    }
    return { t: t, d: d, gaps: gaps, segments: segments };
}

/* ================================================================
 *  データ取得(2段ロード §2.2 / 多段フォールバック §3)
 * ================================================================ */

function replayFetch(file, every) {
    return fetch('/api/laps/' + encodeURIComponent(file) +
                 '?every=' + every + '&fields=' + REPLAY_FIELDS)
        .then(function(res) {
            if (!res.ok) {
                throw new Error('HTTP ' + res.status);
            }
            return res.json();
        });
}

/**
 * サイズ階層の判定(§3.2)。一覧メタ(size_bytes)から追加通信なしで判定する。
 * 一覧メタが参照できない場合は 'normal' 扱い(取得後の実サイズで補正はしない。
 * 通常経路では REVIEW 一覧経由のため size_bytes は常に得られる)。
 */
function replaySizeTier(file) {
    let size = null;
    if (typeof reviewState !== 'undefined' && reviewState.lapsByFile &&
        reviewState.lapsByFile[file]) {
        size = reviewState.lapsByFile[file].size_bytes;
    }
    if (size == null) {
        return 'normal';
    }
    if (size > REPLAY_SIZE_SEGMENT_B) {
        return 'segment';
    }
    if (size > REPLAY_SIZE_LOWRATE_B) {
        return 'lowrate';
    }
    return 'normal';
}

/**
 * 再生開始(REVIEW 一覧の▶から呼ばれる公開入口)。
 * 10Hz 先行ロード → v1 判定 → モード進入 → 再生開始 → 背景高レート差替。
 * @param {string} file - gt7data ファイル名
 */
function replayStart(file) {
    const seq = ++replayState.seq;
    const tier = replaySizeTier(file);
    const els = replayEnsureEls();
    if (!els.bar) {
        return; // DOM 不在環境では何もしない(既存作法)
    }

    replayFetch(file, 6)
        .then(function(body) {
            if (seq !== replayState.seq) {
                return; // 多重起動の古い応答は破棄
            }
            // v1 旧スキーマは再生対象外(采決裁#5) → REVIEW 比較へ誘導
            if (body.meta && body.meta.schema === 'v1') {
                replayShowV1Fallback(file);
                return;
            }
            replayState.file = file;
            replayState.meta = body.meta;
            replayState.tier = tier;
            replayState.rateLabel = '10Hz';
            replayState.hqRequested = false;
            replayState.fromReview =
                document.body.classList.contains('review-mode');
            replaySetBuffer(body.samples);
            replayEnterMode();
            replaySeek(replayState.segments[0].start);
            replaySetPlaying(true);
            replayMaybeUpgrade(file, seq);
        })
        .catch(function(err) {
            const rEls = (typeof ensureReviewEls === 'function') ? ensureReviewEls() : null;
            if (rEls && rEls.listStatus) {
                rEls.listStatus.textContent =
                    '再生データを取得できません (' + err.message + ')';
            }
        });
}

/** バッファと索引を差し替える(初回ロード・高レート差替の共通処理)。 */
function replaySetBuffer(frames) {
    replayState.frames = frames || [];
    const idx = replayBuildIndices(replayState.frames);
    replayState.t = idx.t;
    replayState.d = idx.d;
    replayState.gaps = idx.gaps;
    replayState.segments = idx.segments;
    replayRenderSegments();
    replayUpdateBar();
    // 実レース由来メトリクス P1 (#145): バッファ確定を race-metrics.js へ(唯一のフック)
    if (typeof rmOnReplayBuffer === 'function') rmOnReplayBuffer();
}

/**
 * 背景の高レート差替(§2.2)。tier に応じて 60Hz / 30Hz / なし。
 * 差替は「現在の playhead 秒 → 新バッファ index」の再マップでシームレスに行う。
 */
function replayMaybeUpgrade(file, seq) {
    let every = null;
    let label = null;
    if (replayState.tier === 'normal') {
        every = 1;
        label = '60Hz';
    } else if (replayState.tier === 'lowrate') {
        every = 2;
        label = '30Hz(大容量)';
    } else {
        return; // segment: 10Hz のまま(§3.2。区間高レート化は将来課題)
    }
    replayState.hqRequested = true;
    replayFetch(file, every)
        .then(function(body) {
            if (seq !== replayState.seq || !replayActive) {
                return; // 再生が終了/切替済みなら破棄
            }
            const playheadKeep = replayState.playhead;
            replaySetBuffer(body.samples);
            replayState.rateLabel = label;
            replayState.playIdx = replayIdxForTime(playheadKeep);
            // #135 修正案1-B: 差替後はチャート窓を新バッファで再構築し、
            // 10Hz点と60/30Hz点が同一チャート内に混在する時間スケール不整合を解消する
            const cur = Math.max(0, Math.min(replayState.frames.length - 1,
                                             replayState.playIdx));
            replayRebuildChartWindow(cur, replayLapStartFor(cur));
            replayUpdateBar();
        })
        .catch(function() {
            // 高レート取得失敗時は先行バッファのまま継続(黙って劣化しない=表示に明示)
            replayState.rateLabel = replayState.rateLabel + '(高レート取得失敗)';
            replayUpdateBar();
        });
}

/* ================================================================
 *  モード進入・終了(排他と復元 §5)
 * ================================================================ */

function replayEnterMode() {
    // REVIEW から起動した場合はいったん降ろす(排他)。選択状態は review 側に残る
    if (document.body.classList.contains('review-mode') &&
        typeof applyReviewMode === 'function') {
        applyReviewMode(false);
    }
    // 集約スタット・解析状態を初期化(采決裁#6。TEST MODE 開始時と同じ扱い)
    if (typeof resetLapState === 'function') {
        resetLapState();
    }
    if (typeof resetAnalysis === 'function') {
        resetAnalysis();
    }
    replayActive = true;   // ライブ表示遮断(受信・記録は継続)
    document.body.classList.add('replay-mode');
    replayUpdateBar();
}

/**
 * 再生終了と復元(§5.5。stopTestMode と同じ復元列)。
 */
function replayStop() {
    if (!replayActive && !replayState.file) {
        return;
    }
    replaySetPlaying(false);
    replayState.seq++;            // 進行中の背景fetch応答を無効化
    replayState.file = null;
    replayState.frames = [];      // 大容量バッファの参照切り(GC対象化)
    replayState.t = [];
    replayState.d = [];
    replayState.gaps = [];
    replayState.segments = [];

    if (typeof resetAnalysis === 'function') {
        resetAnalysis();
    }
    if (typeof resetLapState === 'function') {
        resetLapState();
    }
    replayActive = false;         // ライブ表示が自然再開
    document.body.classList.remove('replay-mode');

    // REVIEW 起点なら REVIEW へ復帰
    if (replayState.fromReview && typeof applyReviewMode === 'function') {
        applyReviewMode(true);
    }
    replayState.fromReview = false;
}

/** v1 旧スキーマの縮退(采決裁#5): 案内を出して REVIEW 比較へ誘導する。 */
function replayShowV1Fallback(file) {
    if (typeof reviewState === 'undefined' ||
        typeof applyReviewMode !== 'function') {
        return;
    }
    reviewState.selA = file;
    if (reviewState.selB === file) {
        reviewState.selB = null;
    }
    applyReviewMode(true);
    if (typeof reviewRenderList === 'function') {
        reviewRenderList();   // Aバッジを即時表示
    }
    // 注意: reviewUpdateComparison() はここでは呼ばない。詳細fetch完了時に
    // listStatus を空文字で上書きするため、下の案内メッセージが消える。
    // 比較チャートはユーザーの次の操作(B選択等)で自然にロードされる。
    const rEls = (typeof ensureReviewEls === 'function') ? ensureReviewEls() : null;
    if (rEls && rEls.listStatus) {
        rEls.listStatus.textContent =
            'この記録は旧形式(v1)のため再生非対応です。REVIEW比較(A設定済み)でご覧ください。';
    }
}

/* ================================================================
 *  再生タイマ・フレーム供給
 * ================================================================ */

function replaySetPlaying(on) {
    replayState.playing = on;
    const els = replayEnsureEls();
    if (els.btnPlay) {
        els.btnPlay.textContent = on ? '❚❚' : '▶';
        els.btnPlay.setAttribute('aria-label', on ? '一時停止' : '再生');
    }
    if (on && !replayState.timer) {
        replayState.lastTickMs = performance.now();
        replayState.timer = setInterval(replayTick, REPLAY_TICK_MS);
    } else if (!on && replayState.timer) {
        clearInterval(replayState.timer);
        replayState.timer = null;
    }
}

/** 再生タイマ本体: playhead を実時間×倍速で進め、追い越したフレームを順に供給する。 */
function replayTick() {
    if (!replayActive || !replayState.playing || !replayState.frames.length) {
        return;
    }
    const now = performance.now();
    const dt = (now - replayState.lastTickMs) / 1000;
    replayState.lastTickMs = now;
    replayState.playhead += dt * replayState.speed;

    const t = replayState.t;
    const n = replayState.frames.length;
    let i = replayState.playIdx;
    let supplied = 0;

    while (i < n && t[i] <= replayState.playhead) {
        // ギャップ境界: 実時間待ちせず次区間の先頭へジャンプ(§4.3)
        if (replayState.gaps.indexOf(i) !== -1) {
            replayState.playhead = t[i];
        }
        replaySupplyFrame(i);
        i++;
        supplied++;
        if (supplied > 240) {
            break; // 1tick の供給上限(タブ復帰時の暴走防止)。playhead を実位置へ戻す
        }
    }
    if (supplied > 240) {
        replayState.playhead = t[Math.min(i, n - 1)];
    }
    replayState.playIdx = i;

    if (i >= n) {
        replaySetPlaying(false); // 終端で自動停止(バーは表示のまま)
    }
    replayUpdateBar();
}

/** 1フレームを既存単一入口へ供給する。 */
function replaySupplyFrame(i) {
    const f = replayState.frames[i];
    if (f && typeof handleTelemetryMessage === 'function') {
        handleTelemetryMessage(f, performance.now());
    }
}

/* ================================================================
 *  シーク(§4.3)・スクラバー
 * ================================================================ */

/** 指定秒に対応するフレーム index(二分探索)。 */
function replayIdxForTime(sec) {
    const t = replayState.t;
    let lo = 0;
    let hi = t.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (t[mid] < sec) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

/** 指定距離[m]に対応するフレーム index(二分探索。d は単調非減少)。 */
function replayIdxForDist(m) {
    const d = replayState.d;
    let lo = 0;
    let hi = d.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (d[mid] < m) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

/**
 * 指定フレームが属するラップの先頭 index を返す。
 * @param {number} idx
 * @returns {number}
 */
function replayLapStartFor(idx) {
    const frames = replayState.frames;
    const lap = frames[idx].lap_count;
    let lapStart = idx;
    while (lapStart > 0 && frames[lapStart - 1].lap_count === lap) {
        lapStart--;
    }
    return lapStart;
}

/**
 * ストリップチャート窓の再構築(#135 修正案1-A/1-B)。
 * リング配列(timeData/speedData等)全1200点を対象フレーム列から直接構築し、
 * 各チャートへ setData を1回だけ発行する。旧方式(updateChartState を最大1200回
 * 同期呼出し)は (a)窓に満たない先頭に直前の内容(ライブ/デモの残骸)が残存して
 * 新旧データが混在表示される (b)uPlot 全再描画×1200回の同期バーストで実機が
 * 数秒フリーズし得る、の2因子で「グラフが壊れる」原因だった(調査レポート§1)。
 * 窓に満たない先頭は 0 で明示的にクリアする。加速度チャートも同様に
 * 配列を直接構築して描画1回にまとめる。
 * @param {number} idx - 窓の右端となるフレーム index
 * @param {number} windowStart - 窓の左端の下限(通常はラップ先頭)
 */
function replayRebuildChartWindow(idx, windowStart) {
    // チャート未初期化環境(データ源未起動)では何もしない
    if (typeof timeData === 'undefined' || typeof updateChartState !== 'function') {
        return;
    }
    const frames = replayState.frames;
    const N = REPLAY_CHART_WINDOW;   // = CHART_POINTS(1200)
    const from = Math.max(windowStart, idx - N + 1);
    const count = idx - from + 1;
    const pad = N - count;

    for (let k = 0; k < N; k++) {
        // x は従来と同じ「連番の継続」(uPlot のスケールは窓に追随する。実測済み)
        timeData[k] = timeCounter + k;
        if (k < pad) {
            speedData[k] = 0;
            rpmData[k] = 0;
            throttleData[k] = 0;
            brakeData[k] = 0;
        } else {
            const f = frames[from + (k - pad)];
            speedData[k] = Math.round(f.speed_kmh || 0);
            rpmData[k] = Math.round(f.rpm || 0);
            throttleData[k] = Math.round(f.throttle_pct || 0);
            brakeData[k] = Math.round(f.brake_pct || 0);
        }
    }
    timeCounter += N;

    if (typeof speedChart !== 'undefined' && speedChart) {
        speedChart.setData([timeData, speedData]);
    }
    if (typeof rpmChart !== 'undefined' && rpmChart) {
        rpmChart.setData([timeData, rpmData]);
    }
    if (typeof throttleChart !== 'undefined' && throttleChart) {
        throttleChart.setData([timeData, throttleData]);
    }
    if (typeof brakeChart !== 'undefined' && brakeChart) {
        brakeChart.setData([timeData, brakeData]);
    }

    // 加速度チャート: 配列を直接構築し drawAccelChart() 1回(旧方式は毎push描画)
    if (typeof accelData !== 'undefined' && Array.isArray(accelData.accelG)) {
        accelData.accelG.length = 0;
        accelData.accelDecel.length = 0;
        const maxPts = (typeof ACCEL_CHART_CONFIG !== 'undefined' &&
                        ACCEL_CHART_CONFIG.maxPoints) || 100;
        const aFrom = Math.max(from, idx - maxPts + 1);
        for (let j = aFrom; j <= idx; j++) {
            accelData.accelG.push(frames[j].accel_g || 0);
            accelData.accelDecel.push(frames[j].accel_decel || 0);
        }
        if (typeof drawAccelChart === 'function') {
            drawAccelChart();
        }
    }
}

/**
 * シーク実行(§4.3): ①集約スタット再計算 ②チャート窓の再構築 ③現在フレーム供給。
 * @param {number} idx - シーク先フレーム index
 */
function replaySeek(idx) {
    const n = replayState.frames.length;
    if (!n) {
        return;
    }
    idx = Math.max(0, Math.min(n - 1, idx));

    // ①集約スタット(采決裁#6): リセット後「現在ラップ内のシーク位置までの最大」を再計算
    if (typeof resetLapState === 'function') {
        resetLapState();
    }
    if (typeof resetAnalysis === 'function') {
        resetAnalysis();
    }
    const lapStart = replayLapStartFor(idx);
    let maxSpeed = 0;
    for (let j = lapStart; j <= idx; j++) {
        const s = replayState.frames[j].speed_kmh || 0;
        if (s > maxSpeed) {
            maxSpeed = s;
        }
    }
    if (typeof updateMaxSpeed === 'function') {
        updateMaxSpeed(Math.round(maxSpeed));
    }

    // ②ストリップチャート窓: リング全点を直接構築し setData 1回(#135 1-A)
    replayRebuildChartWindow(idx, lapStart);

    // ③位置確定・現在フレームの即時反映
    replayState.playIdx = idx;
    replayState.playhead = replayState.t[idx];
    replaySupplyFrame(idx);
    replayState.playIdx = idx + 1;
    replayUpdateBar();
}

/* ================================================================
 *  バーUI(§4.2)
 * ================================================================ */

function replayFmtTime(sec) {
    const m = Math.floor(sec / 60);
    const s = (sec - m * 60).toFixed(1);
    return m + ':' + (s.length < 4 ? '0' : '') + s;
}

function replayUpdateBar() {
    const els = replayEnsureEls();
    if (!els.bar) {
        return;
    }
    const n = replayState.frames.length;
    const total = n ? replayState.t[n - 1] : 0;
    if (els.title) {
        const course = replayState.meta && replayState.meta.course;
        els.title.textContent = (replayState.file || '') +
            (course && (course.name_ja || course.name_en)
                ? ' | ' + (course.name_ja || course.name_en) : '') +
            ' | ' + replayState.rateLabel;
    }
    if (els.scrubber && n) {
        els.scrubber.max = String(Math.ceil(total * 10));
        els.scrubber.value = String(Math.round(replayState.playhead * 10));
    }
    if (els.time && n) {
        const i = Math.max(0, Math.min(n - 1, replayState.playIdx - 1));
        els.time.textContent = replayFmtTime(replayState.playhead) + ' / ' +
            replayFmtTime(total) + ' | ' + Math.round(replayState.d[i]) + 'm';
    }
}

/** 区間セレクト(segment tier のみ表示)。 */
function replayRenderSegments() {
    const els = replayEnsureEls();
    if (!els.segment) {
        return;
    }
    const segs = replayState.segments;
    const show = replayState.tier === 'segment' && segs.length > 1;
    els.segment.style.display = show ? '' : 'none';
    if (!show) {
        return;
    }
    els.segment.innerHTML = '';
    segs.forEach(function(seg, k) {
        const opt = document.createElement('option');
        opt.value = String(k);
        opt.textContent = '区間' + (k + 1) + ' (' +
            replayFmtTime(replayState.t[seg.start]) + '〜' +
            replayFmtTime(replayState.t[seg.end]) + ')';
        els.segment.appendChild(opt);
    });
}

/* ================================================================
 *  初期化(自己初期化。既存 UI との配線)
 * ================================================================ */

function initReplayMode() {
    const els = replayEnsureEls();
    if (!els.bar) {
        return;
    }

    if (els.btnPlay) {
        els.btnPlay.addEventListener('click', function() {
            if (replayState.playIdx >= replayState.frames.length) {
                replaySeek(replayState.segments.length
                    ? replayState.segments[0].start : 0); // 終端からの再再生
            }
            replaySetPlaying(!replayState.playing);
        });
    }
    if (els.btnStepB) {
        els.btnStepB.addEventListener('click', function() {
            replaySetPlaying(false);
            replaySeek(Math.max(0, replayState.playIdx - 2));
        });
    }
    if (els.btnStepF) {
        els.btnStepF.addEventListener('click', function() {
            replaySetPlaying(false);
            replaySeek(replayState.playIdx);
        });
    }
    if (els.speed) {
        REPLAY_SPEEDS.forEach(function(sp) {
            const opt = document.createElement('option');
            opt.value = String(sp);
            opt.textContent = sp + 'x';
            if (sp === 1) {
                opt.selected = true;
            }
            els.speed.appendChild(opt);
        });
        els.speed.addEventListener('change', function() {
            replayState.speed = parseFloat(els.speed.value) || 1;
        });
    }
    if (els.scrubber) {
        // ドラッグ中はプレビュー(時刻表示のみ)、確定でシーク(§4.3)
        els.scrubber.addEventListener('input', function() {
            const sec = (parseInt(els.scrubber.value, 10) || 0) / 10;
            if (els.time) {
                els.time.textContent = replayFmtTime(sec) + ' へ移動…';
            }
        });
        els.scrubber.addEventListener('change', function() {
            const sec = (parseInt(els.scrubber.value, 10) || 0) / 10;
            replaySetPlaying(false);
            replaySeek(replayIdxForTime(sec));
        });
    }
    if (els.segment) {
        els.segment.addEventListener('change', function() {
            const seg = replayState.segments[parseInt(els.segment.value, 10) || 0];
            if (seg) {
                replaySetPlaying(false);
                replaySeek(seg.start);
            }
        });
    }
    if (els.btnExit) {
        els.btnExit.addEventListener('click', function() {
            replayStop();
        });
    }

    // 他モードへの切替を検知して再生を自動終了する(§5.2。既存 Observer パターン)
    if (typeof MutationObserver === 'function') {
        ['test-mode-btn', 'view-mode-btn', 'review-mode-btn'].forEach(function(id) {
            const btn = document.getElementById(id);
            if (!btn) {
                return;
            }
            const mo = new MutationObserver(function() {
                if (replayActive && btn.classList.contains('active')) {
                    replayState.fromReview = false; // 明示遷移なので REVIEW 復帰しない
                    replayStop();
                }
            });
            mo.observe(btn, { attributes: true, attributeFilter: ['class'] });
        });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initReplayMode);
} else {
    initReplayMode();
}
