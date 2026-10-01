from playwright.sync_api import sync_playwright
from e2e_env import BASE
ok=[0,0]
def chk(n,c,x=''): ok[0 if c else 1]+=1; print('PASS' if c else 'FAIL',n,x)
with sync_playwright() as pw:
    b=pw.chromium.launch(args=['--no-sandbox']); pg=b.new_page(); errs=[]
    pg.on('pageerror',lambda e:errs.append(str(e))); pg.route('**/api/**',lambda r:r.fulfill(status=404,body='{}'))
    pg.goto(BASE+'/'); pg.wait_for_timeout(1500)
    has=lambda: pg.evaluate("!!document.getElementById('rm-alert-slot')")
    pg.evaluate("rmRaiseAlert('OIL PRESSURE','1.8 bar','serious')"); chk('ANALYSIS: 枠が出る',has())
    pg.evaluate("document.body.classList.add('drive-mode')"); pg.wait_for_timeout(1600)
    chk('DRIVE へ切替: 1秒余りで枠が消える',not has() and pg.evaluate("rmState.alerts.active.length")==0)
    pg.evaluate("document.body.classList.remove('drive-mode'); rmRaiseAlert('OIL PRESSURE','1.8 bar','serious')"); chk('戻して再度出る',has())
    pg.evaluate("document.body.classList.add('review-mode')"); pg.wait_for_timeout(1600)
    chk('REVIEW へ切替: 枠が消える',not has())
    pg.evaluate("document.body.classList.remove('review-mode'); rmRaiseAlert('OIL PRESSURE','1.8 bar','serious'); rmRaiseAlert('LAP ANOMALY','L2','warning')")
    pg.evaluate("resetAnalysis()"); chk('resetAnalysis(): 枠と待ち行列が消える',not has() and pg.evaluate("rmState.alerts.active.length")==0)
    chk('pageerror 0',not errs,errs); b.close()
print('PASS',ok[0],'FAIL',ok[1])
