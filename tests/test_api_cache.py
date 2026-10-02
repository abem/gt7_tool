"""再読み込みキャッシュ(#573)のテスト: /api/laps/{file}・gated_groups.json・
joblibモデルの各キャッシュが、ファイル内容が変わらない間はI/Oを避け、
ファイルが変わったら次回呼び出しで確実に取り直すことを確認する。

実行(コンテナ内、または scikit-learn/pandas/aiohttp がある環境):
    python -m pytest tests/test_api_cache.py
"""
import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402
from aiohttp.test_utils import make_mocked_request  # noqa: E402


def _request(path_and_query, filename):
    return make_mocked_request("GET", path_and_query, match_info={"file": filename})


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


SAMPLE_LAP = [
    {"timestamp": "2026-09-01T10:00:00", "current_laptime": 1000, "speed_kmh": 100.0,
     "throttle_pct": 50.0, "brake_pct": 0.0, "position_x": 0.0, "position_z": 0.0,
     "gear": 3, "lap_count": 2, "last_laptime": 60000, "car_id": 1},
    {"timestamp": "2026-09-01T10:00:01", "current_laptime": 1016, "speed_kmh": 110.0,
     "throttle_pct": 60.0, "brake_pct": 0.0, "position_x": 1.0, "position_z": 0.0,
     "gear": 3, "lap_count": 2, "last_laptime": 60000, "car_id": 1},
]
LAP_FILENAME = "2026-09-01_10_00_00_CAR-1_Lap-2.json"


@pytest.fixture
def lap_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "LOG_DIR", str(tmp_path))
    monkeypatch.setattr(main, "IMPORT_LOG_DIR", str(tmp_path / "imported_unused"))
    main._lap_detail_cache = main._ByteBoundedLRUCache(
        main.LAP_RESPONSE_CACHE_TOTAL_BYTES, main.LAP_RESPONSE_CACHE_MAX_ENTRY_BYTES
    )
    path = tmp_path / LAP_FILENAME
    path.write_text(json.dumps(SAMPLE_LAP))
    return tmp_path, path


def _get_lap(path_filename, query=""):
    req = _request(f"/api/laps/{path_filename}{query}", path_filename)
    return _run(main.api_lap_detail_handler(req))


