"""#561 CORNER REPORT 検証: 実データのラップ + 仕様から独立して書いた Python 実装との照合。"""
from corner_common import *  # noqa: F401,F403

with sync_playwright() as pw:
    b,pg,errs=mk(pw)
    chk('未選択: 案内を表示',pg.evaluate("document.getElementById('cr-summary').textContent").startswith('A/B の2本'))
    select(pg,A,B)
    expAB,gotAB=compare(pg,A,B,'A/B(83.6s/83.8s)')
    advice=pg.evaluate("Array.from(document.querySelectorAll('#cr-advice li')).map(l=>l.textContent)")
    print(json.dumps(advice,ensure_ascii=False,indent=0))
    chk('改善提案が出る(損失のあるコーナー)',len(advice)>=1 and advice[0].startswith('T'),advice[:1])
    # 文章と指標の整合: 提案の Tn の Δ と表の Δ が一致
    m=re.match(r'T(\d+) \(([+−]?[\d.]+) s\)',advice[0]); tn=int(m.group(1)); tb=next(r for r in gotAB if r[0]=='T%d'%tn)
    chk('提案の Δ が表と一致',m.group(2)==tb[2],(m.group(2),tb[2]))
    # 損失順: 提案は Δ の大きい順
    ds=[float(re.match(r'T\d+ \(([+−][\d.]+)',x).group(1).replace('−','-')) for x in advice if x.startswith('T')]
    chk('提案は損失の大きい順',ds==sorted(ds,reverse=True),ds)
    # ホバー: 行のホバーで地図の区間強調(tmHighlightRange)が呼ばれる
    pg.evaluate("window.__hl=[]; const o=window.tmHighlightRange; window.tmHighlightRange=function(a,b){window.__hl.push([a,b]); return o&&o(a,b)}")
    pg.hover('#cr-table tbody tr:nth-child(2)'); pg.wait_for_timeout(200)
    hl=pg.evaluate("window.__hl"); r2=pg.evaluate("(()=>{const tr=document.querySelector('#cr-table tbody tr:nth-child(2)');return [+tr.dataset.crI0,+tr.dataset.crI1]})()")
    chk('行ホバーで地図の該当区間を強調',bool(hl) and hl[-1]==r2,(hl[-1:],r2))
    # 入れ替え: 対称
    row(pg,A); pg.wait_for_timeout(400); row(pg,B); pg.wait_for_timeout(400)   # 両方解除
    select(pg,B,A)                                                              # A/B を入れ替え
    swapped=table(pg)
    same_n=len(swapped)==len(gotAB)
    flip=all(abs(float(s[2].replace('−','-'))+float(g[2].replace('−','-')))<0.006 for s,g in zip(swapped,gotAB)) if same_n else False
    chk('A/B を入れ替えると、同じコーナーで Δ の符号が反転',same_n and flip,(len(swapped),len(gotAB)))
    titles=pg.evaluate("Object.fromEntries(Array.from(document.querySelectorAll('#cr-table tbody tr')).map(tr=>[tr.children[0].textContent,tr.title]))")
    t4=titles['T4']
    chk('入れ替えると T4 の文が逆向き(ブレーキ 早い→遅い、最低速度 −12→+12、Δ +0.28→−0.28)',
        'ブレーキが 10 m 遅い' in t4 and 'ブレーキを離すのが 10 m 早い' in t4 and '最低速度 +12 km/h' in t4 and '(−0.28 s)' in t4,t4)
    chk('入れ替えると、T4 は損失でなく得の側(先頭の提案に T4 が無く、得に T4 が出る)',
        not any(x.startswith('T4 ') for x in pg.evaluate("Array.from(document.querySelectorAll('#cr-advice li.cr-loss')).map(l=>l.textContent)")),'')
    # 別のペア(タイム差の大きい周回)
    row(pg,B); pg.wait_for_timeout(300); row(pg,A); pg.wait_for_timeout(400)   # 解除
    select(pg,C,D); compare(pg,C,D,'C/D(85.1s/102.5s)')
    # 比較不可
    row(pg,C); pg.wait_for_timeout(300); row(pg,D); pg.wait_for_timeout(400)
    select(pg,A,other['file']); s1=pg.evaluate("document.getElementById('cr-summary').textContent")
    chk('別コース: 算出せず理由を表示',('コースが異なる' in s1) and not table(pg),s1)
    row(pg,A); pg.wait_for_timeout(300); row(pg,other['file']); pg.wait_for_timeout(400)
    select(pg,A,longm['file']); s2=pg.evaluate("document.getElementById('cr-summary').textContent")
    chk('走行距離が異なる: 算出せず理由を表示',('走行距離が異なる' in s2) and not table(pg),s2)
    row(pg,A); pg.wait_for_timeout(300); row(pg,longm['file']); pg.wait_for_timeout(300)
    row(pg,A); pg.wait_for_timeout(900)
    s3=pg.evaluate("document.getElementById('cr-summary').textContent")
    chk('片方のみ選択: 案内',s3.startswith('A/B の2本'),s3)
    chk('pageerror 0',not errs,errs); b.close()
    for vw,vh in ((390,844),(1920,1080)):
        b,pg,errs=mk(pw,vw,vh); select(pg,A,B)
        pg.evaluate("document.getElementById('cr-review-card').scrollIntoView()"); pg.wait_for_timeout(400)
        sw=pg.evaluate("[document.documentElement.scrollWidth,innerWidth]"); chk(f'{vw}px: 横スクロールなし',sw[0]<=sw[1],sw)
        cw=pg.evaluate("(()=>{const s=document.getElementById('cr-scroll').getBoundingClientRect(),k=document.getElementById('cr-review-card').getBoundingClientRect();return [Math.round(s.right),Math.round(k.right)]})()")
        chk(f'{vw}px: 表がカード内(内部スクロール)に収まる',cw[0]<=cw[1],cw)
        pg.screenshot(path=f'{OUT}/cr561_{vw}.png'); chk(f'{vw}px: pageerror 0',not errs,errs); b.close()
print('PASS',ok[0],'FAIL',ok[1])
