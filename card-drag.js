/**
 * カード(.card)をマウス/タッチでピックして自由に移動する。
 *
 * - トップレベルの .card を対象（ネストした子カードは除外）。
 * - ハンドル = そのカードのタイトル(.card-title、ヘッダ内などネストしていても可)。
 *   タイトルの無いカード(スタット系)は「カード全体」をハンドルにする。
 * - ドラッグ開始でカードを body 直下へ「浮かせて」(position:fixed)自由移動する。
 *   列(.left/center/right-panel)は overflow クリップ + contain:content のため。
 * - 位置は localStorage に保存し次回ロードで復元（画面外はクランプ）。
 * - ヘッダ「↻ 配置」で全リセット / ハンドルのダブルクリックで個別リセット。
 *
 * 依存なし・プレーンスクリプト。読み込み時に自動初期化。
 */
(function () {
    'use strict';
    var STORE_KEY = 'gt7-card-layout-v1';
    var THRESHOLD = 4;        // クリックとドラッグの区別(px)
    var zTop = 1000;
    var cards = [];           // { el, id, handle, orig:{parent,index} }

    function isTopLevelCard(el) {
        return el.classList.contains('card') &&
            !(el.parentElement && el.parentElement.closest('.card'));
    }
    // このカードに属する .card-title（ネスト下でも可 / 子カードのものは除外）
    function ownTitle(el) {
        var titles = el.querySelectorAll('.card-title');
        for (var i = 0; i < titles.length; i++) {
            if (titles[i].closest('.card') === el) return titles[i];
        }
        return null;
    }
    function slug(s) {
        return (s || 'card').trim().replace(/\s+/g, '-').replace(/[^\w\-]/g, '').toLowerCase().slice(0, 24) || 'card';
    }
    function loadStore() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; } }
    function saveStore(m) { try { localStorage.setItem(STORE_KEY, JSON.stringify(m)); } catch (e) {} }
    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    // ドラッグを開始しない要素（本物の操作系のみ）。canvas は当ダッシュボードでは
    // 表示専用（uPlot は cursor:{show:false}、他も入力ハンドラ無し）なので除外しない
    // → チャート/ビジュアライズ系カードも本体のどこからでも掴めるようにする。
    function isInteractive(t) {
        return !!(t && t.closest && t.closest('button, input, select, textarea, a, [contenteditable], [role="button"]'));
    }

    function floatCard(c, left, top, width, height) {
        if (c.el.classList.contains('floating')) return;
        var s = c.el.style;
        s.width = width + 'px';
        s.height = height + 'px';
        s.position = 'fixed';
        s.left = left + 'px';
        s.top = top + 'px';
        s.margin = '0';
        s.zIndex = String(++zTop);
        document.body.appendChild(c.el);   // クリップ外へ（列は自然に詰まる）
        c.el.classList.add('floating');
    }
    function unfloat(c) {
        var el = c.el;
        if (!el.classList.contains('floating')) return;
        ['position', 'left', 'top', 'width', 'height', 'margin', 'zIndex', 'transform'].forEach(function (p) {
            el.style[p] = '';
        });
        el.classList.remove('floating', 'dragging');
        // 元の並びへ: まだ列に残っている「元 index が自分より後」の最も近い兄弟の直前に挿す
        var parent = c.orig.parent, ref = null, best = Infinity;
        cards.forEach(function (o) {
            if (o === c || o.orig.parent !== parent) return;
            if (o.el.classList.contains('floating') || o.el.parentElement !== parent) return;
            if (o.orig.index > c.orig.index && o.orig.index < best) { best = o.orig.index; ref = o.el; }
        });
        parent.insertBefore(el, ref);
    }
    function persist(c) {
        var r = c.el.getBoundingClientRect();
        var s = loadStore();
        s[c.id] = { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
        saveStore(s);
    }
    function forget(c) { var s = loadStore(); delete s[c.id]; saveStore(s); }

    function attach(c) {
        var startX = 0, startY = 0, grabX = 0, grabY = 0, pending = false, dragging = false, activeId = null;

        function teardown() {
            document.removeEventListener('pointermove', onMove, true);
            document.removeEventListener('pointerup', onUp, true);
            document.removeEventListener('pointercancel', onUp, true);
            window.removeEventListener('blur', onUp);
        }
        function onMove(e) {
            if (e.pointerId !== activeId) return;         // 発端のポインタのみ(多点タッチ対策)
            if (e.buttons === 0) { onUp(e); return; }     // ボタンが離れている(枠外リリース等)→終了
            if (pending && !dragging) {
                if (Math.hypot(e.clientX - startX, e.clientY - startY) < THRESHOLD) return;
                var r = c.el.getBoundingClientRect();
                grabX = startX - r.left; grabY = startY - r.top;
                floatCard(c, r.left, r.top, r.width, r.height);
                c.el.classList.add('dragging');
                dragging = true;
            }
            if (!dragging) return;
            var w = c.el.offsetWidth, h = c.el.offsetHeight;
            c.el.style.left = clamp(e.clientX - grabX, 0, Math.max(0, window.innerWidth - w)) + 'px';
            c.el.style.top = clamp(e.clientY - grabY, 0, Math.max(0, window.innerHeight - Math.min(h, 40))) + 'px';
            c.el.style.zIndex = String(++zTop);
            e.preventDefault();
        }
        function onUp(e) {
            if (e && e.pointerId != null && e.pointerId !== activeId) return;
            teardown();
            if (dragging) { c.el.classList.remove('dragging'); persist(c); }
            pending = false; dragging = false; activeId = null;
        }
        c.handle.addEventListener('pointerdown', function (e) {
            if (e.button !== 0) return;
            if (pending || dragging) return;              // 進行中のジェスチャは1本のみ
            if (isInteractive(e.target)) return;          // ボタン等の操作系からは開始しない
            activeId = e.pointerId;
            pending = true; dragging = false;
            startX = e.clientX; startY = e.clientY;
            document.addEventListener('pointermove', onMove, true);
            document.addEventListener('pointerup', onUp, true);
            document.addEventListener('pointercancel', onUp, true);
            window.addEventListener('blur', onUp);
            e.preventDefault();
        });
        c.handle.addEventListener('dblclick', function (e) {
            if (isInteractive(e.target)) return;
            unfloat(c); forget(c);
        });
    }

    function resetAll() {
        cards.slice().sort(function (a, b) { return a.orig.index - b.orig.index; }).forEach(unfloat);
        saveStore({});
    }

    function addResetButton() {
        var header = document.querySelector('.header');
        if (!header || document.getElementById('layout-reset-btn')) return;
        var btn = document.createElement('button');
        btn.id = 'layout-reset-btn';
        btn.type = 'button';
        btn.className = 'test-mode-btn layout-reset-btn';
        btn.textContent = '↻ 配置';
        btn.title = 'カード配置を初期化。カード(またはタイトル)をドラッグで移動 / ダブルクリックで個別リセット';
        btn.addEventListener('click', resetAll);
        var status = document.getElementById('connection-status');
        if (status) header.insertBefore(btn, status); else header.appendChild(btn);
    }

    function restoreSaved() {
        var store = loadStore();
        cards.forEach(function (c) {
            var s = store[c.id];
            if (!s) return;
            var w = s.width || c.el.getBoundingClientRect().width;
            var h = s.height || c.el.getBoundingClientRect().height;
            var left = clamp(s.left, 0, Math.max(0, window.innerWidth - w));
            var top = clamp(s.top, 0, Math.max(0, window.innerHeight - Math.min(h, 40)));
            floatCard(c, left, top, w, h);
        });
    }

    function onResize() {
        cards.forEach(function (c) {
            if (!c.el.classList.contains('floating')) return;
            var w = c.el.offsetWidth, h = c.el.offsetHeight;
            c.el.style.left = clamp(parseFloat(c.el.style.left) || 0, 0, Math.max(0, window.innerWidth - w)) + 'px';
            c.el.style.top = clamp(parseFloat(c.el.style.top) || 0, 0, Math.max(0, window.innerHeight - Math.min(h, 40))) + 'px';
        });
    }

    function init() {
        var all = Array.prototype.slice.call(document.querySelectorAll('.card')).filter(isTopLevelCard);
        all.forEach(function (el, idx) {
            var titleEl = ownTitle(el);
            var handle = el;                               // カード全体をハンドルに（どこでも掴める）
            var key = slug(titleEl ? titleEl.textContent : (el.className || 'card')) + '#' + idx;
            var c = {
                el: el, handle: handle, id: key,
                orig: { parent: el.parentElement, index: Array.prototype.indexOf.call(el.parentElement.children, el) }
            };
            el.classList.add('draggable-card');
            handle.classList.add('card-drag-handle');
            attach(c);
            cards.push(c);
        });
        addResetButton();
        restoreSaved();
        window.addEventListener('resize', onResize);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
