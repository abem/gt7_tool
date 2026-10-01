"""#552 T5(区間レポート)/T3(ラップ推移) headless verification with real lap fixtures.
Usage: python3 tests/e2e/e2e_552_segment_trend.py
"""
import sys, json, re, math, io
from datetime import datetime
from urllib.parse import unquote
from playwright.sync_api import sync_playwright
from PIL import Image

from e2e_env import S, OUT, BASE
base, SHOTS = BASE, OUT
FX = f'{S}/fx_trend'
idx = json.load(open(f'{FX}/index.json'))
lap_meta = [r['lap'] for r in idx]
files = [m['file'] for m in lap_meta]
detail = {f: json.load(open(f'{FX}/{f}')) for f in files}
# 距離が大きく異なる組(東京)用
TK = f'{S}/fx'
tk_cand = json.load(open(f'{TK}/cand.json'))
tk_detail = {tk_cand[i]['file']: json.load(open(f'{TK}/detail{i}.json')) for i in range(3)}
tk_files = [c['file'] for c in tk_cand]

results = []
def check(name, ok, info=''):
    results.append((name, bool(ok), info))
    print(('PASS' if ok else 'FAIL'), name, info)

def install(page, listing, details):
    def h(route):
        url = route.request.url
        path = re.sub(r'^https?://[^/]+', '', url).split('?')[0]
        q = url.split('?', 1)[1] if '?' in url else ''
        if path == '/api/laps':
            route.fulfill(status=200, content_type='application/json',
                          body=json.dumps({'total': len(listing), 'laps': listing}))
        elif path.startswith('/api/laps/'):
            f = unquote(path[len('/api/laps/'):])
            d = details.get(f)
            if d is None:
                route.fulfill(status=404, body='{}'); return
            m = re.search(r'every=(\d+)', q)
            if m and int(m.group(1)) >= 60:      # every=60 を every=6 の10分の1間引きで模擬
                d = {'meta': d['meta'], 'samples': d['samples'][::10]}
            route.fulfill(status=200, content_type='application/json', body=json.dumps(d))
        else:
            route.continue_()
    page.route('**/api/laps**', h)

# ---------- 独立実装(Python): reviewBuildSeries + resampleByDist(STEP=10) ----------
STEP = 10.0
def series(samples):
    cum = t = 0.0; lx = lz = None; prev = None; out = []
    for s in samples:
        ts = s.get('timestamp')
        if ts:
            v = datetime.fromisoformat(ts).timestamp()
            if prev is not None:
                dt = v - prev
                if 0 < dt < 2.0: t += dt
            prev = v
        if s.get('position_x') is not None and s.get('position_z') is not None:
            if lx is not None:
                seg = math.hypot(s['position_x'] - lx, s['position_z'] - lz)
                if seg <= 120: cum += seg
            lx, lz = s['position_x'], s['position_z']
        out.append(dict(dist=cum, t=t, speed=s.get('speed_kmh') or 0, throttle=s.get('throttle_pct') or 0, brake=s.get('brake_pct') or 0))
    return out
