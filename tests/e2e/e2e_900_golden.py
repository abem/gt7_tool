"""整理(リファクタリング)の前後で、画面の結果が変わらないことを確かめる、ゴールデン・スナップショット。

状態ごとに、次を保存した期待値(golden/*.json)と比べる:
  - 全要素の算出スタイル(getComputedStyle)のハッシュ。レイアウトで決まる寸法(width/height 等)は除く
  - 主要な要素の表示テキスト
  - REVIEW の3つのチャートのデータ(系列ごとの件数とハッシュ)
状態: 起動直後の ANALYSIS、DRIVE、REVIEW(A/B + 重ね書き2本 + ばらつき + ラップ推移を読み込んだ状態)。
画面幅: 1600x900 と 390x844。

期待値は、同じ環境(ブラウザ・フォント)での前後比較のためのもの。環境が変わったとき・意図して見た目を
変えたときは、差分を確認してから `run_e2e.py --update-golden -k golden` で作り直す。
食い違いの調査: GT7_E2E_GOLDEN_DUMP=1 で、全要素の算出スタイルを out/ に書き出す(前後で diff を取る)。
"""
import json, os
from corner_common import *  # noqa: F401,F403
from e2e_env import golden, OUT, GOLDEN_DIR

DUMP = os.environ.get('GT7_E2E_GOLDEN_DUMP') == '1'

# 時刻・通信で変わる要素(接続状態の表示・通知のトースト・再生バー)は、比較から外す
SNAP_JS = r"""
(dump) => {
  const SKIP_PROPS = new Set(['width','height','inline-size','block-size','perspective-origin','transform-origin']);
  const SKIP_SEL = '#connection-status, #race-engineer-feed, script, style, link, meta, title, head';
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const i = e.parentElement ? Array.prototype.indexOf.call(e.parentElement.children, e) : 0;
      parts.unshift(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + ':' + i);
    }
    return parts.join('>');
  };
  const out = [];
  const full = {};
  document.querySelectorAll('body, body *').forEach((el) => {
    if (el.closest(SKIP_SEL)) return;
    const cs = getComputedStyle(el);
    const parts = [];
    const o = dump ? {} : null;
    for (let i = 0; i < cs.length; i++) {
      const p = cs[i];
      if (SKIP_PROPS.has(p)) continue;
      const v = cs.getPropertyValue(p);
      parts.push(p + ':' + v);
      if (o) o[p] = v;
    }
    parts.sort();       // カスタムプロパティ(--*)の列挙順は、実行ごとに変わるため、並べ替えてからハッシュする
    const p = path(el);
    out.push([p, hash(parts.join(';'))]);
    if (o) full[p] = o;
  });
  return { styles: out, full: full };
}
"""

TEXT_IDS = ['review-sum-a', 'review-sum-b', 'review-sum-delta', 'review-sum-course', 'review-sum-theory',
            'review-overlay-legend', 'sr-summary', 'sr-table', 'cr-summary', 'cr-advice', 'cr-table',
            'cr-cons-status', 'cr-cons-advice', 'cr-cons-table', 'cp-readout', 'lt-status', 'lt-stats',
            'tm-readout', 'rm-phase-table', 'rm-corner-list', 'review-list-status']

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
    r = pg.evaluate(SNAP_JS, DUMP)
    if DUMP:
        json.dump(r['full'], open(os.path.join(OUT, 'golden_dump_%s.json' % name), 'w'), ensure_ascii=False, indent=0)
    return r['styles']


def style_golden(name, styles):
    """算出スタイルの比較。食い違ったときは、要素のパスで説明する。"""
    good, why = golden(name, styles)
    if good:
        return good, why
    try:
        exp = dict(map(tuple, json.load(open(os.path.join(GOLDEN_DIR, name + '.json'), encoding='utf-8'))))
    except Exception:
        return good, why
    got = dict(map(tuple, styles))
    changed = [p for p in got if p in exp and exp[p] != got[p]]
    added = [p for p in got if p not in exp]
    removed = [p for p in exp if p not in got]
    return False, '変化 %d / 追加 %d / 削除 %d 要素。例: %s' % (
        len(changed), len(added), len(removed), [p[-90:] for p in (changed + added + removed)[:3]])


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
        chk('%s: ANALYSIS(起動直後)の算出スタイルが、保存した期待値と同一' % label, g, why)
        pg.evaluate("document.getElementById('view-mode-btn').click()"); pg.wait_for_timeout(600)
        g, why = style_golden('style_%s_drive' % label, snap(pg, label + '_drive'))
        chk('%s: DRIVE の算出スタイルが同一' % label, g, why)
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
        chk('%s: REVIEW(A/B+重ね書き+ばらつき+推移)の算出スタイルが同一' % label, g, why)
        g, why = golden('text_%s_review' % label, texts(pg))
        chk('%s: REVIEW の表示テキスト(要約・表・提案・ばらつき・推移)が同一' % label, g, why)
        g, why = golden('charts_%s_review' % label, pg.evaluate(CHART_JS))
        chk('%s: REVIEW のチャートのデータ(3チャート・全系列)と区間の境界が同一' % label, g, why)
        chk('%s: pageerror 0(REVIEW)' % label, not errs, errs); b.close()
print('PASS', ok[0], 'FAIL', ok[1])
