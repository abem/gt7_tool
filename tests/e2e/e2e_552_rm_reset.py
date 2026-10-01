"""REVIEW で A/B の選択を全て外したとき、RACE METRICS も初期表示へ戻る(古い値が残らない)。"""
from corner_common import *  # noqa: F401,F403

with sync_playwright() as pw:
    b,pg,errs=mk(pw)
    pg.evaluate("window.__calls=[]; const o=window.rmOnReviewCompare; window.rmOnReviewCompare=function(a,b){window.__calls.push([!!a,!!b]); return o(a,b)}")
    select(pg,A,B); pg.wait_for_timeout(1200)
    ph=lambda: pg.evaluate("document.getElementById('rm-phase-table').textContent")
    chk('A/B を選ぶと、フェーズ別Δt が出る',ph().startswith('フェーズ別 Δt'),ph()[:30])
    row(pg,A); pg.wait_for_timeout(500); row(pg,B); pg.wait_for_timeout(1200)
    calls=pg.evaluate("window.__calls")
    chk('全て外すと、最後に rmOnReviewCompare(null, null) が呼ばれる',calls[-1]==[False,False],calls)
    chk('フェーズ別Δt が案内文に戻り、コーナー別の一覧が空になる',ph().startswith('フェーズ別デルタ: AとBの2本を選択') and pg.evaluate("document.getElementById('rm-corner-list').textContent.length")==0,ph()[:30])
    chk('pageerror 0',not errs,errs); b.close()
print('PASS',ok[0],'FAIL',ok[1])
