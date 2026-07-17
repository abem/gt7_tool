#!/usr/bin/env python3
"""浮遊カードのモード漏出スモーク (#157)。

背景: card-drag.js の floatCard() は浮遊時に要素を body 直下へ再親化するため、
祖先の display:none に依存するカードはモードを跨いで漏出していた(#157調査)。
是正: styles.css の REVIEW 版汎用ルール + #rm-review-card の id 直接ルール。

検証:
 A. 代表カードを浮遊化した状態で全モードを巡回し、各要素の描画有無が
    「非浮遊時の正解表示」と全数一致すること(新規リーク0件の機械検査)。
    代表: FUEL(左パネル系)/SPEEDチャート/TYRES(中央系)/DELTA(右パネル系)/
          rm-review-card/rm-strategy-card(①直接ルール系)
 B. 既知実害の解消を実クリックで確認:
    - rm-review-card 浮遊状態の ANALYSIS で DRIVE/REVIEW タブと ALIGN が押せる
    - 実再生中(バー表示)に EXIT が押せる
 C. REVIEW 内では浮遊 rm-review-card が表示のまま(除外設計の確認)

usage: python3 float_leak_smoke.py [base_url]
"""
import asyncio
import json
import sys

from playwright.async_api import async_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8090"
LAP = "2026-07-16_03_48_43_CAR-3343_Lap-14.json"
EXPECTED_ERR = ("WebSocket", "ws://", "wss://", "/ws", "course_database", "telemetry",
                "favicon", "Failed to load resource", "ERR_CONNECTION")

# 代表要素(マーカー→セレクタ)と、各モードでの正解表示(非浮遊時の設計)
REPS = {
    "fuel": ".fuel-card",
    "speed_chart": ".charts-container .chart-wrapper",   # 先頭=SPEED
    "tyres": ".tyres-card",
    "delta": ".delta-card",
    "review_card": "#rm-review-card",
    "strategy": "#rm-strategy-card",
}
# 正解表示マトリクス: mode -> {rep: visible?}
TRUTH = {
    "analysis": {"fuel": True, "speed_chart": True, "tyres": True, "delta": True,
                 "review_card": False, "strategy": True},
    "drive":    {"fuel": False, "speed_chart": False, "tyres": False, "delta": False,
                 "review_card": False, "strategy": False},
    "review":   {"fuel": False, "speed_chart": False, "tyres": False, "delta": False,
                 "review_card": True, "strategy": False},
    "replay":   {"fuel": True, "speed_chart": True, "tyres": True, "delta": True,
                 "review_card": False, "strategy": True},
}

MARK = """(sels) => {
  for (const [k, sel] of Object.entries(sels)) {
    const el = document.querySelector(sel);
    if (el) el.dataset.fls = k;
  }
  return Object.keys(sels).filter(k => !document.querySelector(`[data-fls="${k}"]`));
}"""

SNAP = """() => {
  const out = {};
  for (const el of document.querySelectorAll('[data-fls]')) {
    out[el.dataset.fls] = el.getClientRects().length > 0;
  }
  return out;
}"""


async def rect(pg, sel):
    return await pg.evaluate(f"""() => {{
        const r = document.querySelector('{sel}').getBoundingClientRect();
        return {{l: r.left, t: r.top, w: r.width, h: r.height}}; }}""")


async def float_el(pg, sel, dx, dy):
    r = await rect(pg, sel)
    x, y = r["l"] + 30, r["t"] + 8
    await pg.mouse.move(x, y)
    await pg.mouse.down()
    await pg.mouse.move(x + dx, y + dy, steps=6)
    await pg.mouse.up()
    await pg.wait_for_timeout(250)
    return await pg.evaluate(f"""() => document.querySelector('{sel}')
        .classList.contains('floating')""")


async def clickable(pg, sel):
    """要素の中心が実際にヒットし、クリックが到達するか(3秒で判定)"""
    try:
        await pg.click(sel, timeout=3000)
        return True
    except Exception:
        return False


