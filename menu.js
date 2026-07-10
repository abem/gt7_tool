/**
 * 操作帯（Windows 風ドロップダウン・メニューバー）
 *
 * ヘッダーのタイトル行の下に「表示 / モード / 配置 / 設定」の見出しを並べ、
 * クリックで操作一覧をドロップダウン表示する。各操作は既存のボタン
 * (#test-mode-btn / #view-mode-btn / 配置リセット)を
 * 「隠しプロキシ」として .click() で駆動し、状態(✓)はそのボタンの class から
 * 読む。これにより test-mode.js / drive-view.js / telemetry-analysis.js /
 * card-drag.js のロジックには一切手を入れずに一元化する。
 *
 * 依存なし・プレーンスクリプト。読み込み時に自動初期化。ビルド成功後にのみ
 * 個別ボタンを隠すため、万一エラーでも元のボタンはフォールバックとして残る。
 */
(function () {
    'use strict';

    function byId(id) { return document.getElementById(id); }
    function proxyClick(id) { var el = byId(id); if (el) el.click(); }

    // ---- 状態参照(プロキシの class / text がソース) ----
    function isDrive() { var b = byId('view-mode-btn'); return !!(b && b.classList.contains('active')); }
    function isTest() { var b = byId('test-mode-btn'); return !!(b && b.classList.contains('active')); }
    function isFullscreen() { return !!document.fullscreenElement; }
    function resetLayout() {
        if (typeof window.gt7ResetLayout === 'function') window.gt7ResetLayout();
        else proxyClick('layout-reset-btn');
    }
    function toggleFullscreen() {
        try {
            if (document.fullscreenElement) { if (document.exitFullscreen) document.exitFullscreen(); }
            else if (document.documentElement.requestFullscreen) {
                var p = document.documentElement.requestFullscreen();
                if (p && p.catch) p.catch(function () {});
            }
        } catch (e) { /* 未対応/拒否時は無視 */ }
    }

    // ---- メニュー定義 ----
    var MENUS = [
        { label: '表示', items: [
            { label: 'ANALYSIS 表示', check: function () { return !isDrive(); }, action: function () { if (isDrive()) proxyClick('view-mode-btn'); } },
            { label: 'DRIVE 表示', check: function () { return isDrive(); }, action: function () { if (!isDrive()) proxyClick('view-mode-btn'); } }
        ] },
        { label: 'モード', items: [
            { label: 'TEST MODE', check: function () { return isTest(); }, hint: function () { return isTest() ? '実行中' : ''; }, action: function () { proxyClick('test-mode-btn'); } }
        ] },
        { label: '配置', items: [
            { label: '全ブロックを整列（リセット）', action: function () { resetLayout(); } },
            { sep: true },
            { label: 'ブロックはドラッグで移動', disabled: true },
            { label: 'ダブルクリックで個別リセット', disabled: true }
        ] },
        { label: '設定', items: [
            { label: '全画面表示', check: function () { return isFullscreen(); }, action: function () { toggleFullscreen(); } }
        ] }
    ];

    var roots = [];           // { el, updaters:[fn] }
    var menuOpen = false;

    function closeAll() {
        menuOpen = false;
        roots.forEach(function (r) {
            r.el.classList.remove('open');
            r.el.setAttribute('aria-expanded', 'false');
        });
    }
    function openRoot(r) {
        roots.forEach(function (o) {
            var on = o === r;
            o.el.classList.toggle('open', on);
            o.el.setAttribute('aria-expanded', String(on));
        });
        menuOpen = true;
        r.updaters.forEach(function (fn) { fn(); });   // 開くたびに ✓/ラベルを最新化
    }

    function callable(v) { return typeof v === 'function' ? v() : v; }

    function buildItem(item, updaters) {
        if (item.sep) {
            var sep = document.createElement('div');
            sep.className = 'menu-sep';
            return sep;
        }
        var el = document.createElement('div');
        el.className = 'menu-item';
        el.setAttribute('role', 'menuitem');

        var check = document.createElement('span');
        check.className = 'menu-check';
        el.appendChild(check);

        var label = document.createElement('span');
        label.className = 'menu-label';
        el.appendChild(label);

        var hintEl = null;
        if (item.hint != null) {
            hintEl = document.createElement('span');
            hintEl.className = 'menu-hint';
            el.appendChild(hintEl);
        }

        function update() {
            label.textContent = callable(item.label) || '';
            var dis = item.disabled === true || (typeof item.disabled === 'function' && item.disabled());
            el.classList.toggle('disabled', !!dis);
            check.textContent = (item.check && item.check()) ? '✓' : '';
            if (hintEl) hintEl.textContent = callable(item.hint) || '';
        }
        updaters.push(update);
        update();

        if (item.action) {
            el.addEventListener('click', function (e) {
                e.stopPropagation();
                var dis = item.disabled === true || (typeof item.disabled === 'function' && item.disabled());
                if (dis) return;
                closeAll();
                item.action();
            });
        }
        return el;
    }

    function buildRoot(menu) {
        var updaters = [];
        var root = document.createElement('div');
        root.className = 'menu-root';
        root.setAttribute('role', 'menuitem');
        root.setAttribute('aria-haspopup', 'true');
        root.setAttribute('aria-expanded', 'false');
        root.tabIndex = 0;

        var lbl = document.createElement('span');
        lbl.className = 'menu-root-label';
        lbl.textContent = menu.label;
        root.appendChild(lbl);

        var dd = document.createElement('div');
        dd.className = 'menu-dropdown';
        dd.setAttribute('role', 'menu');
        menu.items.forEach(function (it) { dd.appendChild(buildItem(it, updaters)); });
        root.appendChild(dd);

        var r = { el: root, updaters: updaters };

        root.addEventListener('click', function (e) {
            e.stopPropagation();
            if (root.classList.contains('open')) closeAll();
            else openRoot(r);
        });
        root.addEventListener('pointerenter', function () {
            if (menuOpen && !root.classList.contains('open')) openRoot(r);
        });
        roots.push(r);
        return root;
    }

    function init() {
        var header = document.querySelector('.header');
        if (!header || document.getElementById('app-menubar')) return;

        var bar = document.createElement('nav');
        bar.id = 'app-menubar';
        bar.className = 'app-menubar';
        bar.setAttribute('role', 'menubar');
        bar.setAttribute('aria-label', '操作メニュー');
        MENUS.forEach(function (m) { bar.appendChild(buildRoot(m)); });
        header.appendChild(bar);

        // 外側クリック / Esc で閉じる（メニュー内クリックは各ハンドラが stopPropagation
        // するのでここには来ないが、念のため #app-menubar 内は無視する）
        document.addEventListener('click', function (e) {
            if (menuOpen && !(e.target.closest && e.target.closest('#app-menubar'))) closeAll();
        });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && menuOpen) closeAll(); });

        // ビルド成功後に個別ボタンをメニューへ一元化(=非表示)。失敗時はここに来ず残る。
        ['test-mode-btn', 'view-mode-btn', 'layout-reset-btn'].forEach(function (id) {
            var el = byId(id); if (el) el.style.display = 'none';
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
