/**
 * GT7 Telemetry Dashboard - 仮想セクタータイム算出 (#436 B4)
 *
 * GT7パケットに実際のセクター情報が含まれない(GT7テレメトリ仕様調査F1で確認済み)ため、
 * #434 P5 Stage3(laptime-predict.js)が確立した「参照ラップの走行距離ベースの進行度」
 * インフラをそのまま流用し、参照ラップの総距離をN等分した「仮想」境界での区間タイムを
 * 算出する。実際のコースセクター境界(GT7公式UI)とは異なる旨をUI表記でも明示する。
 *
 * 設計方針(予備調査完了報告2026-08-02・計承認済み):
 *   - decoder.py/telemetry.py/main.py・websocket.js本体は無変更。
 *   - 本モジュールは既存グローバル(lpState.cumDistance/lpFetchReferenceDistance/
 *     analysisState.lapClockS)を読み取り専用で参照する独自1Hzティッカー
 *     (race-metrics.js M-4・laptime-predict.jsと同じ設計)。
 *   - セッション内のクライアント側状態のみ(バックエンド永続化なし、B1/P5と同方針)。
 *   - セクター境界は参照ラップの走行距離を機械的にN等分した仮想境界であり、GT7の
 *     実コースレイアウトのセクター境界とは無関係(既知の限界、予備調査(b)に明記済み)。
 *
 * @module sector-time
 * @depends laptime-predict.js (lpState.cumDistance, lpFetchReferenceDistance),
 *          telemetry-analysis.js (analysisState.lapClockS),
 *          race-metrics.js (rmParseLapText — #current-lap の厳格パース関数を再利用)。
 *          全てtypeofガードで安全に参照。
 */

const ST_SECTOR_COUNT = 3;    // 仮想セクター分割数(計指示によりN=3で確定)
const ST_TICK_MS = 1000;      // race-metrics.js M-4 / laptime-predict.js と同じ1Hzポーリング

const stState = {
    currentLapNumber: null,
    sectorStartClockS: 0,      // 現在計測中セクターの開始時点のanalysisState.lapClockS
    sectorIdx: 0,              // 現在計測中のセクターindex(0-based)
    curLapSectors: [null, null, null],  // このラップの確定済みセクタータイム[s](未確定はnull)
    bestSectors: {},           // key: `${courseId}__${carId}` -> [s1,s2,s3](セッション内ベスト)
    els: null,
};

function stEnsureEls() {
    if (!stState.els) {
        stState.els = {
            row: document.getElementById('sector-time-row'),
            sectors: [
                document.getElementById('sector-1-value'),
                document.getElementById('sector-2-value'),
                document.getElementById('sector-3-value'),
            ],
        };
    }
    return stState.els;
}

/** 秒(float)をセクタータイム表示用に整形(例: 32.451)。未確定はnull。 */
function stFormatSector(sec) {
    if (sec == null || !(sec > 0)) {
        return '--.---';
    }
    return sec.toFixed(3);
}

/**
 * "M:SS.sss"形式(既存formatLapTimeの出力、#current-lap-time="LAST"表示)を秒(float)へ
 * 逆変換する。ラップ完了時、最終セクターの確定に必要(analysisState.lapClockSは
 * 新ラップ検知時点で既に0へリセット済みのため、完了ラップの総時間はここから読む)。
 */
function stParseLapTimeText(text) {
    const m = /^(\d+):(\d{2})\.(\d{3})$/.exec((text || '').trim());
    if (!m) {
        return null;
    }
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + parseInt(m[3], 10) / 1000;
}

function stResetLap() {
    stState.sectorStartClockS = 0;
    stState.sectorIdx = 0;
    stState.curLapSectors = new Array(ST_SECTOR_COUNT).fill(null);
}

