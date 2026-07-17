/**
 * GT7 Telemetry Dashboard - 実レース由来メトリクス P1 (Redmine #144/#145)
 *
 * M-1: G-G ダイアグラム(摩擦円) — REVIEW(A/B重畳)・全カード再生(全体+現在位置)
 * M-2: コーナーフェーズ別デルタ + トレイルブレーキ重なり指標 — REVIEW比較
 * 設計: docs/実レース由来6項目計画書_20260717.md §2/§3(計最終承認済み・差し戻し是正版)
 *
 * 原則(采指定・#145指示書):
 *  - 全て読み出し系のみ。ライブ受信経路・既存フレーム経路には一切フックしない。
 *  - 既存グローバル(replayState/reviewState/STEP/classifyZone等)は読み取り専用。
 *    書込は本ファイルの rm 接頭辞状態のみ(実装後に書込0件grepで証明)。
 *  - 既存への接続はフック各1行(review-view.js / replay-mode.js)から呼ばれる
 *    rmOnReviewCompare / rmOnReplayBuffer のみ。
 *  - G-G はライブ ANALYSIS には追加しない(采決裁)。カードは下部追加行のみ。
 *  - REVIEW側の補助データ(加速度・舵角)は既存 /api/laps/{file} から
 *    必要4フィールドのみ射影で追加取得する(#145キックオフ後の計承認=案a)。
 *
 * @module race-metrics
 * @depends telemetry-analysis.js (STEP, classifyZone — typeofガード読み取り)
 * @depends replay-mode.js (replayState — 読み取りのみ) / review-view.js (フック元)
 */

/* ================================================================
 *  定数
 * ================================================================ */
const RM_G = 9.81;
const RM_GG_RINGS_G = [0.5, 1.0, 1.5];   // 摩擦円ガイド半径[G]
const RM_GG_RANGE_G = 1.8;               // 描画レンジ[±G]
const RM_GG_MAX_POINTS = 3000;           // 散布点の間引き上限(描画コスト対策)
const RM_STEP_FALLBACK_M = 10;           // STEP 参照不可時のフォールバック
const RM_CORNER_SMOOTH = 5;              // コーナー検出: 速度平滑窓(グリッド数)
const RM_CORNER_PROM_KMH = 15;           // コーナー検出: 極小の顕著性[km/h]
const RM_CORNER_WINDOW = 15;             // コーナー区間の半幅(グリッド=150m)
const RM_TRAIL_STEER_NORM_RAD = 0.5;     // トレイル重なりの舵角正規化上限[rad]
const RM_TOP_CORNERS = 5;                // コーナー別得失の表示数
const RM_REPLAY_HL_MS = 250;             // 再生G-Gの現在位置更新周期
// 補助取得(案a): 必要最小フィールドのみ射影(位置は距離軸整合用)
// P2(#146): サスヒストグラム用に susp_height を追加(承認済み方式の同一枠内)
const RM_AUX_FIELDS = 'timestamp,position_x,position_z,body_accel_sway,' +
                      'accel_g,accel_decel,wheel_rotation,brake_pct,susp_height';
const RM_AUX_EVERY = 6;

/* ---- P2(#146) 定数 ---- */
const RM_HISTO_BINS = 20;                 // サス変位ヒストグラムのビン数
const RM_WHEELS = ['FL', 'FR', 'RL', 'RR'];
const RM_STRATEGY_TICK_MS = 1000;         // M-4 ライブポーリング周期(1Hz)
const RM_DEG_LAPS = 5;                    // デグ回帰に使う直近ラップ数
const RM_DEG_OUTLIER_FRAC = 0.08;         // 中央値±8%超を外れ値(ピット/ミス周)として除外

/* ================================================================
 *  状態(rm 接頭辞のみに書込)
 * ================================================================ */
const rmState = {
    els: null,
    auxCache: {},        // file -> {samples} 補助取得キャッシュ
    reviewToken: 0,      // 比較世代(古い応答破棄)
    replayHlTimer: null, // 再生G-Gの現在位置タイマ
    replayGGBase: null   // 再生G-Gの事前描画(offscreen canvas)
};

