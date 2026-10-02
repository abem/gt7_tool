"""整理(リファクタリング)の前後で、画面の結果が変わらないことを確かめる、ゴールデン・スナップショット。

状態ごとに、次を保存した期待値(golden/*.json)と比べる:
  - 全要素の算出スタイル(getComputedStyle)のハッシュ。レイアウトで決まる寸法(width/height 等)は除く。
    内容を持つ擬似要素(::before / ::after)も、同じように比べる
  - 全要素の属性(class・title・aria-* など)のハッシュ。インラインの style と、寸法(width/height)は除く
  - 主要な要素の表示テキスト
  - REVIEW の3つのチャートのデータ(系列ごとの件数とハッシュ)
  - 主な操作要素にマウスを載せたとき(:hover)の算出スタイル
状態: 起動直後の ANALYSIS、DRIVE、REVIEW(A/B + 重ね書き2本 + ばらつき + ラップ推移を読み込んだ状態)。
画面幅: 1600x900 と 390x844。

期待値は、同じ環境(ブラウザ・フォント)での前後比較のためのもの。環境が変わったとき・意図して見た目を
変えたときは、差分を確認してから `run_e2e.py --update-golden -k golden` で作り直す。
食い違いの調査: GT7_E2E_GOLDEN_DUMP=1 で、全要素の算出スタイルと属性を out/ に書き出す(前後で diff を取る)。

比べていないもの: :focus / :active の見た目、canvas に描いた絵そのもの(個別のテストが画素で確かめる)。
"""
import json, os
from corner_common import *  # noqa: F401,F403
from e2e_env import golden, OUT, GOLDEN_DIR

DUMP = os.environ.get('GT7_E2E_GOLDEN_DUMP') == '1'

# 時刻・通信で変わる要素(接続状態の表示・通知のトースト・再生バー)は、比較から外す
SNAP_JS = r"""
(arg) => {
  const dump = arg.dump;
  const SKIP_PROPS = new Set(['width','height','inline-size','block-size','perspective-origin','transform-origin']);
  const SKIP_ATTRS = new Set(['style','width','height']);
  const SKIP_SEL = '#connection-status, #race-engineer-feed, script, style, link, meta, title, head';
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
  const root = arg.root || null;
  const stop = root ? root.parentElement : document.documentElement;
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e !== stop; e = e.parentElement) {
      // script / style 等は、パスの番号に数えない(読み込むスクリプトを足しても、要素の名前が変わらないように)
      const i = e.parentElement ? Array.prototype.filter.call(e.parentElement.children, (c) => !c.matches('script, style, link, meta')).indexOf(e) : 0;
      parts.unshift(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + ':' + (e === root ? 0 : i));
    }
    return parts.join('>');
  };
  const styleOf = (cs) => {
    const parts = [];
    const o = {};
    for (let i = 0; i < cs.length; i++) {
      const p = cs[i];
      if (SKIP_PROPS.has(p)) continue;
      const v = cs.getPropertyValue(p);
      parts.push(p + ':' + v);
      if (dump) o[p] = v;
    }
    parts.sort();       // カスタムプロパティ(--*)の列挙順は、実行ごとに変わるため、並べ替えてからハッシュする
    return [hash(parts.join(';')), o];
  };
  const attrsOf = (el) => Array.prototype.map.call(el.attributes, (a) => [a.name, a.value])
    .filter((a) => !SKIP_ATTRS.has(a[0])).map((a) => a[0] + '=' + a[1]).sort();
  const out = [];
  const full = {};
  const els = root ? [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')))
                   : Array.prototype.slice.call(document.querySelectorAll('body, body *'));
  els.forEach((el) => {
    if (el.closest(SKIP_SEL)) return;
    const p = path(el);
    const st = styleOf(getComputedStyle(el));
    const at = attrsOf(el);
    out.push([p, st[0], hash(at.join('|'))]);
    if (dump) full[p] = { style: st[1], attrs: at };
    ['::before', '::after'].forEach((ps) => {
      const cs = getComputedStyle(el, ps);
      const content = cs.getPropertyValue('content');
      if (!content || content === 'none' || content === 'normal') return;   // 描かれない擬似要素
      const s2 = styleOf(cs);
      out.push([p + ps, s2[0], '']);
      if (dump) full[p + ps] = { style: s2[1], attrs: [] };
    });
  });
  return { styles: out, full: full };
}
"""

