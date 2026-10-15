"""#628 REVIEW: TCS / ABS の作動区間がペダル入力チャートの帯と区間レポートの列に出る。

フィクスチャには作動の情報が無いので、差し替え API で `aids` ビット(TCS=1 / ABS=4)を距離に応じて付け、
独立した Python 実装(距離の積算・区間の重なり)と突き合わせる。
"""
import json, math, re
from urllib.parse import unquote
from playwright.sync_api import sync_playwright
from e2e_env import S, BASE

idx = json.load(open(f'{S}/fx_trend/index.json')); lap = [r['lap'] for r in idx]
det = {m['file']: json.load(open(f'{S}/fx_trend/{m["file"]}')) for m in lap}
A = '2026-09-25_16_34_10_CAR-3346_Lap-3.json'; B = '2026-09-25_16_32_46_CAR-3346_Lap-2.json'
TCS_RANGE = (500, 700); ABS_RANGE = (1500, 1700)      # A だけに付ける(距離[m])
SEGMENTS = 20
ok = [0, 0]
def chk(n, c, x=''): ok[0 if c else 1] += 1; print('PASS' if c else 'FAIL', n, x)


def dists(samples):
    out = []; cum = 0.0; lx = lz = None
    for s in samples:
        x, z = s.get('position_x'), s.get('position_z')
        if x is not None and z is not None:
            if lx is not None:
                seg = math.hypot(x - lx, z - lz)
                if seg <= 120: cum += seg
            lx, lz = x, z
        out.append(cum)
    return out


def with_aids(d):
    d = json.loads(json.dumps(d)); ds = dists(d['samples'])
    for s, dist in zip(d['samples'], ds):
        bits = 0
        if TCS_RANGE[0] <= dist < TCS_RANGE[1]: bits |= 1
        if ABS_RANGE[0] <= dist < ABS_RANGE[1] and (s.get('brake_pct') or 0) > 0: bits |= 4
        s['aids'] = bits
    return d


# 独立実装: 作動区間と、20 等分の区間ごとの重なり
dA = with_aids(det[A]); ds = dists(dA['samples']); total = ds[-1]
def ranges(bit):
    r = []; cur = None
    for i, s in enumerate(dA['samples']):
        d0 = ds[i]; d1 = ds[i + 1] if i + 1 < len(ds) else d0
        if s['aids'] & bit:
            if cur and cur[1] >= d0: cur[1] = d1
            else: cur = [d0, d1]; r.append(cur)
    return r
exp = {k: ranges(b) for k, b in (('tcs', 1), ('abs', 4))}
def overlap(rs, d0, d1): return sum(max(0, min(r[1], d1) - max(r[0], d0)) for r in rs)
exp_seg = [(overlap(exp['tcs'], s * total / SEGMENTS, (s + 1) * total / SEGMENTS),
            overlap(exp['abs'], s * total / SEGMENTS, (s + 1) * total / SEGMENTS)) for s in range(SEGMENTS)]
print('expected tcs', [[round(a), round(b)] for a, b in exp['tcs']], 'abs', [[round(a), round(b)] for a, b in exp['abs']])

with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox', '--use-gl=swiftshader'])
    pg = b.new_context(viewport={'width': 1600, 'height': 900}).new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    fields_seen = []
    def h(r):
        url = r.request.url; p = re.sub(r'^https?://[^/]+', '', url).split('?')[0]
        if p == '/api/laps': r.fulfill(status=200, content_type='application/json', body=json.dumps({'total': len(lap), 'laps': lap}))
        elif p.startswith('/api/laps/'):
            f = unquote(p[10:]); fields_seen.append(url.split('fields=')[-1] if 'fields=' in url else '')
            d = with_aids(det[f]) if f == A else det[f]
            r.fulfill(status=200, content_type='application/json', body=json.dumps(d))
        else: r.fulfill(status=404, body='{}')
    pg.route('**/api/**', h); pg.goto(BASE + '/'); pg.wait_for_timeout(1200)
    pg.evaluate("document.getElementById('review-mode-btn').click()"); pg.wait_for_timeout(1200)
    for f in (A, B):
        pg.evaluate("(f)=>document.querySelector('.review-lap-item[data-file=\"'+f+'\"]').click()", f); pg.wait_for_timeout(1200)
    chk('詳細の取得で aids を要求している', any('aids' in x for x in fields_seen), fields_seen[:1])
    got = pg.evaluate("reviewState.aidBands")
    chk('A の TCS 区間が独立実装と一致(±10m)', got and got['a'] and len(got['a']['tcs']) == len(exp['tcs']) and
        all(abs(x[0] - y[0]) < 10 and abs(x[1] - y[1]) < 10 for x, y in zip(got['a']['tcs'], exp['tcs'])), (got or {}).get('a'))
    chk('A の ABS 区間が独立実装と一致(±10m)', got and all(abs(x[0] - y[0]) < 10 and abs(x[1] - y[1]) < 10 for x, y in zip(got['a']['abs'], exp['abs'])) and len(got['a']['abs']) == len(exp['abs']))
    chk('B には作動が無い(帯は空)', got and got['b'] and got['b']['tcs'] == [] and got['b']['abs'] == [])
    # 区間レポートの列
    heads = pg.evaluate("[...document.querySelectorAll('#sr-table thead th')].map(e => e.textContent)")
    chk('区間レポートに TCS / ABS の列がある', heads[-2:] == ['TCS A/B (m)', 'ABS A/B (m)'], heads[-2:])
    rows = pg.evaluate("[...document.querySelectorAll('#sr-table tbody tr')].map(tr => [...tr.children].slice(-2).map(td => td.textContent))")
    def parse(cell):   # 'a / b' の a
        return float(cell.split('/')[0].strip())
    bad = [(s, rows[s], exp_seg[s]) for s in range(SEGMENTS) if abs(parse(rows[s][0]) - exp_seg[s][0]) > 15 or abs(parse(rows[s][1]) - exp_seg[s][1]) > 15]
    chk('区間ごとの作動距離(A)が独立実装と一致(±15m、全 %d 区間)' % SEGMENTS, len(rows) == SEGMENTS and not bad, bad[:3])
    chk('B の作動距離は全区間 0', all(float(r[0].split('/')[1]) == 0 and float(r[1].split('/')[1]) == 0 for r in rows))
    # 帯が描かれている(ペダル入力チャートの上端に橙・青の画素がある)
    png = pg.locator('#review-inputs-chart canvas').first.screenshot()
    import io
    from PIL import Image
    im = Image.open(io.BytesIO(png)).convert('RGB'); px = list(im.getdata())
    near = lambda c, tol=40: sum(1 for p_ in px if abs(p_[0]-c[0])+abs(p_[1]-c[1])+abs(p_[2]-c[2]) < tol)
    # 帯は不透明度 0.6 で背景(#1B1F26)と混ざる: 橙 (232,161,61)→(150,109,52)、青 (61,155,255)→(48,106,168)
    blend = lambda c, a=0.6, bg=(0x1B, 0x1F, 0x26): tuple(round(a * c[i] + (1 - a) * bg[i]) for i in range(3))
    tcs_px, abs_px = near(blend((0xE8, 0xA1, 0x3D))), near(blend((0x3D, 0x9B, 0xFF)))
    chk('チャートに橙(TCS)と青(ABS)の帯の画素がある(背景と混ざった色)', tcs_px > 30 and abs_px > 30, (tcs_px, abs_px))
    chk('pageerror 0', not errs, errs); b.close()
print('PASS', ok[0], 'FAIL', ok[1])
raise SystemExit(1 if ok[1] else 0)
