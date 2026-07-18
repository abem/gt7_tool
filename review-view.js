/**
 * GT7 Telemetry Dashboard - REVIEW ビュー (P1-3 A案)
 *
 * gt7data/ の過去ラップを一覧・選択し、距離基準チャートで重畳比較する
 * 走行後レビュー用ビュー。設計: docs/P1詳細計画書_セッションレビューと
 * 保存ポリシー_20260716.md §2.2（時間軸は 2026-07-16 訂正注記どおり
 * timestamp のクランプ付き累積経過秒で v1/v2 統一）。
 *
 * 設計原則:
 *  - ライブ経路に不フック: websocket.js のメッセージ処理・update* 関数を
 *    一切呼ばず、フックもしない。データ取得は /api/laps の fetch のみ。
 *  - 既存シンボル無改変: 本ファイルの全トップレベル名は review 接頭辞
 *    (衝突ゼロを全ファイル grep で確認)。既存関数は読み取り参照のみ
 *    (resampleByDist / STEP / formatLapTime、全て typeof ガード付き)。
 *  - ビュー切替は既存機構踏襲: 隠しプロキシ #review-mode-btn を本ファイルが
 *    配線し、menu.js のツールバーが .click() プロキシ + MutationObserver で
 *    状態同期する(drive-view.js と同型)。
 *
 * @module review-view
 * @depends telemetry-analysis.js (resampleByDist — 純関数を読み取り利用)
 * @depends ui_components.js (formatLapTime)
 */

/* ================================================================
 *  定数
 * ================================================================ */
// 距離グリッド[m]。telemetry-analysis.js の STEP と同値を既定とし、
// 参照可能ならそちらを使う(再宣言はしない)
const REVIEW_STEP_FALLBACK_M = 10;
// 1フレーム弦長がこれ超は瞬間移動(pit/respawn)として距離加算スキップ
// (telemetry-analysis.js DISCONTINUITY_M と同じ値・同じ意味)
const REVIEW_DISCONTINUITY_M = 120;
// サンプル間の受信時刻差がこれ以上は記録中断(メニュー等)として時間加算スキップ
// (main.py LAP_DURATION_GAP_S と同じ値・同じ意味)
const REVIEW_TIME_GAP_S = 2.0;
// 一覧取得の1ページ件数(APIの limit 上限)。全件をページングで逐次取得する。
// 旧実装の固定上限500件は、本番1,085件で最古期(v1世代)が一覧・日付フィルタ・
// BEST基準のいずれからも到達不能になる不具合だった(査の実機検証 #125 で検出)。
// 現本番全件で約163KB、B案ローテーション上限(20GB≒約3,100件)でも軽量。
const REVIEW_LIST_PAGE = 1000;
// 詳細取得の間引き(60Hz→約10Hz)
const REVIEW_FETCH_EVERY = 6;

const REVIEW_VIEW_STORAGE_VALUE = 'review';

/* ================================================================
 *  状態(単一オブジェクト)
 * ================================================================ */
const reviewState = {
    active: false,
    initialized: false,     // 初回表示時の lazy-init 済みフラグ
    els: null,
    laps: [],               // /api/laps の一覧(メタ)
    lapsByFile: {},         // file -> 一覧メタ
    detailCache: {},        // file -> {meta, resampled} (取得済み詳細)
    selA: null,             // 比較対象ファイル名
    selB: null,             // 基準ファイル名
    charts: null            // {speed, delta, inputs} uPlot インスタンス(A-5)
};

/* ================================================================
 *  DOM キャッシュ・ビュー切替 (A-3)
 * ================================================================ */

/**
 * DOM 要素をキャッシュ(初回のみ)
 */
function ensureReviewEls() {
    if (reviewState.els) {
        return reviewState.els;
    }
    reviewState.els = {
        btn: document.getElementById('review-mode-btn'),
        root: document.getElementById('review-root'),
        sidebarHead: document.getElementById('review-sidebar-head'),
        filterDate: document.getElementById('review-filter-date'),
        btnBest: document.getElementById('review-btn-best'),
        listStatus: document.getElementById('review-list-status'),
        lapList: document.getElementById('review-lap-list'),
        sumA: document.getElementById('review-sum-a'),
        sumB: document.getElementById('review-sum-b'),
        sumDelta: document.getElementById('review-sum-delta'),
        sumCourse: document.getElementById('review-sum-course')
    };
    return reviewState.els;
}

