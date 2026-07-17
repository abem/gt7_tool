#!/usr/bin/env python3
"""カード表示グループ管理スモーク (#151)。

検証(計画書§7・采指定3点):
 A. 組合せ: 全表示/全非表示/各グループ単独非表示(6)/単独表示(6)/擬似ランダム10
    — プロパティ「store値 ⇔ 全カードのcg-hidden状態 ⇔ 実可視性」+リロード永続性
 B. UI経路: CARDSボタン→パネル→チェック操作で即時反映+保存+リロード保持+SHOW ALL
 C. ドラッグ位置相互作用: 浮遊+リサイズ済みカードのグループ非表示→再表示±4px、
    非表示中リロード後の復元、ALIGNリセットとグループ状態の独立性
 D. 操作経路(#135教訓): DRIVE往復/REVIEW往復/再生開始・EXIT/TEST MODE中切替/
    同一ビュー再クリック
 E. 幾何(#136教訓): 各グループ単独非表示×3幅(1920/1366/1066)で横オーバーフロー無し
    +視覚証跡PNG(--shots DIR 指定時に保存)

usage: python3 cardgroups_smoke.py [base_url] [--shots DIR]
"""
import asyncio
import json
import random
import sys

from playwright.async_api import async_playwright

URL = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "http://127.0.0.1:8090"
SHOTS = None
if "--shots" in sys.argv:
    SHOTS = sys.argv[sys.argv.index("--shots") + 1]
EXPECTED_ERR = ("WebSocket", "ws://", "wss://", "/ws", "course_database", "telemetry",
                "favicon", "Failed to load resource", "ERR_CONNECTION")
STORE = "gt7-card-groups-v1"
GROUPS = ["g1", "g2", "g3", "g4", "g5", "g6"]
EXPECT_COUNT = {"g1": 4, "g2": 3, "g3": 3, "g4": 5, "g5": 8, "g6": 2}
REPLAY_FILE = "2026-07-16_03_48_43_CAR-3343_Lap-14.json"

PROP_JS = """() => {
  const out = {};
  for (const g of ['g1','g2','g3','g4','g5','g6']) {
    const els = Array.from(document.querySelectorAll(`[data-cardgroup="${g}"]`));
    out[g] = { count: els.length,
               hiddenCls: els.filter(e => e.classList.contains('cg-hidden')).length,
               visible: els.filter(e => e.getClientRects().length > 0).length };
  }
  return out;
}"""


async def set_state(pg, state):
    await pg.evaluate(f"(s) => localStorage.setItem('{STORE}', JSON.stringify(s))", state)
    await pg.reload(wait_until="networkidle")
    await pg.wait_for_timeout(600)


async def prop_check(pg, state, in_analysis=True):
    """プロパティ: 非表示グループは hiddenCls=count かつ visible=0、
       表示グループは hiddenCls=0 (可視数はモード依存のためANALYSIS時のみ>0を要求)"""
    snap = await pg.evaluate(PROP_JS)
    for g in GROUPS:
        vis = state.get(g, True)
        if snap[g]["count"] != EXPECT_COUNT[g]:
            return False, f"{g} count {snap[g]['count']}"
        if not vis:
            if snap[g]["hiddenCls"] != snap[g]["count"] or snap[g]["visible"] != 0:
                return False, f"{g} hide mismatch {snap[g]}"
        else:
            if snap[g]["hiddenCls"] != 0:
                return False, f"{g} stray cg-hidden {snap[g]}"
            if in_analysis and snap[g]["visible"] == 0:
                return False, f"{g} should be visible {snap[g]}"
    return True, None


async def rect(pg, cid):
    return await pg.evaluate(f"""() => {{
        const el = document.getElementById('{cid}');
        const r = el.getBoundingClientRect();
        return {{left: Math.round(r.left), top: Math.round(r.top),
                 w: Math.round(r.width), h: Math.round(r.height)}}; }}""")


def near(a, b, tol=4):
    return abs(a - b) <= tol


async def no_h_overflow(pg):
    return await pg.evaluate(
        "() => document.documentElement.scrollWidth <= window.innerWidth + 1")


