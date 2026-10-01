"""#563 過去の自己ベストを基準にするライブのデルタ 検証(記録済みラップの再生でライブ経路を駆動)。"""
import json, re, math
from datetime import datetime
from urllib.parse import unquote
from playwright.sync_api import sync_playwright
from e2e_env import S, OUT, BASE
idx=json.load(open(f'{S}/fx_trend/index.json')); LAP=[r['lap'] for r in idx]
DET={m['file']:json.load(open(f"{S}/fx_trend/{m['file']}")) for m in LAP}
CAR={m['file']:m['car_id'] for m in LAP}
BEST=LAP[10]['file']                       # 83.589 s(最速の単独周回)
PLAY=LAP[3]['file']                        # 85.6 s(再生する、より遅い周回)
# ---- 罠: 途中で切れた速い記録・別コースの速い記録 ----
n0=len(DET[BEST]['samples']); k=int(n0*0.3)
trunc=dict(LAP[10]); trunc['file']='2026-09-25_17_00_00_CAR-3346_Lap-9.json'
dt=json.loads(json.dumps(DET[BEST])); dt['samples']=dt['samples'][:k]; dt['meta']['laptime_ms_approx']=25000; DET[trunc['file']]=dt
oc=dict(LAP[10]); oc['file']='2026-09-25_17_10_00_CAR-3346_Lap-8.json'
do=json.loads(json.dumps(DET[BEST])); do['meta']['course']=dict(do['meta']['course'],id='other_course'); do['meta']['laptime_ms_approx']=60000; DET[oc['file']]=do
huge=dict(LAP[10]); huge['file']='2026-09-25_17_20_00_CAR-3346_Lap-7.json'; huge['size_bytes']=90_000_000
dh=json.loads(json.dumps(DET[BEST])); dh['meta']['laptime_ms_approx']=80000; DET[huge['file']]=dh
ALL=LAP+[trunc,oc,huge]
for m in (trunc,oc,huge): CAR[m['file']]=3346
ok=[0,0]
def chk(n,c,x=''): ok[0 if c else 1]+=1; print('PASS' if c else 'FAIL',n,x)

