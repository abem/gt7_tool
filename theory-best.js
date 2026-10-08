/**
 * GT7 Telemetry Dashboard - REVIEW 理論上のベストラップ (#552 T2)
 *
 * AiM RaceStudio3 の「best segment times から best theoretical time を算出」に相当する指標。
 * GT7 は実セクタータイムを送らないため、距離グリッドを N 等分した仮想区間ごとに
 * A/B(と、重ね書きで選んだ周回)の区間タイムの小さい方を採り、その合計を理論ベストとする。
 * 実ベスト(A/B の速い方)との差が「取りこぼし」で、ラップのどこで時間を失っているかを
 * TRACK MAP / TIME DELTA と併せて探る手掛かりになる。
 *
 * 前提と限界(表示にも明記する):
 *  - A/B の 2 ラップ(重ね書きで比較可能な周回を選んでいれば、それらも含む。最大7本)からの合成
 *    (N=20 区間)。ラップ数が増えるほど理論値は速くなる。
 *  - 区間境界は距離の等分で、コースの実コーナーとは無関係。
 *  - 同一コースの場合のみ算出する(コースが異なる場合は算出しない)。
 *  - 走行ラインの違いによる距離差は、短い方の距離範囲で切り揃えて比較する。
 *
 * 契約: review-view.js の reviewNotifyExtras() から tbOnReviewCompare(a, b, extras) が呼ばれる
 * 唯一のフック。IIFE で隔離し、公開するグローバルは tbOnReviewCompare のみ。
 */
(function() {
    'use strict';

    const SEGMENTS = 20;

    /**
     * 各ラップの距離連続タイム列(res.time[])から理論ベストの取りこぼしを求める。
     * @param {Array} laps - 2本以上の {res} (A/B と、比較可能な重ね書きの周回)
     * @returns {Object|null} {gainS, bestS} または算出不能なら null
     */
    function compute(laps) {
        const rs = laps.map(function(l) { return l && l.res; });
        if (rs.length < 2 || rs.some(function(r) { return !r || !r.time; })) {
            return null;
        }
        const n = Math.min.apply(null, rs.map(function(r) { return r.time.length; }));
        if (n < SEGMENTS + 1) {
            return null;
        }
        let theory = 0;
        for (let s = 0; s < SEGMENTS; s++) {
            const i0 = Math.floor((n - 1) * s / SEGMENTS);
            const i1 = Math.floor((n - 1) * (s + 1) / SEGMENTS);
            theory += Math.min.apply(null, rs.map(function(r) { return r.time[i1] - r.time[i0]; }));
        }
        const best = Math.min.apply(null, rs.map(function(r) { return r.time[n - 1] - r.time[0]; }));
        return { gainS: Math.max(0, best - theory), bestS: best };
    }

    /** review-view.js の共通判定(未読込なら、算出しない側に倒す)。 */
    function comparable(a, b) {
        return typeof reviewComparable === 'function'
            ? reviewComparable(a, b)
            : { ok: false, reason: 'no-data', da: 0, db: 0 };
    }

    function setText(text, title) {
        const el = document.getElementById('review-sum-theory');
        if (!el) {
            return;
        }
        el.textContent = text;
        el.title = title || '';
    }

    /**
     * @param {Object|null} a
     * @param {Object|null} b
     * @param {Array} [extras] - 重ね書きで描画している周回の詳細(基準と比較可能と判定済み)。無ければ A/B のみ
     */
    window.tbOnReviewCompare = function(a, b, extras) {
        if (!a || !b) {
            setText('理論ベスト: A/B両方を選択', '');
            return;
        }
        // 同一コース・距離が近い組だけ算出する(判定は review-view.js の共通関数。
        // コース情報が片方でも無い場合は「同一と確認できない」として算出しない)。
        const cmp = comparable(a, b);
        if (!cmp.ok) {
            if (cmp.reason === 'course-diff') {
                setText('理論ベスト: コースが異なるため算出しません', '');
            } else if (cmp.reason === 'course-unknown') {
                setText('理論ベスト: コース情報が無いため算出しません（旧形式・インポート等）',
                    '同一コースと確認できない組は、別コースを誤って合成しないよう算出しません。');
            } else if (cmp.reason === 'dist-diff') {
                // 途中で切れた記録・別ルート等は、距離で対応づける合成が成り立たず、
                // 区間の意味がずれて非現実的な値になるため算出しない。
                setText(
                    '理論ベスト: 走行距離が異なるため算出しません (A ' + Math.round(cmp.da) +
                    ' m / B ' + Math.round(cmp.db) + ' m)',
                    '距離の差が 3% を超える組は、仮想区間が対応しないため合成できません。'
                );
            } else {
                setText('理論ベスト: --', '');
            }
            return;
        }
        // 重ね書きの周回は、A とも比較可能なものだけ加える(A/B と同じ判定)
        const laps = [a, b].concat((extras || []).filter(function(e) {
            return e && e !== a && e !== b && comparable(a, e).ok;
        }));
        const r = compute(laps);
        if (!r) {
            setText('理論ベスト: --', '');
            return;
        }
        const times = laps.map(function(l) { return l.meta && l.meta.laptime_ms_approx; }).filter(Boolean);
        const fastest = times.length ? Math.min.apply(null, times) : 0;
        const gainMs = r.gainS * 1000;
        const abs = fastest ? gtFormatLapMs(fastest - gainMs) + ' ' : '';
        setText(
            '理論ベスト: ' + abs + '(実ベスト比 −' + r.gainS.toFixed(2) + 's' +
            (laps.length > 2 ? '・' + laps.length + '本から合成' : '') + ')',
            SEGMENTS + '等分した仮想区間ごとに' + (laps.length > 2 ? 'A/B と重ね書きの' + laps.length + '本' : ' A/B') +
            'の速い方を合成した近似値です。区間境界は実コーナーとは無関係です。'
        );
    };
})();
