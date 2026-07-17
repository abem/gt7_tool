/* ============================================================
 * card-groups.js — カード表示グループ管理 (#151)
 *
 * 依拠: docs/カード表示グループ管理計画書_20260717.md(#149 承認済み)
 *  - 管理対象: index.html の data-cardgroup="g1"〜"g6" 付き25カード。
 *    racing-top-bar / #rm-review-card / #rm-replay-card は対象外(采決裁)。
 *  - 非表示は .cg-hidden(display:none !important) の付け外しのみで表現し、
 *    inline style は使わない(モード別CSS body.drive-mode / body.replay-mode
 *    等の表示制御を上書きしないため。計画書§3.1)。
 *  - 永続化: localStorage 'gt7-card-groups-v1' = {g1:true,...}(true=表示)。
 *    キー欠落は表示扱い・parse失敗は全表示フォールバック。
 *    card-drag の 'gt7-card-layout-v1' には一切触れない(状態の直交性)。
 *  - UI: menu.js が生成する #app-toolbar へ CARDS ボタンを挿入(このファイルは
 *    menu.js より後にロードされる。index.html のタグ順コメント参照)。
 *  - 全て cg 接頭辞。既存グローバルへの書込なし(読み取りも DOM のみ)。
 * ============================================================ */

(function () {
    'use strict';

    var CG_STORE_KEY = 'gt7-card-groups-v1';
    var CG_GROUPS = [
        { id: 'g1', label: 'CHARTS' },
        { id: 'g2', label: 'PEDALS / DRIVETRAIN' },
        { id: 'g3', label: 'FUEL / STRATEGY' },
        { id: 'g4', label: 'CAR BEHAVIOR' },
        { id: 'g5', label: 'LAP / TIMING' },
        { id: 'g6', label: 'CAR INFO' }
    ];

    function cgLoad() {
        try {
            var v = JSON.parse(localStorage.getItem(CG_STORE_KEY));
            return (v && typeof v === 'object') ? v : {};
        } catch (e) { return {}; }   // 不正値は全表示へフォールバック
    }
    function cgSave(m) {
        try {
            localStorage.setItem(CG_STORE_KEY, JSON.stringify(m));
        } catch (e) {
            // #153: 保存失敗の握りつぶしをやめ、実害時のみ非侵襲トーストで知らせる
            // (表示切替自体は cgApply が済ませているため画面は反映済み。
            //  リロードで元に戻る、という事実をユーザーが知れることが目的)
            cgWarnSaveFailed();
        }
    }

    var cgWarnShown = false;   // セッション中は初回のみ(連打での多重表示防止)
    function cgWarnSaveFailed() {
        if (cgWarnShown) return;
        cgWarnShown = true;
        var el = document.createElement('div');
        el.id = 'cg-save-warn';
        el.setAttribute('role', 'alert');
        el.textContent = 'カード表示設定を保存できませんでした(ブラウザのストレージ設定を確認)。表示は反映されていますが、リロードすると元に戻ります。';
        document.body.appendChild(el);
        setTimeout(function () {
            if (el.parentNode) el.parentNode.removeChild(el);
        }, 5000);
    }
    function cgVisible(state, gid) { return state[gid] !== false; }  // 欠落=表示

    function cgApply(state) {
        CG_GROUPS.forEach(function (g) {
            var hide = !cgVisible(state, g.id);
            var els = document.querySelectorAll('[data-cardgroup="' + g.id + '"]');
            for (var i = 0; i < els.length; i++) {
                els[i].classList.toggle('cg-hidden', hide);
            }
        });
        // .charts-container は固定高(styles.css: clamp(200px,30vh,320px))のため、
        // G1全カード非表示時に空帯が残る。中身が全て非表示なら容器ごと畳む。
        var cc = document.querySelector('.charts-container');
        if (cc) {
            cc.classList.toggle('cg-empty',
                !cc.querySelector('.chart-wrapper:not(.cg-hidden)'));
        }
        // 再表示直後に uPlot 等の実寸依存描画を追随させる(drive往復と同型の防御)
        try { window.dispatchEvent(new Event('resize')); } catch (e) {}
    }

    // ---- パネルUI ----
    var cgPanel = null;

    function cgBuildPanel() {
        if (cgPanel) return cgPanel;
        cgPanel = document.createElement('div');
        cgPanel.id = 'cg-panel';
        var title = document.createElement('div');
        title.className = 'cg-panel-title';
        title.textContent = 'CARD GROUPS';
        cgPanel.appendChild(title);

        CG_GROUPS.forEach(function (g) {
            var row = document.createElement('label');
            row.className = 'cg-row';
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.dataset.cgGroup = g.id;
            cb.addEventListener('change', function () {
                var state = cgLoad();
                state[g.id] = cb.checked;
                cgSave(state);
                cgApply(state);
            });
            var span = document.createElement('span');
            span.textContent = g.label;
            var count = document.createElement('span');
            count.className = 'cg-count';
            count.textContent = String(
                document.querySelectorAll('[data-cardgroup="' + g.id + '"]').length);
            row.appendChild(cb);
            row.appendChild(span);
            row.appendChild(count);
            cgPanel.appendChild(row);
        });

        var showAll = document.createElement('button');
        showAll.type = 'button';
        showAll.className = 'cg-show-all';
        showAll.textContent = 'SHOW ALL';
        showAll.addEventListener('click', function () {
            var state = {};
            CG_GROUPS.forEach(function (g) { state[g.id] = true; });
            cgSave(state);
            cgApply(state);
            cgSyncChecks();
            // #153: 押下効果を確実に視認させる — パネルを閉じて復帰したカード群を見せ、
            // CARDSボタンを一瞬フラッシュ(menu.jsのtb-flashと同じ発想の独自クラス)
            cgClosePanel();
            var btn = document.getElementById('cg-toolbar-btn');
            if (btn) {
                btn.classList.add('cg-flash');
                setTimeout(function () { btn.classList.remove('cg-flash'); }, 250);
            }
        });
        cgPanel.appendChild(showAll);
        document.body.appendChild(cgPanel);
        return cgPanel;
    }

    function cgSyncChecks() {
        if (!cgPanel) return;
        var state = cgLoad();
        var boxes = cgPanel.querySelectorAll('input[type="checkbox"]');
        for (var i = 0; i < boxes.length; i++) {
            boxes[i].checked = cgVisible(state, boxes[i].dataset.cgGroup);
        }
    }

    function cgTogglePanel(anchorBtn) {
        var p = cgBuildPanel();
        var open = !p.classList.contains('cg-open');
        if (open) {
            cgSyncChecks();
            var r = anchorBtn.getBoundingClientRect();
            p.style.top = (r.bottom + 6) + 'px';
            p.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
        }
        p.classList.toggle('cg-open', open);
        anchorBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function cgInsertButton() {
        var bar = document.getElementById('app-toolbar');
        if (!bar || document.getElementById('cg-toolbar-btn')) return !!document.getElementById('cg-toolbar-btn');
        var btn = document.createElement('button');
        btn.id = 'cg-toolbar-btn';
        btn.type = 'button';
        btn.className = 'tb-btn';
        btn.title = 'カードをグループ単位で表示/非表示';
        btn.setAttribute('aria-label', 'CARDS');
        btn.setAttribute('aria-haspopup', 'true');
        btn.setAttribute('aria-expanded', 'false');
        var ico = document.createElement('span');
        ico.className = 'tb-ico';
        ico.setAttribute('aria-hidden', 'true');
        ico.textContent = '▦';
        var label = document.createElement('span');
        label.className = 'tb-label';
        label.textContent = 'CARDS';
        btn.appendChild(ico);
        btn.appendChild(label);
        btn.addEventListener('click', function () { cgTogglePanel(btn); });
        // ALIGN(#tb-layout) の直前=既存の並び ALIGN/FULLSCREEN の左に置く
        var alignBtn = document.getElementById('tb-layout');
        if (alignBtn && alignBtn.parentNode === bar) bar.insertBefore(btn, alignBtn);
        else bar.appendChild(btn);
        return true;
    }

    function cgClosePanel() {
        if (!cgPanel) return;
        cgPanel.classList.remove('cg-open');
        var btn = document.getElementById('cg-toolbar-btn');
        if (btn) btn.setAttribute('aria-expanded', 'false');
    }

    // パネル外クリックで閉じる
    document.addEventListener('pointerdown', function (e) {
        if (!cgPanel || !cgPanel.classList.contains('cg-open')) return;
        var btn = document.getElementById('cg-toolbar-btn');
        if (cgPanel.contains(e.target) || (btn && btn.contains(e.target))) return;
        cgClosePanel();
    });

    // #153: タブ間同期 — 他タブでの変更(同一オリジンのstorageイベント)を反映する。
    // e.key===null は clear() のケース。標準機構のみでポーリングは行わない。
    window.addEventListener('storage', function (e) {
        if (e.key !== null && e.key !== CG_STORE_KEY) return;
        cgApply(cgLoad());
        cgSyncChecks();
    });

    function cgInit() {
        cgApply(cgLoad());
        // menu.js のツールバーは DOMContentLoaded で生成される。本ファイルは
        // menu.js より後だが、生成前に走った場合に備えて短いリトライを持つ。
        if (!cgInsertButton()) {
            var tries = 0;
            var t = setInterval(function () {
                if (cgInsertButton() || ++tries > 20) clearInterval(t);
            }, 100);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', cgInit);
    } else {
        cgInit();
    }
})();
