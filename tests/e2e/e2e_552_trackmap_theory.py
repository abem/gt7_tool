"""#552 T1/T2 headless verification with real lap fixtures (API routed).
Usage: python3 tests/e2e/e2e_552_trackmap_theory.py
"""
import sys, json, re, io
from urllib.parse import unquote
from playwright.sync_api import sync_playwright
from PIL import Image

from e2e_env import S, OUT, BASE
base, SHOTS = BASE, OUT
# 同じコース・走行距離が揃った3周(スパ・車3346)。A/B の理論ベスト等が算出できる組
_idx = {r['lap']['file']: r['lap'] for r in json.load(open(f'{S}/fx_trend/index.json'))}
_FILES = ['2026-09-25_16_34_10_CAR-3346_Lap-3.json', '2026-09-25_16_32_46_CAR-3346_Lap-2.json',
          '2026-09-25_16_15_56_CAR-3346_Lap-2.json']
cand = [_idx[f] for f in _FILES]
details = [json.load(open(f'{S}/fx_trend/{f}')) for f in _FILES]
by_file = {cand[i]['file']: details[i] for i in range(3)}
files = [c['file'] for c in cand]

FASTEST = min(d['meta']['laptime_ms_approx'] for d in details[:2]) / 1000.0
results = []
def check(name, ok, info=''):
    results.append((name, bool(ok), info))
    print(('PASS' if ok else 'FAIL'), name, info)

def install_routes(page, mismatch_b=False):
    def handler(route):
        url = route.request.url
        path = re.sub(r'^https?://[^/]+', '', url).split('?')[0]
        if path == '/api/laps':
            route.fulfill(status=200, content_type='application/json',
                          body=json.dumps({'total': 3, 'laps': cand}))
        elif path.startswith('/api/laps/'):
            f = unquote(path[len('/api/laps/'):])
            d = by_file.get(f)
            if d is None:
                route.fulfill(status=404, body='{}')
                return
            if mismatch_b and f == files[1]:
                d = json.loads(json.dumps(d))
                d['meta']['course'] = {'id': 'other_course', 'name_ja': '別コース'}
            route.fulfill(status=200, content_type='application/json', body=json.dumps(d))
        else:
            route.continue_()
    page.route('**/api/laps**', handler)

def canvas_stats(page):
    """Return (non-transparent pixel count, distinct hue buckets) of #tm-canvas."""
    png = page.locator('#tm-canvas').screenshot()
    im = Image.open(io.BytesIO(png)).convert('RGB')
    px = im.getdata()
    bg = px[0]
    n = 0
    hues = set()
    import colorsys
    for p in px:
        if abs(p[0]-bg[0]) + abs(p[1]-bg[1]) + abs(p[2]-bg[2]) > 60:
            n += 1
            h, s, v = colorsys.rgb_to_hsv(p[0]/255, p[1]/255, p[2]/255)
            if s > 0.5 and v > 0.4:
                hues.add(int(h * 12))
    return n, hues, png

OFFSCREEN = """() => { const vw=document.documentElement.clientWidth, out=[];
  for (const el of document.body.querySelectorAll('*')) { const cs=getComputedStyle(el);
    if (cs.display==='none'||cs.visibility==='hidden'||cs.position==='fixed'||cs.position==='absolute') continue;
    if (el.closest('svg')||el.closest('#sr-scroll')||el.closest('#cr-scroll')) continue; const r=el.getBoundingClientRect(); if (r.width===0||r.height===0) continue;
    if (r.right>vw+1||r.left<-1) out.push(el.tagName.toLowerCase()+(el.id?'#'+el.id:'')); }
  return out.slice(0,8); }"""

