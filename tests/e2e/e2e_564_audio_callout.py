"""#564 音声の通知 検証: speechSynthesis を差し替え、読み上げ内容・間隔・抑制条件を確認する。"""
from playwright.sync_api import sync_playwright
from e2e_env import OUT, BASE
ok=[0,0]
def chk(n,c,x=''): ok[0 if c else 1]+=1; print('PASS' if c else 'FAIL',n,x)
STUB="""window.__spoken=[];window.__cancels=0;
Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{speaking:false,speak:function(u){window.__spoken.push(u.text)},cancel:function(){window.__cancels++},getVoices:function(){return []}}});
window.SpeechSynthesisUtterance=function(t){this.text=t;};"""
NOSTUB="Object.defineProperty(window,'speechSynthesis',{value:undefined,configurable:true});"
def page(pw,vw=1600,vh=900,stub=STUB,ctx=None):
    b=pw.chromium.launch(args=['--no-sandbox']) if ctx is None else None
    c=ctx or b.new_context(viewport={'width':vw,'height':vh}); c.add_init_script(stub); pg=c.new_page(); errs=[]
    pg.on('pageerror',lambda e:errs.append(str(e))); pg.route('**/api/**',lambda r:r.fulfill(status=404,body='{}'))
    pg.goto(BASE+'/'); pg.wait_for_timeout(1800); return b,c,pg,errs
