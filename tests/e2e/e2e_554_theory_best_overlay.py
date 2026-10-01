import json, re, math
from datetime import datetime
from urllib.parse import unquote
from playwright.sync_api import sync_playwright
from e2e_env import S, BASE
idx=json.load(open(f'{S}/fx_trend/index.json')); lap=[r['lap'] for r in idx]
det={m['file']:json.load(open(f"{S}/fx_trend/{m['file']}")) for m in lap}
A,B=lap[10]['file'],lap[9]['file']; OV=[lap[0]['file'],lap[1]['file'],lap[3]['file']]
other=dict(lap[10]); other['file']='2026-09-25_17_00_00_CAR-3346_Lap-9.json'
d=json.loads(json.dumps(det[A])); d['meta']['course']=dict(d['meta']['course'],id='tokyo_expressway_east'); det[other['file']]=d; lap=lap+[other]
ok=[0,0]
def chk(n,c,x=''): ok[0 if c else 1]+=1; print('PASS' if c else 'FAIL',n,x)
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
        if s.get('position_x') is not None:
            if lx is not None:
                seg=math.hypot(s['position_x']-lx,s['position_z']-lz)
                if seg<=120: cum+=seg
            lx,lz=s['position_x'],s['position_z']
        out.append((cum,t))
    return out
def times(f):
    sm=series(det[f]['samples']); N=int(sm[-1][0]//10)+1; si=0; r=[]
    for k in range(N):
        dd=k*10
        while si<len(sm)-2 and sm[si+1][0]<dd: si+=1
        a=sm[si]; b=sm[min(si+1,len(sm)-1)]; span=b[0]-a[0]; f_=(dd-a[0])/span if span>0 else 0; f_=max(0,min(1,f_)); r.append(a[1]+(b[1]-a[1])*f_)
    return r
def gain(files):
    rs=[times(f) for f in files]; n=min(len(r) for r in rs); th=0
    for s in range(20):
        i0=(n-1)*s//20; i1=(n-1)*(s+1)//20; th+=min(r[i1]-r[i0] for r in rs)
    best=min(r[n-1]-r[0] for r in rs); return max(0,best-th)
def run(base,overlays=True):
    with sync_playwright() as pw:
        b=pw.chromium.launch(args=['--no-sandbox']); pg=b.new_context(viewport={'width':1600,'height':900}).new_page(); errs=[]
        pg.on('pageerror',lambda e:errs.append(str(e)))
        def h(r):
            path=re.sub(r'^https?://[^/]+','',r.request.url).split('?')[0]
            if path=='/api/laps': r.fulfill(status=200,content_type='application/json',body=json.dumps({'laps':lap}))
            elif path.startswith('/api/laps/'): r.fulfill(status=200,content_type='application/json',body=json.dumps(det[unquote(path[10:])]))
            else: r.fulfill(status=404,body='{}')
        pg.route('**/api/**',h); pg.goto(base+'/'); pg.wait_for_timeout(1200)
        pg.evaluate("document.getElementById('review-mode-btn').click()"); pg.wait_for_timeout(1500)
        row=lambda f: pg.evaluate("(f)=>document.querySelector('.review-lap-item[data-file=\"'+f+'\"]').click()",f)
        ov=lambda f: pg.evaluate("(f)=>document.querySelector('.review-lap-item[data-file=\"'+f+'\"] .review-lap-ov').click()",f)
        th=lambda: pg.evaluate("document.getElementById('review-sum-theory').textContent")
        row(A); pg.wait_for_timeout(500); row(B); pg.wait_for_timeout(1500); t2=th()
        if not overlays:
            b.close(); return t2,None,None,None,errs
        for f in OV: ov(f); pg.wait_for_timeout(1500)
        t5=th(); ov(other['file']); pg.wait_for_timeout(1500); t5b=th()
        ov(OV[0]); pg.wait_for_timeout(1200); t4=th()
        b.close(); return t2,t5,t5b,t4,errs
g=lambda t: float(re.search(r'−([\d.]+)s',t).group(1))
n=run(BASE)
print('A+B :',n[0]); print('new +3  :',n[1]); print('new +別コース:',n[2]); print('new -1  :',n[3])
chk('A/B のみでは、重ね書きの対応前と同一の表示',n[0]=='理論ベスト: 1:22.662 (実ベスト比 −0.93s)',n[0])
e2=gain([A,B]); e5=gain([A,B]+OV); e4=gain([A,B]+OV[1:])
chk('A/B のみの取りこぼし: 独立実装と一致',abs(g(n[0])-e2)<0.006,(g(n[0]),round(e2,3)))
chk('A/B+重ね書き3本: 5本から合成と表示',('5本から合成' in n[1]),n[1])
chk('5本の取りこぼしが独立実装と一致(±0.006s)',abs(g(n[1])-e5)<0.006,(g(n[1]),round(e5,3)))
chk('本数が増えると取りこぼしは減らない(単調)',g(n[1])>=g(n[0])-1e-9)
chk('別コースの重ね書きは合成に含めない(表示不変)',n[2]==n[1],n[2])
chk('1本外すと4本から合成(独立実装と一致)',('4本から合成' in n[3]) and abs(g(n[3])-e4)<0.006,(n[3],round(e4,3)))
chk('pageerror 0',not n[4],n[4])
print('PASS',ok[0],'FAIL',ok[1])