with sync_playwright() as p:
    b = p.chromium.launch(args=['--no-sandbox', '--use-gl=swiftshader'])

    # ---- 1) desktop: ANALYSIS で非表示、REVIEW で表示 ----
    ctx = b.new_context(viewport={'width': 1920, 'height': 1080}, ignore_https_errors=True)
    page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    install_routes(page)
    page.goto(base + '/'); page.wait_for_timeout(1500)
    check('ANALYSISではトラックマップ非表示', page.evaluate("getComputedStyle(document.getElementById('tm-review-card')).display") == 'none')
    page.evaluate("document.getElementById('review-mode-btn').click()"); page.wait_for_timeout(1500)
    check('REVIEWでトラックマップ表示', page.evaluate("getComputedStyle(document.getElementById('tm-review-card')).display") == 'block')
    check('未選択の理論ベスト表示', 'A/B両方を選択' in page.inner_text('#review-sum-theory'), page.inner_text('#review-sum-theory'))

    # ---- 2) A のみ選択 ----
    page.evaluate(f"reviewToggleSelect({json.dumps(files[0])})"); page.wait_for_timeout(2500)
    n, hues, png = canvas_stats(page)
    open(f'{SHOTS}/desktop_A_speed.png', 'wb').write(png)
    check('A選択でライン描画(色分け=複数色相)', n > 800 and len(hues) >= 4, f'pixels={n} hues={sorted(hues)}')
    check('A単独の理論ベストは案内表示', 'A/B両方を選択' in page.inner_text('#review-sum-theory'))

    # ---- 3) A/B 選択 ----
    page.evaluate(f"reviewToggleSelect({json.dumps(files[1])})"); page.wait_for_timeout(2500)
    n2, hues2, png2 = canvas_stats(page)
    open(f'{SHOTS}/desktop_AB_speed.png', 'wb').write(png2)
    check('A/B選択でBの白線が加わる(描画ピクセル増)', n2 >= n, f'{n}->{n2}')
    th = page.inner_text('#review-sum-theory')
    m = re.search(r'理論ベスト: (\d+:\d+\.\d+) \(実ベスト比 −(\d+\.\d+)s\)', th)
    check('理論ベスト値と取りこぼしが表示される', bool(m), th)
    if m:
        gain = float(m.group(2))
        check('取りこぼしが妥当範囲(0〜実ベストの20%)', 0 <= gain < 0.2 * FASTEST, f'gain={gain}s')
        # 理論ベストは A/B の速い方(205909ms)以下
        mm, ss = m.group(1).split(':'); tb = int(mm) * 60 + float(ss)
        check(f'理論ベスト ≤ 速い方の実タイム({FASTEST:.3f}s)', tb <= FASTEST + 0.001, f'{tb:.3f}s')
    check('近似である旨がtitleに明記', '近似' in (page.get_attribute('#review-sum-theory', 'title') or ''))

    # ---- 4) 指標切替 ----
    sigs = {}
    for mode in ('speed', 'brake', 'throttle'):
        page.click(f'[data-tm-mode="{mode}"]'); page.wait_for_timeout(300)
        n3, h3, pngm = canvas_stats(page)
        open(f'{SHOTS}/desktop_AB_{mode}.png', 'wb').write(pngm)
        sigs[mode] = pngm
        check(f'{mode}: aria-pressed', page.get_attribute(f'[data-tm-mode="{mode}"]', 'aria-pressed') == 'true')
    check('指標切替で描画が変わる(speed≠brake≠throttle)',
          len({hash(v) for v in sigs.values()}) == 3)

    # ---- 5) ホバー ----
    page.click('[data-tm-mode="speed"]'); page.wait_for_timeout(300)
    box = page.locator('#tm-canvas').bounding_box()
    hit = False
    for fx in (0.3, 0.4, 0.5, 0.6, 0.7):
        for fy in (0.3, 0.4, 0.5, 0.6):
            page.mouse.move(box['x'] + box['width'] * fx, box['y'] + box['height'] * fy)
            page.wait_for_timeout(60)
            t = page.inner_text('#tm-readout')
            if '距離' in t:
                hit = True; break
        if hit: break
    check('ホバーで地点の値(距離/速度/ブレーキ/スロットル)を表示', hit, page.inner_text('#tm-readout'))
    page.mouse.move(2, 2); page.wait_for_timeout(100)
    check('カーソルを外すと案内文へ戻る', '線にカーソルを合わせる' in page.inner_text('#tm-readout'))

    # ---- 6) 選択解除で初期化 ----
    page.evaluate(f"reviewToggleSelect({json.dumps(files[0])})"); page.wait_for_timeout(600)
    page.evaluate(f"reviewToggleSelect({json.dumps(files[1])})"); page.wait_for_timeout(800)
    check('全解除で理論ベストが初期表示へ戻る', 'A/B両方を選択' in page.inner_text('#review-sum-theory'))
    n4, _, _ = canvas_stats(page)
    check('全解除でキャンバスは案内文のみ', n4 < 3000, f'pixels={n4}')
    check('pageerror 0件(desktop)', not errs, str(errs[:2]))
    ctx.close()

    # ---- 7) コース不一致 ----
    ctx = b.new_context(viewport={'width': 1920, 'height': 1080}, ignore_https_errors=True)
    page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    install_routes(page, mismatch_b=True)
    page.goto(base + '/'); page.wait_for_timeout(1500)
    page.evaluate("document.getElementById('review-mode-btn').click()"); page.wait_for_timeout(1500)
    page.evaluate(f"reviewToggleSelect({json.dumps(files[0])})"); page.wait_for_timeout(1500)
    page.evaluate(f"reviewToggleSelect({json.dumps(files[1])})"); page.wait_for_timeout(2500)
    check('コースが異なる場合は理論ベストを算出しない', 'コースが異なる' in page.inner_text('#review-sum-theory'), page.inner_text('#review-sum-theory'))
    check('pageerror 0件(不一致)', not errs)
    ctx.close()

    # ---- 8) 縦画面: 横スクロールなし・画面外要素なし・描画される ----
    for (w, h) in [(390, 844), (360, 780)]:
        ctx = b.new_context(viewport={'width': w, 'height': h}, ignore_https_errors=True)
        page = ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        install_routes(page)
        page.goto(base + '/'); page.wait_for_timeout(1500)
        page.evaluate("document.getElementById('review-mode-btn').click()"); page.wait_for_timeout(1500)
        page.evaluate(f"reviewToggleSelect({json.dumps(files[0])})"); page.wait_for_timeout(1200)
        page.evaluate(f"reviewToggleSelect({json.dumps(files[1])})"); page.wait_for_timeout(2500)
        sw = page.evaluate('document.documentElement.scrollWidth')
        off = page.evaluate(OFFSCREEN)
        n5, h5, png5 = canvas_stats(page)
        open(f'{SHOTS}/mobile_{w}.png', 'wb').write(png5)
        check(f'{w}px 横スクロールなし', sw == w, f'scrollW={sw}')
        check(f'{w}px 画面外要素なし', not off, str(off))
        check(f'{w}px トラックマップ描画', n5 > 500 and len(h5) >= 4, f'pixels={n5}')
        check(f'{w}px pageerror 0件', not errs)
        page.locator('#tm-review-card').screenshot(path=f'{SHOTS}/mobile_{w}_card.png')
        ctx.close()
    b.close()

fails = [r for r in results if not r[1]]
print(f'\n== {len(results)-len(fails)}/{len(results)} PASS ==')
sys.exit(1 if fails else 0)
