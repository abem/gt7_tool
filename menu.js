/**
 * フラット1段操作ツールバー
 *
 * ヘッダーのタイトル行の下に、ドロップダウンを持たない1段のツールバー
 * (ANALYSIS│DRIVE セグメント / TEST MODE ピル / ALIGN / FULLSCREEN)を注入する。
 * 「状態は常時点灯、操作は1クリック、隠れた状態ゼロ」を方針とし、
 * role="toolbar" + トグルは aria-pressed で表現する(menu 系 ARIA は不使用)。
 *
 * 設計要点:
 * - プロキシ方式: 各操作は既存の隠しボタン (#test-mode-btn / #view-mode-btn /
 *   #layout-reset-btn) を .click() で駆動し、状態はそのボタンの class から読む。
 *   test-mode.js / drive-view.js / card-drag.js のロジックには一切手を入れない。
 *   対応プロキシが無いコントロールは生成しない(disabled 表示より「無い機能は出さない」)。
 * - イベント駆動同期: プロキシの class 変化を MutationObserver で、全画面状態を
 *   'fullscreenchange' で監視して表示へ反映する(ポーリングなし・楽観的更新なし)。
 *   script 順序や localStorage 復元のタイミングに依存せず、表示が実態と乖離しない。
 * - フォールバック: ビルドは try/catch で包み、成功した場合のみ元ボタンを隠す。
 *   途中で throw したら注入済み nav を撤去し、元のボタンは可視のまま残す。
 *
 * 依存なし・プレーンスクリプト(IIFE)。読み込み時に自動初期化。
 */
