"""#555 T6/T7 (CHANNEL PLOTS) 検証: 実データのラップ + 独立したPython実装との照合。"""
import json, re, math
from datetime import datetime
from urllib.parse import unquote
from playwright.sync_api import sync_playwright
from e2e_env import S, OUT, BASE
idx=json.load(open(f'{S}/fx_trend/index.json')); lap=[r['lap'] for r in idx]
det={m['file']:json.load(open(f"{S}/fx_trend/{m['file']}")) for m in lap}
A,B=lap[10]['file'],lap[9]['file']
other=dict(lap[10]); other['file']='2026-09-25_17_00_00_CAR-3346_Lap-9.json'
d=json.loads(json.dumps(det[A])); d['meta']['course']=dict(d['meta']['course'],id='tokyo_expressway_east'); det[other['file']]=d; lap=lap+[other]
OTHER=other['file']
ok=[0,0]
def chk(n,c,x=''):
    ok[0 if c else 1]+=1; print('PASS' if c else 'FAIL',n,x)

# ---- 独立実装(review-view.js の reviewBuildSeries / resampleByDist と同じ仕様) ----
def series(samples):
    out=[];cum=0;t=0;lx=lz=None;pts=None
    for s in samples:
        ts=s.get('timestamp')
        if ts:
            v=datetime.fromisoformat(ts.replace('Z','+00:00')).timestamp()
            if pts is not None:
                dt=v-pts
                if 0<dt<2.0: t+=dt
            pts=v
        if s.get('position_x') is not None and s.get('position_z') is not None:
            if lx is not None:
                seg=math.hypot(s['position_x']-lx,s['position_z']-lz)
                if seg<=120: cum+=seg
            lx,lz=s['position_x'],s['position_z']
        out.append(dict(dist=cum,t=t,speed=s.get('speed_kmh') or 0,thr=s.get('throttle_pct') or 0,brk=s.get('brake_pct') or 0,gear=s.get('gear') or 0))
    return out,cum