def res_time(f):
    sm=[];cum=0;t=0;lx=lz=None;pts=None
    for s in DET[f]['samples']:
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
        sm.append((cum,t))
    N=int(sm[-1][0]//10)+1; si=0; R=[]
    for k in range(N):
        dd=k*10
        while si<len(sm)-2 and sm[si+1][0]<dd: si+=1
        a=sm[si]; b=sm[min(si+1,len(sm)-1)]; sp=b[0]-a[0]; fr=(dd-a[0])/sp if sp>0 else 0; fr=max(0,min(1,fr)); R.append(a[1]+(b[1]-a[1])*fr)
    return R,sm[-1][0]
def ref_at(R,d):
    N=len(R); i=int(d//10); i=max(0,min(N-2,i)); fr=(d-i*10)/10; fr=max(0,min(1,fr)); return R[i]+(R[i+1]-R[i])*fr

def mk(pw,laps=ALL,fail_list=False,vw=1600,vh=900,delay_ms=0,fail_first=False):
    b=pw.chromium.launch(args=['--no-sandbox']); c=b.new_context(viewport={'width':vw,'height':vh}); pg=c.new_page(); errs=[]; log={'list':0,'detail':0,'best':0,'by_car':{},'files':[]}; seen_fail=[False]
    pg.on('pageerror',lambda e:errs.append(str(e)))
    def h(r):
        url=r.request.url; path=re.sub(r'^https?://[^/]+','',url).split('?')[0]
        if path=='/api/laps':
            if 'limit=60' in url:
                log['list']+=1      # persistent-ref.js の呼び出しだけ(REVIEW の一覧・予測の参照距離は別)
                car=re.search(r'car_id=(\d+)',url).group(1); log['by_car'][car]=log['by_car'].get(car,0)+1
                if fail_first and not seen_fail[0]: seen_fail[0]=True; r.fulfill(status=500,body='{}'); return
            if fail_list: r.fulfill(status=500,body='{}'); return
            r.fulfill(status=200,content_type='application/json',body=json.dumps({'laps':laps}))
        elif path.startswith('/api/laps/'):
            f=unquote(path[10:]); d=json.loads(json.dumps(DET[f]))
            if 'every=60' in url:
                log['detail']+=1; log['files'].append(f)
                if delay_ms: pg.wait_for_timeout(delay_ms)
            if 'every=6' in url and 'every=60' not in url and 'fields=' not in url: log['best']+=1; log.setdefault('best_files',[]).append(f)
            if 'fields=' in url and 'position_x,position_z' not in url:
                for s in d['samples']: s['car_id']=CAR[f]; cc=d['meta']['course']; s['course']=dict(cc,name=(cc.get('name_en') or cc.get('name_ja') or cc['id']))
            r.fulfill(status=200,content_type='application/json',body=json.dumps(d))
        else: r.fulfill(status=404,body='{}')
    pg.route('**/api/**',h); pg.goto(BASE+'/'); pg.wait_for_timeout(1200)
    return b,pg,errs,log
def play(pg,f,wait=3500,speed=None):
    pg.evaluate("document.getElementById('review-mode-btn').click()"); pg.wait_for_timeout(1500)
    pg.evaluate(f"replayStart({json.dumps(f)})"); pg.wait_for_function("replayState.frames && replayState.frames.length>100",timeout=60000)
    if speed: pg.evaluate(f"(()=>{{const s=document.getElementById('replay-speed'); s.value='{speed}'; s.dispatchEvent(new Event('change',{{bubbles:true}}))}})()")
    pg.wait_for_timeout(wait)
ev=lambda pg,js: pg.evaluate(js)
with sync_playwright() as pw:
    # ---- 1. 過去のベストが、走り始めから基準になる ----
    b,pg,errs,log=mk(pw); play(pg,PLAY)
    tt=ev(pg,"analysisState.refLap&&analysisState.refLap.totalTime"); lab=ev(pg,"document.getElementById('ref-source').textContent")
    chk('基準が、過去の最速の単独周回(83.589 s)になる',tt is not None and abs(tt-83.589)<0.002,tt)
    chk('罠(途中切れの速い記録・別コースの速い記録・巨大な記録)は選ばれない',log.get('best_files')==[BEST],log.get('best_files'))
    chk('巨大な記録(90MB)は、概要の取得もしない',huge['file'] not in log['files'],log['files'][:3])
    chk('由来が表示される(過去のベスト 1:23.589 と日付)','過去のベスト 1:23.589' in lab and '2026-09-25' in lab,lab)
    # 独立検証: 再生中のデルタ = ラップ内クロック − 基準の距離ごとの通過時刻(最速の周回)
    R,tot=res_time(BEST)
    errsd=[]
    for i in range(6):
        pg.wait_for_timeout(1200)
        st=ev(pg,"({d:analysisState.curLap.cumDist,t:analysisState.lapClockS,live:analysisState._liveDelta,rt:analysisState.refLap.totalDist})")
        d=min(st['d'],st['rt']); exp=st['t']-ref_at(R,d); errsd.append(abs(st['live']-exp))
    chk('ライブのデルタが、独立計算(クロック−最速周回の通過時刻)と一致(±0.05s)',max(errsd)<0.05,[round(x,3) for x in errsd])
    txt=ev(pg,"document.getElementById('lap-delta').textContent")
    chk('DELTA VS BEST の表示に、値が出ている',bool(re.match(r'^[+-]?\d+\.\d\ds$',txt)),txt)
    n_detail=log['detail']; pg.wait_for_timeout(3500)
    chk('取得は組み合わせごとに1回だけ(毎秒は問い合わせない)',log['list']==1 and log['detail']==n_detail and log['detail']<=20,log)
    # ---- 2. resetAnalysis で消えても、入れ直す ----
    ev(pg,"resetAnalysis()"); ev(pg,"true"); pg.wait_for_timeout(1800)
    chk('resetAnalysis() で基準が消えても、1〜2秒で入れ直す',abs((ev(pg,"analysisState.refLap&&analysisState.refLap.totalTime") or 0)-83.589)<0.002)
    # ---- 3. その日のベストが、過去のベストより速い場合 ----
    ev(pg,"(()=>{const r=JSON.parse(JSON.stringify(analysisState.refLap)); r.totalTime=70.0; analysisState.refLap=r; window.__sess=r;})()"); pg.wait_for_timeout(1500)
    lab=ev(pg,"document.getElementById('ref-source').textContent")
    chk('その日のベストのほうが速いときは、基準を書き換えない',ev(pg,"analysisState.refLap===window.__sess") and 'このセッションのベスト' in lab,lab)
    # ---- 4. オフ/オン ----
    ev(pg,"analysisState.refLap=null"); pg.wait_for_timeout(1500)
    pg.click('#ref-persistent-toggle'); pg.wait_for_timeout(300)
    chk('オフにすると、過去のベストの基準を外す(従来の基準なし)',ev(pg,"analysisState.refLap===null") and ev(pg,"localStorage.getItem('gt7.persistentRef')")=='0' and ev(pg,"document.getElementById('ref-persistent-toggle').getAttribute('aria-pressed')")=='false')
    pg.wait_for_timeout(2000); chk('オフの間は、入れ直さない',ev(pg,"analysisState.refLap===null"))
    pg.click('#ref-persistent-toggle'); pg.wait_for_timeout(1800)
    chk('オンに戻すと、また基準になる',abs((ev(pg,"analysisState.refLap&&analysisState.refLap.totalTime") or 0)-83.589)<0.002)
    chk('pageerror 0',not errs,errs); b.close()
    # ---- 5. オフから読み込み直しても、設定が残る ----
    b,pg,errs,log=mk(pw); pg.evaluate("localStorage.setItem('gt7.persistentRef','0')"); pg.reload(); pg.wait_for_timeout(1500)
    play(pg,PLAY,wait=3000)
    chk('オフで保存されていれば、基準にしない(リクエストもしない)',ev(pg,"analysisState.refLap===null") and log['list']==0 and ev(pg,"document.getElementById('ref-persistent-toggle').getAttribute('aria-pressed')")=='false',log); b.close()
    # ---- 6. 該当なし(一覧が空/取得失敗)→ 従来どおり ----
    for label,kw,word in (('一覧が空',dict(laps=[]),'該当なし'),('一覧の取得に失敗',dict(fail_list=True),'取得できません')):
        b,pg,errs,log=mk(pw,**kw); play(pg,PLAY,wait=3500)
        lab=ev(pg,"document.getElementById('ref-source').textContent")
        chk(f'{label}: 基準は入らず、「{word}」と表示・エラーなし(取得失敗は「該当なし」と確定させない)',ev(pg,"analysisState.refLap===null") and word in lab and not errs and (('該当なし' in lab)==(word=='該当なし')),(lab,errs)); b.close()
    # ---- 7. 候補が3周未満 → 使わない ----
    few=[m for m in LAP if m['file'] in (BEST,LAP[9]['file'])]
    b,pg,errs,log=mk(pw,laps=few); play(pg,PLAY,wait=3500)
    chk('候補が3周未満なら、使わない(中央値が頼りにならない)',ev(pg,"analysisState.refLap===null"),ev(pg,"analysisState.refLap&&analysisState.refLap.totalTime")); b.close()
    # ---- 8. REVIEW 表示中は何もしない ----
    b,pg,errs,log=mk(pw); pg.evaluate("document.getElementById('review-mode-btn').click()"); pg.wait_for_timeout(2500)
    chk('REVIEW 表示中は、一覧・概要を取りに行かない',log['list']<=1 and log['detail']==0,log); b.close()
    # ---- 8b. TEST MODE は対象外(合成データ) ----
    b,pg,errs,log=mk(pw); pg.evaluate("document.getElementById('test-mode-btn').click()"); pg.wait_for_timeout(5000)
    chk('TEST MODE: 過去の周回を取りに行かず、基準も書き換えない',log['list']==0 and ev(pg,"document.getElementById('ref-source').textContent")=='',(log,)); b.close()
    # ---- 8c. 取得の一時的な失敗は「該当なし」にせず、毎秒は再試行しない ----
    b,pg,errs,log=mk(pw,fail_first=True); play(pg,PLAY,wait=5500)
    lab=ev(pg,"document.getElementById('ref-source').textContent")
    chk('一時的な失敗: 「該当なし」と確定させず、取得できない旨を表示・毎秒は再試行しない',('取得できません' in lab) and ('該当なし' not in lab) and log['list']==1,(lab,log['list']))
    chk('一時的な失敗: エラーなし・基準は入らない',not errs and ev(pg,"analysisState.refLap===null"),errs); b.close()
    # ---- 8d. 読み込み中に組み合わせが変わっても、二重に取得しない(状態の競合) ----
    b,pg,errs,log=mk(pw,delay_ms=350); play(pg,PLAY,wait=9000)
    chk('(前提)最初の読み込みが終わり、基準が入っている',abs((ev(pg,"analysisState.refLap&&analysisState.refLap.totalTime") or 0)-83.589)<0.002,log['by_car'])
    ev(pg,"replayState.playing=false")
    ev(pg,"document.getElementById('car-id').textContent='9999'"); pg.wait_for_timeout(1300)      # 9999 の読み込みが始まる(遅い)
    ev(pg,"document.getElementById('car-id').textContent='8888'"); pg.wait_for_timeout(11000)     # 8888 に変わる → 9999 の古い読み込みが終わる
    chk('組み合わせが変わっても、各組み合わせの取得は1回だけ(古い読み込みの完了で二重に始めない)',log['by_car'].get('8888')==1 and log['by_car'].get('9999')==1,log['by_car'])
    chk('pageerror 0(競合)',not errs,errs); b.close()
    # ---- 9. レイアウト ----
    for vw,vh in ((390,844),(1920,1080)):
        b,pg,errs,log=mk(pw,vw=vw,vh=vh); play(pg,PLAY,wait=3000)
        pg.evaluate("document.querySelector('.delta-card').scrollIntoView()"); pg.wait_for_timeout(300)
        sw=ev(pg,"[document.documentElement.scrollWidth,innerWidth]"); chk(f'{vw}px: 横スクロールなし',sw[0]<=sw[1],sw)
        cw=ev(pg,"(()=>{const r=document.querySelector('.ref-source-row').getBoundingClientRect(),c=document.querySelector('.delta-card').getBoundingClientRect();return [Math.round(r.right),Math.round(c.right)]})()")
        chk(f'{vw}px: 由来の行がカード内に収まる',cw[0]<=cw[1]+1,cw)
        pg.screenshot(path=f'{OUT}/pr563_{vw}.png'); chk(f'{vw}px: pageerror 0',not errs,errs); b.close()
print('PASS',ok[0],'FAIL',ok[1])
raise SystemExit(1 if ok[1] else 0)
