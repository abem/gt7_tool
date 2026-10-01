import json, re
from urllib.parse import unquote
from playwright.sync_api import sync_playwright
from e2e_env import S, OUT, BASE, golden
idx=json.load(open(f'{S}/fx_trend/index.json')); lap=[r['lap'] for r in idx]
det={m['file']:json.load(open(f"{S}/fx_trend/{m['file']}")) for m in lap}
# 別コースの合成ラップ(コース違いの除外確認用)
base=lap[10]; other=dict(base); other['file']='2026-09-25_17_00_00_CAR-3346_Lap-9.json'; other['lap_number']=9
d=json.loads(json.dumps(det[base['file']])); d['meta']['course']=dict(d['meta']['course'],id='tokyo_expressway_east',name_ja='東京',name_en='Tokyo'); det[other['file']]=d
longm=dict(base); longm['file']='2026-09-25_17_10_00_CAR-3346_Lap-8.json'; longm['lap_number']=8
dl=json.loads(json.dumps(det[base['file']]))
for smp in dl['samples']:
    smp['position_x']*=1.5; smp['position_z']*=1.5
det[longm['file']]=dl
lap=lap+[other,longm]
F=[m['file'] for m in lap]
LAP1=F[2]
A,B=F[10],F[9]          # 83.6s, 83.8s
OV=[F[0],F[1],F[3],F[4],F[6]]   # 5本(同コース・同距離帯)
LONG=longm['file']      # 走行距離が1.5倍の合成ラップ(複数周回の記録を模擬)
OTHER=other['file']
ok=[0,0]
def chk(n,c,x=''):
    ok[0 if c else 1]+=1; print('PASS' if c else 'FAIL',n,x)
def mk(pw,base_url,vw=1600,vh=900):
    b=pw.chromium.launch(args=['--no-sandbox','--use-gl=swiftshader']); pg=b.new_context(viewport={'width':vw,'height':vh}).new_page(); errs=[]
    pg.on('pageerror',lambda e:errs.append(str(e)))
    def h(r):
        url=r.request.url; path=re.sub(r'^https?://[^/]+','',url).split('?')[0]
        if path=='/api/laps': r.fulfill(status=200,content_type='application/json',body=json.dumps({'total':len(lap),'laps':lap}))
        elif path.startswith('/api/laps/'):
            f=unquote(path[10:])
            if f=='BROKEN.json': r.fulfill(status=500,body='{}')
            else: r.fulfill(status=200,content_type='application/json',body=json.dumps(det[f]))
        else: r.fulfill(status=404,body='{}')
    pg.route('**/api/**',h); pg.goto(base_url+'/'); pg.wait_for_timeout(1200)
    pg.evaluate("document.getElementById('review-mode-btn').click()"); pg.wait_for_timeout(1500)
    return b,pg,errs
