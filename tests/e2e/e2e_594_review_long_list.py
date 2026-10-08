"""#594 REVIEW: ラップ一覧が多い(本番で約1,000件)ときに、ページとチャートが件数ぶん伸びない。

幅 1400px 未満では body がスクロールし、ラップ一覧の高さに上限が無かったため、一覧が約5万px に伸び、
グリッドの行に揃う右列のチャート3本まで巨大化していた。13件のフィクスチャでは起きないため、
一覧を 1,000 件に水増しして(詳細は同じファイルを指す)、3つの画面幅で確かめる。
"""
import json, re
from datetime import datetime, timedelta
from urllib.parse import unquote, urlparse, parse_qs
from playwright.sync_api import sync_playwright
from e2e_env import S, BASE

idx = json.load(open(f'{S}/fx_trend/index.json')); real = [r['lap'] for r in idx]
det = {m['file']: json.load(open(f'{S}/fx_trend/{m["file"]}')) for m in real}
# 1,000 件: 日付を1件ずつずらす(日ごとの見出しも増える)。file は本物の13件を順に使い回す
laps = []; real_of = {}
t0 = datetime(2026, 9, 25, 16, 0, 0)
for i in range(1000):
    base = real[i % len(real)]
    t = t0 - timedelta(hours=i * 3)
    f = t.strftime('%Y-%m-%d_%H_%M_%S') + '_CAR-%d_Lap-%d.json' % (base['car_id'], base['lap_number'])
    real_of[f] = base['file']
    laps.append(dict(base, file=f, recorded_at=t.strftime('%Y-%m-%dT%H:%M:%S')))
ok = [0, 0]
def chk(n, c, x=''): ok[0 if c else 1] += 1; print('PASS' if c else 'FAIL', n, x)

MEASURE = """() => {
  const h = (e) => Math.round(e.getBoundingClientRect().height);
  const list = document.getElementById('review-lap-list'), side = document.getElementById('review-sidebar');
  return { page: document.documentElement.scrollHeight, items: document.querySelectorAll('.review-lap-item').length,
           charts: ['review-speed-chart','review-delta-chart','review-inputs-chart'].map(i => h(document.getElementById(i))),
           side: h(side), main: h(document.getElementById('review-main')), listScrolls: list.scrollHeight > list.clientHeight + 10,
           sideTop: Math.round(side.getBoundingClientRect().top) };
}"""

with sync_playwright() as pw:
    for vw, vh in ((1366, 768), (1600, 900), (390, 844)):
        b = pw.chromium.launch(args=['--no-sandbox', '--use-gl=swiftshader'])
        pg = b.new_context(viewport={'width': vw, 'height': vh}).new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        def h(r):
            p = re.sub(r'^https?://[^/]+', '', r.request.url).split('?')[0]
            q = parse_qs(urlparse(r.request.url).query)
            if p == '/api/laps':     # 本物と同じく limit / offset でページを返す
                off = int(q.get('offset', ['0'])[0]); lim = int(q.get('limit', ['50'])[0])
                r.fulfill(status=200, content_type='application/json', body=json.dumps({'total': len(laps), 'laps': laps[off:off + lim]}))
            elif p.startswith('/api/laps/'):     # 水増しした名前は本物の詳細へ。それ以外(過去ベスト等の問い合わせ)は本物の名前のまま
                f = unquote(p[10:]); d = det.get(real_of.get(f, f))
                if d is None: r.fulfill(status=404, body='{}')
                else: r.fulfill(status=200, content_type='application/json', body=json.dumps(d))
            else: r.fulfill(status=404, body='{}')
        pg.route('**/api/**', h)
        pg.goto(BASE + '/'); pg.wait_for_timeout(1200)
        pg.evaluate("document.getElementById('review-mode-btn').click()")
        pg.wait_for_function("document.querySelectorAll('.review-lap-item').length >= 1000", timeout=60000); pg.wait_for_timeout(800)
        m = pg.evaluate(MEASURE)
        chk(f'{vw}px: 一覧に 1,000 件が並ぶ', m['items'] == 1000, m['items'])
        chk(f'{vw}px: ページの高さが件数ぶん伸びない(< 4,000px)', m['page'] < 4000, m['page'])
        chk(f'{vw}px: チャート3本の高さが常識的(各 < 600px)', all(c < 600 for c in m['charts']), m['charts'])
        # 1400px以上は .dashboard が 100vh で内側をスクロールするため、枠は右列(内容)の高さまで。1399px以下は画面の高さまで
        cap = max(vh, m['main']) if vw >= 1400 else vh
        chk(f'{vw}px: 一覧は枠の中でスクロールし、枠の高さは件数に依らない(<= %d)' % cap, m['listScrolls'] and m['side'] <= cap, (m['listScrolls'], m['side']))
        if vw == 1366:
            pg.evaluate("window.scrollTo(0, 600)"); pg.wait_for_timeout(300)
            m2 = pg.evaluate(MEASURE)
            chk('1366px: ページをスクロールしても一覧が見える位置に留まる(sticky)', 0 <= m2['sideTop'] <= 40, m2['sideTop'])
        # 選択して詳細を描いても伸びない
        pg.evaluate("(f)=>document.querySelector('.review-lap-item[data-file=\"'+f+'\"]').click()", laps[3]['file']); pg.wait_for_timeout(800)
        pg.evaluate("(f)=>document.querySelector('.review-lap-item[data-file=\"'+f+'\"]').click()", laps[4]['file']); pg.wait_for_timeout(1500)
        m3 = pg.evaluate(MEASURE)
        chk(f'{vw}px: A/B を選んで描いたあとも、チャートの高さが常識的', all(c < 600 for c in m3['charts']), m3['charts'])
        chk(f'{vw}px: pageerror 0', not errs, errs); b.close()
print('PASS', ok[0], 'FAIL', ok[1])
raise SystemExit(1 if ok[1] else 0)