/**
 * REVIEW ビューを適用する。
 * ON: body.review-mode 付与(review.css がライブ表示を隠す)。DRIVE 中なら
 *     プロキシ経由で ANALYSIS に戻してから重ねる(排他)。初回は一覧を読み込む。
 * OFF: 解除して localStorage は 'analysis' に戻す。
 * @param {boolean} on
 */
function applyReviewMode(on) {
    reviewState.active = on;
    document.body.classList.toggle('review-mode', on);

    const els = ensureReviewEls();
    if (els.btn) {
        els.btn.textContent = 'REVIEW';
        els.btn.classList.toggle('active', on);
        els.btn.setAttribute('aria-pressed', String(on));
    }

    if (on) {
        // 排他: DRIVE が下敷きだと復帰時の見た目が不定になるため ANALYSIS へ戻す
        const viewBtn = document.getElementById('view-mode-btn');
        if (viewBtn && viewBtn.classList.contains('active')) {
            viewBtn.click();
        }
    }

    try {
        localStorage.setItem('gt7_view_mode', on ? REVIEW_VIEW_STORAGE_VALUE : 'analysis');
    } catch (e) {
        /* プライベートブラウジング等では永続化しない */
    }

    if (on && !reviewState.initialized) {
        reviewState.initialized = true;
        reviewLoadList();
    }

    // 表示に戻ったチャートの再リサイズを促す(drive-view.js と同じ作法)
    setTimeout(function() {
        window.dispatchEvent(new Event('resize'));
    }, 250);
}

/**
 * 起動時初期化: プロキシ配線・保存ビューの復元・DRIVE切替の監視。
 * 本ファイル末尾から一度だけ呼ばれる(自己初期化。app.js は無改変)。
 */
function initReviewView() {
    const els = ensureReviewEls();
    if (!els.btn || !els.root) {
        return; // 要素が無い環境では何もしない(既存作法)
    }

    els.btn.addEventListener('click', function() {
        applyReviewMode(!reviewState.active);
    });

    // DRIVE/ANALYSIS 側が切り替えられたら REVIEW を降ろす(排他の逆方向)
    const viewBtn = document.getElementById('view-mode-btn');
    if (viewBtn && typeof MutationObserver === 'function') {
        const mo = new MutationObserver(function() {
            if (reviewState.active && viewBtn.classList.contains('active')) {
                applyReviewMode(false);
            }
        });
        mo.observe(viewBtn, { attributes: true, attributeFilter: ['class'] });
    }

    // 一覧ペインの配線(A-4)
    if (els.filterDate) {
        els.filterDate.addEventListener('change', function() {
            reviewRenderList();
        });
    }
    if (els.btnBest) {
        els.btnBest.addEventListener('click', function() {
            reviewSelectBest();
        });
    }
    reviewInjectImportControls(els);

    // 保存ビューの復元。drive-view.js は 'review' を知らないため ANALYSIS で
    // 初期化しており、ここで REVIEW を上書き復元する(読込順で本処理が後)
    let saved = null;
    try {
        saved = localStorage.getItem('gt7_view_mode');
    } catch (e) {
        saved = null;
    }
    if (saved === REVIEW_VIEW_STORAGE_VALUE) {
        applyReviewMode(true);
    }
}

/* ================================================================
 *  インポート (#177/#178)
 * ================================================================ */

/**
 * インポートUI(「インポート済みを表示」チェックボックス+アップロードボタン+
 * 隠しファイル入力)を review-sidebar-head へ動的注入する。index.html は
 * 無改変のまま、既存のカードグループ注入・CSVボタン注入(#175)と同じ
 * 「機能はJSが自己配線する」作法を踏襲する。initReviewView から一度だけ呼ぶ。
 * @param {object} els ensureReviewEls() のキャッシュ
 */
