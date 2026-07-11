/**
 * GT7 Telemetry Dashboard - DRIVE view
 *
 * 実車テレメトリの「ドライバー表示/エンジニア解析の分離」ドクトリンに基づく
 * 走行用最小ビュー。F1 ステアリングディスプレイの情報優先度に倣い、
 * Tier-1(ギア/シフトライト/デルタ)を最大化し、Tier-2(ラップ/燃料/タイヤ状態)を
 * 定位置の小フィールドに限定する。Tier-3(チャート/解析)は ANALYSIS ビューへ。
 *
 * 依存: ui_components.js (formatLapTime), telemetry-analysis.js (analysisState),
 *       websocket.js (getTyreTempClass)。全て typeof ガードで安全に参照。
 */

const driveViewState = {
    active: false,
    els: null
};

const DRIVE_VIEW_STORAGE_KEY = 'gt7_view_mode';

/**
 * DOM 要素をキャッシュ(初回のみ)
 */
function ensureDriveViewEls() {
    if (driveViewState.els) {
        return driveViewState.els;
    }
    driveViewState.els = {
        btn: document.getElementById('view-mode-btn'),
        delta: document.getElementById('drive-delta'),
        lap: document.getElementById('drive-lap'),
        last: document.getElementById('drive-last'),
        best: document.getElementById('drive-best'),
        est: document.getElementById('drive-est'),
        fuel: document.getElementById('drive-fuel'),
        tyres: [
            document.getElementById('drive-tyre-fl'),
            document.getElementById('drive-tyre-fr'),
            document.getElementById('drive-tyre-rl'),
            document.getElementById('drive-tyre-rr')
        ]
    };
    return driveViewState.els;
}

/**
 * ビューを適用し、チャートのリサイズを促す
 * @param {boolean} driveMode - true=DRIVE / false=ANALYSIS
 */
function applyViewMode(driveMode) {
    driveViewState.active = driveMode;
    document.body.classList.toggle('drive-mode', driveMode);

    const els = ensureDriveViewEls();
    if (els.btn) {
        els.btn.textContent = driveMode ? 'DRIVE' : 'ANALYSIS';
        els.btn.classList.toggle('active', driveMode);
        els.btn.setAttribute('aria-pressed', String(driveMode));
    }

    try {
        localStorage.setItem(DRIVE_VIEW_STORAGE_KEY, driveMode ? 'drive' : 'analysis');
    } catch (e) {
        /* プライベートブラウジング等では永続化しない */
    }

    // 表示に戻ったチャートは幅0で setSize されている可能性があるため再リサイズ
    // (charts.js の ResizeObserver も発火するが、レイアウト確定後に明示的に押す)
    setTimeout(function() {
        window.dispatchEvent(new Event('resize'));
    }, 250);
}

/**
 * ヘッダーのトグルボタンを配線し、保存されたビューを復元する。
 * app.js から起動時に1回呼ばれる。
 */
function initDriveView() {
    const els = ensureDriveViewEls();
    if (!els.btn) {
        return;
    }

    els.btn.addEventListener('click', function() {
        applyViewMode(!driveViewState.active);
    });

    let saved = null;
    try {
        saved = localStorage.getItem(DRIVE_VIEW_STORAGE_KEY);
    } catch (e) {
        saved = null;
    }
    if (saved === 'drive') {
        applyViewMode(true);
    }
}

/**
 * DRIVE ビューの表示を毎フレーム更新する。
 * websocket.js / test-mode.js の更新経路から typeof ガード付きで呼ばれる。
 * DRIVE 非表示中は何もしない(コスト0)。
 * @param {Object} data - テレメトリデータ(ライブ or 合成)
 */
function driveViewOnFrame(data) {
    if (!driveViewState.active || !data) {
        return;
    }
    const els = ensureDriveViewEls();

    const FUEL_CRIT_LAPS = 3;
    const FUEL_WARN_LAPS = 5;

    // Tier-1: ライブデルタ(ギア隣接・大型)。telemetry-analysis.js の距離基準値を再利用。
    // 3状態デルタ契約(#lap-delta と同一規則): 基準ラップ未成立 または |Δ|<0.05s =
    // クラス無し(中立) / 速い(Δ<=-0.05s)=.faster / 遅い(Δ>=+0.05s)=.slower。表示は '±X.XXs'。
    if (els.delta) {
        const DELTA_NEUTRAL = 0.05;
        let deltaText = '--';
        let deltaCls = '';
        if (typeof analysisState !== 'undefined' && analysisState.refLap) {
            const d = analysisState._liveDelta || 0;
            deltaText = (d >= 0 ? '+' : '') + d.toFixed(2) + 's';
            if (d <= -DELTA_NEUTRAL) {
                deltaCls = 'faster';
            } else if (d >= DELTA_NEUTRAL) {
                deltaCls = 'slower';
            }
        }
        els.delta.textContent = deltaText;
        els.delta.classList.remove('faster', 'slower', 'negative');
        if (deltaCls) {
            els.delta.classList.add(deltaCls);
        }
    }

    // Tier-2: ラップ番号 / LAST / BEST
    if (els.lap) {
        els.lap.textContent = (data.lap_count || '-') + '/' + (data.total_laps || '-');
    }
    if (els.last && typeof formatLapTime === 'function') {
        els.last.textContent = data.last_laptime > 0 ? formatLapTime(data.last_laptime) : '--:--.---';
    }
    if (els.best && typeof formatLapTime === 'function') {
        els.best.textContent = data.best_laptime > 0 ? formatLapTime(data.best_laptime) : '--:--.---';
    }

    // Tier-2: 推定ラップ(#est-lap-time と同じ計算結果をミラー)
    if (els.est) {
        const src = document.getElementById('est-lap-time');
        if (src) {
            els.est.textContent = src.textContent;
            els.est.classList.toggle('pb', src.classList.contains('pb'));
        }
    }

    // Tier-2: 燃料残周回(色=状態: 3周未満=crit / 5周未満=warn)
    if (els.fuel && data.fuel_laps_remaining !== undefined) {
        const laps = data.fuel_laps_remaining;
        // main.py は推定未確定(初回ラップ完了前/給油直後)を fuel_laps_remaining=0 の
        // センチネルで送る。fuel_per_lap>0 が立つまでは中立 '--'、確定後は 0.0 も数値表示。
        const fuelKnown = (data.fuel_per_lap || 0) > 0;
        els.fuel.textContent = fuelKnown ? laps.toFixed(1) : '--';
        els.fuel.classList.toggle('crit', laps > 0 && laps < FUEL_CRIT_LAPS);
        els.fuel.classList.toggle('warn', laps >= FUEL_CRIT_LAPS && laps < FUEL_WARN_LAPS);
    }

    // Tier-2: タイヤ状態ブロック(数値でなく色で読む: MoTeC ゲージ規約)
    if (data.tyre_temp && typeof getTyreTempClass === 'function') {
        for (let i = 0; i < els.tyres.length; i++) {
            const el = els.tyres[i];
            if (el) {
                el.className = 'drive-tyre ' + getTyreTempClass(data.tyre_temp[i]);
            }
        }
    }
}