def resample(sm,step=10):
    last=sm[-1]['dist']; N=int(last//step)+1; si=0; r=dict(dist=[],time=[],speed=[])
    for k in range(N):
        dd=k*step
        while si<len(sm)-2 and sm[si+1]['dist']<dd: si+=1
        a=sm[si]; b=sm[min(si+1,len(sm)-1)]; span=b['dist']-a['dist']
        f=(dd-a['dist'])/span if span>0 else 0; f=max(0,min(1,f))
        r['dist'].append(dd); r['time'].append(a['t']+(b['t']-a['t'])*f); r['speed'].append(a['speed']+(b['speed']-a['speed'])*f)
    return r
def accel(r,k):
    if k<=0 or k>=len(r['speed'])-1: return None
    dt=r['time'][k+1]-r['time'][k-1]
    return (r['speed'][k+1]-r['speed'][k-1])/3.6/dt if dt>0 else None
def pearson(p):
    n=len(p)
    if n<3: return None
    mx=sum(x for x,_ in p)/n; my=sum(y for _,y in p)/n
    sxy=sum((x-mx)*(y-my) for x,y in p); sxx=sum((x-mx)**2 for x,_ in p); syy=sum((y-my)**2 for _,y in p)
    return sxy/math.sqrt(sxx*syy)
def expected_scatter(f,x='speed',y='accel'):
    sm,_=series(det[f]['samples']); r=resample(sm)
    pts=[(r['speed'][k],accel(r,k)) for k in range(len(r['dist'])) if accel(r,k) is not None]
    return pts
def expected_hist(f,key,bins=20,lo=0,hi=100):
    sm,_=series(det[f]['samples']); c=[0]*bins
    for s in sm:
        v={'thr':s['thr'],'brk':s['brk'],'speed':s['speed'],'gear':s['gear']}[key]
        i=min(bins-1,max(0,int((v-lo)/(hi-lo)*bins))); c[i]+=1
    n=sum(c); return [k/n*100 for k in c],n

def mk(pw,vw=1600,vh=900):
    b=pw.chromium.launch(args=['--no-sandbox','--use-gl=swiftshader']); pg=b.new_context(viewport={'width':vw,'height':vh}).new_page(); errs=[]
    pg.on('pageerror',lambda e:errs.append(str(e)))
    def h(r):
        path=re.sub(r'^https?://[^/]+','',r.request.url).split('?')[0]
        if path=='/api/laps': r.fulfill(status=200,content_type='application/json',body=json.dumps({'total':len(lap),'laps':lap}))
        elif path.startswith('/api/laps/'): r.fulfill(status=200,content_type='application/json',body=json.dumps(det[unquote(path[10:])]))
        else: r.fulfill(status=404,body='{}')
    pg.route('**/api/**',h); pg.goto(BASE+'/'); pg.wait_for_timeout(1200)
    pg.evaluate("document.getElementById('review-mode-btn').click()"); pg.wait_for_timeout(1500)
    return b,pg,errs
def row(pg,f): pg.evaluate("(f)=>document.querySelector('.review-lap-item[data-file=\"'+f+'\"]').click()",f)
def ro(pg): return pg.evaluate("document.getElementById('cp-readout').textContent")
def sel(pg,i,v): pg.select_option(i,v); pg.wait_for_timeout(300)
def tab(pg,m): pg.evaluate("(m)=>document.querySelector('.cp-tab[data-cp-mode=\"'+m+'\"]').click()",m); pg.wait_for_timeout(300)
def bars(pg,color,bins,ymax,pw_pad_l=46,pad_r=12,pad_t=10,pad_b=30,ncount=2,half=0):
    """canvasの各ビン中央付近の棒の高さ[px]を、色(A/B)で走査して測る"""
    return pg.evaluate("""([col,bins,ymax,padl,padr,padt,padb,half,count])=>{
      const cv=document.getElementById('cp-canvas'); const ctx=cv.getContext('2d'); const W=cv.width,H=cv.height;
      const pw=W-padl-padr, ph=H-padt-padb, bw=pw/bins, out=[];
      const want=col; for(let i=0;i<bins;i++){
        const w=bw*0.9/count; const x=Math.round(padl+i*bw+bw*0.05+half*w+w/2);
        const px=ctx.getImageData(x,padt,1,ph).data; let h=0;
        for(let y=ph-1;y>=0;y--){const r=px[y*4],g=px[y*4+1],b=px[y*4+2],a=px[y*4+3]; if(a>150 && Math.abs(r-want[0])<40 && Math.abs(g-want[1])<40 && Math.abs(b-want[2])<40) h++; else if(h>0) break;}
        out.push(h/ph*ymax);}
      return out}""",[color,bins,ymax,pw_pad_l,pad_r,pad_t,pad_b,half,ncount])

with sync_playwright() as pw:
    b,pg,errs=mk(pw)
    chk('未選択: メッセージ表示・readout 空',ro(pg)=='')
    row(pg,A); pg.wait_for_timeout(800); row(pg,B); pg.wait_for_timeout(1500)
    def rng(v):
        a=sorted(v); n=len(a); lo=a[int(0.01*(n-1))]; hi=a[int(0.99*(n-1))]; sp=(hi-lo) or 1; return lo-0.25*sp,hi+0.25*sp
    PA=expected_scatter(A); PB=expected_scatter(B); allp=PA+PB
    xr=rng([p[0] for p in allp]); yr=rng([p[1] for p in allp])
    ins=lambda p: xr[0]<=p[0]<=xr[1] and yr[0]<=p[1]<=yr[1]
    nA,nB=len(PA),len(PB); rA=pearson([p for p in PA if ins(p)]); rB=pearson([p for p in PB if ins(p)])
    print('独立実装: 範囲外',len(allp)-sum(1 for p in allp if ins(p)),'yrange',[round(x,1) for x in yr])
    t=ro(pg); print(t)
    m=re.search(r'A\(青\): (\d+)点 相関 r=([+\-\d.]+).*B\(緑\): (\d+)点 相関 r=([+\-\d.]+)',t)
    chk('SCATTER(速度×縦加速度): 点数が独立実装と一致',m and int(m.group(1))==nA and int(m.group(3))==nB,(m and m.groups(),nA,nB))
    chk('SCATTER: 相関係数が独立実装と一致(±0.02)',m and abs(float(m.group(2))-rA)<0.02 and abs(float(m.group(4))-rB)<0.02,(m and m.groups(),round(rA,3),round(rB,3)))
    # 描画: 青・緑の点が描かれている
    px=pg.evaluate("""()=>{const cv=document.getElementById('cp-canvas');const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;let a=0,g=0;
      for(let i=0;i<d.length;i+=4){ if(d[i+3]>100){ if(d[i+2]>200&&d[i]<120) a++; else if(d[i+1]>120&&d[i]<70&&d[i+2]<110) g++; } } return [a,g]}""")
    chk('SCATTER: A(青)・B(緑)の点が描かれる',px[0]>20 and px[1]>20,px)
    # タイム差
    sel(pg,'#cp-x','dist'); sel(pg,'#cp-y','delta'); t=ro(pg); print(t)
    chk('SCATTER(距離×タイム差): 描画され点数あり',re.search(r'A\(青\): \d+点',t) is not None,t)
    mm=re.search(r'r=([+\-\d.]+).*r=([+\-\d.]+)',t)
    chk('タイム差は A・B の点で同じ向き(B の符号が逆転しない)',mm and mm.group(1)==mm.group(2) or (mm and abs(float(mm.group(1))-float(mm.group(2)))<0.05),t)
    # 0〜100% の項目は軸固定: スロットル×ブレーキで外れ値扱いの非表示がない
    sel(pg,'#cp-x','throttle'); sel(pg,'#cp-y','brake'); t2=ro(pg)
    chk('スロットル×ブレーキ: 両端の値を隠さない(外れ値の表記なし)','外れ値' not in t2 and re.search(r'A\(青\): \d+点',t2) is not None,t2)
    sel(pg,'#cp-x','speed'); sel(pg,'#cp-y','accel')
    # ヒストグラム
    tab(pg,'hist'); sel(pg,'#cp-h','throttle'); print(ro(pg))
    ha,na=expected_hist(A,'thr'); hb,nb=expected_hist(B,'thr')
    ymax=math.ceil(max(max(ha),max(hb),5)/5)*5
    ba=bars(pg,(0x3D,0x9B,0xFF),20,ymax,half=0); bb=bars(pg,(0x1F,0x9E,0x57),20,ymax,half=1)
    err=max(max(abs(x-y) for x,y in zip(ba,ha)),max(abs(x-y) for x,y in zip(bb,hb)))
    chk('HISTOGRAM(スロットル): 棒の高さが独立実装と一致(±1.5%pt)',err<1.5,round(err,2))
    chk('HISTOGRAM: サンプル数が readout と一致',f'A(青): {na}サンプル' in ro(pg) and f'B(緑): {nb}サンプル' in ro(pg),ro(pg))
    sel(pg,'#cp-h','gear'); t=ro(pg)
    gA=sorted(set(s['gear'] for s in series(det[A]['samples'])[0]))
    chk('HISTOGRAM(ギア): 描画される',f'A(青): {na}サンプル' in t,t)
    # 別コース選択時: タイム差は不可
    row(pg,B); pg.wait_for_timeout(500); row(pg,OTHER); pg.wait_for_timeout(1500)   # B解除→OTHERがB
    tab(pg,'scatter'); sel(pg,'#cp-x','dist'); sel(pg,'#cp-y','delta')
    msg=pg.evaluate("1")  # canvas文言は画素なのでreadout空を確認
    chk('別コースのA/B: タイム差では readout が空(メッセージ表示)',ro(pg)=='',ro(pg))
    chk('pageerror 0',not errs,errs); b.close()
    # A のみ
    b,pg,errs=mk(pw); row(pg,A); pg.wait_for_timeout(1500); t=ro(pg)
    chk('Aのみ: B は「--」',('B(緑): 0点' in t) or ('B(緑): --' in t) ,t); chk('pageerror 0(Aのみ)',not errs,errs); b.close()
    # レイアウト
    for vw,vh in ((390,844),(1920,1080)):
        b,pg,errs=mk(pw,vw,vh); row(pg,A); pg.wait_for_timeout(600); row(pg,B); pg.wait_for_timeout(1500)
        pg.evaluate("document.getElementById('cp-review-card').scrollIntoView()"); pg.wait_for_timeout(400)
        sw=pg.evaluate("[document.documentElement.scrollWidth,innerWidth]"); chk(f'{vw}px: 横スクロールなし',sw[0]<=sw[1],sw)
        cw=pg.evaluate("(()=>{const c=document.getElementById('cp-canvas').getBoundingClientRect(),k=document.getElementById('cp-review-card').getBoundingClientRect();return [Math.round(c.right),Math.round(k.right)]})()")
        chk(f'{vw}px: canvas がカード内に収まる',cw[0]<=cw[1],cw)
        pg.screenshot(path=f'{OUT}/cp555_{vw}_scatter.png')
        tab(pg,'hist'); pg.wait_for_timeout(300); pg.screenshot(path=f'{OUT}/cp555_{vw}_hist.png')
        chk(f'{vw}px: pageerror 0',not errs,errs); b.close()
print('PASS',ok[0],'FAIL',ok[1])