function reviewInjectImportControls(els) {
    if (!els.sidebarHead || document.getElementById('review-include-imported')) {
        return; // 対象コンテナが無い、または注入済み(多重初期化ガード)
    }

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'review-import-toggle';
    toggleLabel.title = 'gt7data_imported/ のインポート済みラップを一覧に混在表示する(既定は非表示)';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'review-include-imported';
    checkbox.addEventListener('change', function() {
        reviewLoadList();
    });

    toggleLabel.appendChild(checkbox);
    toggleLabel.appendChild(document.createTextNode('インポート済みを表示'));

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'review-import-file';
    fileInput.accept = '.csv';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', function() {
        if (fileInput.files && fileInput.files[0]) {
            reviewUploadImportFile(fileInput.files[0]);
        }
        fileInput.value = ''; // 同一ファイルの連続選択でも change を発火させる
    });

    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.id = 'review-import-btn';
    importBtn.textContent = 'CSVインポート';
    importBtn.title = '本ツールが出力したCSV(#174/#175形式)を取り込む(gt7data_imported/へ分離保存)';
    importBtn.addEventListener('click', function() {
        fileInput.click();
    });

    els.sidebarHead.appendChild(toggleLabel);
    els.sidebarHead.appendChild(importBtn);
    els.sidebarHead.appendChild(fileInput);

    els.includeImported = checkbox;
    els.importBtn = importBtn;
    els.importFile = fileInput;
}

/**
 * 選択されたCSVファイルを /api/laps/import へアップロードする。
 * 成功時は「インポート済みを表示」を自動でONにし一覧を再読込する(直後に
 * 結果が見えないと分かりにくいため)。失敗時はサーバのエラーメッセージを
 * ステータス欄にそのまま表示する(main.py側の検証メッセージが最終文言)。
 * @param {File} file
 */
function reviewUploadImportFile(file) {
    const els = ensureReviewEls();
    if (els.listStatus) {
        els.listStatus.textContent = 'インポート中… (' + file.name + ')';
    }
    if (els.importBtn) {
        els.importBtn.disabled = true;
    }

    const formData = new FormData();
    formData.append('file', file);

    fetch('/api/laps/import', { method: 'POST', body: formData })
        .then(function(res) {
            return res.json().then(function(body) {
                if (!res.ok) {
                    throw new Error(body.error || ('HTTP ' + res.status));
                }
                return body;
            });
        })
        .then(function(body) {
            if (els.listStatus) {
                els.listStatus.textContent =
                    'インポート完了: ' + body.file + ' (' + body.samples + '件)';
            }
            if (els.includeImported) {
                els.includeImported.checked = true;
            }
            // reviewLoadList() は直後に listStatus を「読込中…」で上書きするため、
            // 完了メッセージが視認できるよう一呼吸置いてから一覧を再読込する。
            setTimeout(reviewLoadList, 1200);
        })
        .catch(function(err) {
            if (els.listStatus) {
                els.listStatus.textContent = 'インポート失敗: ' + err.message;
            }
        })
        .then(function() {
            if (els.importBtn) {
                els.importBtn.disabled = false;
            }
        });
}

/* ================================================================
 *  ラップ一覧 (A-4)
 * ================================================================ */

/**
 * /api/laps から全件を offset ページングで逐次取得して描画する。
 * 取得中もページごとに進捗をステータス表示する。ページ間で新規記録により
 * 重複が生じ得るため file 名でデデュープする。
 * include_imported(#177/#178): 「インポート済みを表示」チェック時のみ
 * 全ページ共通で付与する(既定は付与せず、サーバ既定動作=gt7data/のみと一致)。
 */
