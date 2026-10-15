"""#629 SESSION SUMMARY: 日 × 車種の統計(外れ値除外・σ)・前回セッション比・時間を失っている上位コーナーを、
独立した Python 実装(corner_common の距離グリッドとコーナー検出)と突き合わせる。
フィクスチャ(2026-09-25・CAR 3346・13 周)を、7 日前にも同じ内容で並べ、前回セッションとの差が 0 になることを確かめる。"""
import json, re

from urllib.parse import unquote
from corner_common import *  # noqa: F401,F403

DAY = '2026-09-25'; PREV = '2026-09-18'
prev_laps = []; real_of = {}
for m in lap:
    f = m['file'].replace('2026-09-25', PREV)
    real_of[f] = m['file']
    prev_laps.append(dict(m, file=f, recorded_at=m['recorded_at'].replace('2026-09-25', PREV)))
all_laps = lap + prev_laps      # 新しい順(今日 → 前回)

# ---- 独立実装 ----
def session_stats(files):
    rows = []
    for f in files:
        r = res_of(f); ms = det[f]['meta']['laptime_ms_approx']
        if not (ms and ms > 0): continue
        rows.append((f, r, ms, r['dist'][-1], det[f]['meta']['course']['id']))
    counts = {}
    for x in rows: counts[x[4]] = counts.get(x[4], 0) + 1
    major = max(counts, key=counts.get)
    rows = [x for x in rows if x[4] == major]          # 多数派のコースだけ(別コースの周回は除く)
    med_d = sorted(x[3] for x in rows)[len(rows) // 2]
    rows = [x for x in rows if abs(x[3] - med_d) / med_d <= 0.03]
    ms_all = sorted(x[2] for x in rows)
    if len(rows) >= 4:
        med = ms_all[len(ms_all) // 2] if len(ms_all) % 2 else (ms_all[len(ms_all) // 2 - 1] + ms_all[len(ms_all) // 2]) / 2
        kept = [x for x in rows if x[2] <= med * 1.3]
    else:
        kept = rows
    ms = sorted(x[2] for x in kept); n = len(ms)
    median = ms[n // 2] if n % 2 else (ms[n // 2 - 1] + ms[n // 2]) / 2
    mean = sum(ms) / n; sigma = (sum((v - mean) ** 2 for v in ms) / n) ** 0.5
    best = min(kept, key=lambda x: x[2])
    return dict(n=n, outliers=len(rows) - n, best=best, bestMs=best[2], median=median, sigma=sigma, kept=kept)

st = session_stats([m['file'] for m in lap])
# コーナー: 全周回の平均速度の谷(corner_common.corners は 2 本の平均 → 同じものを 2 回渡せば 1 本の平均)
nmin = min(len(x[1]['dist']) for x in st['kept'])
mean = {'dist': st['kept'][0][1]['dist'][:nmin], 'speed': [sum(x[1]['speed'][k] for x in st['kept']) / len(st['kept']) for k in range(nmin)]}
cs = corners(mean, mean)
best_r = st['best'][1]; others = [x for x in st['kept'] if x is not st['best']]
losses = []
for (a, s, e) in cs:
    bt = best_r['time'][e] - best_r['time'][s]
    avg = sum((x[1]['time'][e] - x[1]['time'][s]) - bt for x in others) / len(others)
    losses.append((best_r['dist'][a], avg))
top = sorted([l for l in losses if l[1] >= 0.03], key=lambda l: -l[1])[:3]
fmt = lambda ms: '%d:%06.3f' % (int(ms // 60000), (ms % 60000) / 1000)
print('expected n=%d outliers=%d best=%s median=%s sigma=%.3f corners=%d top=%s' % (st['n'], st['outliers'], fmt(st['bestMs']), fmt(st['median']), st['sigma'] / 1000, len(cs), [(round(d), round(v, 2)) for d, v in top]))

with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox', '--use-gl=swiftshader'])
    pg = b.new_context(viewport={'width': 1600, 'height': 900}).new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    n_fetch = [0]
    def h(r):
        p = re.sub(r'^https?://[^/]+', '', r.request.url).split('?')[0]
        if p == '/api/laps': r.fulfill(status=200, content_type='application/json', body=json.dumps({'total': len(all_laps), 'laps': all_laps}))
        elif p.startswith('/api/laps/'):
            f = unquote(p[10:]); n_fetch[0] += 1
            r.fulfill(status=200, content_type='application/json', body=json.dumps(det[real_of.get(f, f)]))
        else: r.fulfill(status=404, body='{}')
    pg.route('**/api/**', h); pg.goto(BASE + '/'); pg.wait_for_timeout(1200)
    pg.evaluate("document.getElementById('review-mode-btn').click()"); pg.wait_for_timeout(1200)
    chk('カードは REVIEW で表示される', pg.evaluate("getComputedStyle(document.getElementById('ss-review-card')).display") == 'block')
    pg.click('#ss-load')
    pg.wait_for_function("document.getElementById('ss-table') && document.getElementById('ss-status').textContent === ''", timeout=90000)
    rows = pg.evaluate("[...document.querySelectorAll('#ss-table tr')].map(tr => [tr.children[0].textContent, tr.children[1].textContent])")
    r = dict(rows)
    chk('セッション行: 日 × 車種 × コース', r['セッション'].startswith(DAY + ' ・ CAR 3346'), r['セッション'])
    chk('周回数と外れ値の除外が独立実装と一致', r['周回数'].startswith('%d 周' % st['n']) and (('外れ値 %d 周' % st['outliers']) in r['周回数'] if st['outliers'] else '外れ値' not in r['周回数']), r['周回数'])
    chk('ベストが一致し、前回(同じ内容)との差が ±0.000s', r['ベスト'].startswith(fmt(st['bestMs'])) and '±0.000s' in r['ベスト'], r['ベスト'])
    chk('中央値が一致し、前回との差が ±0.000s', r['中央値'].startswith(fmt(st['median'])) and '±0.000s' in r['中央値'], r['中央値'])
    sig = float(re.search(r'([\d.]+)s', r['ばらつき σ']).group(1))
    chk('ばらつき σ が一致(±0.01s)', abs(sig - st['sigma'] / 1000) < 0.011, (r['ばらつき σ'], round(st['sigma'] / 1000, 3)))
    chk('前回のセッションの日と周回数', r['前回'].startswith(PREV + '（%d 周）' % st['n']), r['前回'])
    items = pg.evaluate("[...document.querySelectorAll('#ss-corners li')].map(e => e.textContent)")
    got = [(int(re.search(r'（(\d+)m 付近）', t).group(1)), float(re.search(r'平均 \+([\d.]+)s', t).group(1))) for t in items if 'm 付近' in t]
    chk('時間を失っている上位コーナー(位置 ±10m・平均損失 ±0.02s・順序)が独立実装と一致', len(got) == len(top) and
        all(abs(g[0] - t[0]) <= 10 and abs(g[1] - t[1]) <= 0.02 for g, t in zip(got, top)), (got, [(round(d), round(v, 2)) for d, v in top]))
    chk('取得は 2 セッション × 上限 16 周以内', n_fetch[0] <= 32, n_fetch[0])
    # 一覧で前回の日に絞ると、前回のセッションがまとめられ「前のセッションなし」になる
    pg.select_option('#review-filter-date', PREV); pg.wait_for_timeout(300); pg.click('#ss-load')
    pg.wait_for_function("document.getElementById('ss-status').textContent === '' && document.getElementById('ss-table').textContent.includes('" + PREV + "')", timeout=90000)
    r2 = dict(pg.evaluate("[...document.querySelectorAll('#ss-table tr')].map(tr => [tr.children[0].textContent, tr.children[1].textContent])"))
    chk('日付の絞り込みに従い、前回の日をまとめる(それ以前のセッションは無し)', r2['セッション'].startswith(PREV) and 'なし' in r2['前回'], r2['前回'])
    chk('pageerror 0', not errs, errs); b.close()
print('PASS', ok[0], 'FAIL', ok[1])
raise SystemExit(1 if ok[1] else 0)