def resample(sr):
    N = int(sr[-1]['dist'] // STEP) + 1; si = 0; o = dict(dist=[], time=[], speed=[], throttle=[], brake=[])
    for k in range(N):
        d = k * STEP
        while si < len(sr) - 2 and sr[si + 1]['dist'] < d: si += 1
        a = sr[si]; b = sr[min(si + 1, len(sr) - 1)]
        span = b['dist'] - a['dist']; f = (d - a['dist']) / span if span > 0 else 0; f = max(0, min(1, f))
        L = lambda x, y: x + (y - x) * f
        o['dist'].append(d); o['time'].append(L(a['t'], b['t'])); o['speed'].append(L(a['speed'], b['speed']))
        o['throttle'].append(L(a['throttle'], b['throttle'])); o['brake'].append(L(a['brake'], b['brake']))
    return o
def seg_expect(ra, rb, s, SEG=20):
    n = min(len(ra['time']), len(rb['time']))
    i0 = (n - 1) * s // SEG; i1 = (n - 1) * (s + 1) // SEG
    def st(r):
        v = r['speed'][i0:i1 + 1]; b = r['brake'][i0:i1 + 1]; th = r['throttle'][i0:i1 + 1]
        return dict(t=r['time'][i1] - r['time'][i0], vmax=max(v), vmin=min(v), bmax=max(b), thr=sum(th) / len(th))
    return st(ra), st(rb), (ra['dist'][i0], ra['dist'][i1])

def tm_data(page):
    return page.evaluate("document.getElementById('tm-canvas').toDataURL()")

def canvas_png(page, sel):
    im = Image.open(io.BytesIO(page.locator(sel).screenshot())).convert('RGB')
    w, h = im.size
    return im.crop((3, 3, w - 3, h - 3)).tobytes()   # 端3pxを除外(サブピクセル誤差対策)

OFFSCREEN = """() => { const vw=document.documentElement.clientWidth, out=[];
  for (const el of document.body.querySelectorAll('*')) { const cs=getComputedStyle(el);
    if (cs.display==='none'||cs.visibility==='hidden'||cs.position==='fixed'||cs.position==='absolute') continue;
    if (el.closest('svg')||el.closest('#sr-scroll')||el.closest('#cr-scroll')) continue; const r=el.getBoundingClientRect(); if (r.width===0||r.height===0) continue;
    if (r.right>vw+1||r.left<-1) out.push(el.tagName.toLowerCase()+(el.id?'#'+el.id:'')); }
  return out.slice(0,8); }"""

A_FILE = files[10]   # 83589ms
B_FILE = files[9]    # 83768ms

with sync_playwright() as p:
    b = p.chromium.launch(args=['--no-sandbox', '--use-gl=swiftshader'])

    # ===================== T5 区間レポート =====================
    ctx = b.new_context(viewport={'width': 1920, 'height': 1080})
    page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    install(page, lap_meta, detail)
    page.goto(base + '/'); page.wait_for_timeout(1500)
    check('T5: ANALYSISでは区間レポート非表示', page.evaluate("getComputedStyle(document.getElementById('sr-review-card')).display") == 'none')
    check('T3: ANALYSISではラップ推移非表示', page.evaluate("getComputedStyle(document.getElementById('lt-review-card')).display") == 'none')
    page.evaluate("document.getElementById('review-mode-btn').click()"); page.wait_for_timeout(1500)
    check('T5: 未選択の案内', 'A/B のラップを選択すると' in page.inner_text('#sr-summary'), page.inner_text('#sr-summary')[:40])
    check('T3: 未選択でボタン無効', page.is_disabled('#lt-load'))
    page.evaluate(f"reviewToggleSelect({json.dumps(A_FILE)})"); page.wait_for_timeout(1500)
    page.evaluate(f"reviewToggleSelect({json.dumps(B_FILE)})"); page.wait_for_timeout(2500)

    rows = page.locator('#sr-table tbody tr')
    check('T5: 20区間の行が描画される', rows.count() == 20, f'rows={rows.count()}')
    ra = resample(series(detail[A_FILE]['samples'])); rb = resample(series(detail[B_FILE]['samples']))
    def cells(i): return [c.strip() for c in page.locator('#sr-table tbody tr').nth(i).locator('td').all_inner_texts()]
    bad = []
    for s in (0, 6, 12, 19):
        ea, eb, dr = seg_expect(ra, rb, s)
        c = cells(s)
        d = ea['t'] - eb['t']
        got_dt = float(c[4].replace('−', '-').replace('+', '')) if c[4] not in ('--',) else None
        va = [float(x) for x in c[5].split('/')]; vb = [float(x) for x in c[6].split('/')]
        bb = [float(x) for x in c[7].split('/')]; tt = [float(x) for x in c[8].split('/')]
        okrow = (abs(float(c[2]) - ea['t']) < 0.006 and abs(float(c[3]) - eb['t']) < 0.006 and got_dt is not None and abs(got_dt - d) < 0.011
                 and abs(va[0] - ea['vmax']) <= 1 and abs(va[1] - eb['vmax']) <= 1 and abs(vb[0] - ea['vmin']) <= 1 and abs(vb[1] - eb['vmin']) <= 1
                 and abs(bb[0] - ea['bmax']) <= 1 and abs(tt[0] - ea['thr']) <= 1)
        if not okrow: bad.append((s + 1, c, ea, eb))
    check('T5: 区間タイム/Δ/最高速/最低速/最大ブレーキ/平均スロットルが独立実装と一致(区間1,7,13,20)', not bad, str(bad[:1]))
    # Δ の合計 = 共通区間でのタイム差
    n = min(len(ra['time']), len(rb['time'])); tot = (ra['time'][n - 1] - ra['time'][0]) - (rb['time'][n - 1] - rb['time'][0])
    sd = 0.0
    for i in range(20):
        v = cells(i)[4]; sd += float(v.replace('−', '-').replace('+', ''))
    check('T5: Δの合計が共通距離でのA−Bタイム差に一致', abs(sd - tot) < 0.06, f'sumΔ={sd:.2f} expect={tot:.2f}')
    summ = page.inner_text('#sr-summary')
    check('T5: 最大の損失/利得区間の要約と近似の注記', '損失区間' in summ and '利得区間' in summ and '実際のコーナーとは無関係' in summ, summ[:70])

    # 左右並び(>=1400px): 地図と表の行が同時に画面内にある
    vis = page.evaluate("""()=>{const r=document.getElementById('tm-canvas').getBoundingClientRect();const row=document.querySelector('#sr-table tbody tr:nth-child(7)').getBoundingClientRect();const sr=document.getElementById('sr-review-card').getBoundingClientRect();const tm=document.getElementById('tm-review-card').getBoundingClientRect();return {mapTop:Math.round(r.top),mapBottom:Math.round(r.bottom),rowBottom:Math.round(row.bottom),vh:innerHeight,sameRow:Math.abs(tm.top-sr.top)<2,mapLeft:Math.round(tm.right)<=Math.round(sr.left)+1}}""")
    check('T5: 1920pxで地図と表が左右に並び、行7と地図が同時に画面内', vis['sameRow'] and vis['mapLeft'] and vis['rowBottom'] <= vis['vh'] and vis['mapTop'] < vis['vh'] - 100, str(vis))
    # ホバーで地図が変化(強調)
    before = tm_data(page)
    page.locator('#sr-table tbody tr').nth(6).hover(); page.wait_for_timeout(300)
    hov = tm_data(page)
    page.locator('#tm-canvas').screenshot(path=f'{SHOTS}/sr_hover.png')
    check('T5: 表の行ホバーでトラックマップの該当区間が強調される', before != hov)
    page.mouse.move(5, 5); page.wait_for_timeout(300)
    check('T5: ホバー解除で強調が消える', tm_data(page) == before)
    # クリックで固定
    page.locator('#sr-table tbody tr').nth(6).click(); page.wait_for_timeout(200)
    page.mouse.move(5, 5); page.wait_for_timeout(300)
    check('T5: クリックで強調を固定(sr-pinned)', 'sr-pinned' in (page.get_attribute('#sr-table tbody tr:nth-child(7)', 'class') or '') and tm_data(page) != before)
    page.locator('#sr-table tbody tr').nth(6).click(); page.wait_for_timeout(200)
    check('T5: 再クリックで固定解除', 'sr-pinned' not in (page.get_attribute('#sr-table tbody tr:nth-child(7)', 'class') or ''))
    check('T5: pageerror 0件', not errs, str(errs[:2]))

    # ===================== T3 ラップ推移 =====================
    check('T3: 選択後にボタン有効', not page.is_disabled('#lt-load'))
    page.click('#lt-load')
    page.wait_for_function("document.getElementById('lt-status').textContent.indexOf('を表示') >= 0 || document.getElementById('lt-status').textContent.indexOf('描けません') >= 0", timeout=30000)
    st = page.inner_text('#lt-status'); stats = page.inner_text('#lt-stats')
    # 期待本数: 同コース同車種で距離が基準の3%以内(every=60間引きの経路長で判定)
    def pl(samples):
        cum = 0; lx = lz = None
        for s in samples:
            if s.get('position_x') is not None and s.get('position_z') is not None:
                if lx is not None:
                    sg = math.hypot(s['position_x'] - lx, s['position_z'] - lz)
                    if sg <= 120: cum += sg
                lx, lz = s['position_x'], s['position_z']
        return cum
    base_dist = series(detail[A_FILE]['samples'])[-1]['dist']
    exp = [f for f in files if abs(pl(detail[f]['samples'][::10]) - base_dist) / max(pl(detail[f]['samples'][::10]), base_dist) <= 0.03 and detail[f]['meta']['laptime_ms_approx']]
    m = re.search(r'n=(\d+)', stats)
    lts_all = [detail[f]['meta']['laptime_ms_approx'] for f in exp]
    # 外れ値(#553): 4本以上のとき、中央値の1.3倍を超えるものを除外して統計を出す(独立実装)
    srt = sorted(lts_all); mid = len(srt) // 2
    median = srt[mid] if len(srt) % 2 else (srt[mid - 1] + srt[mid]) / 2
    outl = [v for v in lts_all if len(lts_all) >= 4 and v > median * 1.3]
    lts = [v for v in lts_all if not (len(lts_all) >= 4 and v > median * 1.3)]
    mean = sum(lts) / len(lts); sigma = math.sqrt(sum((v - mean) ** 2 for v in lts) / len(lts))
    fmt_lap = lambda ms: f'{int(round(ms) // 60000)}:{(round(ms) % 60000) / 1000:06.3f}'
    check('T3: 推移の本数が独立算出と一致(距離3%以内・外れ値を除く)', m and int(m.group(1)) == len(lts), f'表示n={m.group(1) if m else None} 期待={len(lts)}(距離OK {len(lts_all)} 本のうち外れ値 {len(outl)}) / {stats}')
    check('T3: 距離が揃わないラップの除外数を明示', re.search(r'距離が揃わない \d+ 本を除外', st) is not None, st)
    check('T3: ベストが期待と一致', f'ベスト {fmt_lap(min(lts))}' in stats, stats)
    check('T3: 平均が外れ値を除いた値と一致', f'平均 {fmt_lap(mean)}' in stats, f'期待 {fmt_lap(mean)} / {stats}')
    check('T3: ばらつきσが外れ値を除いた値と一致', f'σ={sigma / 1000:.2f}s' in stats, f'期待 σ={sigma / 1000:.2f}s / {stats}')
    check('T3: 外れ値の本数を統計行と説明に明示', (f'外れ値 {len(outl)} 本を除外' in stats) == (len(outl) > 0) and ((f'外れ値 {len(outl)} 本' in st) == (len(outl) > 0)), f'期待外れ値={len(outl)} / {stats} / {st[-70:]}')
    # A/B マーカー(青/緑)がチャートcanvasに描かれる
    png = page.locator('#lt-chart').screenshot(); open(f'{SHOTS}/lt_chart.png', 'wb').write(png)
    im = Image.open(io.BytesIO(png)).convert('RGB'); px = list(im.getdata())
    def near(c, tol=60): return sum(1 for p_ in px if abs(p_[0]-c[0])+abs(p_[1]-c[1])+abs(p_[2]-c[2]) < tol)
    blue = near((0x3D, 0x9B, 0xFF)); green = near((0x1F, 0x9E, 0x57))
    check('T3: A(青)・B(緑)のマーカーが描画される', blue > 20 and green > 20, f'blue={blue} green={green}')
    # 縮尺: 外れ値を除いた周回(灰色の点)が縦方向に十分広がって描かれる(外れ値に引っ張られて潰れない)
    W_, H_ = im.size
    gray_ys = [i // W_ for i, p_ in enumerate(px) if abs(p_[0]-0xC2) + abs(p_[1]-0xC9) + abs(p_[2]-0xD4) < 40]
    span = (max(gray_ys) - min(gray_ys)) / H_ if gray_ys else 0
    check('T3: 外れ値を除いた周回が読める縮尺で描かれる(縦の広がり25%超)', span > 0.25, f'縦の広がり={span:.2f}')
    if outl:
        orange = near((0xE8, 0xA1, 0x3D))
        check('T3: 外れ値の印(橙の○)が描画される', orange > 10, f'orange={orange}')
    box = page.locator('#lt-chart').bounding_box(); hit = False
    for fx in [i / 20 for i in range(2, 19)]:
        page.mouse.move(box['x'] + box['width'] * fx, box['y'] + box['height'] * 0.5); page.wait_for_timeout(50)
        if '#' in page.inner_text('#lt-readout'): hit = True; break
    check('T3: ホバーで日時とタイムを表示', hit, page.inner_text('#lt-readout'))
    # 選択解除でクリア
    page.evaluate(f"reviewToggleSelect({json.dumps(A_FILE)})"); page.wait_for_timeout(600)
    page.evaluate(f"reviewToggleSelect({json.dumps(B_FILE)})"); page.wait_for_timeout(800)
    check('T3: 全解除でボタン無効・統計消去', page.is_disabled('#lt-load') and page.inner_text('#lt-stats') == '')
    check('T5: 全解除で表が空・案内表示', page.locator('#sr-table tbody tr').count() == 0 and 'A/B のラップを選択すると' in page.inner_text('#sr-summary'))
    check('T3/T5: pageerror 0件(desktop全体)', not errs, str(errs[:2]))
    ctx.close()

    # ===================== 距離が異なる組 =====================
    ctx = b.new_context(viewport={'width': 1600, 'height': 900}); page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    install(page, tk_cand, tk_detail)
    page.goto(base + '/'); page.wait_for_timeout(1500)
    page.evaluate("document.getElementById('review-mode-btn').click()"); page.wait_for_timeout(1200)
    page.evaluate(f"reviewToggleSelect({json.dumps(tk_files[0])})"); page.wait_for_timeout(1500)
    page.evaluate(f"reviewToggleSelect({json.dumps(tk_files[1])})"); page.wait_for_timeout(2500)
    cs = [c.strip() for c in page.locator('#sr-table tbody tr').first.locator('td').all_inner_texts()]
    check('T5: 距離が異なる組はΔを「--」にして注記', cs[4] == '--' and '差分(Δ)は表示しません' in page.inner_text('#sr-summary'), f'{cs[:5]} / {page.inner_text("#sr-summary")[:40]}')
    check('T5: 距離不一致でもpageerror 0件', not errs)
    ctx.close()

    # ===================== 縦画面 =====================
    for (w, h) in [(390, 844), (360, 780)]:
        ctx = b.new_context(viewport={'width': w, 'height': h}); page = ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        install(page, lap_meta, detail)
        page.goto(base + '/'); page.wait_for_timeout(1500)
        page.evaluate("document.getElementById('review-mode-btn').click()"); page.wait_for_timeout(1200)
        page.evaluate(f"reviewToggleSelect({json.dumps(A_FILE)})"); page.wait_for_timeout(1200)
        page.evaluate(f"reviewToggleSelect({json.dumps(B_FILE)})"); page.wait_for_timeout(2500)
        page.click('#lt-load')
        page.wait_for_function("document.getElementById('lt-status').textContent.indexOf('を表示') >= 0", timeout=30000)
        sw = page.evaluate('document.documentElement.scrollWidth'); off = page.evaluate(OFFSCREEN)
        scroll_ok = page.evaluate("()=>{const e=document.getElementById('sr-scroll');const r=e.getBoundingClientRect();return {right:Math.round(r.right),vw:document.documentElement.clientWidth,scrollable:e.scrollWidth>e.clientWidth}}")
        check(f'{w}px: ページの横スクロールなし', sw == w, f'scrollW={sw}')
        check(f'{w}px: 画面外要素なし(区間表はカード内スクロール)', not off, str(off))
        check(f'{w}px: 区間表はカード内で横スクロール可能で画面内に収まる', scroll_ok['scrollable'] and scroll_ok['right'] <= w, str(scroll_ok))
        cw = page.evaluate("()=>document.getElementById('lt-chart').getBoundingClientRect().width")
        check(f'{w}px: ラップ推移チャートが画面幅に収まる', 0 < cw <= w, f'width={cw}')
        check(f'{w}px: pageerror 0件', not errs, str(errs[:2]))
        page.locator('#sr-review-card').screenshot(path=f'{SHOTS}/sr_mobile_{w}.png')
        page.locator('#lt-review-card').screenshot(path=f'{SHOTS}/lt_mobile_{w}.png')
        ctx.close()
    b.close()

fails = [r for r in results if not r[1]]
print(f'\n== {len(results)-len(fails)}/{len(results)} PASS ==')
sys.exit(1 if fails else 0)