function reviewLoadList() {
    const els = ensureReviewEls();
    if (els.listStatus) {
        els.listStatus.textContent = '一覧を読込中…';
    }

    const collected = [];
    const seen = {};
    const includeImported = !!(els.includeImported && els.includeImported.checked);
    const importedQuery = includeImported ? '&include_imported=true' : '';

    const fetchPage = function(offset) {
        return fetch('/api/laps?limit=' + REVIEW_LIST_PAGE + '&offset=' + offset + importedQuery)
            .then(function(res) {
                if (!res.ok) {
                    throw new Error('HTTP ' + res.status);
                }
                return res.json();
            })
            .then(function(body) {
                const page = body.laps || [];
                page.forEach(function(lap) {
                    if (!seen[lap.file]) {
                        seen[lap.file] = true;
                        collected.push(lap);
                    }
                });
                if (els.listStatus) {
                    els.listStatus.textContent =
                        '一覧を読込中… ' + collected.length + '/' + body.total;
                }
                // 全件到達(または空ページ=これ以上ない)まで次ページへ
                if (collected.length < body.total && page.length > 0) {
                    return fetchPage(offset + page.length);
                }
                return body.total;
            });
    };

    fetchPage(0)
        .then(function(total) {
            // recorded_at 降順を全件で保証(ページ間の追記ずれ対策)
            collected.sort(function(a, b) {
                return a.recorded_at < b.recorded_at ? 1 : -1;
            });
            reviewState.laps = collected;
            reviewState.lapsByFile = {};
            reviewState.laps.forEach(function(lap) {
                reviewState.lapsByFile[lap.file] = lap;
            });
            reviewPopulateDateFilter();
            reviewRenderList();
            if (els.listStatus) {
                els.listStatus.textContent =
                    '全' + reviewState.laps.length + '件を表示' +
                    (reviewState.laps.length !== total
                        ? '(取得時点の総数: ' + total + ')' : '');
            }
        })
        .catch(function(err) {
            // 静的配信(バックエンド無し)や API 障害時はエラー表示のみ。
            // ライブ表示側には一切影響しない。
            if (els.listStatus) {
                els.listStatus.textContent = '一覧を取得できません (' + err.message + ')';
            }
        });
}

/**
 * 一覧の記録日から日付フィルタの選択肢を生成する。
 */
function reviewPopulateDateFilter() {
    const els = ensureReviewEls();
    if (!els.filterDate) {
        return;
    }
    const days = [];
    reviewState.laps.forEach(function(lap) {
        const day = lap.recorded_at.slice(0, 10);
        if (days.indexOf(day) === -1) {
            days.push(day);
        }
    });
    // 既存選択を保ちながら再構築
    const current = els.filterDate.value;
    els.filterDate.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = '';
    optAll.textContent = '全日付';
    els.filterDate.appendChild(optAll);
    days.forEach(function(day) {
        const opt = document.createElement('option');
        opt.value = day;
        opt.textContent = day;
        els.filterDate.appendChild(opt);
    });
    if (current && days.indexOf(current) !== -1) {
        els.filterDate.value = current;
    }
}

/**
 * 現在のフィルタで一覧を描画する(日付グループ見出し付き)。
 */
function reviewRenderList() {
    const els = ensureReviewEls();
    if (!els.lapList) {
        return;
    }
    const filter = els.filterDate ? els.filterDate.value : '';
    els.lapList.innerHTML = '';

    let currentDay = null;
    reviewState.laps.forEach(function(lap) {
        const day = lap.recorded_at.slice(0, 10);
        if (filter && day !== filter) {
            return;
        }
        if (day !== currentDay) {
            currentDay = day;
            const head = document.createElement('div');
            head.className = 'review-day-head';
            head.textContent = day;
            els.lapList.appendChild(head);
        }
        els.lapList.appendChild(reviewBuildLapItem(lap));
    });

    if (!els.lapList.children.length) {
        const empty = document.createElement('div');
        empty.className = 'review-day-head';
        empty.textContent = '該当ラップなし';
        els.lapList.appendChild(empty);
    }
}

/**
 * 一覧の1行を生成する。
 * @param {Object} lap - /api/laps のメタ1件
 * @returns {Element}
 */
