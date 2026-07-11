/**
 * カード(.card)をマウス/タッチでピックして自由に移動する。
 *
 * - トップレベルの .card を対象（ネストした子カードは除外）。
 * - ハンドル = そのカードのタイトル(.card-title、ヘッダ内などネストしていても可)。
 *   タイトルの無いカード(スタット系)は「カード全体」をハンドルにする。
 * - ドラッグ開始でカードを body 直下へ「浮かせて」(position:absolute)自由移動する。
 *   列(.left/center/right-panel)は overflow クリップ + contain:content のため。
 *   座標はドキュメント基準なので、ページがスクロールする幅(≤1399px)でも内容に追従する。
 * - 位置・サイズは localStorage に保存し次回ロードで復元（画面外・過大はクランプ）。
 * - ブロック右下のグリップ(またはコーナー24px域)のドラッグでリサイズ。グリップは
 *   body 直下の単一オーバーレイ(#gt7-resize-grip) — カード内注入はスクロール
 *   コンテナと衝突するため(docs/plan-block-resize-2026-07-11.md §7-6)。
 * - ヘッダ「↻ 配置」で全リセット / ハンドルのダブルクリックで個別リセット(位置・サイズとも)。
 *
 * 依存なし・プレーンスクリプト。読み込み時に自動初期化。
 */
