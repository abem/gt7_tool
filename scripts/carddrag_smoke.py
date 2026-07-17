#!/usr/bin/env python3
"""card-drag スモーク (#148): race-metrics 3カードのドラッグ・リサイズ・リロード復元。

対象: #rm-strategy-card(ANALYSISライブ) / #rm-review-card(REVIEW) / #rm-replay-card(再生)
検証: 各カードで (a)移動で位置が変わる (b)リサイズでサイズが変わる
      (c)localStorage 'gt7-card-layout-v1' に保存される (d)リロード後に位置・サイズ復元。
付帯: card-drag.js と同一規則(#150: id優先、id無しはslug+同一slug内連番)で
      キー一覧を再現し、全キーが一意であること(誤復元の前提条件)を検査。

usage: python3 carddrag_smoke.py [base_url] [replay_file]
"""
import asyncio
import json
import sys

from playwright.async_api import async_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8090"
REPLAY_FILE = sys.argv[2] if len(sys.argv) > 2 else "2026-07-16_03_48_43_CAR-3343_Lap-14.json"
EXPECTED_ERR = ("WebSocket", "ws://", "wss://", "/ws", "course_database", "telemetry",
                "favicon", "Failed to load resource", "ERR_CONNECTION")
STORE_KEY = "gt7-card-layout-v1"
TOL = 4  # 復元座標の許容誤差(px)

# card-drag.js の init() と同一規則のキー列挙(検査用の読み取り専用再現)
KEYS_JS = """() => {
  const BLOCK_SEL = '.card, .chart-wrapper, .racing-top-bar';
  const isTop = el => { let p = el.parentElement;
    while (p && p !== document.body) { if (p.matches && p.matches(BLOCK_SEL)) return false; p = p.parentElement; }
    return true; };
  const ownTitle = el => { const ts = el.querySelectorAll('.card-title, .chart-title');
    for (const t of ts) if (t.closest(BLOCK_SEL) === el) return t; return null; };
  const slug = s => (s || 'card').trim().replace(/\\s+/g, '-').replace(/[^\\w\\-]/g, '')
                    .toLowerCase().slice(0, 24) || 'card';
  const all = Array.from(document.querySelectorAll(BLOCK_SEL)).filter(isTop);
  const seq = {};
  return all.map((el) => {
    let key;
    if (el.id) { key = el.id; }
    else {
      const t = ownTitle(el);
      // 実行時はinitが付けた draggable-card 等が付与済みのため、キー再現時は除去して初期状態に合わせる
      const cls = el.className.replace(/\\s*(draggable-card|card-drag-handle|floating)\\s*/g, ' ').trim();
      const s = slug(t ? t.textContent : (cls || 'card'));
      seq[s] = (seq[s] || 0) + 1;
      key = s + '#' + (seq[s] - 1);
    }
    return { key, id: el.id || null, cls: el.className };
  });
}"""


async def rect(pg, cid):
    return await pg.evaluate(f"""() => {{
        const r = document.getElementById('{cid}').getBoundingClientRect();
        return {{left: Math.round(r.left), top: Math.round(r.top),
                 w: Math.round(r.width), h: Math.round(r.height)}}; }}""")


async def drag_move(pg, cid, dx, dy):
    r = await rect(pg, cid)
    x, y = r["left"] + 30, r["top"] + 8
    await pg.mouse.move(x, y)
    await pg.mouse.down()
    await pg.mouse.move(x + dx, y + dy, steps=8)
    await pg.mouse.up()
    await pg.wait_for_timeout(250)


async def drag_resize(pg, cid, dw, dh):
    r = await rect(pg, cid)
    # カード上にホバー → 右下に単一オーバーレイ #gt7-resize-grip が追従表示される
    await pg.mouse.move(r["left"] + r["w"] / 2, r["top"] + r["h"] / 2)
    await pg.wait_for_timeout(200)
    g = await pg.evaluate("""() => {
        const g = document.getElementById('gt7-resize-grip');
        if (!g || g.style.display === 'none') return null;
        const r = g.getBoundingClientRect();
        return {x: r.x + r.width / 2, y: r.y + r.height / 2}; }""")
    if not g:
        return False
    await pg.mouse.move(g["x"], g["y"])
    await pg.mouse.down()
    await pg.mouse.move(g["x"] + dw, g["y"] + dh, steps=8)
    await pg.mouse.up()
    await pg.wait_for_timeout(250)
    return True


def near(a, b, tol=TOL):
    return abs(a - b) <= tol