function rmEnsureEls() {
    if (rmState.els) {
        return rmState.els;
    }
    rmState.els = {
        reviewCard: document.getElementById('rm-review-card'),
        ggReview: document.getElementById('rm-gg-review'),
        phaseTable: document.getElementById('rm-phase-table'),
        cornerList: document.getElementById('rm-corner-list'),
        trailBox: document.getElementById('rm-trail-box'),
        replayCard: document.getElementById('rm-replay-card'),
        ggReplay: document.getElementById('rm-gg-replay'),
        suspReview: document.getElementById('rm-susp-review'),
        suspReplay: document.getElementById('rm-susp-replay'),
        degValue: document.getElementById('rm-deg-value'),
        pitValue: document.getElementById('rm-pit-value')
    };
    return rmState.els;
}

function rmStepM() {
    return (typeof STEP === 'number' && STEP > 0) ? STEP : RM_STEP_FALLBACK_M;
}

/* ================================================================
 *  G-G 描画(Canvas2D。ACCEL(G)チャートと同じ自前描画の流儀)
 * ================================================================ */

/** キャンバスを実ピクセルに合わせ、変換パラメータを返す。 */
function rmSetupCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(100, Math.round(rect.width));
    const h = Math.max(100, Math.round(rect.height));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const cx = w / 2;
    const cy = h / 2;
    const scale = Math.min(w, h) / 2 / RM_GG_RANGE_G;  // px per G
    return { ctx: canvas.getContext('2d'), w: w, h: h, cx: cx, cy: cy, scale: scale };
}

/** 摩擦円ガイド+軸を描く。 */
function rmDrawGGBase(g) {
    const ctx = g.ctx;
    ctx.clearRect(0, 0, g.w, g.h);
    ctx.fillStyle = '#1B1F26';
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.strokeStyle = '#2C313A';
    ctx.lineWidth = 1;
    RM_GG_RINGS_G.forEach(function(r) {
        ctx.beginPath();
        ctx.arc(g.cx, g.cy, r * g.scale, 0, Math.PI * 2);
        ctx.stroke();
    });
    ctx.beginPath();
    ctx.moveTo(g.cx - RM_GG_RANGE_G * g.scale, g.cy);
    ctx.lineTo(g.cx + RM_GG_RANGE_G * g.scale, g.cy);
    ctx.moveTo(g.cx, g.cy - RM_GG_RANGE_G * g.scale);
    ctx.lineTo(g.cx, g.cy + RM_GG_RANGE_G * g.scale);
    ctx.stroke();
    ctx.fillStyle = '#828B99';
    ctx.font = '10px sans-serif';
    ctx.fillText('1.0G', g.cx + 1.0 * g.scale + 2, g.cy - 2);
    ctx.fillText('LAT→', g.w - 34, g.cy - 4);
    ctx.fillText('ACC↑', g.cx + 4, 12);
}

/**
 * サンプル列から (latG, lonG) を取り出す。
 * lat = body_accel_sway[m/s^2]/9.81、lon = accel_g - accel_decel [G](main.py付加)。
 * 必要フィールド欠落(v1等)のサンプルは null。
 */
function rmGGOf(sample) {
    if (!sample || sample.body_accel_sway == null ||
        (sample.accel_g == null && sample.accel_decel == null)) {
        return null;
    }
    return {
        lat: (sample.body_accel_sway || 0) / RM_G,
        lon: (sample.accel_g || 0) - (sample.accel_decel || 0)
    };
}

/** 散布を描く(間引き付き)。 */
function rmDrawGGScatter(g, samples, color) {
    const step = Math.max(1, Math.ceil(samples.length / RM_GG_MAX_POINTS));
    g.ctx.fillStyle = color;
    let drawn = 0;
    for (let i = 0; i < samples.length; i += step) {
        const p = rmGGOf(samples[i]);
        if (!p) continue;
        const x = g.cx + Math.max(-RM_GG_RANGE_G, Math.min(RM_GG_RANGE_G, p.lat)) * g.scale;
        const y = g.cy - Math.max(-RM_GG_RANGE_G, Math.min(RM_GG_RANGE_G, p.lon)) * g.scale;
        g.ctx.fillRect(x - 1, y - 1, 2, 2);
        drawn++;
    }
    return drawn;
}

