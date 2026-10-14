"""#617 複数コースの混在した記録(セッションをまたいだ古い記録): 一覧に印が出て、ラップ推移の候補から外れる。
#620 A/B を全て外すと RACE METRICS は取得せずに初期表示へ戻る。"""
import json, re
from urllib.parse import unquote
from playwright.sync_api import sync_playwright
from e2e_env import S, BASE

idx = json.load(open(f'{S}/fx_trend/index.json')); lap = [r['lap'] for r in idx]
det = {m['file']: json.load(open(f'{S}/fx_trend/{m["file"]}')) for m in lap}
MULTI = lap[5]['file']   # この 1 本を「複数コース混在」にする
ok = [0, 0]
def chk(n, c, x=''): ok[0 if c else 1] += 1; print('PASS' if c else 'FAIL', n, x)

with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox', '--use-gl=swiftshader'])
    pg = b.new_context(viewport={'width': 1600, 'height': 900}).new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    aux_calls = [0]
    def h(r):
        url = r.request.url; p = re.sub(r'^https?://[^/]+', '', url).split('?')[0]
        if p == '/api/laps': r.fulfill(status=200, content_type='application/json', body=json.dumps({'total': len(lap), 'laps': lap}))
        elif p.startswith('/api/laps/'):
            f = unquote(p[10:]); d = json.loads(json.dumps(det[f]))
            if 'fields=' in url: aux_calls[0] += 1
            if f == MULTI:
                d['meta']['courses'] = {'spa': 500, 'nurburgring': 300}; d['meta']['multi_course'] = True
            else:
                d['meta']['courses'] = {'spa': len(d['samples'])}; d['meta']['multi_course'] = False
            r.fulfill(status=200, content_type='application/json', body=json.dumps(d))
        else: r.fulfill(status=404, body='{}')
    pg.route('**/api/**', h); pg.goto(BASE + '/'); pg.wait_for_timeout(1200)
    pg.evaluate("document.getElementById('review-mode-btn').click()"); pg.wait_for_timeout(1200)
    click = lambda f: (pg.evaluate("(f)=>document.querySelector('.review-lap-item[data-file=\"'+f+'\"]').click()", f), pg.wait_for_timeout(900))
    click(lap[3]['file']); click(MULTI)
    txt = lambda f: pg.evaluate("(f)=>document.querySelector('.review-lap-item[data-file=\"'+f+'\"]').textContent", f)
    chk('一覧: 混在した記録の行に「複数コース」の印が出る', '複数コース' in txt(MULTI), txt(MULTI))
    chk('一覧: 通常の記録には印が出ない', '複数コース' not in txt(lap[3]['file']))
    # ラップ推移: 混在した記録は候補から外れる
    pg.evaluate("document.getElementById('lt-load').click()")
    pg.wait_for_function("document.getElementById('lt-stats').textContent.length>0", timeout=60000)
    stats = pg.evaluate("document.getElementById('lt-stats').textContent")
    m = re.search(r'n=(\d+)', stats)
    # フィクスチャは 13 周で、外れ値 1 本は統計から除かれる(n に含まれない)。混在の 1 本はさらに候補から外れる
    chk('ラップ推移: 混在した記録が候補から外れる(n=11: 13 − 外れ値 1 − 混在 1)', m and int(m.group(1)) == 11 and '外れ値 1 本' in stats, stats)
    # #620: A/B を全て外す → RACE METRICS は初期表示へ、補助データの取得は増えない
    before = aux_calls[0]
    click(lap[3]['file']); click(MULTI); pg.wait_for_timeout(600)
    chk('#620: 全解除で滑らかさが「較正中」に戻る', pg.evaluate("document.getElementById('rm-smooth-a').textContent") == '滑らかさA: 較正中')
    chk('#620: 全解除では補助データを取得しない', aux_calls[0] == before, (before, aux_calls[0]))
    chk('#620: フェーズ別の案内文に戻る', pg.evaluate("document.getElementById('rm-phase-table').textContent").startswith('フェーズ別デルタ: AとBの2本を選択'))
    chk('pageerror 0', not errs, errs); b.close()
print('PASS', ok[0], 'FAIL', ok[1])
raise SystemExit(1 if ok[1] else 0)
