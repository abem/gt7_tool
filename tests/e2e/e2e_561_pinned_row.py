"""#561 レビュー指摘: 重ね書きの追加・解除では、固定した行と地図の強調を失わない。"""
from corner_common import *  # noqa: F401,F403
with sync_playwright() as pw:
    b,pg,errs=mk(pw); select(pg,A,B)
    pg.click('#cr-table tbody tr:nth-child(3)'); pg.wait_for_timeout(200)
    pinned=lambda: pg.evaluate("!!document.querySelector('#cr-table tbody tr.cr-pinned')")
    chk('行を固定',pinned())
    # 重ね書きを追加しても、固定が残る
    ov=[m['file'] for m in lap][0]
    pg.evaluate("(f)=>document.querySelector('.review-lap-item[data-file=\"'+f+'\"] .review-lap-ov').click()",ov); pg.wait_for_timeout(1800)
    chk('重ね書きの追加で固定が残る',pinned())
    pg.evaluate("(f)=>document.querySelector('.review-lap-item[data-file=\"'+f+'\"] .review-lap-ov').click()",ov); pg.wait_for_timeout(1200)
    chk('重ね書きの解除でも固定が残る',pinned())
    row(pg,A); pg.wait_for_timeout(300); row(pg,B); pg.wait_for_timeout(600)
    chk('A/B を外すと表が空',not table(pg))
    select(pg,A,B); chk('選び直すと表が再描画される(固定は解除)',len(table(pg))==8 and not pinned())
    chk('pageerror 0',not errs,errs); b.close()
print('PASS',ok[0],'FAIL',ok[1])
raise SystemExit(1 if ok[1] else 0)
