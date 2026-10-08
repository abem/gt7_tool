"""#603 CAR ATTITUDE の TCS / ABS / ASM 表示: 常設され、旗(TCS/ASM)と推定(ABS)で点灯し、フレームが途絶えると消える。"""
import json
from playwright.sync_api import sync_playwright
from e2e_env import BASE

ok = [0, 0]
def chk(n, c, x=''): ok[0 if c else 1] += 1; print('PASS' if c else 'FAIL', n, x)

BASE_FRAME = {'speed_kmh': 180, 'rpm': 6000, 'gear': 4, 'throttle_pct': 60, 'brake_pct': 0, 'brake_filtered_pct': 0,
              'wheel_rps': [-170, -170, -170, -170], 'tyre_radius': [0.3, 0.3, 0.3, 0.3],     # 170*0.3=51m/s ≒ 184km/h
              'flags': {'car_on_track': True, 'in_gear': True, 'tcs_active': False, 'asm_active': False}}
def frame(**kw):
    f = json.loads(json.dumps(BASE_FRAME)); f.update(kw); return f

STATE = "() => ['tcs','abs','asm'].map(k => document.getElementById('da-'+k).classList.contains('da-on'))"

with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox', '--use-gl=swiftshader'])
    pg = b.new_context(viewport={'width': 1600, 'height': 900}).new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route('**/api/**', lambda r: r.fulfill(status=404, body='{}'))
    pg.goto(BASE + '/'); pg.wait_for_timeout(1200)
    chk('CAR ATTITUDE のタイトルに TCS / ABS / ASM が常設される',
        pg.evaluate("document.querySelector('.car-3d-card .card-title #da-aids') && [...document.querySelectorAll('#da-aids .da-aid')].map(e => e.textContent).join(',')") == 'TCS,ABS,ASM')
    chk('起動直後は全て消灯', pg.evaluate(STATE) == [False, False, False])
    chk('ABS の表示に推定である説明(title)がある', '推定' in pg.evaluate("document.getElementById('da-abs').title"))

    def feed(f): pg.evaluate("(f) => handleTelemetryMessage(f, performance.now())", f); pg.wait_for_timeout(80)
    feed(frame(flags=dict(BASE_FRAME['flags'], tcs_active=True)))
    chk('TCS の旗で TCS だけ点灯', pg.evaluate(STATE) == [True, False, False], pg.evaluate(STATE))
    feed(frame(flags=dict(BASE_FRAME['flags'], asm_active=True)))
    chk('ASM の旗で ASM だけ点灯(TCS は消える)', pg.evaluate(STATE) == [False, False, True], pg.evaluate(STATE))
    feed(frame(brake_pct=60, brake_filtered_pct=52))
    chk('ABS 推定(a): ペダル 60 に対し補正後 52 → ABS 点灯', pg.evaluate(STATE) == [False, True, False], pg.evaluate(STATE))
    feed(frame(brake_pct=100, brake_filtered_pct=100, wheel_rps=[-150, -150, -170, -170]))   # 前輪 45m/s vs 車速 50m/s = スリップ 10%
    chk('ABS 推定(b): 全開制動で前輪のスリップ 10% → ABS 点灯', pg.evaluate(STATE) == [False, True, False], pg.evaluate(STATE))
    feed(frame(brake_pct=100, brake_filtered_pct=100, wheel_rps=[-164, -164, -164, -164]))   # スリップ 1.6%
    chk('全開制動でもスリップ 1.6% なら ABS は消灯', pg.evaluate(STATE) == [False, False, False], pg.evaluate(STATE))
    feed(frame(brake_pct=0, brake_filtered_pct=0, wheel_rps=[-100, -100, -100, -100]))        # 制動なし(惰行の比の荒れ)
    chk('制動していなければスリップがあっても ABS は点かない', pg.evaluate(STATE) == [False, False, False])
    feed(frame(speed_kmh=5, brake_pct=100, brake_filtered_pct=100, wheel_rps=[0, 0, 0, 0]))
    chk('極低速(10km/h 未満)ではスリップで ABS を判定しない', pg.evaluate(STATE) == [False, False, False])
    feed(frame(flags=dict(BASE_FRAME['flags'], tcs_active=True), brake_pct=60, brake_filtered_pct=50))
    chk('TCS と ABS は同時に点く', pg.evaluate(STATE) == [True, True, False], pg.evaluate(STATE))
    pg.wait_for_timeout(2700)
    chk('フレームが 2 秒来なければ全て消灯', pg.evaluate(STATE) == [False, False, False], pg.evaluate(STATE))
    feed({'speed_kmh': 100})
    chk('旗や車輪の情報が無いフレームでも落ちない(全て消灯のまま)', pg.evaluate(STATE) == [False, False, False])
    feed(frame(wheel_rps=[-150, -150], tyre_radius=[0.3, 0.3], brake_pct=100, brake_filtered_pct=100))
    chk('車輪の配列が 4 つ未満なら ABS のスリップ判定をしない', pg.evaluate(STATE) == [False, False, False])
    # 全カード再生の一時停止中は消灯しない(他のカードと同じく最後の表示を保つ)
    pg.evaluate("replayActive = true; replayState.playing = false")
    feed(frame(flags=dict(BASE_FRAME['flags'], tcs_active=True)))
    pg.wait_for_timeout(2700)
    chk('全カード再生の一時停止中は 2 秒たっても消灯しない', pg.evaluate(STATE) == [True, False, False], pg.evaluate(STATE))
    pg.evaluate("replayActive = false"); pg.wait_for_timeout(1200)
    chk('再生を終えれば消灯する', pg.evaluate(STATE) == [False, False, False], pg.evaluate(STATE))
    chk('pageerror 0', not errs, errs); b.close()

    # 幅 390px: 表示がカードの中に収まり、タイトル行の中にある
    b = pw.chromium.launch(args=['--no-sandbox', '--use-gl=swiftshader'])
    pg = b.new_context(viewport={'width': 390, 'height': 844}).new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route('**/api/**', lambda r: r.fulfill(status=404, body='{}'))
    pg.goto(BASE + '/'); pg.wait_for_timeout(1200)
    m = pg.evaluate("""() => { const r = (e) => e.getBoundingClientRect(); const card = r(document.querySelector('.car-3d-card')),
        title = r(document.querySelector('.car-3d-card .card-title')), row = r(document.getElementById('da-aids'));
        return { inCard: row.right <= card.right + 0.5 && row.left >= card.left, inTitle: row.top >= title.top - 1 && row.bottom <= title.bottom + 1,
                 oneLine: title.height < 30, w: Math.round(row.width) }; }""")
    chk('390px: 表示がカードの中に収まり、タイトルの行の中にある(タイトルが 2 行にならない)', m['inCard'] and m['inTitle'] and m['oneLine'], m)
    chk('390px: pageerror 0', not errs, errs); b.close()
print('PASS', ok[0], 'FAIL', ok[1])
raise SystemExit(1 if ok[1] else 0)