(function () {
    'use strict';
    var STORE_KEY = 'gt7-card-layout-v1';
    var THRESHOLD = 4;        // クリックとドラッグの区別(px)
    var zTop = 1000;
    var cards = [];           // { el, id, handle, orig:{parent,index} }
    // ドラッグ対象「ブロック」= カード + チャートタイル(SPEED/RPM/THROTTLE/BRAKE 等)
    //   + 上部の大型バー(速度/ギア/ペダル = .racing-top-bar)
    var BLOCK_SEL = '.card, .chart-wrapper, .racing-top-bar';

    function isTopLevelBlock(el) {
        return el.matches(BLOCK_SEL) &&
            !(el.parentElement && el.parentElement.closest(BLOCK_SEL));
    }
    // このブロックに属するタイトル（.card-title / .chart-title、ネスト下でも可・子ブロックのものは除外）
    function ownTitle(el) {
        var titles = el.querySelectorAll('.card-title, .chart-title');
        for (var i = 0; i < titles.length; i++) {
            if (titles[i].closest(BLOCK_SEL) === el) return titles[i];
        }
        return null;
    }
    function slug(s) {
        return (s || 'card').trim().replace(/\s+/g, '-').replace(/[^\w\-]/g, '').toLowerCase().slice(0, 24) || 'card';
    }
    function loadStore() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; } }
    function saveStore(m) { try { localStorage.setItem(STORE_KEY, JSON.stringify(m)); } catch (e) {} }
    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    // スクロール量とドキュメント境界（浮遊は position:absolute でドキュメント基準に置く）
    function scrollX() { return window.pageXOffset || document.documentElement.scrollLeft || 0; }
    function scrollY() { return window.pageYOffset || document.documentElement.scrollTop || 0; }
    function pageW() { return document.documentElement.clientWidth || window.innerWidth; }
    function pageBottom() { return Math.max(document.documentElement.scrollHeight, window.innerHeight); }
    // ページが縦スクロールできるか（デスクトップは body/html overflow:hidden で不可）。
    // scrollHeight は浮遊ブロック自身で膨らむため overflow スタイルで判定する。
    function pageCanScrollY() {
        function blocked(v) { return v === 'hidden' || v === 'clip'; }
        return !(blocked(getComputedStyle(document.body).overflowY) ||
                 blocked(getComputedStyle(document.documentElement).overflowY));
    }
    // top をクランプ。スクロール可ならページ全高まで、不可ならビューポート内に収める
    // （＝レイアウト切替でブロックが画面外に取り残されて掴めなくなるのを防ぐ）。
    function clampTop(top, h) {
        var visible = Math.min(h, 40);
        var bound = pageCanScrollY() ? Math.max(0, pageBottom() - visible)
                                     : Math.max(0, window.innerHeight - visible);
        return clamp(top, 0, bound);
    }
    // ドラッグを開始しない要素（本物の操作系のみ）。canvas は当ダッシュボードでは
    // 表示専用（uPlot は cursor:{show:false}、他も入力ハンドラ無し）なので除外しない
    // → チャート/ビジュアライズ系カードも本体のどこからでも掴めるようにする。
    function isInteractive(t) {
        return !!(t && t.closest && t.closest('button, input, select, textarea, a, [contenteditable], [role="button"]'));
    }

    // left/top はドキュメント基準座標（ページスクロールに追従させるため position:absolute）
    function floatCard(c, left, top, width, height) {
        if (c.el.classList.contains('floating')) return;
        var s = c.el.style;
        s.width = width + 'px';
        s.height = height + 'px';
        s.position = 'absolute';
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
        // ドキュメント基準座標で保存（復元後もスクロール位置に依存しない）
        s[c.id] = { left: Math.round(r.left + scrollX()), top: Math.round(r.top + scrollY()), width: Math.round(r.width), height: Math.round(r.height) };
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
                floatCard(c, r.left + scrollX(), r.top + scrollY(), r.width, r.height);
                c.el.classList.add('dragging');
                dragging = true;
                hideGrip();                                // ドラッグ中はグリップ非表示
            }
            if (!dragging) return;
            // ポインタはビューポート座標。表示内に収まるようクランプしてからスクロール量を足し、
            // ドキュメント基準の absolute 座標にする（ドロップ後はスクロールに追従する）。
            var w = c.el.offsetWidth, h = c.el.offsetHeight;
            var vpLeft = clamp(e.clientX - grabX, 0, Math.max(0, window.innerWidth - w));
            var vpTop = clamp(e.clientY - grabY, 0, Math.max(0, window.innerHeight - Math.min(h, 40)));
            c.el.style.left = (vpLeft + scrollX()) + 'px';
            c.el.style.top = (vpTop + scrollY()) + 'px';
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
            if (inCorner(e, c.el)) return;                 // コーナー24px域はリサイズが受け持つ
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

    /* ================================================================
     *  リサイズ（計画: docs/plan-block-resize-2026-07-11.md）
     * ================================================================ */
    var GRIP = 20;             // グリップ実寸(px)
    var CORNER = 24;           // コーナー直接開始の判定域(px、タッチ発見可能性のため)
    var MAX_W = 1600, MAX_H = 1200;
    var grip = null;           // 単一オーバーレイ
    var gripTarget = null;     // グリップが指しているカード record
    var resizing = null;       // { c, startW, startH, startX, startY, vpTop, vpLeft, activeId }

    // 種別ごとの最小サイズ(§3.2 v2: racing バーは実測 min-content と CSS min-height に整合)
    function minSize(el) {
        if (el.classList.contains('racing-top-bar')) return { w: 670, h: 112 };
        if (el.classList.contains('chart-wrapper')) return { w: 180, h: 110 };
        return { w: 140, h: 90 };
    }
    function findCard(el) {
        for (var i = 0; i < cards.length; i++) if (cards[i].el === el) return cards[i];
        return null;
    }
    function blockFromEvent(e) {
        var el = e.target && e.target.closest ? e.target.closest(BLOCK_SEL) : null;
        return (el && isTopLevelBlock(el)) ? findCard(el) : null;
    }
    function inCorner(e, el) {
        var r = el.getBoundingClientRect();
        return (r.right - e.clientX) <= CORNER && (r.bottom - e.clientY) <= CORNER &&
               e.clientX <= r.right && e.clientY <= r.bottom;
    }
    function ensureGrip() {
        if (grip) return grip;
        grip = document.createElement('div');
        grip.id = 'gt7-resize-grip';
        grip.title = 'ドラッグでサイズ変更';
        grip.addEventListener('pointerdown', function (e) {
            if (e.button !== 0 || !gripTarget) return;
            startResize(gripTarget, e);
            e.preventDefault();
            e.stopPropagation();
        });
        // グリップ上のダブルクリックはリセットに化けない(§7-7)
        grip.addEventListener('dblclick', function (e) { e.stopPropagation(); });
        document.body.appendChild(grip);
        return grip;
    }
    function placeGrip(c) {
        ensureGrip();
        gripTarget = c;
        var r = c.el.getBoundingClientRect();
        grip.style.left = (r.right - GRIP + scrollX()) + 'px';
        grip.style.top = (r.bottom - GRIP + scrollY()) + 'px';
        grip.style.display = 'block';
    }
    function hideGrip() { if (grip) grip.style.display = 'none'; gripTarget = null; }

    // ホバー中ブロックの右下へグリップを追従(浮遊/グリッド内どちらでも)
    document.addEventListener('pointerover', function (e) {
        if (resizing) return;
        if (grip && (e.target === grip || grip.contains(e.target))) return;
        var c = blockFromEvent(e);
        if (c) placeGrip(c);
        else if (!(e.target && e.target.closest && e.target.closest('#gt7-resize-grip'))) hideGrip();
    });

    function startResize(c, e) {
        // グリッド内ブロックはその場の座標・サイズで浮遊してからリサイズ(ドラッグと同じ規約)
        var r = c.el.getBoundingClientRect();
        if (!c.el.classList.contains('floating')) {
            floatCard(c, r.left + scrollX(), r.top + scrollY(), r.width, r.height);
        }
        c.el.style.zIndex = String(++zTop);
        resizing = {
            c: c, activeId: e.pointerId,
            startW: r.width, startH: r.height,
            startX: e.clientX, startY: e.clientY,
            vpTop: r.top, vpLeft: r.left
        };
        document.body.classList.add('gt7-resizing');
        document.addEventListener('pointermove', onResizeMove, true);
        document.addEventListener('pointerup', onResizeUp, true);
        document.addEventListener('pointercancel', onResizeUp, true);
        window.addEventListener('blur', onResizeUp);
    }
    function onResizeMove(e) {
        var rz = resizing;
        if (!rz || e.pointerId !== rz.activeId) return;
        if (e.buttons === 0) { onResizeUp(e); return; }
        var mn = minSize(rz.c.el);
        // 最大: ドキュメント右端/下端(スクロール不可時はビューポート)を超えない(§7-5)
        var maxW = Math.max(mn.w, Math.min(MAX_W, pageW() - rz.vpLeft));
        var maxH = Math.max(mn.h, Math.min(MAX_H,
            (pageCanScrollY() ? MAX_H : window.innerHeight - rz.vpTop)));
        var w = clamp(rz.startW + (e.clientX - rz.startX), mn.w, maxW);
        var h = clamp(rz.startH + (e.clientY - rz.startY), mn.h, maxH);
        rz.c.el.style.width = w + 'px';
        rz.c.el.style.height = h + 'px';
        placeGrip(rz.c);
        e.preventDefault();
    }
    function onResizeUp(e) {
        var rz = resizing;
        if (!rz || (e && e.pointerId != null && e.pointerId !== rz.activeId)) return;
        document.removeEventListener('pointermove', onResizeMove, true);
        document.removeEventListener('pointerup', onResizeUp, true);
        document.removeEventListener('pointercancel', onResizeUp, true);
        window.removeEventListener('blur', onResizeUp);
        document.body.classList.remove('gt7-resizing');
        resizing = null;
        persist(rz.c);
        placeGrip(rz.c);
    }

    function resetAll() {
        cards.slice().sort(function (a, b) { return a.orig.index - b.orig.index; }).forEach(unfloat);
        saveStore({});
        hideGrip();
    }
    // メニュー(menu.js)などから配置リセットを呼べるように公開
    window.gt7ResetLayout = resetAll;

    function addResetButton() {
        var header = document.querySelector('.header');
        if (!header || document.getElementById('layout-reset-btn')) return;
        var btn = document.createElement('button');
        btn.id = 'layout-reset-btn';
        btn.type = 'button';
        btn.className = 'test-mode-btn layout-reset-btn';
        btn.textContent = '↻ 配置';
        btn.title = 'ブロック配置を初期化。ブロック(カード/チャート)をドラッグで移動 / ダブルクリックで個別リセット';
        btn.addEventListener('click', resetAll);
        var status = document.getElementById('connection-status');
        // connection-status は .header 直下でなく .header-row 内なので親基準で挿入する
        if (status && status.parentNode) status.parentNode.insertBefore(btn, status);
        else header.appendChild(btn);
    }

    function restoreSaved() {
        var store = loadStore();
        cards.forEach(function (c) {
            var s = store[c.id];
            if (!s) return;
            var mn = minSize(c.el);
            var w = s.width || c.el.getBoundingClientRect().width;
            var h = s.height || c.el.getBoundingClientRect().height;
            // 保存サイズも復元時にクランプ(広い画面で保存→狭い画面でグリップが画面外に
            // 出て縮小不能になるのを防ぐ。§7-5)
            w = clamp(w, mn.w, Math.max(mn.w, Math.min(MAX_W, pageW())));
            if (!pageCanScrollY()) h = clamp(h, mn.h, Math.max(mn.h, window.innerHeight));
            // ドキュメント基準でクランプ（左は表示幅、上はスクロール可否に応じて）
            var left = clamp(s.left, 0, Math.max(0, pageW() - w));
            var top = clampTop(s.top, h);
            floatCard(c, left, top, w, h);
        });
    }

    function onResize() {
        cards.forEach(function (c) {
            if (!c.el.classList.contains('floating')) return;
            var mn = minSize(c.el);
            var w = c.el.offsetWidth, h = c.el.offsetHeight;
            // ウィンドウ縮小でブロックが画面より大きく残らないよう再クランプ(§7-5)
            if (w > pageW()) { w = Math.max(mn.w, pageW()); c.el.style.width = w + 'px'; }
            if (!pageCanScrollY() && h > window.innerHeight) {
                h = Math.max(mn.h, window.innerHeight); c.el.style.height = h + 'px';
            }
            c.el.style.left = clamp(parseFloat(c.el.style.left) || 0, 0, Math.max(0, pageW() - w)) + 'px';
            c.el.style.top = clampTop(parseFloat(c.el.style.top) || 0, h) + 'px';
        });
    }

    function initCornerResize() {
        document.addEventListener('pointerdown', function (e) {
            if (e.button !== 0 || resizing) return;
            if (grip && (e.target === grip || grip.contains(e.target))) return;  // グリップ自身は専用ハンドラ
            var c = blockFromEvent(e);
            if (!c || !inCorner(e, c.el) || isInteractive(e.target)) return;
            startResize(c, e);
            e.preventDefault();
            e.stopPropagation();   // capture 段でカードのドラッグ開始を抑止
        }, true);
    }

    function init() {
        var all = Array.prototype.slice.call(document.querySelectorAll(BLOCK_SEL)).filter(isTopLevelBlock);
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
        initCornerResize();
        restoreSaved();
        window.addEventListener('resize', onResize);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
