"""#562 CONSISTENCY 検証: 実データのラップ + 仕様から独立した Python 実装との照合。"""
import json, re, math
from corner_common import *  # noqa: F401,F403
# 少数周回の車(算出しないケース用): 車9999 の2周
for i,src in enumerate((A,B)):
    m=dict([x for x in lap if x['file']==src][0]); m['file']=f'2026-09-25_18_0{i}_00_CAR-9999_Lap-{i+2}.json'; m['car_id']=9999
    dd=json.loads(json.dumps(det[src])); dd['meta']['car_id']=9999; dd['meta']['file']=m['file']; det[m['file']]=dd; lap.append(m)
FEW=[x['file'] for x in lap if 'CAR-9999' in x['file']]

def dist_of(f):
    cum=0;lx=lz=None
    for s in det[f]['samples']:
        if s.get('position_x') is not None:
            if lx is not None:
                g=math.hypot(s['position_x']-lx,s['position_z']-lz)
                if g<=120: cum+=g
            lx,lz=s['position_x'],s['position_z']
    return cum
def expected_cons(fa,fb):
    car=det[fa]['meta']['car_id']; course=det[fa]['meta']['course']['id']
    cand=sorted([m for m in lap if m['car_id']==car],key=lambda m:m['recorded_at'],reverse=True)
    chosen=[fa,fb]; tried=0; ref=dist_of(fa)
    for m in cand:
        if len(chosen)>=16 or tried>=40: break
        if m['file'] in chosen: continue
        tried+=1
        if det[m['file']]['meta']['course']['id']!=course: continue
        d=dist_of(m['file'])
        if abs(ref-d)/max(ref,d)>0.03: continue
        chosen.append(m['file'])
    # ラップタイムが中央値から±10%超の周回を除く(A/B は残す)。最大12周
    lt=lambda f: det[f]['meta']['laptime_ms_approx']
    ts=sorted(lt(f) for f in chosen); mid=len(ts)//2; med=ts[mid] if len(ts)%2 else (ts[mid-1]+ts[mid])/2
    chosen=[f for f in chosen if f in (fa,fb) or abs(lt(f)-med)/med<=0.10][:12]
    R=[res_of(f) for f in chosen]; n=min(len(r['dist']) for r in R)
    mean={'dist':R[0]['dist'][:n],'speed':[sum(r['speed'][k] for r in R)/len(R) for k in range(n)]}
    cs=corners(mean,mean)
    def sd(v):
        v=[x for x in v if x is not None]
        if len(v)<3: return None
        mu=sum(v)/len(v); return math.sqrt(sum((x-mu)**2 for x in v)/(len(v)-1))
    out=[]
    for i,c in enumerate(cs):
        ms=[metrics(r,c) for r in R]
        out.append(dict(n=i+1,apex=R[0]['dist'][c[0]],sdb=sd([m['brakePos'] for m in ms]),sdv=sd([m['minv'] for m in ms]),
                        sdt=sd([m['thr'] for m in ms]),sdtime=sd([m['time'] for m in ms]),
                        score=max([x for x in (None if sd([m['brakePos'] for m in ms]) is None else sd([m['brakePos'] for m in ms])/30,
                                              None if sd([m['minv'] for m in ms]) is None else sd([m['minv'] for m in ms])/12,
                                              None if sd([m['thr'] for m in ms]) is None else sd([m['thr'] for m in ms])/45) if x is not None] or [None]),
                        c=c))
    for o in out: o['level']=None if o['score'] is None else min(1,o['score'])
    return chosen,out