async def main():
    perr, cerr, checks, detail = [], [], {}, {}
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        pg = await b.new_page(viewport={"width": 1920, "height": 1080})
        pg.on("pageerror", lambda e: perr.append(str(e)))
        pg.on("console", lambda m: cerr.append(m.text) if m.type == "error" else None)
        await pg.goto(URL, wait_until="networkidle")
        await pg.wait_for_timeout(1000)
        await pg.evaluate("() => localStorage.clear()")
        await pg.reload(wait_until="networkidle")
        await pg.wait_for_timeout(1000)
        missing = await pg.evaluate(MARK, REPS)
        checks["all_reps_found"] = (missing == [])

        # ---- 浮遊化: ANALYSIS側5枚(重なりを避けて分散配置) ----
        floats_ok = []
        floats_ok.append(await float_el(pg, ".fuel-card", 500, -60))
        floats_ok.append(await float_el(pg, '[data-fls="speed_chart"]', 300, 260))
        floats_ok.append(await float_el(pg, ".tyres-card", -200, -300))
        floats_ok.append(await float_el(pg, ".delta-card", -600, 200))
        floats_ok.append(await float_el(pg, "#rm-strategy-card", 200, -400))
        # REVIEWでrm-review-cardを浮遊化
        await pg.click("#tb-view-review")
        await pg.wait_for_timeout(4000)
        floats_ok.append(await float_el(pg, "#rm-review-card", 120, -80))
        checks["all_floated"] = all(floats_ok)

        # ---- C. REVIEW内では浮遊rm-review-cardは表示のまま(除外設計) ----
        snap_rv = await pg.evaluate(SNAP)
        checks["review_card_visible_in_review_while_floating"] = snap_rv.get("review_card") is True

        # ---- A. 全モード巡回×全数突合(#135経路: 往復含む) ----
        leaks = []

        async def audit(mode_key, tag):
            snap = await pg.evaluate(SNAP)
            for k, expect in TRUTH[mode_key].items():
                if snap.get(k) != expect:
                    leaks.append({"at": tag, "rep": k, "expect": expect, "got": snap.get(k)})

        await audit("review", "review_floated")
        await pg.click("#tb-view-analysis")
        await pg.wait_for_timeout(700)
        await audit("analysis", "analysis")
        await pg.click("#tb-view-drive")
        await pg.wait_for_timeout(700)
        await audit("drive", "drive")
        await pg.click("#tb-view-analysis")
        await pg.wait_for_timeout(700)
        await audit("analysis", "analysis_roundtrip")

        # ---- B1. 既知実害: ANALYSIS(浮遊review card持ち)でタブ・ALIGNが押せる ----
        checks["align_clickable_in_analysis"] = await clickable(pg, "#tb-layout")
        # ALIGNを押してしまったので再浮遊(検証続行のため)
        await pg.click("#tb-view-review")
        await pg.wait_for_timeout(3500)
        await float_el(pg, "#rm-review-card", 120, -80)
        await pg.click("#tb-view-analysis")
        await pg.wait_for_timeout(600)
        checks["drive_tab_clickable_in_analysis"] = await clickable(pg, "#tb-view-drive")
        await pg.wait_for_timeout(500)
        await pg.click("#tb-view-analysis")
        await pg.wait_for_timeout(500)
        checks["review_tab_clickable_in_analysis"] = await clickable(pg, "#tb-view-review")
        await pg.wait_for_timeout(3500)

        # ---- B2. 実再生: 全浮遊状態でもEXITが押せる+再生中の漏出なし ----
        await pg.click(f'.review-lap-item[data-file="{LAP}"] .review-lap-play')
        await pg.wait_for_timeout(4500)
        await audit("replay", "replay_real")
        checks["exit_clickable_in_replay"] = await clickable(pg, "#replay-btn-exit")
        await pg.wait_for_timeout(700)
        await audit("review", "after_exit")

        checks["no_leaks_anywhere"] = (len(leaks) == 0)
        detail["leaks"] = leaks[:10]

        await pg.evaluate("() => window.gt7ResetLayout()")
        await pg.wait_for_timeout(400)
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