/* ================================================================
 *  再生側 M-1: rmOnReplayBuffer (replay-mode.js replaySetBuffer 末尾から1行で呼出)
 * ================================================================ */

function rmOnReplayBuffer() {
    const els = rmEnsureEls();
    if (!els.ggReplay || typeof replayState === 'undefined') {
        return;
    }
    const frames = replayState.frames || [];

    // P2 M-3: 再生ラップのサスヒストグラム(単一系列)
    if (els.suspReplay) {
        rmDrawSuspHisto(els.suspReplay, rmSuspSeries(frames), null);
    }

    const g = rmSetupCanvas(els.ggReplay);
    rmDrawGGBase(g);
    const drawn = rmDrawGGScatter(g, frames, 'rgba(61, 155, 255, 0.55)');
    if (!drawn) {
        g.ctx.fillStyle = '#828B99';
        g.ctx.font = '12px sans-serif';
        g.ctx.fillText('N/A: この記録に加速度データがありません', 12, 24);
    }
    // ベースを退避(現在位置ハイライトの重ね描き用)
    const off = document.createElement('canvas');
    off.width = g.w;
    off.height = g.h;
    off.getContext('2d').drawImage(els.ggReplay, 0, 0);
    rmState.replayGGBase = { canvas: off, g: g };

    if (!rmState.replayHlTimer) {
        rmState.replayHlTimer = setInterval(rmReplayHighlightTick, RM_REPLAY_HL_MS);
    }
}

/** 再生中の現在位置を強調表示。replay-mode 終了時は自動でベース消去+タイマ停止。 */
function rmReplayHighlightTick() {
    const els = rmEnsureEls();
    if (!document.body.classList.contains('replay-mode') ||
        typeof replayState === 'undefined' || !rmState.replayGGBase) {
        clearInterval(rmState.replayHlTimer);
        rmState.replayHlTimer = null;
        rmState.replayGGBase = null;
        return;
    }
    const base = rmState.replayGGBase;
    const ctx = els.ggReplay.getContext('2d');
    ctx.drawImage(base.canvas, 0, 0);
    const i = Math.max(0, Math.min(replayState.frames.length - 1, replayState.playIdx - 1));
    const p = rmGGOf(replayState.frames[i]);
    if (p) {
        const g = base.g;
        const x = g.cx + Math.max(-RM_GG_RANGE_G, Math.min(RM_GG_RANGE_G, p.lat)) * g.scale;
        const y = g.cy - Math.max(-RM_GG_RANGE_G, Math.min(RM_GG_RANGE_G, p.lon)) * g.scale;
        ctx.strokeStyle = '#E8A13D';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.stroke();
    }
}

/* ================================================================
 *  REVIEW側 M-1+M-2: rmOnReviewCompare
 *  (review-view.js reviewUpdateComparison の .then() 内・
 *   reviewRenderCharts(a,b) 直後から1行で呼出)
 * ================================================================ */

/** 補助データ(加速度・舵角)の取得。既存APIの射影を利用しキャッシュ。 */
function rmFetchAux(file) {
    if (!file) {
        return Promise.resolve(null);
    }
    if (rmState.auxCache[file]) {
        return Promise.resolve(rmState.auxCache[file]);
    }
    return fetch('/api/laps/' + encodeURIComponent(file) +
                 '?every=' + RM_AUX_EVERY + '&fields=' + RM_AUX_FIELDS)
        .then(function(res) {
            if (!res.ok) {
                throw new Error('HTTP ' + res.status);
            }
            return res.json();
        })
        .then(function(body) {
            const entry = { samples: body.samples || [] };
            rmState.auxCache[file] = entry;
            return entry;
        })
        .catch(function() {
            return null; // 補助データ欠落時は各表示側で「—」縮退
        });
}

/**
 * 補助サンプルを10m距離グリッドへ整列した series を作る。
 * 距離は position 弦長積算(REVIEW と同一規則・120mクランプ)。
 * @returns {{steer:number[], brake:number[]}} 長さ N(不足は null)
 */