function reviewBuildLapItem(lap) {
    const item = document.createElement('div');
    item.className = 'review-lap-item';
    item.setAttribute('role', 'option');
    item.dataset.file = lap.file;
    if (lap.file === reviewState.selA) {
        item.classList.add('sel-a');
    } else if (lap.file === reviewState.selB) {
        item.classList.add('sel-b');
    }

    const badge = document.createElement('span');
    badge.className = 'review-lap-badge';
    badge.textContent = lap.file === reviewState.selA ? 'A'
        : (lap.file === reviewState.selB ? 'B' : '');

    item.appendChild(badge);

    // インポート済みラップの視覚区別(#177/#178調査報告§2-2)。既定は
    // include_imported 未指定のため通常は出現しない(サーバ側opt-in)。
    if (lap.source === 'imported') {
        const importedBadge = document.createElement('span');
        importedBadge.className = 'review-lap-badge-imported';
        importedBadge.textContent = 'IMPORTED';
        importedBadge.title = 'gt7data_imported/ から取り込まれたラップ(実記録データとは分離管理)';
        item.appendChild(importedBadge);
    }

    const time = document.createElement('span');
    time.className = 'review-lap-time';
    time.textContent = lap.recorded_at.slice(11, 19);

    const label = document.createElement('span');
    const detail = reviewState.detailCache[lap.file];
    const laptime = detail && detail.meta.laptime_ms_approx;
    label.textContent = 'Lap' + lap.lap_number +
        (laptime && typeof formatLapTime === 'function'
            ? ' ' + formatLapTime(laptime) : '');

    const meta = document.createElement('span');
    meta.className = 'review-lap-meta';
    meta.textContent = 'CAR ' + lap.car_id + ' / ' +
        (lap.size_bytes / 1e6).toFixed(1) + 'MB';

    item.appendChild(time);
    item.appendChild(label);
    item.appendChild(meta);

    // 全カード再生の入口(#133/#134 采決裁#2)。行クリック(A/B選択)とは分離。
    // replay-mode.js 不在環境ではボタンを出さない(既存の縮退作法)
    if (typeof replayStart === 'function') {
        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'review-lap-play';
        play.textContent = '▶';
        play.title = 'このラップを全カードで再生';
        play.addEventListener('click', function(e) {
            e.stopPropagation();
            replayStart(lap.file);
        });
        item.appendChild(play);
    }

    // CSVダウンロード(#174/#175)。自前形式の単純出力(他ソフト形式との互換性は未検証)。
    // 行クリック(A/B選択)とは分離。ブラウザネイティブのdownload属性でトリガー(#174仕様書§4)。
    const csvLink = document.createElement('a');
    csvLink.className = 'review-lap-csv';
    csvLink.href = '/api/laps/' + encodeURIComponent(lap.file) + '?format=csv';
    csvLink.download = lap.file.replace(/\.json$/, '.csv');
    csvLink.textContent = '⬇ CSV';
    csvLink.title = 'このラップをCSVでダウンロード（自前形式。他ソフトとの互換性は未検証）';
    csvLink.addEventListener('click', function(e) {
        e.stopPropagation();
    });
    item.appendChild(csvLink);

    item.addEventListener('click', function() {
        reviewToggleSelect(lap.file);
    });
    return item;
}

/**
 * 行クリックによる A/B 選択のトグル。
 * 未選択→A、A選択済み→B、選択中の行を再クリック→解除。
 * @param {string} file
 */
function reviewToggleSelect(file) {
    if (reviewState.selA === file) {
        reviewState.selA = null;
    } else if (reviewState.selB === file) {
        reviewState.selB = null;
    } else if (!reviewState.selA) {
        reviewState.selA = file;
    } else if (!reviewState.selB) {
        reviewState.selB = file;
    } else {
        // 両方埋まっている場合は A を置き換える(直近の関心が比較対象)
        reviewState.selA = file;
    }
    reviewRenderList();
    reviewUpdateComparison();
}

/**
 * 「BEST基準」: 表示中一覧のうち laptime_ms_approx 最小のラップを B に設定。
 * 詳細未取得のラップはタイム不明のため対象外(取得済みから選ぶ)。
 * 対象が無い場合はステータスに案内を出す。
 */