async def exercise(pg, checks, detail, tag, cid, mv=(90, -130)):
    """1カード分: 移動→リサイズ→store確認。復元は呼び出し側でリロード後に verify_restore。
    mv: 移動量(dx, dy)。浮遊カードはbody直下へ再親化され全モードで表示され続けるため、
    後段テストの操作点(再生バー等)と重ならない移動先を指定できるようにしている。"""
    p0 = await rect(pg, cid)
    await drag_move(pg, cid, mv[0], mv[1])
    p1 = await rect(pg, cid)
    checks[f"{tag}_moved"] = (p1["left"] != p0["left"] or p1["top"] != p0["top"])
    grip_ok = await drag_resize(pg, cid, 60, 45)
    p2 = await rect(pg, cid)
    checks[f"{tag}_resized"] = grip_ok and (p2["w"] != p1["w"] or p2["h"] != p1["h"])
    store = await pg.evaluate(f"() => JSON.parse(localStorage.getItem('{STORE_KEY}') || '{{}}')")
    checks[f"{tag}_persisted"] = any(v for v in store.values() if isinstance(v, dict))
    detail[tag] = {"initial": p0, "after_move": p1, "after_resize": p2}
    return p2


async def verify_restore(pg, checks, detail, tag, cid):
    p = await rect(pg, cid)
    exp = detail[tag]["after_resize"]
    checks[f"{tag}_restored"] = (near(p["left"], exp["left"]) and near(p["top"], exp["top"])
                                 and near(p["w"], exp["w"]) and near(p["h"], exp["h"]))
    detail[tag]["restored"] = p