function rmAlignAux(samples, N) {
    const step = rmStepM();
    const steer = new Array(N).fill(null);
    const brake = new Array(N).fill(null);
    if (!samples || !samples.length) {
        return { steer: steer, brake: brake };
    }
    let cum = 0;
    let lastX = null;
    let lastZ = null;
    for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        if (s.position_x != null && s.position_z != null) {
            if (lastX !== null) {
                const seg = Math.hypot(s.position_x - lastX, s.position_z - lastZ);
                if (seg <= 120) {
                    cum += seg;
                }
            }
            lastX = s.position_x;
            lastZ = s.position_z;
        }
        const k = Math.floor(cum / step);
        if (k >= 0 && k < N) {
            if (s.wheel_rotation != null) steer[k] = Math.abs(s.wheel_rotation);
            if (s.brake_pct != null) brake[k] = s.brake_pct;
        }
    }
    return { steer: steer, brake: brake };
}

/** 速度系列からコーナー(局所極小)のグリッド index を検出する。 */
function rmFindCorners(speed) {
    const n = speed.length;
    if (n < RM_CORNER_SMOOTH * 2) {
        return [];
    }
    const half = Math.floor(RM_CORNER_SMOOTH / 2);
    const sm = new Array(n);
    for (let i = 0; i < n; i++) {
        let sum = 0;
        let cnt = 0;
        for (let j = i - half; j <= i + half; j++) {
            if (j >= 0 && j < n) {
                sum += speed[j];
                cnt++;
            }
        }
        sm[i] = sum / cnt;
    }
    const corners = [];
    for (let m = 1; m < n - 1; m++) {
        if (sm[m] <= sm[m - 1] && sm[m] < sm[m + 1]) {
            const a = Math.max(0, m - RM_CORNER_WINDOW);
            const b = Math.min(n - 1, m + RM_CORNER_WINDOW);
            let maxSide = sm[m];
            for (let j = a; j <= b; j++) {
                if (sm[j] > maxSide) maxSide = sm[j];
            }
            if (maxSide - sm[m] > RM_CORNER_PROM_KMH) {
                corners.push(m);
            }
        }
    }
    return corners;
}

/**
 * フェーズ別デルタ集計。
 * 各グリッドの区間所要差(dA-dB)を、基準B側のゾーン(classifyZone)へ帰属して合算。
 */
function rmPhaseDelta(a, b, N) {
    const sums = { brake: 0, throttle: 0, coast: 0 };
    if (typeof classifyZone !== 'function') {
        return sums;
    }
    for (let k = 1; k < N; k++) {
        const dA = a.time[k] - a.time[k - 1];
        const dB = b.time[k] - b.time[k - 1];
        const zone = classifyZone(b.throttle[k] || 0, b.brake[k] || 0);
        sums[zone] += (dA - dB);
    }
    return sums;
}

/** コーナー別得失(Δt)とトレイル重なり指標(A/B)を算出。 */
function rmCornerMetrics(a, b, N, auxA, auxB) {
    const corners = rmFindCorners(b.speed.slice(0, N));
    const out = [];
    corners.forEach(function(v) {
        const s = Math.max(0, v - RM_CORNER_WINDOW);
        const e = Math.min(N - 1, v + RM_CORNER_WINDOW);
        const gain = (a.time[e] - a.time[s]) - (b.time[e] - b.time[s]);
        // トレイル重なり: 進入区間[s..v] の (brake/100)×(|steer|正規化) の平均
        const trail = function(aux) {
            if (!aux) return null;
            let sum = 0;
            let cnt = 0;
            for (let k = s; k <= v; k++) {
                if (aux.brake[k] == null || aux.steer[k] == null) continue;
                const st = Math.min(aux.steer[k], RM_TRAIL_STEER_NORM_RAD) /
                           RM_TRAIL_STEER_NORM_RAD;
                sum += (aux.brake[k] / 100) * st;
                cnt++;
            }
            return cnt ? (sum / cnt) : null;
        };
        out.push({
            distM: Math.round(v * rmStepM()),
            deltaS: gain,
            trailA: trail(auxA),
            trailB: trail(auxB)
        });
    });
    out.sort(function(p, q) { return Math.abs(q.deltaS) - Math.abs(p.deltaS); });
    return out.slice(0, RM_TOP_CORNERS);
}

function rmFmtS(v) {
    return (v >= 0 ? '+' : '') + v.toFixed(2) + 's';
}

function rmFmtTrail(v) {
    return (v == null) ? '—' : (v * 100).toFixed(0) + '%';
}