function reviewSelectBest() {
    const els = ensureReviewEls();
    const filter = els.filterDate ? els.filterDate.value : '';
    let best = null;
    let bestMs = Infinity;
    Object.keys(reviewState.detailCache).forEach(function(file) {
        const meta = reviewState.detailCache[file].meta;
        const listMeta = reviewState.lapsByFile[file];
        if (!listMeta) {
            return;
        }
        if (filter && listMeta.recorded_at.slice(0, 10) !== filter) {
            return;
        }
        const ms = meta.laptime_ms_approx;
        if (ms > 0 && ms < bestMs) {
            bestMs = ms;
            best = file;
        }
    });
    if (!best) {
        if (els.listStatus) {
            els.listStatus.textContent =
                'BEST基準: タイム既知のラップがありません(先にラップを開いてください)';
        }
        return;
    }
    reviewState.selB = best;
    if (reviewState.selA === best) {
        reviewState.selA = null;
    }
    reviewRenderList();
    reviewUpdateComparison();
}

/* ================================================================
 *  比較・チャート (A-5)
 * ================================================================ */

// 系列色: A=比較対象(azure)/B=基準(green)。styles.css のトークンと同系の実値
// (uPlot は CSS 変数を解決しないため実値で持つ)
const REVIEW_SERIES_COLORS = {
    a: '#3D9BFF',
    aFill: 'rgba(61, 155, 255, 0.10)',
    b: '#1F9E57',
    delta: '#E8A13D',
    brakeA: '#E05252',
    brakeB: '#B36B3E'
};

/**
 * 距離グリッド[m]。telemetry-analysis.js の STEP が参照できればそれを使う
 * (同一グローバルスコープ・読み取りのみ。再宣言はしない)。
 * @returns {number}
 */
function reviewStepM() {
    return (typeof STEP === 'number' && STEP > 0) ? STEP : REVIEW_STEP_FALLBACK_M;
}

/**
 * APIサンプル列から距離・時間系列を構築する。
 * 距離: position x/z の弦長積算(REVIEW_DISCONTINUITY_M 超はテレポートとしてスキップ。
 *       telemetry-analysis.js updateDistanceIndex と同一規則)。
 * 時間: timestamp のクランプ付き累積経過秒(dt < REVIEW_TIME_GAP_S のみ加算。
 *       2026-07-16 設計訂正: current_laptime はゲーム内時刻進行のため使わない。
 *       v1/v2 共通で機能する)。
 * @param {Array} samples - /api/laps/{file} の samples
 * @returns {Object} {samples: resampleByDist互換の配列, cumDist}
 */
function reviewBuildSeries(samples) {
    const out = [];
    let cum = 0;
    let t = 0;
    let lastX = null;
    let lastZ = null;
    let prevTs = null;

    (samples || []).forEach(function(s) {
        // 時間軸
        if (s.timestamp) {
            const ts = Date.parse(s.timestamp);
            if (!isNaN(ts)) {
                if (prevTs !== null) {
                    const dt = (ts - prevTs) / 1000;
                    if (dt > 0 && dt < REVIEW_TIME_GAP_S) {
                        t += dt;
                    }
                }
                prevTs = ts;
            }
        }
        // 距離索引
        if (s.position_x != null && s.position_z != null) {
            if (lastX !== null) {
                const seg = Math.hypot(s.position_x - lastX, s.position_z - lastZ);
                if (seg <= REVIEW_DISCONTINUITY_M) {
                    cum += seg;
                }
            }
            lastX = s.position_x;
            lastZ = s.position_z;
        }
        out.push({
            dist: cum,
            t: t,
            speed: s.speed_kmh || 0,
            throttle: s.throttle_pct || 0,
            brake: s.brake_pct || 0,
            x: s.position_x || 0,
            z: s.position_z || 0
        });
    });
    return { samples: out, cumDist: cum };
}

/**
 * 単一ラップの詳細を取得し、距離グリッドへリサンプルして返す(キャッシュ付き)。
 * @param {string} file
 * @returns {Promise<Object>} {meta, res} res=resampleByDistの戻り値+totalDist
 */
