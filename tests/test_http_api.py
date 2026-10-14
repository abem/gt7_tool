"""#622 main.py の HTTP API の特性テスト(aiohttp のテストクライアント。UDP の受信は起動しない)。

一覧(/api/laps)・詳細(/api/laps/{file}: json/csv/fastf1)・取込(/api/laps/import)・診断ログ(/api/diag)・
静的配信(許可リスト・パストラバーサル拒否)の、現在の挙動を固定する。

実行(コンテナ内):
    python -m pytest tests/test_http_api.py
"""
import asyncio
import json
import os
import sys

import pytest
from aiohttp import FormData
from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402

REPO = os.path.join(os.path.dirname(__file__), "..")


def _sample(i, lap_count=2, car_id=63, course="spa"):
    return {"timestamp": "2026-10-08T17:41:%02d.%06d" % (46 + i // 60, (i % 60) * 16667),
            "current_laptime": 1000 + i, "speed_kmh": 100.0 + i, "throttle_pct": 50.0, "brake_pct": 0.0,
            "position_x": float(i), "position_z": 0.0, "gear": 3, "lap_count": lap_count,
            "last_laptime": 60000, "car_id": car_id, "course": {"id": course, "name_ja": "", "name_en": course}}


LAPS = {
    "2026-10-08_17_41_45_CAR-63_Lap-2.json": [_sample(i) for i in range(120)],
    "2026-10-08_17_43_40_CAR-63_Lap-3.json": [_sample(i, lap_count=3) for i in range(60)],
    "2026-10-07_10_00_00_CAR-3346_Lap-1.json": [_sample(i, lap_count=1, car_id=3346) for i in range(30)],
}


@pytest.fixture
def env(tmp_path, monkeypatch):
    log_dir = tmp_path / "gt7data"; log_dir.mkdir()
    imp_dir = tmp_path / "imported"; imp_dir.mkdir()
    diag_dir = tmp_path / "logs"
    for name, data in LAPS.items():
        (log_dir / name).write_text(json.dumps(data))
    monkeypatch.setattr(main, "LOG_DIR", str(log_dir))
    monkeypatch.setattr(main, "IMPORT_LOG_DIR", str(imp_dir))
    monkeypatch.setattr(main, "DIAG_LOG_DIR", str(diag_dir))
    monkeypatch.setattr(main, "_diag_last_ts", {})
    main._lap_detail_cache = main._ByteBoundedLRUCache(
        main.LAP_RESPONSE_CACHE_TOTAL_BYTES, main.LAP_RESPONSE_CACHE_MAX_ENTRY_BYTES)
    monkeypatch.chdir(REPO)      # 静的配信はカレントディレクトリのファイルを返す
    return {"log": log_dir, "imp": imp_dir, "diag": diag_dir}


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


async def _with_client(fn):
    app = main.build_app(with_telemetry=False)
    async with TestClient(TestServer(app)) as client:
        return await fn(client)


def call(fn):
    return run(_with_client(fn))


# ---------------------------------------------------------------- 一覧

def test_list_sorted_newest_first_with_paging_and_filters(env):
    async def fn(c):
        r = await c.get("/api/laps"); body = await r.json()
        assert r.status == 200 and body["total"] == 3
        assert [l["file"] for l in body["laps"]] == sorted(LAPS, reverse=True)
        assert body["laps"][0]["car_id"] == 63 and body["laps"][0]["lap_number"] == 3
        r = await c.get("/api/laps?limit=1&offset=1"); body = await r.json()
        assert body["total"] == 3 and [l["file"] for l in body["laps"]] == [sorted(LAPS, reverse=True)[1]]
        r = await c.get("/api/laps?car_id=3346"); body = await r.json()
        assert body["total"] == 1 and body["laps"][0]["file"].startswith("2026-10-07")
        r = await c.get("/api/laps?date=2026-10-08"); body = await r.json()
        assert body["total"] == 2
        for bad in ("limit=0", "limit=abc", "offset=-1", "date=2026/10/08"):
            r = await c.get("/api/laps?" + bad)
            assert r.status == 400, bad
    call(fn)


# ---------------------------------------------------------------- 詳細

def test_detail_json_every_fields_and_meta(env):
    async def fn(c):
        f = "2026-10-08_17_41_45_CAR-63_Lap-2.json"
        r = await c.get("/api/laps/" + f); body = await r.json()
        assert r.status == 200
        m = body["meta"]
        assert m["samples_total"] == 120 and m["samples_returned"] == 20 and m["every"] == 6
        assert m["schema"] == "v2" and m["course"]["id"] == "spa" and m["car_id"] == 63
        assert m["multi_course"] is False and m["courses"] == {"spa": 120}
        assert 1900 <= m["laptime_ms_approx"] <= 2000      # 119 間隔 × 1/60 秒 ≒ 1.98 秒
        assert "speed_kmh" in body["samples"][0] and "timestamp" in body["samples"][0]
        r = await c.get("/api/laps/" + f + "?every=1&fields=speed_kmh"); body = await r.json()
        assert body["meta"]["samples_returned"] == 120 and list(body["samples"][0].keys()) == ["speed_kmh"]
        r = await c.get("/api/laps/" + f + "?every=0"); assert r.status == 400
        r = await c.get("/api/laps/" + f + "?every=61"); assert r.status == 400
        r = await c.get("/api/laps/nope_CAR-1_Lap-1.json"); assert r.status in (400, 404)
        r = await c.get("/api/laps/..%2Fconfig.json"); assert r.status in (400, 404)
    call(fn)


def test_detail_csv_and_fastf1_downloads(env):
    async def fn(c):
        f = "2026-10-08_17_43_40_CAR-63_Lap-3.json"
        r = await c.get("/api/laps/" + f + "?format=csv&every=1"); text = await r.text()
        assert r.status == 200 and r.headers["Content-Type"].startswith("text/csv")
        assert r.headers["Content-Disposition"] == 'attachment; filename="2026-10-08_17_43_40_CAR-63_Lap-3.csv"'
        assert text.startswith("\ufeff")                       # Excel 向けの BOM 付き
        lines = text.lstrip("\ufeff").strip().splitlines()
        assert lines[0].split(",")[0] == "timestamp" and len(lines) == 61
        r = await c.get("/api/laps/" + f + "?format=fastf1&every=1"); text2 = await r.text()
        assert r.status == 200 and "_fastf1.csv" in r.headers["Content-Disposition"]
        assert text2.splitlines()[0].startswith("Date,") or "Date" in text2.splitlines()[0]
        r = await c.get("/api/laps/" + f + "?format=xml"); assert r.status == 400
    call(fn)


# ---------------------------------------------------------------- 取込(CSV の往復)

def test_import_roundtrip_csv_export(env):
    async def fn(c):
        f = "2026-10-08_17_43_40_CAR-63_Lap-3.json"
        r = await c.get("/api/laps/" + f + "?format=csv&every=1"); csv_text = await r.text()
        form = FormData(); form.add_field("file", csv_text.encode("utf-8"), filename="x.csv", content_type="text/csv")
        r = await c.post("/api/laps/import", data=form); body = await r.json()
        assert r.status == 201 and body["samples"] == 60
        imported = json.load(open(os.path.join(env["imp"], body["file"])))
        assert [round(s["speed_kmh"], 3) for s in imported] == [round(s["speed_kmh"], 3) for s in LAPS[f]]
        assert [s["timestamp"] for s in imported] == [s["timestamp"] for s in LAPS[f]]
        # 取込んだ記録は include_imported=true のときだけ一覧に出る
        r = await c.get("/api/laps"); assert (await r.json())["total"] == 3
        r = await c.get("/api/laps?include_imported=true"); body = await r.json()
        assert body["total"] == 4 and any(l["source"] == "imported" for l in body["laps"])
    call(fn)


def test_import_rejects_bad_input(env):
    async def fn(c):
        for content, expect in ((b"not,a,known,header\n1,2,3,4\n", 400), (b"\xff\xfe\x00bad", 400), (b"", 400)):
            form = FormData(); form.add_field("file", content, filename="x.csv", content_type="text/csv")
            r = await c.post("/api/laps/import", data=form)
            assert r.status == expect, (content[:20], r.status)
        r = await c.post("/api/laps/import", data=b"plain"); assert r.status == 400
        form = FormData(); form.add_field("other", b"x", filename="x.csv")
        r = await c.post("/api/laps/import", data=form); assert r.status == 400
    call(fn)


# ---------------------------------------------------------------- 診断ログ

def test_diag_accepts_json_object_and_rejects_others(env):
    async def fn(c):
        r = await c.post("/api/diag", data=json.dumps({"v": 1, "sid": "t", "records": [{"ev": "sample"}]}))
        assert r.status == 204
        path = os.path.join(env["diag"], main.DIAG_LOG_NAME)
        rec = json.loads(open(path).read().splitlines()[-1])
        assert rec["data"]["sid"] == "t" and rec["ip"]
        r = await c.post("/api/diag", data=b"{}"); assert r.status == 429          # 同一 IP の連投
        main._diag_last_ts.clear()
        r = await c.post("/api/diag", data=b"not json"); assert r.status == 400
        main._diag_last_ts.clear()
        r = await c.post("/api/diag", data=b"[1,2]"); assert r.status == 400
        main._diag_last_ts.clear()
        r = await c.post("/api/diag", data=b"x" * (main.DIAG_MAX_BODY_BYTES + 1)); assert r.status == 413
    call(fn)


# ---------------------------------------------------------------- 静的配信

def test_static_allowlist_and_pages(env):
    async def fn(c):
        r = await c.get("/"); assert r.status == 200 and "<title" in (await r.text())
        r = await c.get("/engineer"); assert r.status == 200
        r = await c.get("/common-utils.js"); assert r.status == 200 and "gtMedian" in (await r.text())
        r = await c.get("/styles.css"); assert r.status == 200
        r = await c.get("/favicon.ico"); assert r.status == 204
        for denied in ("/main.py", "/config.json", "/ssl/server-key.pem", "/tests/static_check.py",
                       "/nope.js", "/..%2Fconfig.json", "/index.html", "/Dockerfile"):
            r = await c.get(denied)
            assert r.status == 404, denied
    call(fn)