/* ================================================================
 *  P2 M-3: サスペンション変位ヒストグラム(#146)
 * ================================================================ */

/**
 * サンプル列から4輪の susp_height[mm] 値列を取り出す。
 * @returns {Array<number[]>|null} [FL[],FR[],RL[],RR[]]。データ欠落時 null
 */
function rmSuspSeries(samples) {
    const out = [[], [], [], []];
    let found = false;
    (samples || []).forEach(function(s) {
        const sh = s && s.susp_height;
        if (Array.isArray(sh) && sh.length >= 4) {
            found = true;
            for (let w = 0; w < 4; w++) {
                out[w].push((sh[w] || 0) * 1000);   // m → mm
            }
        }
    });
    return found ? out : null;
}

/**
 * 4輪ヒストグラムを1キャンバスに2×2で描く。seriesB があれば半透明重畳(A青/B緑)。
 * ビン範囲は A/B 全データの min/max から共通に決める(重畳の比較性確保)。
 */
function rmDrawSuspHisto(canvas, seriesA, seriesB) {
    const g = rmSetupCanvas(canvas);
    const ctx = g.ctx;
    ctx.clearRect(0, 0, g.w, g.h);
    ctx.fillStyle = '#1B1F26';
    ctx.fillRect(0, 0, g.w, g.h);

    if (!seriesA && !seriesB) {
        ctx.fillStyle = '#828B99';
        ctx.font = '12px sans-serif';
        ctx.fillText('N/A: サスペンションデータなし', 12, 24);
        return null;
    }
    // 共通レンジ
    let lo = Infinity;
    let hi = -Infinity;
    [seriesA, seriesB].forEach(function(sr) {
        if (!sr) return;
        sr.forEach(function(vals) {
            vals.forEach(function(v) {
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            });
        });
    });
    if (!(hi > lo)) {
        hi = lo + 1;
    }
    const binW = (hi - lo) / RM_HISTO_BINS;
    const cellW = g.w / 2;
    const cellH = g.h / 2;

    const histoOf = function(vals) {
        const bins = new Array(RM_HISTO_BINS).fill(0);
        vals.forEach(function(v) {
            let k = Math.floor((v - lo) / binW);
            if (k >= RM_HISTO_BINS) k = RM_HISTO_BINS - 1;
            if (k < 0) k = 0;
            bins[k]++;
        });
        return bins;
    };

    const counts = { a: [], b: [] };  // 独立検算用(度数合計)
    for (let w = 0; w < 4; w++) {
        const ox = (w % 2) * cellW;
        const oy = Math.floor(w / 2) * cellH;
        ctx.strokeStyle = '#2C313A';
        ctx.strokeRect(ox + 2, oy + 2, cellW - 4, cellH - 4);
        ctx.fillStyle = '#828B99';
        ctx.font = '10px sans-serif';
        ctx.fillText(RM_WHEELS[w], ox + 6, oy + 13);

        const drawBins = function(bins, color) {
            const maxC = Math.max.apply(null, bins) || 1;
            const bw = (cellW - 12) / RM_HISTO_BINS;
            ctx.fillStyle = color;
            for (let k = 0; k < RM_HISTO_BINS; k++) {
                const h = (bins[k] / maxC) * (cellH - 24);
                ctx.fillRect(ox + 6 + k * bw, oy + cellH - 6 - h, Math.max(1, bw - 1), h);
            }
        };
        if (seriesB) {
            const binsB = histoOf(seriesB[w]);
            counts.b.push(binsB.reduce(function(x, y) { return x + y; }, 0));
            drawBins(binsB, 'rgba(31, 158, 87, 0.45)');
        }
        if (seriesA) {
            const binsA = histoOf(seriesA[w]);
            counts.a.push(binsA.reduce(function(x, y) { return x + y; }, 0));
            drawBins(binsA, 'rgba(61, 155, 255, 0.55)');
        }
    }
    return counts;   // {a:[4輪の度数合計], b:[...]} — 検証時にサンプル数と照合
}

