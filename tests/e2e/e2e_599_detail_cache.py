"""#599 REVIEW の詳細キャッシュに上限がある: 多くの周回を順に開いても、本体を持つ件数は上限で止まり、
一覧のタイム表示と BEST の候補(meta)は残り、捨てた周回は取り直して比較できる。
"""
import json, re
from datetime import datetime, timedelta
from urllib.parse import unquote, urlparse, parse_qs
from playwright.sync_api import sync_playwright
from e2e_env import S, BASE

idx = json.load(open(f'{S}/fx_trend/index.json')); real = [r['lap'] for r in idx]
det = {m['file']: json.load(open(f'{S}/fx_trend/{m["file"]}')) for m in real}
# 60 件(本物13件を使い回し、名前だけ一意にする)。同じコース・同じ車の揃った周回だけ使う
good = [m for m in real if m['file'] in det]
laps = []; real_of = {}
t0 = datetime(2026, 9, 25, 16, 0, 0)
for i in range(60):
    base = good[i % len(good)]
    t = t0 - timedelta(hours=i * 3)
    f = t.strftime('%Y-%m-%d_%H_%M_%S') + '_CAR-%d_Lap-%d.json' % (base['car_id'], base['lap_number'])
    real_of[f] = base['file']
    laps.append(dict(base, file=f, recorded_at=t.strftime('%Y-%m-%dT%H:%M:%S')))
ok = [0, 0]
def chk(n, c, x=''): ok[0 if c else 1] += 1; print('PASS' if c else 'FAIL', n, x)

COUNT_JS = """() => {
  const c = reviewState.detailCache, files = Object.keys(c);
  const times = Array.from(document.querySelectorAll('.review-lap-item .review-lap-time')).filter(e => /\\d:\\d\\d\\.\\d{3}/.test(e.textContent)).length;
  return { meta: files.length, body: files.filter(f => c[f].res !== undefined).length, lru: reviewState.detailLru.length,
           aux: Object.keys(rmState.auxCache).length, auxLru: rmState.auxLru.length, times: times };
}"""

with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox', '--use-gl=swiftshader'])
    pg = b.new_context(viewport={'width': 1600, 'height': 900}).new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    n_detail = [0]
    def h(r):
        p = re.sub(r'^https?://[^/]+', '', r.request.url).split('?')[0]
        q = parse_qs(urlparse(r.request.url).query)
        if p == '/api/laps':
            off = int(q.get('offset', ['0'])[0]); lim = int(q.get('limit', ['50'])[0])
            r.fulfill(status=200, content_type='application/json', body=json.dumps({'total': len(laps), 'laps': laps[off:off + lim]}))
        elif p.startswith('/api/laps/'):
            f = unquote(p[10:]); d = det.get(real_of.get(f, f))
            if d is None: r.fulfill(status=404, body='{}'); return
            if 'fields' not in q: n_detail[0] += 1
            r.fulfill(status=200, content_type='application/json', body=json.dumps(d))
        else: r.fulfill(status=404, body='{}')
    pg.route('**/api/**', h)
    pg.goto(BASE + '/'); pg.wait_for_timeout(1200)
    pg.evaluate("document.getElementById('review-mode-btn').click()")
    pg.wait_for_function("document.querySelectorAll('.review-lap-item').length >= 60", timeout=60000)
    cap = pg.evaluate("REVIEW_DETAIL_CACHE_MAX"); aux_cap = pg.evaluate("RM_AUX_CACHE_MAX")
    chk('上限の定数がある(詳細 %s 件・補助 %s 件)' % (cap, aux_cap), isinstance(cap, int) and cap >= 16 and isinstance(aux_cap, int) and aux_cap >= 16)
    # 上限 + 8 件を順に取得
    files = [l['file'] for l in laps[:cap + 8]]
    pg.evaluate("(fs) => fs.reduce((p, f) => p.then(() => reviewFetchDetail(f)).then(() => rmFetchAux(f)), Promise.resolve())", files)
    pg.wait_for_timeout(500)
    c = pg.evaluate(COUNT_JS)
    chk('本体(res/raw)を持つ件数が上限で止まる', c['body'] == cap and c['lru'] == cap, c)
    chk('meta は全件残る(%d 件)' % len(files), c['meta'] == len(files), c)
    chk('一覧のタイム表示は、取得した全件に出たまま', c['times'] >= len(files), c['times'])
    chk('補助データのキャッシュも上限で止まる', c['aux'] == aux_cap and c['auxLru'] == aux_cap, c)
    # 捨てられた最初の周回を A に、最新を B にして比較できる(取り直す)
    before = n_detail[0]
    pg.evaluate("(f)=>document.querySelector('.review-lap-item[data-file=\"'+f+'\"]').click()", files[0]); pg.wait_for_timeout(800)
    pg.evaluate("(f)=>document.querySelector('.review-lap-item[data-file=\"'+f+'\"]').click()", files[-1]); pg.wait_for_timeout(1500)
    nn = pg.evaluate("reviewState.charts.speed.data[1].filter(v => v != null).length")
    chk('本体を捨てた周回を A に選ぶと取り直され、速度チャートに A の系列が出る', n_detail[0] > before and nn > 100, (n_detail[0] - before, nn))
    c2 = pg.evaluate(COUNT_JS)
    chk('取り直したあとも本体の件数は上限のまま', c2['body'] == cap, c2)
    # 同じ A/B のまま再通知しても取り直さない(キャッシュが効く)
    before = n_detail[0]
    pg.evaluate("reviewCompare()"); pg.wait_for_timeout(800)
    chk('A/B が変わらない再比較では取り直さない', n_detail[0] == before, n_detail[0] - before)
    chk('pageerror 0', not errs, errs); b.close()
print('PASS', ok[0], 'FAIL', ok[1])
raise SystemExit(1 if ok[1] else 0)