def test_second_identical_request_skips_file_loader(lap_dir, monkeypatch):
    calls = []
    original = main._load_lap_file

    def counting(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(main, "_load_lap_file", counting)

    r1 = _get_lap(LAP_FILENAME, "?every=1")
    r2 = _get_lap(LAP_FILENAME, "?every=1")
    assert len(calls) == 1
    assert r1.status == r2.status == 200
    assert r1.body == r2.body
    assert r1.headers.get("Cache-Control") == r2.headers.get("Cache-Control")


def test_different_every_or_fields_are_separate_cache_entries(lap_dir, monkeypatch):
    calls = []
    original = main._load_lap_file
    monkeypatch.setattr(main, "_load_lap_file", lambda *a, **k: (calls.append(1), original(*a, **k))[1])

    r1 = _get_lap(LAP_FILENAME, "?every=1")
    r2 = _get_lap(LAP_FILENAME, "?every=2")
    r3 = _get_lap(LAP_FILENAME, "?every=1&fields=timestamp")
    assert len(calls) == 3
    assert r1.body != r2.body
    assert r1.body != r3.body


def test_rewritten_file_with_different_size_reloads(lap_dir, monkeypatch):
    tmp_path, path = lap_dir
    calls = []
    original = main._load_lap_file
    monkeypatch.setattr(main, "_load_lap_file", lambda *a, **k: (calls.append(1), original(*a, **k))[1])

    r1 = _get_lap(LAP_FILENAME, "?every=1")
    assert len(calls) == 1

    bigger = SAMPLE_LAP + [dict(SAMPLE_LAP[-1], timestamp="2026-09-01T10:00:02")]
    path.write_text(json.dumps(bigger))
    os.utime(path, None)

    r2 = _get_lap(LAP_FILENAME, "?every=1")
    assert len(calls) == 2
    assert r1.body != r2.body
    assert json.loads(r2.body)["meta"]["samples_total"] == 3


def test_byte_budget_enforced_oversized_payload_not_cached(lap_dir, monkeypatch):
    monkeypatch.setattr(main, "LAP_RESPONSE_CACHE_MAX_ENTRY_BYTES", 10)
    main._lap_detail_cache = main._ByteBoundedLRUCache(main.LAP_RESPONSE_CACHE_TOTAL_BYTES, 10)
    calls = []
    original = main._load_lap_file
    monkeypatch.setattr(main, "_load_lap_file", lambda *a, **k: (calls.append(1), original(*a, **k))[1])

    _get_lap(LAP_FILENAME, "?every=1")
    _get_lap(LAP_FILENAME, "?every=1")
    assert len(calls) == 2    # 1エントリの上限(10B)を超えるため、毎回ロードし直す


def test_csv_and_fastf1_responses_identical_with_and_without_cache(lap_dir):
    r1 = _get_lap(LAP_FILENAME, "?every=1&format=csv")
    r2 = _get_lap(LAP_FILENAME, "?every=1&format=csv")
    assert r1.body == r2.body
    assert r1.headers.get("Content-Disposition") == r2.headers.get("Content-Disposition")
    assert r1.headers.get("Content-Type") == r2.headers.get("Content-Type") == "text/csv; charset=utf-8"

    f1 = _get_lap(LAP_FILENAME, "?every=1&format=fastf1")
    f2 = _get_lap(LAP_FILENAME, "?every=1&format=fastf1")
    assert f1.body == f2.body
    assert f1.headers.get("Content-Disposition") == f2.headers.get("Content-Disposition")


# ---- gated_groups.json キャッシュ ----

@pytest.fixture
def gated_groups_path(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "PREDICT_GATED_GROUPS_FILE", str(tmp_path / "gated_groups.json"))
    main._gated_groups_cache = main._StatCache(maxsize=1)
    return tmp_path / "gated_groups.json"


def test_gated_groups_missing_file_returns_empty_dict(gated_groups_path):
    assert main._load_gated_groups() == {}


def test_gated_groups_reload_on_change_without_restart(gated_groups_path, monkeypatch):
    opens = []
    real_open = open

    def counting_open(path, *a, **k):
        if path == str(gated_groups_path):
            opens.append(1)
        return real_open(path, *a, **k)

    monkeypatch.setattr("builtins.open", counting_open)

    gated_groups_path.write_text(json.dumps({"c__1": {"mae_ms": 1.0}}))
    g1 = main._load_gated_groups()
    g2 = main._load_gated_groups()
    assert g1 == g2 == {"c__1": {"mae_ms": 1.0}}
    assert len(opens) == 1    # 2回目はキャッシュヒットで open しない

    gated_groups_path.write_text(json.dumps({"c__2": {"mae_ms": 2.0}}))
    os.utime(gated_groups_path, None)
    g3 = main._load_gated_groups()
    assert g3 == {"c__2": {"mae_ms": 2.0}}
    assert len(opens) == 2    # ファイル変更後は再読み込みする


# ---- joblibモデルキャッシュ ----

class _FakeModel:
    def __init__(self, value):
        self.value = value

    def predict(self, X):
        return [self.value]


def test_model_reload_after_model_file_changes(tmp_path, monkeypatch):
    main._model_cache = main._StatCache(maxsize=main.PREDICT_MODEL_CACHE_MAXSIZE)
    model_path = str(tmp_path / "m.joblib")
    loads = []

    def fake_load(path):
        loads.append(1)
        return _FakeModel(len(loads))

    monkeypatch.setattr(main.joblib, "load", fake_load)
    with open(model_path, "w") as f:
        f.write("v1")

    r1 = main._predict_laptime(model_path, [0.5, 1, 2, 3, 4, 5])
    r2 = main._predict_laptime(model_path, [0.5, 1, 2, 3, 4, 5])
    assert len(loads) == 1 and r1 == r2 == 1.0

    with open(model_path, "w") as f:
        f.write("v2-longer-content")
    os.utime(model_path, None)

    r3 = main._predict_laptime(model_path, [0.5, 1, 2, 3, 4, 5])
    assert len(loads) == 2 and r3 == 2.0


def test_predict_endpoint_identical_to_uncached_path(monkeypatch):
    """キャッシュ有無で/api/predict/laptimeの応答が変わらないこと。"""
    main._model_cache = main._StatCache(maxsize=main.PREDICT_MODEL_CACHE_MAXSIZE)
    group = {"car_id": 1, "model_path": "m", "mae_ms": 1000.0, "mae_pct": 1.6, "n_laps": 20,
             "algorithm": "ridge", "median_laptime_ms": 60_000.0}
    monkeypatch.setattr(main, "_load_gated_groups", lambda: {"c__1": group})
    monkeypatch.setattr(main, "_predict_laptime", lambda path, feats: 61_000.0)

    q = ("/api/predict/laptime?course=c&car_id=1&progress=0.5&avg_speed_kmh=120&max_speed_kmh=190"
         "&avg_throttle_pct=55&avg_brake_pct=8&avg_tyre_temp=70")
    r1 = _run(main.api_predict_laptime_handler(make_mocked_request("GET", q)))
    r2 = _run(main.api_predict_laptime_handler(make_mocked_request("GET", q)))
    assert r1.status == r2.status == 200
    assert r1.body == r2.body