async def main():
    perr, cerr, checks, detail = [], [], {}, {}
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        pg = await b.new_page(viewport={"width": 1600, "height": 1000})
        pg.on("pageerror", lambda e: perr.append(str(e)))
        pg.on("console", lambda m: cerr.append(m.text) if m.type == "error" else None)
        await pg.goto(URL, wait_until="networkidle")
        await pg.wait_for_timeout(800)
        await pg.evaluate("() => localStorage.clear()")
        await pg.reload(wait_until="networkidle")
        await pg.wait_for_timeout(800)

        # --- キー一意性検査: 全ブロックのキーが互いに一意であること(誤復元の前提条件) ---
        new_keys = await pg.evaluate(KEYS_JS)
        rm_ids = {"rm-review-card", "rm-replay-card", "rm-strategy-card"}
        keys = [e["key"] for e in new_keys]
        dupes = sorted({k for k in keys if keys.count(k) > 1})
        checks["no_key_collision"] = (len(dupes) == 0)
        detail["key_audit"] = {"total_blocks": len(new_keys),
                               "rm_keys": [e["key"] for e in new_keys if (e["id"] or "") in rm_ids],
                               "duplicate_keys": dupes}

        # --- 0) STRATEGY 複数位置復元(#148差し戻し是正の検証: 上端/中央/下端) ---
        # 自然高(約39px)のまま各位置へドラッグ→リロードし、±TOL内で復元されること。
        # 下端はminSize一律90px時代に系統誤差(最大24px上方ずれ)が出た再現位置。
        vp_h = 1000
        for pos_tag, target_top in (("top", 10), ("mid", vp_h // 2), ("bottom", vp_h - 45)):
            r = await rect(pg, "rm-strategy-card")
            x, y = r["left"] + 30, r["top"] + 8
            await pg.mouse.move(x, y)
            await pg.mouse.down()
            await pg.mouse.move(x + 40, y + (target_top - r["top"]), steps=8)
            await pg.mouse.up()
            await pg.wait_for_timeout(250)
            placed = await rect(pg, "rm-strategy-card")
            await pg.reload(wait_until="networkidle")
            await pg.wait_for_timeout(800)
            restored = await rect(pg, "rm-strategy-card")
            checks[f"strategy_pos_{pos_tag}_restored"] = (
                near(restored["left"], placed["left"]) and near(restored["top"], placed["top"])
                and near(restored["h"], placed["h"]))
            detail[f"strategy_pos_{pos_tag}"] = {"placed": placed, "restored": restored}
        await pg.evaluate("() => localStorage.clear()")
        await pg.reload(wait_until="networkidle")
        await pg.wait_for_timeout(800)

        # 浮遊カードは body 直下へ再親化され全モードで表示され続けるため、セクションを
        # 跨いで蓄積すると後続セクションのホバー/クリック先を遮り検査が不安定になる。
        # 各セクションはレイアウトストア初期化+リロードで独立させる(検証対象の永続化は
        # 各セクション内のリロードで確認済み)。
        async def section_reset(pg):
            await pg.evaluate(f"() => localStorage.removeItem('{STORE_KEY}')")
            await pg.reload(wait_until="networkidle")
            await pg.wait_for_timeout(800)

        # --- 1) STRATEGY (ANALYSISライブ画面) ---
        await exercise(pg, checks, detail, "strategy", "rm-strategy-card")
        await pg.reload(wait_until="networkidle")
        await pg.wait_for_timeout(800)
        await verify_restore(pg, checks, detail, "strategy", "rm-strategy-card")
        await section_reset(pg)

        # --- 2) REVIEW カード ---
        await pg.click("#tb-view-review")
        await pg.wait_for_timeout(4500)
        await exercise(pg, checks, detail, "review", "rm-review-card")
        await pg.reload(wait_until="networkidle")
        await pg.wait_for_timeout(800)
        await pg.click("#tb-view-review")
        await pg.wait_for_timeout(4500)
        await verify_restore(pg, checks, detail, "review", "rm-review-card")
        await section_reset(pg)

        # --- 3) 再生カード(実再生で表示) ---
        await pg.click("#tb-view-review")
        await pg.wait_for_timeout(4500)
        await pg.click(f'.review-lap-item[data-file="{REPLAY_FILE}"] .review-lap-play')
        await pg.wait_for_timeout(5000)
        await exercise(pg, checks, detail, "replay", "rm-replay-card")
        await pg.reload(wait_until="networkidle")
        await pg.wait_for_timeout(800)
        await pg.click("#tb-view-review")
        await pg.wait_for_timeout(4500)
        await pg.click(f'.review-lap-item[data-file="{REPLAY_FILE}"] .review-lap-play')
        await pg.wait_for_timeout(5000)
        await verify_restore(pg, checks, detail, "replay", "rm-replay-card")
        await section_reset(pg)

        # --- 4) 再生バー(#155): 既定表示は縮小幅+中央寄せのsticky。移動・リサイズ・復元。
        #     ドラッグ開始点は操作系(button/input/select)を避けタイトル部(左端寄り)から。
        await pg.click("#tb-view-review")
        await pg.wait_for_timeout(4500)
        await pg.click(f'.review-lap-item[data-file="{REPLAY_FILE}"] .review-lap-play')
        await pg.wait_for_timeout(5000)
        rb0 = await rect(pg, "replay-bar")
        checks["replaybar_default_width_shrunk"] = rb0["w"] <= 900  # min(100%,880px)+誤差
        await drag_move(pg, "replay-bar", -200, 130 - rb0["top"])
        rb1 = await rect(pg, "replay-bar")
        checks["replaybar_moved"] = (rb1["left"] != rb0["left"] or rb1["top"] != rb0["top"])
        grip_ok = await drag_resize(pg, "replay-bar", -120, 30)
        rb2 = await rect(pg, "replay-bar")
        checks["replaybar_resized"] = grip_ok and (rb2["w"] != rb1["w"] or rb2["h"] != rb1["h"])
        store_rb = await pg.evaluate(f"() => JSON.parse(localStorage.getItem('{STORE_KEY}') || '{{}}')")
        checks["replaybar_persisted"] = "replay-bar" in store_rb  # #150 id方式のキー
        detail["replaybar"] = {"default": rb0, "moved": rb1, "resized": rb2,
                               "storeKeys": [k for k in store_rb]}
        # リロード復元(±TOL)
        await pg.reload(wait_until="networkidle")
        await pg.wait_for_timeout(800)
        await pg.click("#tb-view-review")
        await pg.wait_for_timeout(4500)
        await pg.click(f'.review-lap-item[data-file="{REPLAY_FILE}"] .review-lap-play')
        await pg.wait_for_timeout(5000)
        rbr = await rect(pg, "replay-bar")
        checks["replaybar_restored"] = (near(rbr["left"], rb2["left"]) and near(rbr["top"], rb2["top"])
                                        and near(rbr["w"], rb2["w"]) and near(rbr["h"], rb2["h"]))
        detail["replaybar"]["restored"] = rbr
        # ALIGNリセットでバーが既定(sticky・非浮遊)へ戻ることを確認しつつ、
        # 浮遊カード群を片付けてから EXIT を押す(浮遊カードは全モードで表示され続け
        # クリックを遮るため。この挙動自体は #155 完了報告で別途報告)
        await pg.evaluate("() => window.gt7ResetLayout()")
        await pg.wait_for_timeout(500)
        checks["replaybar_align_reset_unfloats"] = await pg.evaluate(
            "() => !document.getElementById('replay-bar').classList.contains('floating')")
        await pg.click("#replay-btn-exit")
        await pg.wait_for_timeout(400)

        await b.close()

    unexpected = [e for e in cerr if not any(x in e for x in EXPECTED_ERR)]
    out = {"checks": checks, "detail": detail, "pageerrors": perr,
           "unexpected_console_errors": unexpected,
           "verdict": "PASS" if (all(checks.values()) and not perr and not unexpected) else "FAIL"}
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0 if out["verdict"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