/** セッション内ベストを更新(コース×車種単位、既存参照距離キャッシュと同じキー規約)。 */
function stUpdateBest(courseId, carId, idx, sectorTime) {
    const key = courseId + '__' + carId;
    if (!stState.bestSectors[key]) {
        stState.bestSectors[key] = new Array(ST_SECTOR_COUNT).fill(null);
    }
    const arr = stState.bestSectors[key];
    if (arr[idx] == null || sectorTime < arr[idx]) {
        arr[idx] = sectorTime;
    }
}

function stRender(courseId, carId) {
    const els = stEnsureEls();
    const key = courseId + '__' + carId;
    const best = (courseId && carId && stState.bestSectors[key]) || [];
    els.sectors.forEach(function(el, i) {
        if (!el) {
            return;
        }
        const t = stState.curLapSectors[i];
        el.textContent = stFormatSector(t);
        el.classList.remove('sector-best');
        if (t != null && best[i] != null && t <= best[i]) {
            el.classList.add('sector-best');
        }
    });
}

async function stTick() {
    const els = stEnsureEls();
    if (!els.row) {
        return;
    }
    if (typeof lpState === 'undefined' || typeof lpFetchReferenceDistance !== 'function' ||
        typeof analysisState === 'undefined') {
        return;
    }

    const carIdEl = document.getElementById('car-id');
    const courseNameEl = document.getElementById('course-name');
    const carId = carIdEl ? carIdEl.textContent.trim() : '';
    const courseId = courseNameEl ? courseNameEl.dataset.courseId : '';

    // ラップ切替検出(既存#current-lapの厳格パース、laptime-predict.jsと同型のパターン)
    const curLapEl = document.getElementById('current-lap');
    const lap = curLapEl && typeof rmParseLapText === 'function'
        ? rmParseLapText(curLapEl.textContent) : null;
    if (lap && lap.cur !== stState.currentLapNumber) {
        // 直前ラップの、進行中だった最終セクターを完了タイムから確定させる。
        // (参照距離の誤差でN-1番目までしか境界を跨がずにラップが終わる場合がある。
        //  その場合、途中で跨ぎ損ねたセクターは確定不能のためnullのまま=既知の限界)
        if (stState.currentLapNumber !== null && stState.curLapSectors[stState.sectorIdx] == null) {
            const lastTimeEl = document.getElementById('current-lap-time');
            const lastTimeS = lastTimeEl ? stParseLapTimeText(lastTimeEl.textContent) : null;
            if (lastTimeS != null) {
                const sectorTime = lastTimeS - stState.sectorStartClockS;
                if (sectorTime > 0 && carId && courseId) {
                    stState.curLapSectors[stState.sectorIdx] = sectorTime;
                    stUpdateBest(courseId, carId, stState.sectorIdx, sectorTime);
                }
            }
        }
        stRender(courseId, carId);
        stResetLap();
        stState.currentLapNumber = lap.cur;
        return;
    }

    if (!carId || !courseId || lpState.cumDistance <= 0) {
        stRender(courseId, carId);
        return;
    }

    const refDistance = await lpFetchReferenceDistance(courseId, carId);
    if (!refDistance) {
        stRender(courseId, carId);
        return;
    }

    const progress = Math.min(1, Math.max(0, lpState.cumDistance / refDistance));
    const targetIdx = Math.min(ST_SECTOR_COUNT - 1, Math.floor(progress * ST_SECTOR_COUNT));

    if (targetIdx > stState.sectorIdx) {
        for (let i = stState.sectorIdx; i < targetIdx; i++) {
            const sectorTime = analysisState.lapClockS - stState.sectorStartClockS;
            if (sectorTime > 0) {
                stState.curLapSectors[i] = sectorTime;
                stUpdateBest(courseId, carId, i, sectorTime);
            }
            stState.sectorStartClockS = analysisState.lapClockS;
        }
        stState.sectorIdx = targetIdx;
    }

    stRender(courseId, carId);
}

setInterval(stTick, ST_TICK_MS);
