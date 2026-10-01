"""#552 レビュー指摘への修正の検証。
Usage: python3 tests/e2e/e2e_552_review_fixes.py
"""
import sys, json, re
from urllib.parse import unquote
from playwright.sync_api import sync_playwright

from e2e_env import S, BASE
base = BASE
idx = json.load(open(f'{S}/fx_trend/index.json'))
spa_meta = [r['lap'] for r in idx]
spa_files = [m['file'] for m in spa_meta]
spa_det = {f: json.load(open(f'{S}/fx_trend/{f}')) for f in spa_files}
tk_cand = json.load(open(f'{S}/fx/cand.json'))
tk_det = {tk_cand[i]['file']: json.load(open(f'{S}/fx/detail{i}.json')) for i in range(3)}
tk_files = [c['file'] for c in tk_cand]
A_FILE, B_FILE = spa_files[10], spa_files[9]

results = []
def check(name, ok, info=''):
    results.append((name, bool(ok)))
    print(('PASS' if ok else 'FAIL'), name, info)

INIT_RO = """
window.__ro = {active: new Set(), created: 0};
const Orig = window.ResizeObserver;
window.ResizeObserver = class extends Orig {
  constructor(cb){ super(cb); this.__targets = new Set(); window.__ro.created++; }
  observe(t, o){ this.__targets.add(t); if (t && t.id === 'lt-chart') window.__ro.active.add(this); return super.observe(t, o); }
  disconnect(){ window.__ro.active.delete(this); return super.disconnect(); }
};
"""

def install(page, listing, details, null_course_files=(), counter=None):
    def h(route):
        url = route.request.url
        path = re.sub(r'^https?://[^/]+', '', url).split('?')[0]
        if path == '/api/laps':
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'total': len(listing), 'laps': listing}))
        elif path.startswith('/api/laps/'):
            f = unquote(path[len('/api/laps/'):])
            d = details.get(f)
            if d is None:
                route.fulfill(status=404, body='{}'); return
            d = {'meta': dict(d['meta']), 'samples': d['samples']}
            if f in null_course_files:
                d['meta']['course'] = None       # 旧形式・インポート由来のラップを模擬
            if 'every=60' in url:
                d['samples'] = d['samples'][::10]
                if counter is not None: counter.append(f)
            route.fulfill(status=200, content_type='application/json', body=json.dumps(d))
        else:
            route.continue_()
    page.route('**/api/laps**', h)

def open_review(page, listing, details, **kw):
    install(page, listing, details, **kw)
    page.goto(base + '/'); page.wait_for_timeout(1500)
    page.evaluate("document.getElementById('review-mode-btn').click()"); page.wait_for_timeout(1200)

def select(page, a=None, b=None):
    for f in (a, b):
        if f:
            page.evaluate(f"reviewToggleSelect({json.dumps(f)})"); page.wait_for_timeout(1500)
    page.wait_for_timeout(1500)

