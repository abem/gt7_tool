"""#644: /car.glb(CAR ATTITUDE の 3D 車モデル)の配信。models/car.glb があれば返し、無ければ 404。
他の .glb やパス付きは従来の許可リスト(静的配信は直下の .js / .css だけ)で 404。
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402
from test_http_api import env, call  # noqa: E402,F401  (env: pytest フィクスチャ)

GLB_MAGIC = b"glTF" + bytes(12)


def test_car_glb_served_from_model_dir_or_404(env, tmp_path, monkeypatch):
    model_dir = tmp_path / "models3d"
    monkeypatch.setattr(main, "CAR_MODEL_DIR", str(model_dir))

    async def fn(c):
        r = await c.get("/car.glb"); assert r.status == 404                 # モデル未配置 → Canvas2D のまま
        model_dir.mkdir()
        (model_dir / "car.glb").write_bytes(GLB_MAGIC)
        r = await c.get("/car.glb")
        assert r.status == 200 and r.headers["Content-Type"].startswith("model/gltf-binary")
        assert r.headers["Cache-Control"] == "no-cache" and await r.read() == GLB_MAGIC
        r = await c.get("/other.glb"); assert r.status == 404                # 固定名以外は配信しない
        r = await c.get("/models/car.glb"); assert r.status == 404           # パス付きは従来どおり拒否
    call(fn)


def test_three_js_assets_are_top_level_js_and_served(env):
    async def fn(c):
        for name in ("three.min.js", "GLTFLoader.js", "car-3d-model.js"):
            r = await c.get("/" + name)
            assert r.status == 200, name
    call(fn)
