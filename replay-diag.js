/**
 * GT7 Telemetry Dashboard - REVIEW 再生の診断ログ (#558)
 *
 * 「再生が実際より速く見える」のように、操作者のブラウザ環境でしか再現しない問題の原因を
 * 調べるため、再生中の計測値をサーバー(POST /api/diag)へ送り、ホストのログファイル
 * (logs/replay_diag.jsonl)へ追記してもらう。操作者が手作業でコンソールを貼り付けなくて済む。
 *
 * 送る内容(テレメトリの走行データそのものは送らない):
 *  - 環境: ブラウザ名・CPUコア数・画面サイズ・画面の更新レート・ネットワーク種別
 *  - 1秒ごとの計測: 再生位置の進み÷実時間(=実際の再生倍率)、倍速の設定、再生の種類
 *    (60/30/10Hz)、画面の描画レート(fps)、タイマーの遅れ(最大)、長いタスクの回数・最大、
 *    表示中の速度と、データ上のその時刻の速度との差、時計の食い違い(Date と performance)
 *  - 状態の変化: 再生の開始・終了・一時停止・倍速の変更・高レートへの切替・シーク・タブの非表示
 *
 * 動作は再生中だけ(replayActive)。それ以外では何もしない。サーバーへの送信は5秒ごとにまとめ、
 * 失敗しても再生には一切影響しない(3回連続で失敗したら送信を止める)。
 *
 * 契約: IIFE で隔離し、公開するグローバルは replayDiagDump(手動確認用)のみ。
 * プレーン <script>・単一グローバルスコープの制約に従う。
 */