with sync_playwright() as pw:
    b,pg,errs=mk(pw)
    btn=lambda: pg.evaluate("document.getElementById('cr-cons-load').disabled")
    chk('未選択: 「ばらつきを読み込む」は無効',btn())
    select(pg,A,B)
    chk('A/B を選ぶと有効になり、案内が出る',not btn() and '読み込む' in pg.evaluate("document.getElementById('cr-cons-status').textContent"))
    pg.click('#cr-cons-load'); pg.wait_for_function("document.getElementById('cr-cons-table').querySelector('tbody')",timeout=60000); pg.wait_for_timeout(500)
    status=pg.evaluate("document.getElementById('cr-cons-status').textContent"); print(status)
    chosen,exp=expected_cons(A,B)
    m=re.match(r'(\d+) 周',status)
    chk('使う周回数が独立実装と一致',m and int(m.group(1))==len(chosen),(m and m.group(1),len(chosen)))
    got=pg.evaluate("Array.from(document.querySelectorAll('#cr-cons-table tbody tr')).map(tr=>Array.from(tr.children).map(td=>td.textContent))")
    chk('コーナー数が独立実装と一致',len(got)==len(exp),(len(got),len(exp)))
    def num(x): return None if x=='--' else float(x)
    worst=dict(sdb=0,sdv=0,sdt=0,tm=0); bad=0
    for e,g in zip(exp,got):
        if abs(float(g[1])-e['apex'])>0.5: bad+=1
        for key,col in (('sdb',2),('sdv',3),('sdt',4),('sdtime',5)):
            v=num(g[col]); x=e[key]
            if (v is None)!=(x is None): bad+=1; continue
            if v is not None: worst[{'sdtime':'tm'}.get(key,key)]=max(worst[{'sdtime':'tm'}.get(key,key)],abs(v-x))
    chk('コーナー位置が一致・値の有無が一致',bad==0,bad)
    chk('σ(ブレーキ位置・最低速度・スロットル位置)が一致(±0.06、表示は小数1桁)',max(worst['sdb'],worst['sdv'],worst['sdt'])<=0.06,worst)
    chk('σ(コーナータイム)が一致(±0.003s)',worst['tm']<=0.003,worst)
    # 安定度の判定
    lab=lambda l: '--' if l is None else ('安定' if l<0.34 else ('普通' if l<0.67 else 'ばらつき大'))
    chk('安定度の判定が独立実装と一致',all(g[6]==lab(e['level']) for e,g in zip(exp,got)),[(g[6],lab(e['level'])) for e,g in zip(exp,got)])
    adv=pg.evaluate("Array.from(document.querySelectorAll('#cr-cons-advice li')).map(l=>l.textContent)"); print(adv)
    top=max([e for e in exp if e['score'] is not None],key=lambda e:e['score'])
    chk('最もばらつくコーナー(飽和しない指標の最大)が提案の先頭',adv[0].startswith('T%d:'%top['n']) or top['level']<0.34,(adv[:1],top['n'],round(top['score'],2)))
    # トラックマップ: STABILITY に切り替わり、緑と赤の線が描かれる
    chk('地図が STABILITY に切り替わる',pg.evaluate("document.querySelector('[data-tm-mode=stability]').getAttribute('aria-pressed')")=='true')
    px=pg.evaluate("""()=>{const cv=document.getElementById('tm-canvas');const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;let g=0,r=0,n=0;
      for(let i=0;i<d.length;i+=4){ if(d[i+3]<200) continue; const R=d[i],G=d[i+1],B=d[i+2];
        if(G>150&&R<110&&B<110) g++; else if(R>190&&G<100&&B<100) r++; else if(Math.abs(R-75)<6&&Math.abs(G-85)<6&&Math.abs(B-99)<6) n++; }
      return [g,r,n]}""")
    lv=[e['level'] for e in exp if e['level'] is not None]; print('levels',[round(x,2) for x in lv])
    chk('地図に安定(緑)・ばらつき大(赤)・コーナー外(灰)の線が描かれる',(px[0]>20 or min(lv)>=0.34) and (px[1]>20 or max(lv)<0.67) and px[2]>20,(px,round(min(lv),2),round(max(lv),2)))
    # 行ホバーで区間強調
    pg.evaluate("window.__hl=[]; const o=window.tmHighlightRange; window.tmHighlightRange=function(a,b){window.__hl.push([a,b]); return o&&o(a,b)}")
    pg.hover('#cr-cons-table tbody tr:nth-child(2)'); pg.wait_for_timeout(200)
    rr=pg.evaluate("(()=>{const tr=document.querySelector('#cr-cons-table tbody tr:nth-child(2)');return [+tr.dataset.ccI0,+tr.dataset.ccI1]})()")
    chk('行ホバーで地図の該当区間を強調',pg.evaluate("window.__hl")[-1]==rr,rr)
    # 重ね書きの追加でも結果が残る / A/B を外すと消える
    ov=[m['file'] for m in lap if m['file'] not in (A,B)][0]
    pg.evaluate("(f)=>document.querySelector('.review-lap-item[data-file=\"'+f+'\"] .review-lap-ov').click()",ov); pg.wait_for_timeout(1500)
    chk('重ね書きの追加で結果が残る',len(pg.evaluate("Array.from(document.querySelectorAll('#cr-cons-table tbody tr')).map(t=>1)"))==len(exp))
    row(pg,A); pg.wait_for_timeout(300); row(pg,B); pg.wait_for_timeout(800)
    chk('A/B を外すと結果とボタンが消える',pg.evaluate("document.querySelectorAll('#cr-cons-table tbody tr').length")==0 and btn())
    # 周回が少ない車
    select(pg,FEW[0],FEW[1]); pg.click('#cr-cons-load'); pg.wait_for_timeout(2500)
    s=pg.evaluate("document.getElementById('cr-cons-status').textContent"); print(s)
    chk('周回が3本未満: 算出せず理由を表示',('算出しません' in s) and pg.evaluate("document.querySelectorAll('#cr-cons-table tbody tr').length")==0,s)
    row(pg,FEW[0]); pg.wait_for_timeout(300); row(pg,FEW[1]); pg.wait_for_timeout(600)
    # 読み込み中に A/B を変える: 古い結果は捨てられる
    select(pg,A,B); pg.click('#cr-cons-load'); pg.wait_for_timeout(50); row(pg,B); pg.wait_for_timeout(2500)
    chk('読み込み中に選択を変えると、古い結果は出ない',pg.evaluate("document.querySelectorAll('#cr-cons-table tbody tr').length")==0)
    chk('pageerror 0',not errs,errs); b.close()
    for vw,vh in ((390,844),(1920,1080)):
        b,pg,errs=mk(pw,vw,vh); select(pg,A,B); pg.click('#cr-cons-load'); pg.wait_for_function("document.getElementById('cr-cons-table').querySelector('tbody')",timeout=60000)
        pg.evaluate("document.getElementById('cr-cons').scrollIntoView()"); pg.wait_for_timeout(400)
        sw=pg.evaluate("[document.documentElement.scrollWidth,innerWidth]"); chk(f'{vw}px: 横スクロールなし',sw[0]<=sw[1],sw)
        cw=pg.evaluate("(()=>{const s=document.getElementById('cr-cons-scroll').getBoundingClientRect(),k=document.getElementById('cr-review-card').getBoundingClientRect();return [Math.round(s.right),Math.round(k.right)]})()")
        chk(f'{vw}px: 表がカード内(内部スクロール)に収まる',cw[0]<=cw[1],cw)
        pg.screenshot(path=f'{OUT}/cons562_{vw}.png'); pg.evaluate("document.getElementById('tm-review-card').scrollIntoView()"); pg.wait_for_timeout(300); pg.screenshot(path=f'{OUT}/map562_{vw}.png')
        chk(f'{vw}px: pageerror 0',not errs,errs); b.close()
print('PASS',ok[0],'FAIL',ok[1])
raise SystemExit(1 if ok[1] else 0)
