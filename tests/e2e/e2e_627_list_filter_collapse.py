"""#627 REVIEW 一覧の絞り込み(車種)と日ごとの折りたたみ: 1,000 件・3 車種・多数の日で確かめる。"""
import json, re
from datetime import datetime, timedelta
from urllib.parse import unquote, urlparse, parse_qs
from playwright.sync_api import sync_playwright
from e2e_env import S, BASE

idx = json.load(open(f'{S}/fx_trend/index.json')); real = [r['lap'] for r in idx]
det = {m['file']: json.load(open(f'{S}/fx_trend/{m["file"]}')) for m in real}
laps = []; real_of = {}
t0 = datetime(2026, 9, 25, 16, 0, 0)
CARS = [3346, 63, 3374]
for i in range(1000):
    base = real[i % len(real)]; car = CARS[i % 3]
    t = t0 - timedelta(hours=i * 3)                    # 1 日に 8 件、約 125 日ぶん
    f = t.strftime('%Y-%m-%d_%H_%M_%S') + '_CAR-%d_Lap-%d.json' % (car, base['lap_number'])
    real_of[f] = base['file']
    laps.append(dict(base, file=f, car_id=car, recorded_at=t.strftime('%Y-%m-%dT%H:%M:%S')))
newest_day = laps[0]['recorded_at'][:10]
n_newest = sum(1 for l in laps if l['recorded_at'][:10] == newest_day)
n_car63 = sum(1 for l in laps if l['car_id'] == 63)
ok = [0, 0]
def chk(n, c, x=''): ok[0 if c else 1] += 1; print('PASS' if c else 'FAIL', n, x)

COUNT = """() => ({ items: document.querySelectorAll('.review-lap-item').length,
  shown: Array.from(document.querySelectorAll('.review-lap-item')).filter(e => getComputedStyle(e).display !== 'none').length,
  heads: document.querySelectorAll('.review-day-head[data-day]').length,
  open: document.querySelectorAll('.review-day-head[aria-expanded="true"]').length,
  firstHead: (document.querySelector('.review-day-head[data-day]') || {}).textContent })"""

def route(pg):
    def h(r):
        p = re.sub(r'^https?://[^/]+', '', r.request.url).split('?')[0]; q = parse_qs(urlparse(r.request.url).query)
        if p == '/api/laps':
            off = int(q.get('offset', ['0'])[0]); lim = int(q.get('limit', ['50'])[0])
            r.fulfill(status=200, content_type='application/json', body=json.dumps({'total': len(laps), 'laps': laps[off:off + lim]}))
        elif p.startswith('/api/laps/'):
            f = unquote(p[10:]); d = det.get(real_of.get(f, f))
            r.fulfill(status=200, content_type='application/json', body=json.dumps(d)) if d else r.fulfill(status=404, body='{}')
        else: r.fulfill(status=404, body='{}')
    pg.route('**/api/**', h)

with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox', '--use-gl=swiftshader'])
    ctx = b.new_context(viewport={'width': 1600, 'height': 900}); pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    route(pg); pg.goto(BASE + '/'); pg.wait_for_timeout(1200)
    pg.evaluate("document.getElementById('review-mode-btn').click()")
    pg.wait_for_function("document.querySelectorAll('.review-lap-item').length >= 1000", timeout=60000); pg.wait_for_timeout(500)
    c = pg.evaluate(COUNT)
    chk('一覧は 1,000 件を保持し、見出しは日ごと(件数つき)', c['items'] == 1000 and c['heads'] >= 100 and ('(%d)' % n_newest) in c['firstHead'], c)
    chk('既定では最新の日だけ開いていて、表示される行はその日の件数(%d)' % n_newest, c['open'] == 1 and c['shown'] == n_newest, c)
    # 2 日目の見出しを押すと開く
    pg.evaluate("document.querySelectorAll('.review-day-head[data-day]')[1].click()"); pg.wait_for_timeout(300)
    c = pg.evaluate(COUNT)
    chk('見出しを押すと、その日が開く(開いている日 2・表示行が増える)', c['open'] == 2 and c['shown'] > n_newest, c)
    # 折りたたみ中の行でも A/B の選択は効く(隠すだけ)
    pg.evaluate("(f)=>document.querySelector('.review-lap-item[data-file=\"'+f+'\"]').click()", laps[-1]['file']); pg.wait_for_timeout(1000)
    chk('折りたたまれた日の周回も、スクリプトからの選択(再生・A/B)は効く', pg.evaluate("reviewState.selA") == laps[-1]['file'])
    # 車種で絞る
    pg.select_option('#review-filter-car', '63'); pg.wait_for_timeout(500)
    c = pg.evaluate(COUNT)
    opts = pg.evaluate("[...document.querySelectorAll('#review-filter-car option')].map(o => o.textContent)")
    chk('車種の候補は件数つき(全車種 + 3 車種)', len(opts) == 4 and any('CAR 63 (' in o for o in opts), opts)
    chk('車種で絞ると、その車種の %d 件だけになる' % n_car63, c['items'] == n_car63, c)
    pg.select_option('#review-filter-car', ''); pg.wait_for_timeout(400)
    chk('絞り込みを戻すと 1,000 件に戻る', pg.evaluate(COUNT)['items'] == 1000)
    # 開閉の状態は保存され、再読み込み後も残る
    pg.reload(); pg.wait_for_timeout(1200)
    pg.evaluate("document.getElementById('review-mode-btn').click()")
    pg.wait_for_function("document.querySelectorAll('.review-lap-item').length >= 1000", timeout=60000); pg.wait_for_timeout(500)
    chk('再読み込み後も、開いた日は開いたまま(保存される)', pg.evaluate(COUNT)['open'] == 2, pg.evaluate(COUNT))
    chk('pageerror 0', not errs, errs); b.close()
print('PASS', ok[0], 'FAIL', ok[1])
raise SystemExit(1 if ok[1] else 0)