TEXT_IDS = ['review-sum-a', 'review-sum-b', 'review-sum-delta', 'review-sum-course', 'review-sum-theory',
            'review-overlay-legend', 'sr-summary', 'sr-table', 'cr-summary', 'cr-advice', 'cr-table',
            'cr-cons-status', 'cr-cons-advice', 'cr-cons-table', 'cp-readout', 'lt-status', 'lt-stats',
            'tm-readout', 'rm-phase-table', 'rm-corner-list', 'review-list-status']

# マウスを載せたとき(:hover)の見た目を比べる要素。画面に出ている最初の1つを使う(出ていなければ null を記録)
HOVER_SELS = ['.card', '.tb-ctl', '.tb-seg-btn', '.tb-btn', '.tm-mode-btn',
              '#review-btn-best', '#review-import-btn', '.review-lap-item', '.review-lap-ov', '.review-lap-play',
              '.review-lap-csv', '.review-ov-remove', '#sr-table tbody tr', '#cr-table tbody tr',
              '#cr-cons-table tbody tr', '#cr-cons-load', '#lt-load']

HOVER_TARGET_JS = r"""
(sel) => {
  const el = Array.prototype.find.call(document.querySelectorAll(sel), (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
  });
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  window.__goldenHover = el;
  // 子要素ではなく、その要素自身に当たる点を探す(見つからなければ中央)
  const pts = [[0.5, 0.5], [0.08, 0.5], [0.92, 0.5], [0.5, 0.15], [0.5, 0.85], [0.03, 0.1]];
  for (const q of pts) {
    const x = r.left + r.width * q[0], y = r.top + r.height * q[1];
    const hit = document.elementFromPoint(x, y);
    if (hit && (hit === el || el.contains(hit))) return [x, y];
  }
  return [r.left + r.width / 2, r.top + r.height / 2];
}
"""

CHART_JS = r"""
() => {
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
  const out = {};
  ['speed', 'delta', 'inputs'].forEach((k) => {
    out[k] = reviewState.charts[k].data.map((col) => {
      const s = Array.prototype.map.call(col, (v) => v == null ? 'n' : Number(v).toPrecision(10)).join(',');
      return [col.length, col.filter((v) => v != null).length, hash(s)];
    });
  });
  out.segBounds = reviewState.segMarks.bounds;
  return out;
}
"""


def snap(pg, name):
    r = pg.evaluate(SNAP_JS, {'dump': DUMP})
    if DUMP:
        json.dump(r['full'], open(os.path.join(OUT, 'golden_dump_%s.json' % name), 'w'), ensure_ascii=False, indent=0)
    return r['styles']


def style_golden(name, styles):
    """算出スタイルと属性の比較。食い違ったときは、要素のパスで説明する。"""
    good, why = golden(name, styles)
    if good:
        return good, why
    try:
        exp = {e[0]: e[1:] for e in json.load(open(os.path.join(GOLDEN_DIR, name + '.json'), encoding='utf-8'))}
    except Exception:
        return good, why
    got = {e[0]: list(e[1:]) for e in styles}
    style_changed = [p for p in got if p in exp and exp[p][0] != got[p][0]]
    attr_changed = [p for p in got if p in exp and exp[p][0] == got[p][0] and exp[p][1] != got[p][1]]
    added = [p for p in got if p not in exp]
    removed = [p for p in exp if p not in got]
    return False, 'スタイルの変化 %d / 属性の変化 %d / 追加 %d / 削除 %d 要素。例: %s' % (
        len(style_changed), len(attr_changed), len(added), len(removed),
        [p[-90:] for p in (style_changed + attr_changed + added + removed)[:3]])


def hover_snap(pg):
    """主な操作要素に、順にマウスを載せ、その要素(と子孫)の算出スタイルを集める。"""
    out = {}
    for sel in HOVER_SELS:
        pt = pg.evaluate(HOVER_TARGET_JS, sel)
        if pt is None:
            out[sel] = None
            continue
        pg.mouse.move(pt[0], pt[1]); pg.wait_for_timeout(200)
        r = pg.evaluate("(a)=>{ a.root = window.__goldenHover; const f = (%s); return { hovered: a.root.matches(':hover'), styles: f(a).styles }; }" % SNAP_JS,
                        {'dump': False})
        out[sel] = [r['hovered'], r['styles']]
        pg.mouse.move(2, 2); pg.wait_for_timeout(120)
    return out


