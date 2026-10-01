"""#558/#560 ラップタイム予測の問い合わせ: モデル無し(404)は期限つきで止め、非現実的な予測(422)では止めない。

記録済みラップの再生でライブ経路を駆動し、約12秒間の予測 API への問い合わせ回数と、表示を確かめる。
"""
import json, re
from urllib.parse import unquote
from playwright.sync_api import sync_playwright
from e2e_env import S, BASE

idx=json.load(open(f'{S}/fx_trend/index.json')); lap=[r['lap'] for r in idx]; files=[m['file'] for m in lap]
det={f:json.load(open(f'{S}/fx_trend/{f}')) for f in files}
carof={m['file']:m['car_id'] for m in lap}
F=files[10]
ok=[0,0]
def chk(n,c,x=''): ok[0 if c else 1]+=1; print('PASS' if c else 'FAIL',n,x)

def run(pw,mode,secs=12):
    n=[0]
    b=pw.chromium.launch(args=['--no-sandbox','--use-gl=swiftshader']); pg=b.new_context(viewport={'width':1600,'height':900}).new_page(); errs=[]
    pg.on('pageerror',lambda e:errs.append(str(e)))
    def h(r):
        url=r.request.url; path=re.sub(r'^https?://[^/]+','',url).split('?')[0]
        if path=='/api/laps': r.fulfill(status=200,content_type='application/json',body=json.dumps({'total':len(lap),'laps':lap}))
        elif path.startswith('/api/laps/'):
            f=unquote(path[10:]); d=json.loads(json.dumps(det[f]))
            if 'fields=' in url and 'position_x,position_z' not in url:   # 再生用の取得: 本物と同様に car_id / course を各フレームへ付与
                for s in d['samples']: s['car_id']=carof[f]; c=d['meta']['course']; s['course']=dict(c, name=(c.get('name_en') or c.get('name_ja') or c['id']))
            r.fulfill(status=200,content_type='application/json',body=json.dumps(d))
        elif path=='/api/predict/laptime':
            n[0]+=1
            if mode=='404': r.fulfill(status=404,body='{}')
            elif mode=='422': r.fulfill(status=422,content_type='application/json',body='{"error":"implausible"}')
            else: r.fulfill(status=200,content_type='application/json',body=json.dumps({'predicted_laptime_ms':83800.0,'mae_pct':1.95,'n_laps':14}))
        else: r.fulfill(status=404,body='{}')
    pg.route('**/api/**',h); pg.goto(BASE+'/'); pg.wait_for_timeout(1500)
    pg.evaluate("document.getElementById('review-mode-btn').click()"); pg.wait_for_timeout(1200)
    pg.evaluate(f"replayStart({json.dumps(F)})"); pg.wait_for_function("replayState.frames && replayState.frames.length>100",timeout=60000)
    pg.wait_for_timeout(secs*1000)
    shown=pg.evaluate("document.getElementById('rm-predict-value').textContent")
    meta=pg.evaluate("(document.getElementById('rm-predict-meta')||{}).textContent")
    b.close(); return n[0],shown,meta,errs

with sync_playwright() as pw:
    c,shown,meta,errs=run(pw,'404')
    chk('モデル無し(404): 12秒間の問い合わせは1回だけ・表示は「--」',c==1 and shown=='--',(c,shown)); chk('404: pageerror 0',not errs,errs)
    c,shown,meta,errs=run(pw,'422')
    chk('非現実的な予測(422): 毎秒の問い合わせを続ける(5分の停止にしない)・表示は「--」',c>=8 and shown=='--',(c,shown)); chk('422: pageerror 0',not errs,errs)
    c,shown,meta,errs=run(pw,'200')
    chk('モデル有り(200): 毎秒の問い合わせ・予測タイムと根拠(MAE・n)を表示',c>=8 and shown=='1:23.800' and meta=='MAE 1.95% / n=14',(c,shown,meta)); chk('200: pageerror 0',not errs,errs)
print('PASS',ok[0],'FAIL',ok[1])