/* ================================================================
 *  P2 M-4: タイヤデグ率 + ピットウィンドウ(ライブ1Hzポーリング。#146)
 *
 *  実装方式(#143是正版・計承認済み): ライブ経路JSは完全無改変。
 *   - ラップタイム履歴: 永続グローバル lapState.lapTimes を読み取り専用参照
 *   - 燃料系/残周回: 既存カードの DOM 表示値を厳格パース(失敗時は '--' 縮退)
 * ================================================================ */

/** 厳格パース: 期待形式に一致しない場合 null(黙って誤値を使わない)。 */
function rmParseFloatStrict(text) {
    return (typeof text === 'string' && /^\d+(\.\d+)?$/.test(text.trim()))
        ? parseFloat(text) : null;
}

/** "#current-lap" の "3/10" 形式を {cur,total} に。'--'系は null。 */
function rmParseLapText(text) {
    const m = (typeof text === 'string') && text.trim().match(/^(\d+)\/(\d+)$/);
    return m ? { cur: parseInt(m[1], 10), total: parseInt(m[2], 10) } : null;
}

/**
 * デグ率[s/lap]: 直近 RM_DEG_LAPS の確定ラップから、中央値±8%超の外れ値
 * (ピットイン/ミス周)を除外し、線形回帰の勾配を返す。データ不足は null。
 */
function rmDegRate(lapTimes) {
    if (!Array.isArray(lapTimes) || lapTimes.length < 3) {
        return null;
    }
    const recent = lapTimes.slice(-RM_DEG_LAPS);
    const times = recent.map(function(l) { return l.time; });
    const sorted = times.slice().sort(function(a, b) { return a - b; });
    const median = sorted[Math.floor(sorted.length / 2)];
    const pts = [];
    recent.forEach(function(l) {
        if (Math.abs(l.time - median) <= median * RM_DEG_OUTLIER_FRAC) {
            pts.push({ x: l.number, y: l.time / 1000 });
        }
    });
    if (pts.length < 3) {
        return null;
    }
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    pts.forEach(function(p) {
        sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y;
    });
    const n = pts.length;
    const denom = n * sxx - sx * sx;
    if (!denom) {
        return null;
    }
    return (n * sxy - sx * sy) / denom;   // [s/lap]
}

/** M-4 の1Hz更新本体。 */
function rmStrategyTick() {
    const els = rmEnsureEls();
    if (!els.degValue || !els.pitValue) {
        return;
    }
    // デグ率(lapState は読み取り専用参照)
    let degText = '--';
    let deg = null;
    if (typeof lapState !== 'undefined' && Array.isArray(lapState.lapTimes)) {
        deg = rmDegRate(lapState.lapTimes);
        if (deg != null) {
            degText = (deg >= 0 ? '+' : '') + deg.toFixed(2) + ' s/lap';
        }
    }
    els.degValue.textContent = degText;

    // ピットウィンドウ(既存カードDOM表示値の厳格パース)
    let pitText = '--';
    const fuelLapsEl = document.getElementById('fuel-laps-remaining');
    const curLapEl = document.getElementById('current-lap');
    const fuelLaps = fuelLapsEl ? rmParseFloatStrict(fuelLapsEl.textContent) : null;
    const lap = curLapEl ? rmParseLapText(curLapEl.textContent) : null;
    if (fuelLaps != null && lap && lap.total > 0) {
        const lapsLeft = lap.total - lap.cur;
        if (fuelLaps >= lapsLeft) {
            pitText = '燃料十分(残り' + lapsLeft + '周)';
        } else {
            pitText = 'L' + (lap.cur + Math.floor(fuelLaps)) + 'までにピット';
        }
    } else if (fuelLaps != null) {
        pitText = '燃料残 約' + fuelLaps.toFixed(1) + '周';
    }
    els.pitValue.textContent = pitText;

    // 検証用に最終パース値を保持(rm接頭辞の自前状態のみに書込)
    rmState.strategyLast = { deg: deg, fuelLaps: fuelLaps, lap: lap };
}