function reviewFetchDetail(file) {
    if (reviewState.detailCache[file]) {
        return Promise.resolve(reviewState.detailCache[file]);
    }
    const els = ensureReviewEls();
    if (els.listStatus) {
        els.listStatus.textContent = file + ' を読込中…';
    }
    return fetch('/api/laps/' + encodeURIComponent(file) + '?every=' + REVIEW_FETCH_EVERY)
        .then(function(res) {
            if (!res.ok) {
                throw new Error('HTTP ' + res.status);
            }
            return res.json();
        })
        .then(function(body) {
            const series = reviewBuildSeries(body.samples);
            let resampled = null;
            if (typeof resampleByDist === 'function') {
                resampled = resampleByDist(series.samples, reviewStepM());
                resampled.totalDist = series.cumDist;
            }
            const entry = { meta: body.meta, res: resampled };
            reviewState.detailCache[file] = entry;
            if (els.listStatus) {
                els.listStatus.textContent = '';
            }
            // 一覧にタイムを反映(取得済みラップのみタイム列が出る)
            reviewRenderList();
            return entry;
        });
}

/**
 * uPlot インスタンス3個を初回のみ生成する(charts.js initAnalysisCharts と同じ作法)。
 */
function reviewEnsureCharts() {
    if (reviewState.charts || typeof uPlot !== 'function') {
        return reviewState.charts;
    }
    const se = document.getElementById('review-speed-chart');
    const de = document.getElementById('review-delta-chart');
    const ie = document.getElementById('review-inputs-chart');
    if (!se || !de || !ie) {
        return null;
    }

    const base = {
        width: 400,
        height: 140,
        pxAlign: 0,
        pxSnap: true,
        scales: { x: { time: false }, y: { auto: true } },
        axes: [{ show: false }, { show: false }],
        cursor: { show: false },
        legend: { show: false },
        padding: [0, 0, 0, 0],
        points: { show: false }
    };
    const C = REVIEW_SERIES_COLORS;

    try {
        const charts = {
            speed: new uPlot(Object.assign({}, base, {
                series: [
                    {},
                    { stroke: C.a, width: 1.5, fill: C.aFill },        // A 実線
                    { stroke: C.b, width: 1.25, dash: [4, 3] }          // B 破線
                ]
            }), [[0], [null], [null]], se),
            delta: new uPlot(Object.assign({}, base, {
                series: [{}, { stroke: C.delta, width: 1.25 }]
            }), [[0], [null]], de),
            inputs: new uPlot(Object.assign({}, base, {
                scales: { x: { time: false }, y: { auto: false, range: [0, 100] } },
                series: [
                    {},
                    { stroke: C.a, width: 1.25 },                        // A throttle
                    { stroke: C.brakeA, width: 1.25 },                   // A brake
                    { stroke: C.b, width: 1, dash: [4, 3] },             // B throttle
                    { stroke: C.brakeB, width: 1, dash: [4, 3] }         // B brake
                ]
            }), [[0], [null], [null], [null], [null]], ie)
        };

        // コンテナ追随リサイズ(charts.js setupAnalysisChartResize と同じ作法)
        [[se, charts.speed], [de, charts.delta], [ie, charts.inputs]].forEach(function(pair) {
            const el = pair[0];
            const chart = pair[1];
            const applySize = function() {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    chart.setSize({ width: rect.width, height: rect.height });
                }
            };
            new ResizeObserver(applySize).observe(el);
            applySize();
        });

        reviewState.charts = charts;
    } catch (e) {
        console.error('[REVIEW_CHART]', e);
        reviewState.charts = null;
    }
    return reviewState.charts;
}

/**
 * 取得済み A/B の系列から3チャートを描画する。
 * @param {Object|null} a - reviewFetchDetail の戻り(比較対象)
 * @param {Object|null} b - 同(基準)
 */