(function () {
    'use strict';

    // ---- title 文言(動的なものは sync 内で書換) ----
    var TITLE_ANALYSIS = '解析用の全パネル表示';
    var TITLE_DRIVE = '走行用の最小表示(ギア・シフトライト・デルタ・燃料)';
    var TITLE_REVIEW = '過去ラップのレビュー(一覧・距離基準比較)';
    var TITLE_TEST_OFF = 'デモデータで動作確認(実走データではありません)';
    var TITLE_TEST_ON = 'テスト走行を停止';
    var TITLE_LAYOUT = '全ブロックを初期配置に整列（サイズもリセット） / ドラッグで移動、右下をドラッグでサイズ変更、ダブルクリックで個別リセット';
    var TITLE_FS_OFF = '全画面表示に切替';
    var TITLE_FS_ON = '全画面を解除 (Esc)';

    function byId(id) { return document.getElementById(id); }
    function proxyClick(id) { var el = byId(id); if (el) el.click(); }

    // ---- 状態参照(すべてプロキシが唯一のソース) ----
    function isDrive() { var b = byId('view-mode-btn'); return !!(b && b.classList.contains('active')); }
    function isReview() { var b = byId('review-mode-btn'); return !!(b && b.classList.contains('active')); }
    function isTest() { var b = byId('test-mode-btn'); return !!(b && b.classList.contains('active')); }
    function isFullscreen() { return !!document.fullscreenElement; }

    // 生成したコントロール(プロキシ欠如時は null のまま=非生成)
    var segAnalysis = null;
    var segDrive = null;
    var segReview = null;
    var testBtn = null;
    var fsBtn = null;
    var fsPending = false;    // 全画面の多重要求抑止フラグ

    // ---- 状態同期(全 sync は null ガード・冪等) ----
    function syncView() {
        if (!segAnalysis || !segDrive) return;
        var review = isReview();
        var drive = !review && isDrive();
        var analysis = !review && !drive;
        segDrive.classList.toggle('active', drive);
        segDrive.setAttribute('aria-pressed', String(drive));
        segAnalysis.classList.toggle('active', analysis);
        segAnalysis.setAttribute('aria-pressed', String(analysis));
        if (segReview) {
            segReview.classList.toggle('active', review);
            segReview.setAttribute('aria-pressed', String(review));
        }
    }
    function syncTest() {
        if (!testBtn) return;
        var on = isTest();
        testBtn.classList.toggle('active', on);
        testBtn.setAttribute('aria-pressed', String(on));
        testBtn.title = on ? TITLE_TEST_ON : TITLE_TEST_OFF;
    }
    function syncFullscreen() {
        if (!fsBtn) return;
        var on = isFullscreen();
        fsBtn.classList.toggle('active', on);
        fsBtn.setAttribute('aria-pressed', String(on));
        fsBtn.title = on ? TITLE_FS_ON : TITLE_FS_OFF;
    }

    // ---- 生成ヘルパ ----
    function makeCtl(id, extraClass, title, ariaLabel) {
        var b = document.createElement('button');
        b.type = 'button';                 // フォーム誤送信予防
        b.id = id;
        b.className = 'tb-ctl ' + extraClass;
        b.title = title;
        // title 非依存の明示ラベル(タッチ/スクリーンリーダー向け)
        if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
        // ロービング tabindex の初期値。setupRoving() が1個だけ 0 に昇格させる
        b.setAttribute('tabindex', '-1');
        return b;
    }
    function makeSpan(className, text, ariaHidden) {
        var s = document.createElement('span');
        s.className = className;
        if (text) s.textContent = text;
        if (ariaHidden) s.setAttribute('aria-hidden', 'true');
        return s;
    }

    // ---- コントロール(操作は必ずプロキシ .click() 経由。ロジック無改変) ----
    function buildSeg() {
        var seg = document.createElement('div');
        seg.className = 'tb-seg';
        seg.setAttribute('role', 'group');
        seg.setAttribute('aria-label', '表示モード');

        segAnalysis = makeCtl('tb-view-analysis', 'tb-seg-btn', TITLE_ANALYSIS, 'ANALYSIS');
        segAnalysis.textContent = 'ANALYSIS';
        segAnalysis.addEventListener('click', function () {
            if (isReview()) proxyClick('review-mode-btn'); // REVIEW を先に降ろす(排他)
            if (isDrive()) proxyClick('view-mode-btn');  // 既に ANALYSIS なら no-op(冪等な「選択」)
            syncView();                                  // Observer 不発時の保険
        });

        segDrive = makeCtl('tb-view-drive', 'tb-seg-btn', TITLE_DRIVE, 'DRIVE');
        segDrive.textContent = 'DRIVE';
        segDrive.addEventListener('click', function () {
            if (isReview()) proxyClick('review-mode-btn');
            if (!isDrive()) proxyClick('view-mode-btn');
            syncView();
        });

        seg.appendChild(segAnalysis);
        seg.appendChild(segDrive);

        // REVIEW はプロキシがある場合のみ生成(コントロール単位で縮退する既存方針)
        if (byId('review-mode-btn')) {
            segReview = makeCtl('tb-view-review', 'tb-seg-btn', TITLE_REVIEW, 'REVIEW');
            segReview.textContent = 'REVIEW';
            segReview.addEventListener('click', function () {
                // DRIVE 解除は review-view.js の applyReviewMode(ON) 側が行う
                if (!isReview()) proxyClick('review-mode-btn');
                syncView();
            });
            seg.appendChild(segReview);
        }
        return seg;
    }

    function buildTest() {
        testBtn = makeCtl('tb-test', 'tb-test', TITLE_TEST_OFF, 'TEST MODE');
        testBtn.appendChild(makeSpan('tb-dot', '', true));
        // ラベルは状態で変えない(幅ジャンプ防止)。状態はドット+背景で表現。
        testBtn.appendChild(makeSpan('tb-label', 'TEST MODE', false));
        var last = 0;    // 250ms スロットル(ダブルタップで開始→即停止する事故を防ぐ)
        testBtn.addEventListener('click', function () {
            if (Date.now() - last < 250) return;
            last = Date.now();
            proxyClick('test-mode-btn');
            syncTest();
        });
        return testBtn;
    }

    function buildLayout() {
        var btn = makeCtl('tb-layout', 'tb-btn', TITLE_LAYOUT, 'ALIGN');
        btn.appendChild(makeSpan('tb-ico', '⊞', true));
        btn.appendChild(makeSpan('tb-label', 'ALIGN', false));
        btn.addEventListener('click', function () {
            if (typeof window.gt7ResetLayout === 'function') window.gt7ResetLayout();
            else proxyClick('layout-reset-btn');
            // 効果が画面外でも「実行された」ことが分かる一瞬の応答
            btn.classList.add('tb-flash');
            setTimeout(function () { btn.classList.remove('tb-flash'); }, 250);
        });
        return btn;
    }

    function buildFullscreen() {
        fsBtn = makeCtl('tb-fullscreen', 'tb-btn', TITLE_FS_OFF, 'FULLSCREEN');
        fsBtn.appendChild(makeSpan('tb-ico', '⛶', true));
        fsBtn.appendChild(makeSpan('tb-label', 'FULLSCREEN', false));
        fsBtn.addEventListener('click', function () {
            if (fsPending) return;    // 多重要求の抑止
            // 状態は必ず fullscreenchange イベントから読む(楽観的更新をしない=
            // 拒否時に表示が嘘をつかない)。成功経路は fullscreenchange が
            // pending 解除+sync、失敗経路は catch で pending 解除+再 sync。
            try {
                fsPending = true;
                var p;
                if (document.fullscreenElement) p = document.exitFullscreen();
                else p = document.documentElement.requestFullscreen();
                if (p && p.catch) p.catch(function () { fsPending = false; syncFullscreen(); });
            } catch (e) {
                fsPending = false;
                syncFullscreen();
            }
        });
        return fsBtn;
    }

    // ---- ロービング tabindex(role="toolbar" の APG 契約) ----
    // ツールバー全体で Tab ストップは常に1個。バー内の移動は ArrowLeft/ArrowRight
    // (端で循環)と Home/End。クリック/フォーカスされたボタンが新たな Tab 位置になる。
    function tbButtons(nav) {
        return Array.prototype.slice.call(nav.querySelectorAll('button.tb-ctl'));
    }
    function setRovingCurrent(nav, target) {
        var btns = tbButtons(nav);
        for (var i = 0; i < btns.length; i++) {
            btns[i].setAttribute('tabindex', btns[i] === target ? '0' : '-1');
        }
    }
    function setupRoving(nav) {
        var btns = tbButtons(nav);
        if (!btns.length) return;
        setRovingCurrent(nav, btns[0]);

        nav.addEventListener('keydown', function (e) {
            var key = e.key;
            if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
            var list = tbButtons(nav);    // 毎回再取得(将来のボタン増減に追随)
            if (!list.length) return;
            var idx = list.indexOf(document.activeElement);
            var next;
            if (key === 'Home') next = 0;
            else if (key === 'End') next = list.length - 1;
            else if (idx === -1) next = 0;    // バー内だが非ボタンにフォーカスがある場合の回復
            else if (key === 'ArrowRight') next = (idx + 1) % list.length;
            else next = (idx - 1 + list.length) % list.length;
            e.preventDefault();    // 矢印キーでのページスクロールを抑止
            setRovingCurrent(nav, list[next]);
            list[next].focus();
        });

        // フォーカス到達で追随(Tab 進入・.focus() 呼び出しを含む)
        nav.addEventListener('focusin', function (e) {
            var t = e.target;
            if (t && t.classList && t.classList.contains('tb-ctl')) setRovingCurrent(nav, t);
        });
        // クリックでも追随(Safari 等はクリックでボタンに focus を与えないため focusin と併設)
        nav.addEventListener('click', function (e) {
            var t = e.target;
            while (t && t !== nav && !(t.classList && t.classList.contains('tb-ctl'))) t = t.parentNode;
            if (t && t !== nav) setRovingCurrent(nav, t);
        });
    }

    // ---- 初期化 ----
    function init() {
        var nav = null;
        try {
            if (document.getElementById('app-toolbar')) return;    // 二重初期化ガード
            var header = document.querySelector('.header');
            if (!header) return;

            nav = document.createElement('nav');
            nav.id = 'app-toolbar';
            nav.className = 'app-toolbar';
            nav.setAttribute('role', 'toolbar');
            nav.setAttribute('aria-label', '表示と操作');

            // プロキシが無いコントロールは生成しない(コントロール単位で縮退)
            if (byId('view-mode-btn')) nav.appendChild(buildSeg());
            if (byId('test-mode-btn')) nav.appendChild(buildTest());

            // 状態系クラスタ(左)と受動ユーティリティ(右)を空間分離=誤クリック耐性
            var spacer = document.createElement('div');
            spacer.className = 'tb-spacer';
            nav.appendChild(spacer);

            // 整列は gt7ResetLayout 関数(card-drag.js が公開)があればボタン不在でも動く
            if (typeof window.gt7ResetLayout === 'function' || byId('layout-reset-btn')) {
                nav.appendChild(buildLayout());
            }
            // API 自体が無い/使えない環境(iPhone Safari、iframe 埋め込み等)では非生成
            if (document.fullscreenEnabled && document.documentElement.requestFullscreen) {
                nav.appendChild(buildFullscreen());
            }

            header.appendChild(nav);

            // ロービング tabindex(生成済みボタンが確定した後に一度だけ配線)
            setupRoving(nav);

            // イベント駆動同期: プロキシの class 変化を Observer 1個で監視。
            // app.js 起動時の localStorage 復元(drive-view.js applyViewMode)や
            // test-mode.js 側の状態変化を、script 順序に依存せず確実に反映する。
            var mo = new MutationObserver(function (muts) {
                for (var i = 0; i < muts.length; i++) {
                    var id = muts[i].target && muts[i].target.id;
                    if (id === 'view-mode-btn' || id === 'review-mode-btn') syncView();
                    else if (id === 'test-mode-btn') syncTest();
                }
            });
            var viewProxy = byId('view-mode-btn');
            var reviewProxy = byId('review-mode-btn');
            var testProxy = byId('test-mode-btn');
            if (viewProxy) mo.observe(viewProxy, { attributes: true, attributeFilter: ['class'] });
            if (reviewProxy) mo.observe(reviewProxy, { attributes: true, attributeFilter: ['class'] });
            if (testProxy) mo.observe(testProxy, { attributes: true, attributeFilter: ['class'] });

            document.addEventListener('fullscreenchange', function () {
                fsPending = false;
                syncFullscreen();
            });

            // 初期表示
            syncView();
            syncTest();
            syncFullscreen();

            // ビルド成功後にのみ個別ボタンをツールバーへ一元化(=非表示)。
            // 失敗時はここに来ず、元のボタンがフォールバックとして残る。
            ['test-mode-btn', 'view-mode-btn', 'review-mode-btn', 'layout-reset-btn'].forEach(function (id) {
                var el = byId(id); if (el) el.style.display = 'none';
            });
        } catch (e) {
            // ビルド途中の例外: 注入済み nav を撤去し、元ボタンは可視のまま残す
            if (nav) nav.remove();
            segAnalysis = segDrive = segReview = testBtn = fsBtn = null;
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