/** REVIEW比較の確定データからカードを更新する(フック唯一の入口)。 */
function rmOnReviewCompare(a, b) {
    const els = rmEnsureEls();
    if (!els.reviewCard) {
        return;
    }
    const token = ++rmState.reviewToken;

    // G-G(取得後に描画)・M-2 は A/B の揃い方に応じて段階表示
    const fileA = a && a.meta && a.meta.file;
    const fileB = b && b.meta && b.meta.file;

    Promise.all([rmFetchAux(fileA), rmFetchAux(fileB)]).then(function(aux) {
        if (token !== rmState.reviewToken) {
            return; // 選択変更後の古い応答は破棄
        }
        const auxA = aux[0];
        const auxB = aux[1];

        // --- M-1: G-G 重畳(A=青 / B=緑) ---
        if (els.ggReview) {
            const g = rmSetupCanvas(els.ggReview);
            rmDrawGGBase(g);
            let drawn = 0;
            if (auxB) drawn += rmDrawGGScatter(g, auxB.samples, 'rgba(31, 158, 87, 0.5)');
            if (auxA) drawn += rmDrawGGScatter(g, auxA.samples, 'rgba(61, 155, 255, 0.55)');
            if (!drawn) {
                g.ctx.fillStyle = '#828B99';
                g.ctx.font = '12px sans-serif';
                g.ctx.fillText('N/A: 加速度データなし(旧形式等)', 12, 24);
            }
        }

        // --- P2 M-3: サスヒストグラム(A/B半透明重畳) ---
        if (els.suspReview) {
            rmDrawSuspHisto(els.suspReview,
                auxA ? rmSuspSeries(auxA.samples) : null,
                auxB ? rmSuspSeries(auxB.samples) : null);
        }

        // --- M-2: フェーズ別デルタ+コーナー別+トレイル(A/B両方が必要) ---
        if (!(a && a.res && b && b.res)) {
            if (els.phaseTable) {
                els.phaseTable.innerHTML =
                    '<div class="rm-note">フェーズ別デルタ: AとBの2本を選択すると表示されます</div>';
            }
            if (els.cornerList) els.cornerList.innerHTML = '';
            return;
        }
        const N = Math.min(a.res.time.length, b.res.time.length);
        if (N < 3) {
            if (els.phaseTable) {
                els.phaseTable.innerHTML = '<div class="rm-note">重畳区間が短すぎます</div>';
            }
            if (els.cornerList) els.cornerList.innerHTML = '';
            return;
        }
        const gridAuxA = auxA ? rmAlignAux(auxA.samples, N) : null;
        const gridAuxB = auxB ? rmAlignAux(auxB.samples, N) : null;
        const phases = rmPhaseDelta(a.res, b.res, N);
        const corners = rmCornerMetrics(a.res, b.res, N, gridAuxA, gridAuxB);

        if (els.phaseTable) {
            els.phaseTable.innerHTML =
                '<div class="rm-title">フェーズ別 Δt (A−B)</div>' +
                '<table class="rm-table"><tr><th>進入(brake)</th><th>惰行(coast)</th><th>立上り(throttle)</th></tr>' +
                '<tr><td>' + rmFmtS(phases.brake) + '</td><td>' + rmFmtS(phases.coast) +
                '</td><td>' + rmFmtS(phases.throttle) + '</td></tr></table>';
        }
        if (els.cornerList) {
            let html = '<div class="rm-title">コーナー別得失 Top' + corners.length +
                       '(距離 / Δt / トレイル重なり A｜B)</div>';
            corners.forEach(function(c) {
                html += '<div class="rm-corner-row"><span>' + c.distM + 'm</span>' +
                    '<span class="' + (c.deltaS < 0 ? 'rm-gain' : 'rm-loss') + '">' +
                    rmFmtS(c.deltaS) + '</span>' +
                    '<span>' + rmFmtTrail(c.trailA) + '｜' + rmFmtTrail(c.trailB) +
                    '</span></div>';
            });
            if (!corners.length) {
                html += '<div class="rm-note">検出可能なコーナーがありません</div>';
            }
            els.cornerList.innerHTML = html;
        }
    });
}

/* ================================================================
 *  自己初期化(P2 M-4: ライブ1Hzポーリング開始)
 *  フレーム経路には一切フックしない。DOM/永続グローバルの読み取りのみ。
 * ================================================================ */
function initRaceMetrics() {
    const els = rmEnsureEls();
    if (els.degValue && els.pitValue) {
        setInterval(rmStrategyTick, RM_STRATEGY_TICK_MS);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRaceMetrics);
} else {
    initRaceMetrics();
}
