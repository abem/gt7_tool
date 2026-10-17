"""#644 CAR ATTITUDE の 3D 車モデル: モデルが無い・?car3d=0 では針金図(Canvas2D)だけで従来どおり。
?car3d=1(ソフトウェア描画を許可)+ /car.glb があれば、針金図の背面に WebGL のキャンバスが挿さり、姿勢更新で例外が出ない。"""
import os
from playwright.sync_api import sync_playwright
from e2e_env import BASE, FIXTURES

ok = [0, 0]
def chk(n, c, x=''): ok[0 if c else 1] += 1; print('PASS' if c else 'FAIL', n, x)

GLB = open(os.path.join(FIXTURES, 'car_placeholder.glb'), 'rb').read()
STATE = ("() => ({active: gtCarModelState.active, reason: gtCarModelState.reason,"
         " canvases: document.querySelectorAll('#car-3d-view canvas').length,"
         " first2d: document.querySelector('#car-3d-view canvas') === car3DState.canvas,"
         " inited: car3DState.initialized})")

with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    ctx = b.new_context(viewport={'width': 1600, 'height': 900}); errs = []

    def open_page(query, with_model):
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.route('**/api/**', lambda r: r.fulfill(status=404, body='{}'))
        if with_model:
            pg.route('**/car.glb', lambda r: r.fulfill(status=200, content_type='model/gltf-binary', body=GLB))
        pg.goto(BASE + '/' + query); pg.wait_for_timeout(1500)
        return pg

    # 1) モデル無し(静的サーバーに car.glb は無い → 404)、既定の設定: 針金図だけ
    pg = open_page('', False); st = pg.evaluate(STATE)
    chk('モデル無し: 2D キャンバス 1 枚だけ', st['canvases'] == 1 and st['first2d'], st)
    chk('モデル無し: 3D は無効で理由が記録される', st['active'] is False and st['reason'] != '', st['reason'])
    chk('モデル無し: 針金図は初期化済み', st['inited'] is True)
    pg.close()

    # 2) ?car3d=0: モデルがあっても 3D を使わない
    pg = open_page('?car3d=0', True); st = pg.evaluate(STATE)
    chk('?car3d=0: 2D だけ・理由は disabled', st['canvases'] == 1 and 'disabled' in st['reason'], st)
    pg.close()

    # 3) ?car3d=1 + モデルあり: WebGL キャンバスが針金図の背面(先頭)に挿さる
    pg = open_page('?car3d=1', True); st = pg.evaluate(STATE)
    chk('?car3d=1+モデル: 3D 有効', st['active'] is True, st)
    chk('?car3d=1+モデル: キャンバス 2 枚、先頭が WebGL(2D は上)', st['canvases'] == 2 and not st['first2d'], st)
    pg.evaluate("() => { updateCar3D(0.12, 0.5, -0.1, 0, 0.3, [0.02, 0.05, 0.01, 0.04]); updateCar3D(NaN, 0, undefined, 0, 0, null); }")
    pg.wait_for_timeout(300)
    st2 = pg.evaluate(STATE)
    chk('姿勢更新(NaN を含む)後も 3D 有効のまま', st2['active'] is True, st2)
    pg.close()

    chk('pageerror 0', not errs, errs); b.close()
print('PASS', ok[0], 'FAIL', ok[1])
raise SystemExit(1 if ok[1] else 0)
