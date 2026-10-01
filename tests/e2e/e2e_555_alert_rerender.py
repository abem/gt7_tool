from playwright.sync_api import sync_playwright
from e2e_env import BASE
ok=[0,0]
def chk(n,c,x=''): ok[0 if c else 1]+=1; print('PASS' if c else 'FAIL',n,x)
with sync_playwright() as pw:
    b=pw.chromium.launch(args=['--no-sandbox']); pg=b.new_page(); errs=[]
    pg.on('pageerror',lambda e:errs.append(str(e))); pg.route('**/api/**',lambda r:r.fulfill(status=404,body='{}'))
    pg.goto(BASE+'/'); pg.wait_for_timeout(1500)
    # 1) 警告枠: 同じ内容では要素の中身を作り直さない
    pg.evaluate("rmRaiseAlert('OIL PRESSURE','1.8 bar','serious'); rmRaiseAlert('LAP ANOMALY','L4','warning')")
    r=pg.evaluate("""(()=>{const el=document.getElementById('rm-alert-slot'); const child=el.firstChild; const more=el.querySelector('.rm-alert-more');
       let mut=0; const mo=new MutationObserver(l=>mut+=l.length); mo.observe(el,{childList:true,subtree:true,characterData:true});
       for(let i=0;i<5;i++) rmRenderAlerts();
       return new Promise(res=>setTimeout(()=>{mo.disconnect(); res({same:el.firstChild===child && el.querySelector('.rm-alert-more')===more, mut})},100))})()""")
    chk('同じ内容では DOM を変更しない(5回呼んでも変異0)',r['same'] and r['mut']==0,r)
    pg.evaluate("rmRaiseAlert('FUEL RATE','2.4','notice')")
    chk('件数が増えたら更新(+2)',pg.evaluate("document.querySelector('.rm-alert-more').textContent")=='+2')
    pg.evaluate("document.getElementById('rm-alert-slot').click()")
    t=pg.evaluate("document.querySelector('#rm-alert-slot .ea-label').textContent+'/'+document.querySelector('.rm-alert-more').textContent")
    chk('確認で次の警告(LAP ANOMALY/+1)',t=='LAP ANOMALY/+1',t)
    pg.evaluate("rmState.alerts.active.forEach(a=>a.at-=61000); rmRenderAlerts()")
    chk('期限(61秒)で warning/notice が消え、枠も消える',pg.evaluate("!document.getElementById('rm-alert-slot')") and pg.evaluate("rmState.alerts.active.length")==0)
    pg.evaluate("rmClearAlerts()"); chk('全消去で枠なし',pg.evaluate("!document.getElementById('rm-alert-slot')"))
    pg.evaluate("rmRaiseAlert('OIL PRESSURE','1.0 bar','serious')"); chk('消去後に再度出る(sig リセット)',pg.evaluate("!!document.getElementById('rm-alert-slot')"))
    chk('pageerror 0',not errs,errs); b.close()
print('PASS',ok[0],'FAIL',ok[1])