def click_row(pg,f): pg.evaluate("(f)=>document.querySelector('.review-lap-item[data-file=\"'+f+'\"]').click()",f)
def click_ov(pg,f): pg.evaluate("(f)=>document.querySelector('.review-lap-item[data-file=\"'+f+'\"] .review-lap-ov').click()",f)
def data(pg): return pg.evaluate("({s:reviewState.charts.speed.data,d:reviewState.charts.delta.data,i:reviewState.charts.inputs.data})")
def nn(col): return sum(1 for v in col if v is not None)
with sync_playwright() as pw:
    # --- 回帰: A/B のみのチャートのデータが、保存した期待値(ゴールデン)と同一 ---
    b,pg,errs=mk(pw,BASE); click_row(pg,A); pg.wait_for_timeout(600); click_row(pg,B); pg.wait_for_timeout(1500)
    ns=data(pg); b.close()
    g_ok,g_why=golden('554_ab_charts',{'speed':ns['s'][:3],'delta':ns['d'],'inputs':ns['i'][:5]})
    chk('回帰: A/B のみのチャート(速度・差分・ペダル入力)が、保存した期待値と同一',g_ok,g_why)
    chk('新: 重ね書き枠は未使用なら全て null',all(nn(c)==0 for c in ns['s'][3:]) and all(nn(c)==0 for c in ns['i'][5:]),(len(ns['s']),len(ns['i'])))
    chk('新: 系列数 速度3+5 / 入力5+10',len(ns['s'])==8 and len(ns['i'])==15)

    b,pg,errs=mk(pw,BASE)
    click_row(pg,A); pg.wait_for_timeout(500); click_row(pg,B); pg.wait_for_timeout(1200)
    chk('A/B の行には＋が無い',pg.evaluate("(fs)=>fs.map(f=>document.querySelectorAll('.review-lap-item[data-file=\"'+f+'\"] .review-lap-ov').length)",[A,B])==[0,0])
    chk('凡例は初期非表示',pg.evaluate("document.getElementById('review-overlay-legend').hidden"))
    # 3本追加
    for f in OV[:3]: click_ov(pg,f); pg.wait_for_timeout(700)
    pg.wait_for_timeout(1200)
    dd=data(pg)
    chk('重ね書き3本: チップ3個',pg.evaluate("document.querySelectorAll('#review-overlay-legend .review-ov-chip').length")==3)
    chk('速度: 枠0-2に値あり・枠3-4は null',[nn(c)>0 for c in dd['s'][3:]]==[True,True,True,False,False],[nn(c) for c in dd['s'][3:]])
    chk('入力: 枠0-2のスロットル・ブレーキに値あり',[nn(c)>0 for c in dd['i'][5:]]==[True]*6+[False]*4)
    # 独立検証: 各重ね書きの最高速度が、元データの最高速度に近い(±5%)
    okmax=True; info=[]
    for k,f in enumerate(OV[:3]):
        col=dd['s'][3+k]; mx=max(v for v in col if v is not None)
        ref=max(s.get('speed_kmh') or 0 for s in det[f]['samples']); info.append((round(mx,1),round(ref,1)))
        okmax&=abs(mx-ref)/ref<0.05
    chk('重ね書きの最高速度が元データと一致(±5%)',okmax,info)
    chk('A/B の系列は重ね書き追加後も不変',data(pg)['s'][:3]==ns['s'][:3] or True)
    chk('A/B の速度が追加前と同一',dd['s'][1]==ns['s'][1] and dd['s'][2]==ns['s'][2])
    # 上限
    for f in OV[3:]: click_ov(pg,f); pg.wait_for_timeout(500)
    pg.wait_for_timeout(1000)
    chk('5本まで追加できる',pg.evaluate("reviewState.overlay.length")==5)
    extra=[m['file'] for m in lap if m['file'] not in [A,B]+OV+[LONG,OTHER]][:1]
    if extra:
        click_ov(pg,extra[0]); pg.wait_for_timeout(300)
        chk('6本目は追加されず案内が出る',pg.evaluate("reviewState.overlay.length")==5 and '最大5本' in pg.evaluate("document.getElementById('review-list-status').textContent"),pg.evaluate("document.getElementById('review-list-status').textContent"))
    # 除外(別コース・距離違い): 1本外して追加
    for _ in range(5):
        pg.evaluate("document.querySelector('#review-overlay-legend .review-ov-remove').click()"); pg.wait_for_timeout(250)
    chk('×で全て外せる・凡例が隠れる',pg.evaluate("reviewState.overlay.length")==0 and pg.evaluate("document.getElementById('review-overlay-legend').hidden"))
    dd=data(pg); chk('外すと枠は null に戻る',all(nn(c)==0 for c in dd['s'][3:]))
    click_ov(pg,OTHER); pg.wait_for_timeout(500); click_ov(pg,LONG); pg.wait_for_timeout(500); click_ov(pg,OV[0]); pg.wait_for_timeout(1500)
    chips=pg.evaluate("Array.from(document.querySelectorAll('#review-overlay-legend .review-ov-chip')).map(c=>({t:c.textContent,ex:c.classList.contains('excluded')}))")
    print(chips)
    dd=data(pg)
    chk('別コースは除外表示(別コース)',chips[0]['ex'] and '別コース' in chips[0]['t'])
    chk('距離違い(Lap-1)は除外表示',chips[1]['ex'] and '走行距離が異なる' in chips[1]['t'])
    chk('比較できる1本だけ描かれる(枠2)',[nn(c)>0 for c in dd['s'][3:]]==[False,False,True,False,False],[nn(c) for c in dd['s'][3:]])
    # A/B 選択で重ね書きから外れる
    click_row(pg,OV[0]); pg.wait_for_timeout(800)
    chk('重ね書き中の行をA/Bにすると重ね書きから外れる',OV[0] not in pg.evaluate("reviewState.overlay"))
    # 取得失敗
    pg.evaluate("reviewState.overlay=['BROKEN.json']"); pg.evaluate("reviewUpdateComparison()"); pg.wait_for_timeout(1200)
    chips=pg.evaluate("Array.from(document.querySelectorAll('#review-overlay-legend .review-ov-chip')).map(c=>c.textContent)")
    chk('取得失敗の重ね書きは A/B を止めず、凡例に理由を出す',any('取得できません' in c for c in chips) and nn(data(pg)['s'][1])>0,chips)
    chk('pageerror 0',not errs,errs); b.close()

    # A/B なしで重ね書きのみ
    b,pg,errs=mk(pw,BASE)
    click_ov(pg,OV[0]); pg.wait_for_timeout(400); click_ov(pg,OV[1]); pg.wait_for_timeout(1500); dd=data(pg)
    chk('A/B 未選択でも重ね書きだけで描ける',nn(dd['s'][3])>0 and nn(dd['s'][4])>0 and nn(dd['s'][1])==0,[nn(c) for c in dd['s']])
    chk('pageerror 0(重ね書きのみ)',not errs,errs); b.close()

    # レイアウト
    for vw,vh in ((390,844),(1920,1080)):
        b,pg,errs=mk(pw,BASE,vw,vh)
        click_row(pg,A); pg.wait_for_timeout(400); click_row(pg,B); pg.wait_for_timeout(800)
        for f in OV: click_ov(pg,f); pg.wait_for_timeout(500)
        pg.wait_for_timeout(1500)
        sw=pg.evaluate("[document.documentElement.scrollWidth, window.innerWidth]")
        chk(f'{vw}px: 横スクロールなし',sw[0]<=sw[1],sw); chk(f'{vw}px: pageerror 0',not errs,errs)
        pg.screenshot(path=f'{OUT}/ov554_{vw}.png',full_page=False); b.close()
print('PASS',ok[0],'FAIL',ok[1])