sp=lambda pg: pg.evaluate("window.__spoken.slice()")
ev=lambda pg,js: pg.evaluate(js)
with sync_playwright() as pw:
    b,c,pg,errs=page(pw)
    ev(pg,"ensureAnalysisInit()")
    chk('AUDIO ボタンがツールバーにあり、既定はオフ',ev(pg,"document.getElementById('ac-toolbar-btn').getAttribute('aria-pressed')")=='false')
    ev(pg,"pushNotification('FUEL','20%','serious')"); chk('オフのときは読み上げない',sp(pg)==[])
    pg.click('#ac-toolbar-btn'); pg.wait_for_timeout(200)
    chk('クリックでオン(aria-pressed=true)・確認の音声・設定を保存',
        ev(pg,"document.getElementById('ac-toolbar-btn').getAttribute('aria-pressed')")=='true' and len(sp(pg))==1 and 'オンにしました' in sp(pg)[0] and ev(pg,"localStorage.getItem('gt7.audioCallouts')")=='1',sp(pg))
    pg.wait_for_timeout(3200)
    ev(pg,"pushNotification('FUEL','20%','serious')"); chk('serious を読み上げる(燃料 20%)',sp(pg)[-1]=='燃料、残り 20 パーセント',sp(pg)[-1])
    n=len(sp(pg)); ev(pg,"pushNotification('OIL PRESSURE','1.0 bar','serious')")
    chk('3秒以内の続けての通知は捨てる(同時1件・最小間隔)',len(sp(pg))==n)
    ev(pg,"pushNotification('FINAL LAP','','critical')"); chk('critical は割り込んで読む(cancel してから)',sp(pg)[-1]=='ファイナルラップ' and ev(pg,"window.__cancels")>=2,(sp(pg)[-1],ev(pg,"window.__cancels")))
    pg.wait_for_timeout(3200); n=len(sp(pg))
    for sev in ('warning','notice','good','pb',None): ev(pg,f"pushNotification('X','1',{('\"'+sev+'\"') if sev else 'undefined'})")
    chk('warning/notice/good/pb/未指定は読まない',len(sp(pg))==n)
    n=len(sp(pg)); ev(pg,"pushNotification('ENGINEER','ピットに入れ','critical')")
    chk('ENGINEER(pit-wall が自前で読む)は、音声通知では読まない(二重に読まない)',len(sp(pg))==n)
    chk('ボタンのオン状態が、見た目(.active)にも出る',ev(pg,"document.getElementById('ac-toolbar-btn').classList.contains('active')"))
    # 警告の1枠(ANALYSIS): 1件だけ読む
    ev(pg,"rmRaiseAlert('OIL PRESSURE','1.8 bar','serious')"); pg.wait_for_timeout(200)
    chk('警告の1枠(serious)を、1回だけ読む',sp(pg)[-1]=='油圧が低下しています。1.8 bar' and len(sp(pg))==n+1,(sp(pg)[-1],len(sp(pg))-n))
    ev(pg,"rmState.alerts.active=[]; rmRenderAlerts()"); pg.wait_for_timeout(3200); n=len(sp(pg))
    # DRIVE のトースト経路(従来どおり pushNotification)も、二重に読まない
    ev(pg,"document.body.classList.add('drive-mode'); rmRaiseAlert('OIL PRESSURE','1.2 bar','serious'); document.body.classList.remove('drive-mode')")
    chk('DRIVE のトースト経路でも、1回だけ読む',len(sp(pg))==n+1,len(sp(pg))-n)
    pg.wait_for_timeout(3200); n=len(sp(pg))
    ev(pg,"document.body.classList.add('replay-mode'); pushNotification('FUEL','10%','serious'); document.body.classList.remove('replay-mode')")
    ev(pg,"document.body.classList.add('review-mode'); pushNotification('FUEL','10%','serious'); document.body.classList.remove('review-mode')")
    chk('再生・REVIEW 中は読まない',len(sp(pg))==n)
    # ラップ完了
    mk="""(()=>{analysisState.curLap={samples:[0,1,2,3,4].map(i=>({dist:i*50,t:i*10,speed:100,throttle:50,brake:0,x:i*50,z:0,timestamp:0})),cumDist:200};})()"""
    pg.wait_for_timeout(3200); ev(pg,"analysisState.refLap=null; analysisState.notif.prevBest=Infinity"); ev(pg,mk); ev(pg,"onLapComplete(3, 84012)")
    chk('最初のラップ: タイムだけ読む',sp(pg)[-1]=='ラップタイム 1分24秒012',sp(pg)[-1])
    pg.wait_for_timeout(3200); ev(pg,mk); ev(pg,"onLapComplete(4, 83456)")
    chk('自己ベスト更新: タイムと、前回のベストとの差',sp(pg)[-1]=='自己ベスト更新。1分23秒456。前回のベストより 0.56 秒速い',sp(pg)[-1])
    pg.wait_for_timeout(3200); ev(pg,mk); ev(pg,"onLapComplete(5, 84012)")
    chk('ベスト未満: ベストとの差を読む',sp(pg)[-1]=='ラップタイム 1分24秒012。ベストより 0.56 秒遅い',sp(pg)[-1])
    chk('ラップ完了の通知(PB)の表示・記録は従来どおり',ev(pg,"analysisState.lapTimesMs.length")>=3 and ev(pg,"analysisState.notif.prevBest")==83456)
    # オフ
    pg.click('#ac-toolbar-btn'); pg.wait_for_timeout(200); c0=ev(pg,"window.__cancels"); n=len(sp(pg))
    pg.wait_for_timeout(3200); ev(pg,"pushNotification('FUEL','20%','serious')")
    chk('オフにすると見た目の状態(.active)も消える',not ev(pg,"document.getElementById('ac-toolbar-btn').classList.contains('active')"))
    chk('オフにすると読まない・進行中の音声を止める',ev(pg,"document.getElementById('ac-toolbar-btn').getAttribute('aria-pressed')")=='false' and len(sp(pg))==n and ev(pg,"localStorage.getItem('gt7.audioCallouts')")=='0',c0)
    # 保存された設定: オンで読み込み直し → 最初の操作までは読まない
    pg.click('#ac-toolbar-btn'); pg.wait_for_timeout(200)
    pg.reload(); pg.wait_for_timeout(2000)
    chk('オンのまま読み込み直すと、ボタンはオンの状態(見た目も)',ev(pg,"document.getElementById('ac-toolbar-btn').getAttribute('aria-pressed')")=='true' and ev(pg,"document.getElementById('ac-toolbar-btn').classList.contains('active')"))
    ev(pg,"pushNotification('FUEL','20%','serious')"); chk('読み込み直しの直後(操作前)は、音声の許可が無いため読まない',sp(pg)==[],sp(pg))
    pg.mouse.click(300,300); pg.wait_for_timeout(200)
    ev(pg,"pushNotification('FUEL','20%','serious')"); chk('最初の操作の後は読む',len(sp(pg))==1,sp(pg))
    chk('pageerror 0',not errs,errs); b.close()
    # 音声合成が使えないブラウザ
    b,c,pg,errs=page(pw,stub=NOSTUB)
    chk('音声合成が無い: ボタンを作らず、通知の処理も壊れない',ev(pg,"!document.getElementById('ac-toolbar-btn')") and not errs,errs)
    ev(pg,"ensureAnalysisInit(); pushNotification('FUEL','20%','serious'); rmRaiseAlert('OIL PRESSURE','1 bar','serious')")
    chk('音声合成が無い: 通知の表示は従来どおり(エラーなし)',ev(pg,"document.querySelectorAll('#race-engineer-feed .engineer-alert').length")>=1 and not errs,errs); b.close()
    # レイアウト
    for vw,vh in ((390,844),(1920,1080)):
        b,c,pg,errs=page(pw,vw,vh); sw=ev(pg,"[document.documentElement.scrollWidth,innerWidth]")
        chk(f'{vw}px: 横スクロールなし(ツールバーに AUDIO 追加後)',sw[0]<=sw[1],sw)
        pg.screenshot(path=f'{OUT}/ac564_{vw}.png'); chk(f'{vw}px: pageerror 0',not errs,errs); b.close()
print('PASS',ok[0],'FAIL',ok[1])
