"""#604 GRIP 表示(GRIP OK / SPIN / LOCK): 車輪の周速 = |wheel_rps(rad/s)| × tyre_radius で判定する。
旧コードは 2π を掛けていたため、スロットルを踏むと常に SPIN になっていた。"""
from playwright.sync_api import sync_playwright
from e2e_env import BASE

ok = [0, 0]
def chk(n, c, x=''): ok[0 if c else 1] += 1; print('PASS' if c else 'FAIL', n, x)

def frame(speed_ms, wheel_ratio, throttle=0, brake=0):
    # 4輪とも 周速 = speed_ms * wheel_ratio。tyre_radius 0.3 → wheel_rps = 周速 / 0.3 (rad/s)
    return {'speed_ms': speed_ms, 'speed_kmh': speed_ms * 3.6, 'throttle_pct': throttle, 'brake_pct': brake,
            'wheel_rps': [-(speed_ms * wheel_ratio / 0.3)] * 4, 'tyre_radius': [0.3] * 4, 'flags': {'car_on_track': True}}

with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox', '--use-gl=swiftshader'])
    pg = b.new_context(viewport={'width': 1600, 'height': 900}).new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route('**/api/**', lambda r: r.fulfill(status=404, body='{}'))
    pg.goto(BASE + '/'); pg.wait_for_timeout(1200)
    def feed(f): pg.evaluate("(f) => handleTelemetryMessage(f, performance.now())", f); pg.wait_for_timeout(80)
    grip = lambda: pg.evaluate("document.getElementById('grip-status').textContent")
    feed(frame(50, 1.02, throttle=90)); chk('全開でも周速が車速の 1.02 倍なら GRIP OK(旧コードでは SPIN)', grip() == 'GRIP OK', grip())
    feed(frame(50, 1.09, throttle=90)); chk('周速 1.09 倍(実データの上限付近)でも GRIP OK', grip() == 'GRIP OK', grip())
    feed(frame(50, 1.25, throttle=90)); chk('周速 1.25 倍 + スロットルで SPIN', grip() == 'SPIN', grip())
    feed(frame(50, 1.25, throttle=10)); chk('スロットルを踏んでいなければ SPIN にしない', grip() == 'GRIP OK', grip())
    feed(frame(50, 0.93, brake=100)); chk('全開制動の周速 0.93 倍は GRIP OK(ABS が調整中の通常値)', grip() == 'GRIP OK', grip())
    feed(frame(50, 0.70, brake=100)); chk('周速 0.70 倍 + ブレーキで LOCK', grip() == 'LOCK', grip())
    feed(frame(50, 0.70, brake=0)); chk('ブレーキを踏んでいなければ LOCK にしない', grip() == 'GRIP OK', grip())
    chk('pageerror 0', not errs, errs); b.close()
print('PASS', ok[0], 'FAIL', ok[1])
raise SystemExit(1 if ok[1] else 0)