async def main():
    perr, cerr, checks, detail = [], [], {}, {}
    rng = random.Random(151)  # 再現可能な擬似ランダム
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        # 明示コンテキスト(タブ間同期検査で同一コンテキストに2ページ目を開くため)
        ctx = await b.new_context(viewport={"width": 1920, "height": 1080})
        pg = await ctx.new_page()
        pg.on("pageerror", lambda e: perr.append(str(e)))
        pg.on("console", lambda m: cerr.append(m.text) if m.type == "error" else None)
        await pg.goto(URL, wait_until="networkidle")
        await pg.wait_for_timeout(800)
        await pg.evaluate("() => localStorage.clear()")
        await pg.reload(wait_until="networkidle")
        await pg.wait_for_timeout(800)

        # ---- A. 組合せ(store直接設定=ロード経路) ----
        combos = [({}, "all_visible"), ({g: False for g in GROUPS}, "all_hidden")]
        combos += [({g: (g != h) for g in GROUPS}, f"only_{h}_hidden") for h in GROUPS]
        combos += [({g: (g == v) for g in GROUPS}, f"only_{v}_visible") for v in GROUPS]
        for i in range(10):
            combos.append(({g: rng.random() < 0.5 for g in GROUPS}, f"random_{i}"))
        failed = []
        for state, name in combos:
            await set_state(pg, state)
            ok, why = await prop_check(pg, state)
            if not ok:
                failed.append((name, why))
                continue
            # リロード永続性(set_stateが既にリロード済み→もう一度リロードして不変)
            await pg.reload(wait_until="networkidle")
            await pg.wait_for_timeout(500)
            ok2, why2 = await prop_check(pg, state)
            if not ok2:
                failed.append((name + "_reload", why2))
        checks["combinations_all_pass"] = (len(failed) == 0)
        detail["combinations"] = {"total": len(combos), "failed": failed[:5]}

        # ---- B. UI経路 ----
        await set_state(pg, {})
        await pg.click("#cg-toolbar-btn")
        await pg.wait_for_timeout(300)
        panel_open = await pg.evaluate(
            "() => document.getElementById('cg-panel').classList.contains('cg-open')")
        counts = await pg.evaluate("""() => Array.from(
            document.querySelectorAll('#cg-panel .cg-count')).map(e => e.textContent)""")
        checks["ui_panel_opens"] = panel_open
        checks["ui_counts_correct"] = (counts == [str(EXPECT_COUNT[g]) for g in GROUPS])
        await pg.click('#cg-panel input[data-cg-group="g4"]')
        await pg.wait_for_timeout(300)
        ok, why = await prop_check(pg, {"g4": False})
        store_now = await pg.evaluate(f"() => JSON.parse(localStorage.getItem('{STORE}'))")
        checks["ui_toggle_applies_immediately"] = ok and store_now.get("g4") is False
        await pg.reload(wait_until="networkidle")
        await pg.wait_for_timeout(600)
        ok, why = await prop_check(pg, {"g4": False})
        checks["ui_toggle_survives_reload"] = ok
        await pg.click("#cg-toolbar-btn")
        await pg.wait_for_timeout(200)
        await pg.click("#cg-panel .cg-show-all")
        await pg.wait_for_timeout(300)
        ok, why = await prop_check(pg, {})
        checks["ui_show_all"] = ok
        # #153改善②: SHOW ALL後はパネルが自動で閉じる(それ自体が視覚フィードバック)
        checks["ui_show_all_closes_panel"] = await pg.evaluate(
            "() => !document.getElementById('cg-panel').classList.contains('cg-open')")
        detail["ui"] = {"counts": counts}

        # ---- B2. #153堅牢性改善 ----
        # (b2-1) タブ間同期: 同一コンテキストの別ページで変更→storageイベントで自動追随
        pg2 = await ctx.new_page()
        await pg2.goto(URL, wait_until="networkidle")
        await pg2.wait_for_timeout(800)
        await pg2.evaluate(f"""() => {{
            const s = {{g1: false, g2: true, g3: true, g4: true, g5: true, g6: true}};
            localStorage.setItem('{STORE}', JSON.stringify(s)); }}""")
        # localStorage直書きはstorageイベントを発火しないため、UI経路(チェック操作)で書かせる
        await pg2.evaluate(f"() => localStorage.setItem('{STORE}', JSON.stringify({{}}))")
        await pg2.click("#cg-toolbar-btn")
        await pg2.wait_for_timeout(300)
        await pg2.click('#cg-panel input[data-cg-group="g1"]')   # pg2でg1を非表示に
        await pg2.wait_for_timeout(600)
        ok_sync, why_sync = await prop_check(pg, {"g1": False})  # pg側が自動追随したか
        sync_checks = await pg.evaluate("""() => {
            const b = document.querySelector('#cg-panel input[data-cg-group="g1"]');
            return b ? b.checked : null; }""")
        checks["tab_sync_applies"] = ok_sync and sync_checks is False
        await pg2.click('#cg-panel input[data-cg-group="g1"]')   # 戻す
        await pg2.wait_for_timeout(600)
        ok_sync2, _ = await prop_check(pg, {})
        checks["tab_sync_restores"] = ok_sync2
        await pg2.close()
        # (b2-2) 保存失敗模擬: setItemを例外化→チェック操作→トースト出現+表示は反映継続
        await pg.evaluate("""() => { window.__origSetItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function () { throw new DOMException('QuotaExceededError'); }; }""")
        await pg.click("#cg-toolbar-btn")
        await pg.wait_for_timeout(200)
        await pg.click('#cg-panel input[data-cg-group="g6"]')
        await pg.wait_for_timeout(400)
        warn_shown = await pg.evaluate("() => !!document.getElementById('cg-save-warn')")
        ok_applied, _ = await prop_check(pg, {"g6": False})
        await pg.evaluate("() => { Storage.prototype.setItem = window.__origSetItem; }")
        await pg.click('#cg-panel input[data-cg-group="g6"]')    # 戻す(保存も復旧)
        await pg.wait_for_timeout(300)
        checks["save_fail_toast_and_apply"] = warn_shown and ok_applied
        # (b2-3) touch-action付与の計算値
        ta = await pg.evaluate("""() => ({
            btn: getComputedStyle(document.getElementById('cg-toolbar-btn')).touchAction,
            row: getComputedStyle(document.querySelector('.cg-row')).touchAction,
            sa: getComputedStyle(document.querySelector('.cg-show-all')).touchAction })""")
        checks["touch_action_set"] = all(v == "manipulation" for v in ta.values())
        detail["robustness"] = {"touch_action": ta}
        await pg.evaluate("() => { const p=document.getElementById('cg-panel'); if(p) p.classList.remove('cg-open'); }")

        # ---- C. ドラッグ位置相互作用(g3のSTRATEGYカードを浮遊+リサイズ) ----
        await pg.evaluate("() => localStorage.clear()")
        await pg.reload(wait_until="networkidle")
        await pg.wait_for_timeout(600)
        r0 = await rect(pg, "rm-strategy-card")
        x, y = r0["left"] + 30, r0["top"] + 8
        await pg.mouse.move(x, y)
        await pg.mouse.down()
        await pg.mouse.move(x + 120, y - 300, steps=8)
        await pg.mouse.up()
        await pg.wait_for_timeout(250)
        placed = await rect(pg, "rm-strategy-card")
        # 非表示→再表示
        await pg.evaluate(f"() => localStorage.setItem('{STORE}', JSON.stringify({{g3:false}}))")
        await pg.evaluate("() => window.dispatchEvent(new Event('storage'))")
        await pg.reload(wait_until="networkidle")
        await pg.wait_for_timeout(600)
        hidden_ok, _ = await prop_check(pg, {"g3": False})
        await pg.click("#cg-toolbar-btn")
        await pg.wait_for_timeout(200)
        await pg.click('#cg-panel input[data-cg-group="g3"]')
        await pg.wait_for_timeout(300)
        reshown = await rect(pg, "rm-strategy-card")
        checks["drag_pos_kept_after_hide_reshow"] = (
            hidden_ok and near(reshown["left"], placed["left"])
            and near(reshown["top"], placed["top"]) and near(reshown["h"], placed["h"]))
        detail["drag_interaction"] = {"placed": placed, "reshown": reshown}
        # ALIGN独立性: g6非表示のままALIGN→g6は非表示のまま・グループstore不変
        await pg.evaluate(f"() => localStorage.setItem('{STORE}', JSON.stringify({{g6:false}}))")
        await pg.reload(wait_until="networkidle")
        await pg.wait_for_timeout(600)
        await pg.evaluate("() => window.gt7ResetLayout()")
        await pg.wait_for_timeout(400)
        ok_align, _ = await prop_check(pg, {"g6": False})
        store_after = await pg.evaluate(f"() => JSON.parse(localStorage.getItem('{STORE}'))")
        checks["align_reset_independent"] = ok_align and store_after.get("g6") is False

        # ---- D. 操作経路(#135教訓) g4非表示のままモード横断 ----
        await pg.evaluate(f"() => localStorage.setItem('{STORE}', JSON.stringify({{g4:false}}))")
        await pg.reload(wait_until="networkidle")
        await pg.wait_for_timeout(600)
        # DRIVE往復+同一ビュー再クリック
        await pg.click("#tb-view-drive")
        await pg.wait_for_timeout(600)
        g4_drive = await pg.evaluate(PROP_JS)
        await pg.click("#tb-view-analysis")
        await pg.wait_for_timeout(600)
        await pg.click("#tb-view-analysis")   # 同一ビュー再クリック(#135経路)
        await pg.wait_for_timeout(400)
        ok_drive, _ = await prop_check(pg, {"g4": False})
        checks["mode_drive_roundtrip"] = ok_drive and g4_drive["g4"]["visible"] == 0
        # TEST MODE中の切替
        await pg.click("#tb-test")
        await pg.wait_for_timeout(1200)
        await pg.click("#cg-toolbar-btn")
        await pg.wait_for_timeout(200)
        await pg.click('#cg-panel input[data-cg-group="g1"]')
        await pg.wait_for_timeout(400)
        ok_test, _ = await prop_check(pg, {"g1": False, "g4": False})
        await pg.click('#cg-panel input[data-cg-group="g1"]')  # 戻す
        await pg.wait_for_timeout(300)
        await pg.click("#tb-test")
        await pg.wait_for_timeout(800)
        checks["testmode_toggle"] = ok_test
        # REVIEW往復+再生開始/EXIT(対象外カードが正しく出ること)
        await pg.click("#tb-view-review")
        await pg.wait_for_timeout(3500)
        rv = await pg.evaluate(
            "() => document.getElementById('rm-review-card').getClientRects().length > 0")
        await pg.click(f'.review-lap-item[data-file="{REPLAY_FILE}"] .review-lap-play')
        await pg.wait_for_timeout(4000)
        rp = await pg.evaluate(
            "() => document.getElementById('rm-replay-card').getClientRects().length > 0")
        g4_replay = await pg.evaluate(PROP_JS)
        await pg.click("#replay-btn-exit")
        await pg.wait_for_timeout(600)
        # EXITは元のビュー(REVIEW)へ戻る仕様のため、まずビュー非依存でクラス状態を検査し、
        # その後ANALYSISへ戻して可視性込みで検査する
        ok_after_exit, _ = await prop_check(pg, {"g4": False}, in_analysis=False)
        await pg.click("#tb-view-analysis")
        await pg.wait_for_timeout(600)
        ok_back_analysis, _ = await prop_check(pg, {"g4": False})
        checks["review_replay_paths"] = (rv and rp and g4_replay["g4"]["visible"] == 0
                                         and ok_after_exit and ok_back_analysis)

        # ---- E. 幾何(#136教訓): 各グループ単独非表示×3幅 ----
        geo_fail = []
        for width in (1920, 1366, 1066):
            await pg.set_viewport_size({"width": width, "height": 1080})
            for h in GROUPS:
                await set_state(pg, {g: (g != h) for g in GROUPS})
                if not await no_h_overflow(pg):
                    geo_fail.append(f"{width}px_{h}")
                if SHOTS:
                    await pg.screenshot(path=f"{SHOTS}/cg_{width}_{h}_hidden.png")
        checks["geometry_no_overflow_all"] = (len(geo_fail) == 0)
        detail["geometry_failures"] = geo_fail
        await pg.set_viewport_size({"width": 1920, "height": 1080})
        await pg.evaluate("() => localStorage.clear()")

        await b.close()

    unexpected = [e for e in cerr if not any(x in e for x in EXPECTED_ERR)]
    out = {"checks": checks, "detail": detail, "pageerrors": perr,
           "unexpected_console_errors": unexpected,
           "verdict": "PASS" if (all(checks.values()) and not perr and not unexpected) else "FAIL"}
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0 if out["verdict"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
