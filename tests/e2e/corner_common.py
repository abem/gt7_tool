"""コーナー別レポート系(#561/#562/#565)の e2e テストの共通部。

実データのラップのフィクスチャ、仕様から独立して書いた Python 実装(10m への再サンプル・コーナー検出・
操作の指標)、ブラウザの操作(API の差し替え・A/B の選択・表の読み取り)をまとめる。
"""
import json,re,math,sys
from datetime import datetime
from urllib.parse import unquote
from playwright.sync_api import sync_playwright
from e2e_env import S, OUT, BASE
idx=json.load(open(f'{S}/fx_trend/index.json')); lap=[r['lap'] for r in idx]
det={m['file']:json.load(open(f"{S}/fx_trend/{m['file']}")) for m in lap}
A,B=lap[10]['file'],lap[9]['file']              # 83.6s / 83.8s
C=lap[8]['file']; D=lap[12]['file']              # 別ペア(タイム差の大きい周回)
other=dict(lap[10]); other['file']='2026-09-25_17_00_00_CAR-3346_Lap-9.json'
d=json.loads(json.dumps(det[A])); d['meta']['course']=dict(d['meta']['course'],id='tokyo_expressway_east'); det[other['file']]=d
longm=dict(lap[10]); longm['file']='2026-09-25_17_10_00_CAR-3346_Lap-8.json'
dl=json.loads(json.dumps(det[A]))
for smp in dl['samples']: smp['position_x']*=1.5; smp['position_z']*=1.5
det[longm['file']]=dl; lap=lap+[other,longm]
ok=[0,0]
def chk(n,c,x=''): ok[0 if c else 1]+=1; print('PASS' if c else 'FAIL',n,x)