(function() {
    'use strict';

    const CHECK_MS = 250;          // 状態変化の検知周期
    const SAMPLE_EVERY = 4;        // CHECK_MS × 4 = 1秒ごとに計測値を記録
    const FLUSH_MS = 5000;         // サーバーへの送信周期
    const MAX_BUFFER = 120;        // 未送信の最大件数(超えたら古いものから捨てる)
    const MAX_FAILS = 3;           // 連続失敗がこの回数に達したら送信を止める
    const JUMP_S = 1.0;            // 期待値から再生位置がこれ以上ずれたら「ジャンプ」とみなす

    const sid = Math.random().toString(36).slice(2, 8);   // このページの識別子
    const st = {
        buf: [],
        fails: 0,
        stopped: false,
        lastFlushMs: performance.now(),
        tickN: 0,
        prev: null,             // 直前の1秒サンプル時点のスナップショット
        lastState: null,        // 状態変化の検知用
        // 区間内の集計(1秒サンプルごとにリセット)
        lag: { last: performance.now(), max: 0 },
        raf: { n: 0 },
        longTask: { n: 0, max: 0 },
        envSent: false
    };

    function safe(fn, fallback) {
        try {
            return fn();
        } catch (e) {
            return fallback;
        }
    }

    function push(rec) {
        rec.sid = sid;
        rec.at = Date.now();
        st.buf.push(rec);
        if (st.buf.length > MAX_BUFFER) {
            st.buf.shift();
        }
    }

    function isActive() {
        return typeof replayActive !== 'undefined' && replayActive === true &&
            typeof replayState !== 'undefined' && replayState.frames && replayState.frames.length > 0;
    }

    function speedSelect() {
        const el = document.getElementById('replay-speed');
        return el ? el.value : null;
    }

    function env() {
        const nav = navigator;
        const conn = nav.connection || {};
        return {
            ev: 'env',
            ua: nav.userAgent,
            cores: nav.hardwareConcurrency || null,
            mem: nav.deviceMemory || null,
            vw: window.innerWidth,
            vh: window.innerHeight,
            dpr: window.devicePixelRatio,
            net: conn.effectiveType || null,
            rtt: conn.rtt != null ? conn.rtt : null,
            page: location.host
        };
    }

    /** いまの再生状態のスナップショット。 */
    function snapshot() {
        const s = replayState;
        const idx = Math.max(0, Math.min(s.frames.length - 1, s.playIdx - 1));
        const f = s.frames[idx] || {};
        const speedEl = document.getElementById('speed');
        return {
            perf: performance.now(),
            date: Date.now(),
            playhead: s.playhead,
            playing: !!s.playing,
            speed: s.speed,
            sel: speedSelect(),
            tier: s.tier,
            rate: s.rateLabel,
            frames: s.frames.length,
            idx: s.playIdx,
            dur: s.t.length ? s.t[s.t.length - 1] : null,
            file: s.file,
            dataSpeed: f.speed_kmh != null ? Math.round(f.speed_kmh) : null,
            dispSpeed: speedEl ? parseFloat(speedEl.textContent) : null,
            hidden: document.hidden
        };
    }

    /** 状態の変化(開始・終了・一時停止・倍速・再生種類・ファイル・タブの表示)を記録する。 */
    function detectChanges(snap, active) {
        const cur = active
            ? { active: true, playing: snap.playing, speed: snap.speed, sel: snap.sel, rate: snap.rate,
                file: snap.file, hidden: snap.hidden, frames: snap.frames }
            : { active: false };
        const p = st.lastState;
        if (!p || p.active !== cur.active) {
            push({ ev: cur.active ? 'replay_start' : 'replay_end',
                   file: snap.file || (p && p.file) || null, tier: active ? snap.tier : null });
        } else if (cur.active) {
            const diffs = {};
            ['playing', 'speed', 'sel', 'rate', 'file', 'hidden', 'frames'].forEach(function(k) {
                if (p[k] !== cur[k]) {
                    diffs[k] = { from: p[k], to: cur[k] };
                }
            });
            if (Object.keys(diffs).length) {
                push({ ev: 'change', diffs: diffs, playhead: +snap.playhead.toFixed(2) });
            }
        }
        st.lastState = cur;
    }

    /** 1秒ごとの計測値を記録する。 */
    function sample(snap) {
        const p = st.prev;
        st.prev = snap;
        const rec = {
            ev: 'sample',
            play: +snap.playhead.toFixed(2),
            playing: snap.playing,
            speed: snap.speed,
            sel: snap.sel,
            tier: snap.tier,
            rate: snap.rate,
            frames: snap.frames,
            idx: snap.idx,
            hidden: snap.hidden,
            dataSpeed: snap.dataSpeed,
            dispSpeed: snap.dispSpeed
        };
        if (p) {
            const dPerf = (snap.perf - p.perf) / 1000;
            const dDate = (snap.date - p.date) / 1000;
            const dPlay = snap.playhead - p.playhead;
            rec.dWall = +dPerf.toFixed(3);
            rec.dPlay = +dPlay.toFixed(3);
            // 実際の再生倍率(1x の設定なら 1.0 のはず)。一時停止・ジャンプ中は意味を持たない
            if (snap.playing && p.playing && dPerf > 0) {
                rec.ratio = +(dPlay / dPerf).toFixed(3);
                rec.expect = +(dPerf * snap.speed).toFixed(3);
                if (Math.abs(dPlay - dPerf * snap.speed) > JUMP_S) {
                    rec.jump = true;      // シークや長い停止からの追い付き
                }
            }
            rec.clockSkew = +(dDate - dPerf).toFixed(3);   // Date と performance の食い違い[s]
            rec.fps = +(st.raf.n / dPerf).toFixed(1);       // 画面の描画レート
        }
        rec.lagMax = +st.lag.max.toFixed(1);                 // 50ms タイマーの最大の遅れ[ms]
        rec.longTasks = st.longTask.n;
        rec.longTaskMax = +st.longTask.max.toFixed(1);
        st.lag.max = 0;
        st.raf.n = 0;
        st.longTask.n = 0;
        st.longTask.max = 0;
        push(rec);
    }

    function check() {
        const active = safe(isActive, false);
        if (!active) {
            if (st.lastState && st.lastState.active) {
                detectChanges({ file: null }, false);
            }
            st.prev = null;
            flushIfDue();     // 再生の終了・一時停止の記録も、次の再生を待たずに送る
            return;
        }
        if (!st.envSent) {
            push(env());
            st.envSent = true;
        }
        const snap = snapshot();
        detectChanges(snap, true);
        st.tickN++;
        if (st.tickN % SAMPLE_EVERY === 0) {
            sample(snap);
        }
        flushIfDue();
    }

    function payload() {
        const batch = st.buf.splice(0, st.buf.length);
        return JSON.stringify({ v: 1, sid: sid, records: batch });
    }

    function flushIfDue() {
        const now = performance.now();
        if (now - st.lastFlushMs < FLUSH_MS || !st.buf.length || st.stopped) {
            return;
        }
        st.lastFlushMs = now;
        const body = payload();
        fetch('/api/diag', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body,
            keepalive: true
        }).then(function(res) {
            st.fails = res.ok ? 0 : st.fails + 1;
        }).catch(function() {
            st.fails++;
        }).then(function() {
            if (st.fails >= MAX_FAILS) {
                st.stopped = true;      // 診断は補助機能。失敗し続けるなら黙って止める
            }
        });
    }

    /** ページを離れる・隠すときに、残りを sendBeacon で送る。 */
    function flushNow() {
        if (st.stopped || !st.buf.length) {
            return;
        }
        safe(function() {
            const blob = new Blob([payload()], { type: 'application/json' });
            navigator.sendBeacon('/api/diag', blob);
        });
    }

    function init() {
        // 状態変化・1秒サンプルの検知
        setInterval(check, CHECK_MS);
        // タイマーの遅れ(メインスレッドが詰まると 50ms タイマーが遅れる)
        setInterval(function() {
            const now = performance.now();
            const lag = now - st.lag.last - 50;
            st.lag.last = now;
            if (lag > st.lag.max) {
                st.lag.max = lag;
            }
        }, 50);
        // 描画レート
        (function loop() {
            st.raf.n++;
            requestAnimationFrame(loop);
        })();
        // 長いタスク(50ms超)。非対応のブラウザでは何もしない
        safe(function() {
            new PerformanceObserver(function(list) {
                list.getEntries().forEach(function(e) {
                    st.longTask.n++;
                    if (e.duration > st.longTask.max) {
                        st.longTask.max = e.duration;
                    }
                });
            }).observe({ entryTypes: ['longtask'] });
        });
        document.addEventListener('visibilitychange', function() {
            if (document.hidden) {
                flushNow();
            }
        });
        window.addEventListener('pagehide', flushNow);
    }

    /** 手動確認用: まだ送っていない記録を返す。 */
    window.replayDiagDump = function() {
        return st.buf.slice();
    };

    init();
})();
