"""#565 チャートの区間目盛り 検証: 境界の位置(独立計算)、強調の帯(ホバー連動)、非表示条件、既存データ不変。"""
from corner_common import *  # noqa: F401,F403
def seg_bounds(fa,fb,n_seg=20):
    ra,rb=res_of(fa),res_of(fb); n=min(len(ra['dist']),len(rb['dist']))
    idx=[(n-1)*s//n_seg for s in range(n_seg)]+[(n-1)*n_seg//n_seg]
    return idx,ra['dist']
def canvas_cols(pg,idx,w=None):
    """SPEED チャートの canvas 全画素を取り、列ごとに「白っぽく薄く重なった」変化を数える(マーク on/off の差分)"""
    return pg.evaluate("""(chart)=>{const c=reviewState.charts[chart].ctx.canvas; const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; return {w:c.width,h:c.height,data:Array.from(d)}}""",idx)
def snap(pg,chart='speed'):
    return pg.evaluate("""(chart)=>{const u=reviewState.charts[chart]; const c=u.ctx.canvas; const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; return {w:c.width,h:c.height,bb:u.bbox,data:Array.from(d)}}""",chart)
def diff_cols(s0,s1):
    w,h=s0['w'],s0['h']; cols={}
    for y in range(h):
        base=y*w*4
        for x in range(w):
            i=base+x*4
            if s0['data'][i]!=s1['data'][i] or s0['data'][i+1]!=s1['data'][i+1] or s0['data'][i+2]!=s1['data'][i+2]:
                cols[x]=cols.get(x,0)+1
    return cols
with sync_playwright() as pw:
    b,pg,errs=mk(pw)
    chk('未選択: 境界なし',pg.evaluate("reviewState.segMarks.bounds===null"))
    select(pg,A,B); pg.wait_for_timeout(600)
    idx,dist=seg_bounds(A,B)
    got=pg.evaluate("reviewState.segMarks.bounds")
    chk('境界(21個)が、独立計算(A/B の距離÷20)と一致(±1格子)',got is not None and len(got)==21 and all(abs(x-y)<=1 for x,y in zip(got,idx)),(got,idx))
    # 画素: マーク on/off の差が、境界の x 列にだけ出る
    xs=pg.evaluate("(()=>{const u=reviewState.charts.speed;const st=reviewStepM();return reviewState.segMarks.bounds.map(i=>Math.round(u.valToPos(i*st,'x',true)))})()")
    s_on=snap(pg); pg.evaluate("reviewSetSegmentBounds(null)"); s_off=snap(pg)
    cols=diff_cols(s_off,s_on)
    dpr=1
    inside=[x for x in xs if s_on['bb']['left']<=x<=s_on['bb']['left']+s_on['bb']['width']]
    hit=sum(1 for x in inside if any(cols.get(x+k,0)>10 for k in (-1,0,1)))
    stray=[x for x,v in cols.items() if v>10 and not any(abs(x-t)<=1 for t in inside)]
    chk('チャート上に、境界の縦線が描かれる(境界の列に変化)',hit>=len(inside)-1 and len(inside)>=20,(hit,len(inside)))
    chk('境界の列以外は変化しない(データ・系列は不変)',len(stray)==0,stray[:5])
    pg.evaluate("reviewSetSegmentBounds(reviewState.segMarks.bounds||%s)"%json.dumps(got))
    pg.evaluate("reviewSetSegmentBounds(%s)"%json.dumps(got)); pg.wait_for_timeout(200)
    # 3つのチャートすべて
    okc=True
    for ch in ('delta','inputs'):
        pg.evaluate("reviewSetSegmentBounds(null)"); a0=snap(pg,ch); pg.evaluate("reviewSetSegmentBounds(%s)"%json.dumps(got)); a1=snap(pg,ch)
        if not diff_cols(a0,a1): okc=False
    chk('TIME DELTA・THROTTLE/BRAKE にも描かれる',okc)
    # 強調: 区間レポートの行ホバー → チャートに帯、離すと消える
    pg.evaluate("reviewSetSegmentBounds(null)"); s0=snap(pg)
    pg.hover('#sr-table tbody tr:nth-child(5)'); pg.wait_for_timeout(250)
    band=pg.evaluate("reviewState.segMarks.band"); rr=pg.evaluate("(()=>{const tr=document.querySelector('#sr-table tbody tr:nth-child(5)');return [+tr.dataset.srI0,+tr.dataset.srI1]})()")
    chk('行ホバーで、その区間がチャートの帯に設定される',band==rr,(band,rr))
    s1=snap(pg); cols=diff_cols(s0,s1)
    xs_b=pg.evaluate("(()=>{const u=reviewState.charts.speed;const st=reviewStepM();return reviewState.segMarks.band.map(i=>Math.round(u.valToPos(i*st,'x',true)))})()")
    lo=min(cols) if cols else -1; hi=max(cols) if cols else -1
    chk('帯の範囲が、区間の両端の位置と一致(±2px)',cols and abs(lo-xs_b[0])<=2 and abs(hi-xs_b[1])<=2,(lo,hi,xs_b))
    # 地図の強調とも同時(同じ区間)
    pg.mouse.move(5,5); pg.wait_for_timeout(250)
    chk('離すと帯が消える',pg.evaluate("reviewState.segMarks.band===null"))
    # コーナー別レポートの行でも連動
    pg.hover('#cr-table tbody tr:nth-child(3)'); pg.wait_for_timeout(250)
    cb=pg.evaluate("reviewState.segMarks.band"); crr=pg.evaluate("(()=>{const tr=document.querySelector('#cr-table tbody tr:nth-child(3)');return [+tr.dataset.crI0,+tr.dataset.crI1]})()")
    chk('コーナー別レポートの行ホバーでも、チャートの帯が連動',cb==crr,(cb,crr))
    pg.mouse.move(5,5); pg.wait_for_timeout(200)
    # 固定(クリック)
    pg.click('#sr-table tbody tr:nth-child(7)'); pg.wait_for_timeout(200); pg.mouse.move(5,5); pg.wait_for_timeout(200)
    chk('クリックで固定すると、離しても帯が残り、再クリックで消える',pg.evaluate("reviewState.segMarks.band!==null"))
    pg.click('#sr-table tbody tr:nth-child(7)'); pg.wait_for_timeout(200)
    chk('再クリックで解除',pg.evaluate("reviewState.segMarks.band===null"))
    # A/B が変わると帯は解除、比較不可では境界も解除
    pg.hover('#sr-table tbody tr:nth-child(3)'); pg.wait_for_timeout(200)
    chk('(前提)行ホバー中は帯がある',pg.evaluate("reviewState.segMarks.band!==null"))
    pg.mouse.move(5,5); pg.wait_for_timeout(150)      # マウスが表の行に残ると、再描画された行でホバーが再発火する
    pg.hover('#sr-table tbody tr:nth-child(3)'); pg.wait_for_timeout(150)
    pg.evaluate("document.activeElement&&document.activeElement.blur()")
    pg.mouse.move(5,5); pg.wait_for_timeout(150)
    row(pg,B); pg.wait_for_timeout(800)
    chk('B を外すと帯・境界とも解除',pg.evaluate("reviewState.segMarks.band===null && reviewState.segMarks.bounds===null"))
    row(pg,A); pg.wait_for_timeout(300)
    select(pg,A,other['file']); pg.wait_for_timeout(500)
    chk('別コース: 境界を出さない',pg.evaluate("reviewState.segMarks.bounds===null"))
    row(pg,A); pg.wait_for_timeout(300); row(pg,other['file']); pg.wait_for_timeout(300)
    select(pg,A,longm['file']); pg.wait_for_timeout(500)
    chk('走行距離が異なる: 境界を出さない',pg.evaluate("reviewState.segMarks.bounds===null"))
    row(pg,A); pg.wait_for_timeout(300); row(pg,longm['file']); pg.wait_for_timeout(300)
    # 重ね書きを足しても、境界は残る
    select(pg,A,B); pg.wait_for_timeout(500); ov=[m['file'] for m in lap if m['file'] not in (A,B)][0]
    pg.evaluate("(f)=>document.querySelector('.review-lap-item[data-file=\"'+f+'\"] .review-lap-ov').click()",ov); pg.wait_for_timeout(1500)
    chk('重ね書きを足しても境界が残る',pg.evaluate("reviewState.segMarks.bounds!==null && reviewState.segMarks.bounds.length===21"))
    chk('pageerror 0',not errs,errs); b.close()
    for vw,vh in ((390,844),(1920,1080)):
        b,pg,errs=mk(pw,vw,vh); select(pg,A,B); pg.wait_for_timeout(500)
        sw=pg.evaluate("[document.documentElement.scrollWidth,innerWidth]"); chk(f'{vw}px: 横スクロールなし',sw[0]<=sw[1],sw)
        pg.evaluate("document.getElementById('review-speed-chart').scrollIntoView()"); pg.hover('#sr-table tbody tr:nth-child(5)') if vw>1000 else None; pg.wait_for_timeout(300)
        pg.screenshot(path=f'{OUT}/seg565_{vw}.png'); chk(f'{vw}px: pageerror 0',not errs,errs); b.close()
print('PASS',ok[0],'FAIL',ok[1])