# ---------------- 独立実装(仕様: 平均速度の谷→区間→操作の指標) ----------------
def res_of(f):
    sm=[];cum=0;t=0;lx=lz=None;pts=None
    for s in det[f]['samples']:
        ts=s.get('timestamp')
        if ts:
            v=datetime.fromisoformat(ts.replace('Z','+00:00')).timestamp()
            if pts is not None and 0<v-pts<2.0: t+=v-pts
            pts=v
        if s.get('position_x') is not None:
            if lx is not None:
                g=math.hypot(s['position_x']-lx,s['position_z']-lz)
                if g<=120: cum+=g
            lx,lz=s['position_x'],s['position_z']
        sm.append((cum,t,s.get('speed_kmh') or 0,s.get('throttle_pct') or 0,s.get('brake_pct') or 0))
    N=int(sm[-1][0]//10)+1; si=0; R={k:[] for k in('dist','time','speed','thr','brk')}
    for k in range(N):
        dd=k*10
        while si<len(sm)-2 and sm[si+1][0]<dd: si+=1
        a=sm[si]; b=sm[min(si+1,len(sm)-1)]; sp=b[0]-a[0]; fr=(dd-a[0])/sp if sp>0 else 0; fr=max(0,min(1,fr))
        R['dist'].append(dd)
        for key,i in (('time',1),('speed',2),('thr',3),('brk',4)): R[key].append(a[i]+(b[i]-a[i])*fr)
    return R
def corners(ra,rb):
    n=min(len(ra['dist']),len(rb['dist']))
    vm=[(ra['speed'][k]+rb['speed'][k])/2 for k in range(n)]
    vs=[sum(vm[max(0,k-1):min(n,k+2)])/len(vm[max(0,k-1):min(n,k+2)]) for k in range(n)]
    cand=[]
    for k in range(5,n-5):
        win=vs[k-5:k+6]
        if vs[k]!=min(win) or win.index(vs[k])!=5: continue
        left=max(vs[max(0,k-40):k+1]); right=max(vs[k:min(n,k+41)])
        if min(left,right)-vs[k]>=12: cand.append(k)
    ap=[]
    for k in cand:
        if ap and k-ap[-1]<=6:
            if vs[k]<vs[ap[-1]]: ap[-1]=k
        else: ap.append(k)
    am=lambda lo,hi: max(range(lo,hi+1),key=lambda i:(vs[i],-i))
    out=[]
    for i,a in enumerate(ap):
        st=am(max(0,a-40),a) if i==0 else am(ap[i-1]+1,a)
        out.append([a,st,0])
    for i in range(len(out)):
        out[i][2]=out[i+1][1] if i+1<len(out) else am(out[i][0],min(n-1,out[i][0]+40))
        if out[i][2]<=out[i][0]: out[i][2]=min(n-1,out[i][0]+1)
    return out
def metrics(r,c):
    a,s,e=c
    bi=next((k for k in range(s,a+1) if r['brk'][k]>=10),-1)
    pk=max(r['brk'][s:a+1]); pki=s+r['brk'][s:a+1].index(pk)
    rate=None
    if bi>=0 and pk>=30:
        k90=next((k for k in range(bi,a+1) if r['brk'][k]>=0.9*pk),-1)
        if k90>=0 and 0.9*pk-r['brk'][bi]>0: rate=(0.9*pk-r['brk'][bi])/max(r['time'][k90]-r['time'][bi],0.05)
    rel=None
    if bi>=0:
        rel=next((r['dist'][k] for k in range(pki+1,e+1) if r['brk'][k]<10),None)
    mi=min(range(s,e+1),key=lambda k:(r['speed'][k],k))
    ti=next((k for k in range(mi,e+1) if r['thr'][k]>=30),-1)
    return dict(brakePos=r['dist'][bi] if bi>=0 else None,peak=pk,rate=rate,rel=rel,minv=r['speed'][mi],
                thr=r['dist'][ti] if ti>=0 else None,exitv=r['speed'][min(e,mi+10)],time=r['time'][e]-r['time'][s],
                entry=r['speed'][bi] if bi>=0 else r['speed'][s])
def expected(fa,fb):
    ra,rb=res_of(fa),res_of(fb); cs=corners(ra,rb)
    return [dict(n=i+1,apex=ra['dist'][c[0]],a=metrics(ra,c),b=metrics(rb,c)) for i,c in enumerate(cs)]

# ---------------- ブラウザ ----------------
def mk(pw,vw=1600,vh=900):
    b=pw.chromium.launch(args=['--no-sandbox','--use-gl=swiftshader']); pg=b.new_context(viewport={'width':vw,'height':vh}).new_page(); errs=[]
    pg.on('pageerror',lambda e:errs.append(str(e)))
    def h(r):
        path=re.sub(r'^https?://[^/]+','',r.request.url).split('?')[0]
        if path=='/api/laps': r.fulfill(status=200,content_type='application/json',body=json.dumps({'laps':lap}))
        elif path.startswith('/api/laps/'): r.fulfill(status=200,content_type='application/json',body=json.dumps(det[unquote(path[10:])]))
        else: r.fulfill(status=404,body='{}')
    pg.route('**/api/**',h); pg.goto(BASE+'/'); pg.wait_for_timeout(1200)
    pg.evaluate("document.getElementById('review-mode-btn').click()"); pg.wait_for_timeout(1500)
    return b,pg,errs
row=lambda pg,f: pg.evaluate("(f)=>document.querySelector('.review-lap-item[data-file=\"'+f+'\"]').click()",f)
def select(pg,f1,f2):
    row(pg,f1); pg.wait_for_timeout(500); row(pg,f2); pg.wait_for_timeout(1800)
def table(pg):
    return pg.evaluate("""Array.from(document.querySelectorAll('#cr-table tbody tr')).map(tr=>Array.from(tr.children).map(td=>td.textContent))""")
def pairv(t):
    a,b=t.split(' / '); f=lambda x: None if x=='--' else float(x); return f(a),f(b)
def compare(pg,fa,fb,label):
    exp=expected(fa,fb); got=table(pg)
    chk(f'{label}: コーナー数が独立実装と一致',len(got)==len(exp),(len(got),len(exp)))
    if len(got)!=len(exp): return exp,got
    worst=dict(pos=0,spd=0,dt=0); miss=0
    for e,g in zip(exp,got):
        chk_apex=abs(float(g[1])-e['apex'])<=0.5
        if not chk_apex: miss+=1
        for col,ka,kb,kind in ((3,'brakePos','brakePos','pos'),(4,'peak','peak','spd'),(6,'minv','minv','spd'),(7,'thr','thr','pos'),(8,'exitv','exitv','spd')):
            va,vb=pairv(g[col]); ea,eb=e['a'][ka],e['b'][kb]
            for v,x in ((va,ea),(vb,eb)):
                if (v is None)!=(x is None): miss+=1; continue
                if v is not None: worst[kind]=max(worst[kind],abs(v-x))
        gdt=float(g[2].replace('−','-').replace('+','')); edt=e['a']['time']-e['b']['time']
        worst['dt']=max(worst['dt'],abs(gdt-edt))
    rate_err=0
    for e,g in zip(exp,got):
        va,vb=pairv(g[5])
        for v,x in ((va,e['a']['rate']),(vb,e['b']['rate'])):
            if (v is None)!=(x is None): rate_err=999
            elif v is not None: rate_err=max(rate_err,abs(v-x)/max(abs(x),1))
    chk(f'{label}: 踏み込み %/s が一致(相対2%、時刻の精度差を許容)',rate_err<=0.02,round(rate_err,4))
    chk(f'{label}: 位置(コーナー・ブレーキ・スロットル)が一致(±1m、表示は丸め)',worst['pos']<=1.0 and miss==0,(worst,miss))
    chk(f'{label}: 速度・ブレーキ量が一致(±1)',worst['spd']<=1.0,worst)
    chk(f'{label}: Δタイムが一致(±0.006s)',worst['dt']<=0.006,worst)
    return exp,got