function reviewRenderCharts(a, b) {
    const charts = reviewEnsureCharts();
    if (!charts) {
        return;
    }
    const step = reviewStepM();
    const ra = a && a.res;
    const rb = b && b.res;
    const na = ra ? ra.dist.length : 0;
    const nb = rb ? rb.dist.length : 0;
    const N = Math.max(na, nb, 1);

    const xs = new Array(N);
    const speedA = new Array(N);
    const speedB = new Array(N);
    const delta = new Array(N);
    const thrA = new Array(N);
    const brkA = new Array(N);
    const thrB = new Array(N);
    const brkB = new Array(N);

    for (let k = 0; k < N; k++) {
        xs[k] = k * step;
        speedA[k] = (ra && k < na) ? ra.speed[k] : null;
        speedB[k] = (rb && k < nb) ? rb.speed[k] : null;
        thrA[k] = (ra && k < na) ? ra.throttle[k] : null;
        brkA[k] = (ra && k < na) ? ra.brake[k] : null;
        thrB[k] = (rb && k < nb) ? rb.throttle[k] : null;
        brkB[k] = (rb && k < nb) ? rb.brake[k] : null;
        delta[k] = (ra && rb && k < na && k < nb)
            ? ra.time[k] - rb.time[k]
            : null;
    }

    try {
        charts.speed.setData([xs, speedA, speedB]);
        charts.delta.setData([xs, delta]);
        charts.inputs.setData([xs, thrA, brkA, thrB, brkB]);
    } catch (e) {
        // 描画失敗は握りつぶす(他機能へ波及させない。charts.js と同じ方針)
    }
}

/**
 * 選択(A/B)の変化に応じて詳細取得→サマリ・チャートを更新する。
 * 取得は非同期のため、更新途中に選択が変わった場合は古い結果を破棄する
 * (compareToken による世代ガード)。
 */
function reviewUpdateComparison() {
    const els = ensureReviewEls();
    const selA = reviewState.selA;
    const selB = reviewState.selB;
    const token = (reviewState._compareToken = (reviewState._compareToken || 0) + 1);

    const label = function(file) {
        if (!file) {
            return '未選択';
        }
        const cached = reviewState.detailCache[file];
        const lt = cached && cached.meta.laptime_ms_approx;
        return file.slice(0, 19) +
            (lt && typeof formatLapTime === 'function' ? ' (' + formatLapTime(lt) + ')' : '');
    };
    if (els.sumA) {
        els.sumA.textContent = 'A: ' + label(selA);
    }
    if (els.sumB) {
        els.sumB.textContent = 'B: ' + label(selB);
    }

    if (!selA && !selB) {
        if (els.sumDelta) {
            els.sumDelta.textContent = 'Δ: --';
        }
        if (els.sumCourse) {
            els.sumCourse.textContent = 'コース: --';
        }
        reviewRenderCharts(null, null);
        return;
    }

    Promise.all([
        selA ? reviewFetchDetail(selA) : Promise.resolve(null),
        selB ? reviewFetchDetail(selB) : Promise.resolve(null)
    ]).then(function(pair) {
        if (token !== reviewState._compareToken) {
            return; // 選択が変わった後の古い応答は捨てる
        }
        const a = pair[0];
        const b = pair[1];

        // サマリ(タイム確定後にラベルを引き直す)
        if (els.sumA) {
            els.sumA.textContent = 'A: ' + label(selA);
        }
        if (els.sumB) {
            els.sumB.textContent = 'B: ' + label(selB);
        }
        if (els.sumDelta) {
            const la = a && a.meta.laptime_ms_approx;
            const lb = b && b.meta.laptime_ms_approx;
            els.sumDelta.textContent = (la && lb)
                ? 'Δ: ' + ((la - lb) / 1000 >= 0 ? '+' : '') + ((la - lb) / 1000).toFixed(2) + 's'
                : 'Δ: --';
        }
        if (els.sumCourse) {
            const course = (a && a.meta.course) || (b && b.meta.course);
            els.sumCourse.textContent = 'コース: ' +
                (course ? (course.name_ja || course.name_en || course.id || '--') : '--');
        }

        reviewRenderCharts(a, b);
        // 実レース由来メトリクス P1 (#145): 比較確定データを race-metrics.js へ(唯一のフック)
        if (typeof rmOnReviewCompare === 'function') rmOnReviewCompare(a, b);
    }).catch(function(err) {
        if (token !== reviewState._compareToken) {
            return;
        }
        if (els.listStatus) {
            els.listStatus.textContent = 'ラップを取得できません (' + err.message + ')';
        }
    });
}

/* ================================================================
 *  自己初期化
 * ================================================================ */
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initReviewView);
} else {
    initReviewView();
}
