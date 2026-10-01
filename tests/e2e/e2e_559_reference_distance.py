"""#559 ラップタイム予測の参照距離: 複数周回を含む記録・途中切れに引きずられず、単独周回の塊の中央値を使う。

本番 API には依存しない(フィクスチャ + 合成した長い記録)。独立した Python 実装と照合する。
"""
import json, math, re
from urllib.parse import unquote
from playwright.sync_api import sync_playwright
from e2e_env import S, BASE

idx=json.load(open(f'{S}/fx_trend/index.json')); lap=[r['lap'] for r in idx]
det={m['file']:json.load(open(f"{S}/fx_trend/{m['file']}")) for m in lap}
# 一覧は新しい順(本番 API と同じ)。先頭に、複数周回を含む長い記録(距離1.9倍、Lap-1)を置く
lap=sorted(lap,key=lambda m:m['recorded_at'],reverse=True)
long_m=dict(lap[0]); long_m['file']='2026-09-25_18_00_00_CAR-3346_Lap-1.json'; long_m['lap_number']=1
dl=json.loads(json.dumps(det[lap[0]['file']]))
for s in dl['samples']: s['position_x']*=1.9; s['position_z']*=1.9
det[long_m['file']]=dl; lap=[long_m]+lap
ok=[0,0]
def chk(n,c,x=''): ok[0 if c else 1]+=1; print('PASS' if c else 'FAIL',n,x)

def dist(f):
    d=0; p=None
    for s in det[f]['samples']:
        x,z=s.get('position_x'),s.get('position_z')
        if x is None or z is None: p=None; continue
        if p is not None:
            c=math.hypot(x-p[0],z-p[1])
            if c<=120: d+=c
        p=(x,z)
    return d
def med(a):
    a=sorted(a); n=len(a); return a[n//2] if n%2 else (a[n//2-1]+a[n//2])/2
def expected(course):
    order=[m for m in lap if (m.get('lap_number') or 0)>=2]+[m for m in lap if (m.get('lap_number') or 0)<2]
    ds=[]
    for m in order[:30]:
        if len(ds)>=6: break
        if det[m['file']]['meta']['course']['id']!=course: continue
        ds.append(dist(m['file']))
    best=[]
    for a in ds:
        mem=[d for d in ds if abs(d-a)<=a*0.03]
        if len(mem)>len(best): best=mem
    return med(best) if len(best)>1 else med(ds)

with sync_playwright() as pw:
    b=pw.chromium.launch(args=['--no-sandbox']); pg=b.new_page(); n=[0]; errs=[]
    pg.on('pageerror',lambda e:errs.append(str(e)))
    def h(r):
        path=re.sub(r'^https?://[^/]+','',r.request.url).split('?')[0]
        if path.startswith('/api/laps'): n[0]+=1
        if path=='/api/laps': r.fulfill(status=200,content_type='application/json',body=json.dumps({'laps':lap}))
        elif path.startswith('/api/laps/'): r.fulfill(status=200,content_type='application/json',body=json.dumps(det[unquote(path[10:])]))
        else: r.fulfill(status=404,body='{}')
    pg.route('**/api/**',h); pg.goto(BASE+'/'); pg.wait_for_timeout(1200)
    p=pg.evaluate("""({
      a: lpPickReferenceDistance([8345,9547,6691,4732,5146,8092]),
      b: lpPickReferenceDistance([5146,5172,5172,5143,5141,5136]),
      c: lpPickReferenceDistance([5000]),
      d: lpPickReferenceDistance([]),
      e: lpPickReferenceDistance([8345,5150,9547,5172,5143,14038]),
      f: lpPickReferenceDistance([5000,6000]),
      ord: lpOrderReferenceCandidates([{lap_number:1,file:'a'},{lap_number:3,file:'b'},{lap_number:2,file:'c'},{lap_number:1,file:'d'}]).map(x=>x.file).join('')
    })""")
    chk('純関数: 長短混在(全て食い違う)は全体中央値',abs(p['a']-7391.5)<0.01,p['a'])
    chk('純関数: 揃った6本→中央値',5140<=p['b']<=5150,p['b'])
    chk('純関数: 1本→その値',p['c']==5000); chk('純関数: 空→0',p['d']==0)
    chk('純関数: 外れ値混在でも塊(5143,5150,5172)の中央値',p['e']==5150,p['e'])
    chk('純関数: 2本で食い違い→中央値',p['f']==5500,p['f'])
    chk('候補順: 周回番号2以上が先(新しい順維持)',p['ord']=='bcad',p['ord'])
    got=pg.evaluate("lpFetchReferenceDistance('spa','3346')"); exp=expected('spa')
    chk('参照距離が、独立実装(単独周回の塊の中央値)と一致(±0.5m)',got is not None and abs(got-exp)<0.5,(got,round(exp,1)))
    chk('最新の長い記録(1.9倍)に引きずられない',got is not None and got<dist(long_m['file'])*0.6,(got,round(dist(long_m['file']))))
    n[0]=0; r=[pg.evaluate("lpFetchReferenceDistance('no_such_course','3346')") for _ in range(3)]
    chk('同コースの記録が無い: 3回呼んでも走査は1回だけ(一覧1+詳細14)',r==[None,None,None] and n[0]==1+len(lap),(r,n[0]))
    chk('pageerror 0',not errs,errs); b.close()
print('PASS',ok[0],'FAIL',ok[1])