with sync_playwright() as p:
    br = p.chromium.launch(args=['--no-sandbox', '--use-gl=swiftshader'])

    # 1) コース情報が片方に無い(A の course=null、B は spa): 距離は近いが算出しない
    ctx = br.new_context(viewport={'width': 1920, 'height': 1080}); page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    open_review(page, spa_meta, spa_det, null_course_files={A_FILE})
    select(page, A_FILE, B_FILE)
    th = page.inner_text('#review-sum-theory')
    check('理論ベスト: コース情報が片方に無い組は算出しない', 'コース情報が無い' in th and '1:2' not in th, th)
    cells = [c.strip() for c in page.locator('#sr-table tbody tr').first.locator('td').all_inner_texts()]
    check('区間レポート: コース情報が無い組はΔを「--」にして注記', cells[4] == '--' and 'コース情報が無い' in page.inner_text('#sr-summary'), f'{cells[:5]} / {page.inner_text("#sr-summary")[:50]}')
    page.click('#lt-load'); page.wait_for_timeout(1200)
    check('ラップ推移: 基準のコースが不明なら描かず理由を表示', 'コース情報が無い' in page.inner_text('#lt-status') and page.inner_text('#lt-stats') == '', page.inner_text('#lt-status'))
    check('pageerror 0件(コース不明)', not errs, str(errs[:2]))
    ctx.close()

    # 2) 共通判定の直接検証(reviewComparable)
    ctx = br.new_context(viewport={'width': 1400, 'height': 900}); page = ctx.new_page()
    open_review(page, spa_meta, spa_det)
    select(page, A_FILE, B_FILE)
    r = page.evaluate("""() => {
      const A = reviewState.detailCache[reviewState.selA], B = reviewState.detailCache[reviewState.selB];
      const mk = (e, c) => ({meta: Object.assign({}, e.meta, {course: c}), res: e.res});
      return {
        same: reviewComparable(A, B).reason,
        aNull: reviewComparable(mk(A, null), B).reason,
        bothNull: reviewComparable(mk(A, null), mk(B, null)).reason,
        diff: reviewComparable(mk(A, {id: 'x'}), B).reason,
        noData: reviewComparable(A, null).reason,
        tol: REVIEW_DIST_TOLERANCE
      };
    }""")
    check('reviewComparable: 同一コース・近い距離 → ok', r['same'] == '', str(r))
    check('reviewComparable: 片方コース不明 → course-unknown', r['aNull'] == 'course-unknown')
    check('reviewComparable: 両方コース不明 → course-unknown(旧形式同士も別コースかもしれない)', r['bothNull'] == 'course-unknown')
    check('reviewComparable: コース違い → course-diff', r['diff'] == 'course-diff')
    check('reviewComparable: 片方なし → no-data', r['noData'] == 'no-data')
    check('共通の距離許容が3%', r['tol'] == 0.03)

    # 3) 区間強調は tmOnReviewCompare で解除される(呼び出し順に依存しない)
    base0 = page.evaluate("document.getElementById('tm-canvas').toDataURL()")
    page.evaluate("tmHighlightRange(10, 50)"); page.wait_for_timeout(100)
    hl = page.evaluate("document.getElementById('tm-canvas').toDataURL()")
    page.evaluate("tmOnReviewCompare(reviewState.detailCache[reviewState.selA], reviewState.detailCache[reviewState.selB])"); page.wait_for_timeout(100)
    after = page.evaluate("document.getElementById('tm-canvas').toDataURL()")
    check('強調あり≠強調なし(前提)', hl != base0)
    check('tmOnReviewCompare だけで区間の強調が解除される', after == base0)
    ctx.close()

    # 4) ResizeObserver が積み上がらない(車種・コースを切り替えて再読み込み)
    listing = spa_meta + tk_cand
    details = dict(spa_det); details.update(tk_det)
    ctx = br.new_context(viewport={'width': 1600, 'height': 900}); page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.add_init_script(INIT_RO)
    counter = []
    open_review(page, listing, details, counter=counter)
    def load_trend():
        page.click('#lt-load')
        page.wait_for_function("document.getElementById('lt-status').textContent.indexOf('を表示')>=0 || document.getElementById('lt-status').textContent.indexOf('描けません')>=0", timeout=30000)
    select(page, A_FILE, B_FILE); load_trend()
    n1 = page.evaluate("window.__ro.active.size")
    # 別の車種・コース(東京)へ切り替え → グラフが消える(観測は解除)
    page.evaluate(f"reviewToggleSelect({json.dumps(A_FILE)})"); page.wait_for_timeout(500)
    page.evaluate(f"reviewToggleSelect({json.dumps(B_FILE)})"); page.wait_for_timeout(500)
    page.evaluate(f"reviewToggleSelect({json.dumps(tk_files[0])})"); page.wait_for_timeout(2000)
    n2 = page.evaluate("window.__ro.active.size")
    # spa へ戻して再読み込み(以前は観測が2つに積み上がっていた)
    page.evaluate(f"reviewToggleSelect({json.dumps(tk_files[0])})"); page.wait_for_timeout(500)
    select(page, A_FILE, B_FILE); load_trend()
    n3 = page.evaluate("window.__ro.active.size"); created = page.evaluate("window.__ro.created")
    check('ResizeObserver: 初回読み込みで1つ', n1 == 1, f'active={n1}')
    check('ResizeObserver: グループ切替でグラフを消すと観測も解除される', n2 == 0, f'active={n2}')
    check('ResizeObserver: 再読み込み後も観測は1つだけ(積み上がらない)', n3 == 1, f'active={n3} 生成累計={created}')
    check('ラップ推移: every=60 の軽量取得のみ(基準ラップは詳細表示の距離を使う)', 0 < len(counter) <= 2 * 13 + 2, f'取得{len(counter)}件')
    check('pageerror 0件(推移切替)', not errs, str(errs[:2]))
    ctx.close()
    br.close()

fails = [r for r in results if not r[1]]
print(f'\n== {len(results)-len(fails)}/{len(results)} PASS ==')
sys.exit(1 if fails else 0)