def texts(pg):
    return pg.evaluate("(ids)=>Object.fromEntries(ids.map(i=>[i,(document.getElementById(i)||{}).textContent||null]))", TEXT_IDS)


def settle(pg):
    # トランジション・アニメーションを止めてから測る(途中の値を拾わない)
    pg.add_style_tag(content='*,*::before,*::after{transition:none !important;animation:none !important;caret-color:transparent !important}')
    pg.wait_for_timeout(400)


with sync_playwright() as pw:
    for label, vw, vh in (('desktop', 1600, 900), ('mobile', 390, 844)):
        b = pw.chromium.launch(args=['--no-sandbox', '--use-gl=swiftshader'])
        pg = b.new_context(viewport={'width': vw, 'height': vh}).new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.route('**/api/**', lambda r: r.fulfill(status=404, body='{}'))
        pg.goto(BASE + '/'); pg.wait_for_timeout(1800); settle(pg)
        g, why = style_golden('style_%s_analysis' % label, snap(pg, label + '_analysis'))
        chk('%s: ANALYSIS(起動直後)の算出スタイルと属性が、保存した期待値と同一' % label, g, why)
        hv = hover_snap(pg)
        g, why = golden('hover_%s_analysis' % label, hv)
        chk('%s: ANALYSIS で、操作要素にマウスを載せたときの算出スタイルが同一' % label, g, why)
        on = [s for s in HOVER_SELS[:4] if hv[s] and hv[s][0]]
        chk('%s: ANALYSIS で、カードとツールバーの操作要素(4種)にマウスが載った(:hover)' % label, on == HOVER_SELS[:4], on)
        pg.evaluate("document.getElementById('view-mode-btn').click()"); pg.wait_for_timeout(600)
        g, why = style_golden('style_%s_drive' % label, snap(pg, label + '_drive'))
        chk('%s: DRIVE の算出スタイルと属性が同一' % label, g, why)
        chk('%s: pageerror 0(ANALYSIS/DRIVE)' % label, not errs, errs); b.close()

        b, pg, errs = mk(pw, vw, vh); settle(pg)
        select(pg, A, B)
        for f in (lap[0]['file'], lap[1]['file']):
            pg.evaluate("(f)=>document.querySelector('.review-lap-item[data-file=\"'+f+'\"] .review-lap-ov').click()", f); pg.wait_for_timeout(900)
        pg.click('#cr-cons-load'); pg.wait_for_function("document.getElementById('cr-cons-table').querySelector('tbody')", timeout=60000)
        pg.evaluate("document.getElementById('lt-load').click()")
        pg.wait_for_function("document.getElementById('lt-stats').textContent.length>0", timeout=60000)
        pg.mouse.move(2, 2); pg.wait_for_timeout(800)
        g, why = style_golden('style_%s_review' % label, snap(pg, label + '_review'))
        chk('%s: REVIEW(A/B+重ね書き+ばらつき+推移)の算出スタイルと属性が同一' % label, g, why)
        g, why = golden('text_%s_review' % label, texts(pg))
        chk('%s: REVIEW の表示テキスト(要約・表・提案・ばらつき・推移)が同一' % label, g, why)
        g, why = golden('charts_%s_review' % label, pg.evaluate(CHART_JS))
        chk('%s: REVIEW のチャートのデータ(3チャート・全系列)と区間の境界が同一' % label, g, why)
        # マウスを載せると、行の強調などで状態が変わるため、他の比較のあとに行う
        hv = hover_snap(pg)
        g, why = golden('hover_%s_review' % label, hv)
        chk('%s: REVIEW で、操作要素にマウスを載せたときの算出スタイルが同一' % label, g, why)
        off = [s for s in HOVER_SELS if not (hv[s] and hv[s][0])]
        chk('%s: REVIEW で、比較対象の操作要素のすべてにマウスが載った(:hover)' % label, not off, off)
        chk('%s: pageerror 0(REVIEW)' % label, not errs, errs); b.close()
print('PASS', ok[0], 'FAIL', ok[1])
raise SystemExit(1 if ok[1] else 0)
