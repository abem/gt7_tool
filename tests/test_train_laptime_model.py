"""ラップタイム予測の学習パイプラインと、予測APIの妥当性チェック(#560)のテスト。

実行(コンテナ内、または scikit-learn/pandas がある環境):
    python -m pytest tests/test_train_laptime_model.py
"""
import asyncio
import json
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import train_laptime_model as t  # noqa: E402


def _lap_rows(n_laps, laptime=60_000, dist=2_000, start_day=1, jitter=0.0, course="c", car=1):
    """単独周回 n_laps 本分の行(各3チェックポイント)を作る。ファイル名は時刻の昇順。"""
    rows = []
    rng = np.random.default_rng(0)
    for i in range(n_laps):
        lt = laptime * (1 + jitter * rng.standard_normal())
        fn = f"2026-09-{start_day:02d}_10_{i:02d}_00_CAR-{car}_Lap-{i + 2}.json"
        for frac in t.CHECKPOINT_FRACTIONS:
            rows.append({
                "file": fn, "course_id": course, "car_id": car, "progress_fraction": frac,
                "avg_speed_kmh": 120 + 5 * rng.standard_normal(), "max_speed_kmh": 190.0,
                "avg_throttle_pct": 55.0, "avg_brake_pct": 8.0, "avg_tyre_temp": 70.0,
                "last_laptime": float(lt), "total_dist_m": float(dist),
            })
    return rows


def test_filter_drops_multi_lap_and_truncated_records():
    rows = _lap_rows(10)
    rows += [dict(r, file="2026-09-01_11_00_00_CAR-1_Lap-1.json", total_dist_m=4_890.0, last_laptime=65_000.0)
             for r in _lap_rows(1)]                       # 複数周回を含む記録(距離2.4倍)
    rows += [dict(r, file="2026-09-01_12_00_00_CAR-1_Lap-9.json", total_dist_m=910.0)
             for r in _lap_rows(1)]                       # 途中で切れた記録(距離0.45倍)
    rows += [dict(r, file="2026-09-01_13_00_00_CAR-1_Lap-8.json", last_laptime=532_000.0)
             for r in _lap_rows(1)]                       # ラップタイム異常(距離は正常)
    df = pd.DataFrame(rows)
    kept, dropped = t.filter_group_outliers(df)
    assert dropped == {"distance": 2, "laptime": 1}
    assert kept["file"].nunique() == 10
    assert (kept["last_laptime"] == 60_000).all()


def test_filter_keeps_all_when_consistent_and_tiny_groups_untouched():
    df = pd.DataFrame(_lap_rows(8, jitter=0.01))
    kept, dropped = t.filter_group_outliers(df)
    assert dropped == {"distance": 0, "laptime": 0} and kept["file"].nunique() == 8
    tiny = pd.DataFrame(_lap_rows(2))
    kept2, dropped2 = t.filter_group_outliers(tiny)
    assert len(kept2) == len(tiny) and dropped2 == {"distance": 0, "laptime": 0}


def test_time_split_uses_newest_laps_for_test():
    df = pd.DataFrame(_lap_rows(20))
    train, test = t._time_ordered_split(df)
    assert test["file"].nunique() == 4            # ceil(20 * 0.2)
    assert max(train["file"]) < min(test["file"])  # 検証は学習より新しい周回だけ
    assert len(train) + len(test) == len(df)


def test_time_split_min_test_laps_and_too_few_laps():
    _, test = t._time_ordered_split(pd.DataFrame(_lap_rows(10)))
    assert test["file"].nunique() == t.MIN_TEST_LAPS        # 10*0.2=2 → 最小3本
    with pytest.raises(ValueError):
        t._time_ordered_split(pd.DataFrame(_lap_rows(t.MIN_TRAIN_LAPS + t.MIN_TEST_LAPS - 1)))


def test_train_reports_time_holdout_metrics_and_medians():
    df = pd.DataFrame(_lap_rows(20, jitter=0.01))
    res = t.train_and_evaluate_group(df)
    assert res["n_test_laps"] == 4
    assert abs(res["median_laptime_ms"] - 60_000) < 2_000
    assert res["median_distance_m"] == 2_000
    assert res["mae_ms"] / res["mean_laptime_ms"] < 0.05
    pred = res["_model"].predict([[0.5, 120, 190, 55, 8, 70]])[0]
    assert 55_000 < pred < 65_000               # 全ラップで学習し直したモデルが、周回の分布に合っている


def test_stale_distribution_is_detected_by_time_holdout():
    """古い周回(約130秒)で学習したモデルが、新しい周回(約60秒)で検証されると、大きな誤差になる。
    ランダム分割では見逃す状況(#560)。"""
    old = _lap_rows(15, laptime=130_000, start_day=1, jitter=0.01)
    new = _lap_rows(5, laptime=60_000, start_day=20, jitter=0.01)
    df = pd.DataFrame(old + new)
    _, test = t._time_ordered_split(df)
    assert set(test["file"]) <= {r["file"] for r in new}
    res = t.train_and_evaluate_group(df)
    assert res["mae_ms"] / res["mean_laptime_ms"] * 100 > t.QUALITY_GATE_MAE_PCT


def test_gated_groups_written_with_new_fields_and_raw_gate(tmp_path):
    ok = {"course_id": "c", "car_id": 1, "model_path": "m", "mae_ms": 1_000.0, "mae_pct": 1.67,
          "n_laps": 20, "algorithm": "ridge", "mean_laptime_ms": 60_000.0,
          "median_laptime_ms": 60_000.0, "median_distance_m": 2_000.0, "n_test_laps": 4}
    bad = dict(ok, mae_ms=3_000.0, mean_laptime_ms=60_000.0)   # 5% → ゲート外
    edge = dict(ok, mae_ms=3_001.0, mean_laptime_ms=100_000.0)  # 3.001% → 丸めで3.00%でも外れる
    gated = t._write_gated_groups(str(tmp_path), {"c__1": ok, "c__2": bad, "c__3": edge})
    assert list(gated) == ["c__1"]
    g = json.load(open(tmp_path / "gated_groups.json"))["c__1"]
    assert g["median_laptime_ms"] == 60_000.0 and g["validation"] == "time_holdout"
    assert g["n_test_laps"] == 4 and g["trained_at"].endswith("+00:00")


# ---- 予測APIの妥当性チェック(main.py) ----

def _call_predict(monkeypatch, group, predicted_ms):
    import main
    from aiohttp.test_utils import make_mocked_request
    monkeypatch.setattr(main, "_load_gated_groups", lambda: {"c__1": group})
    monkeypatch.setattr(main, "_predict_laptime", lambda path, feats: predicted_ms)
    q = ("/api/predict/laptime?course=c&car_id=1&progress=0.5&avg_speed_kmh=120&max_speed_kmh=190"
         "&avg_throttle_pct=55&avg_brake_pct=8&avg_tyre_temp=70")
    return asyncio.new_event_loop().run_until_complete(
        main.api_predict_laptime_handler(make_mocked_request("GET", q)))


BASE_GROUP = {"car_id": 1, "model_path": "m", "mae_ms": 1000.0, "mae_pct": 1.6, "n_laps": 20,
              "algorithm": "ridge", "median_laptime_ms": 60_000.0}


def test_api_withholds_implausible_prediction(monkeypatch):
    resp = _call_predict(monkeypatch, BASE_GROUP, 136_500.0)    # goodwood/63 の実例(2.3倍)
    assert resp.status == 404
    assert "implausible" in json.loads(resp.body)["error"]


def test_api_serves_plausible_prediction_and_boundary(monkeypatch):
    ok = _call_predict(monkeypatch, BASE_GROUP, 61_234.0)
    assert ok.status == 200 and json.loads(ok.body)["predicted_laptime_ms"] == 61_234.0
    assert _call_predict(monkeypatch, BASE_GROUP, 60_000 * 1.29).status == 200     # 範囲内
    assert _call_predict(monkeypatch, BASE_GROUP, 60_000 * 1.31).status == 404     # 範囲外
    assert _call_predict(monkeypatch, BASE_GROUP, 60_000 * 0.69).status == 404


def test_api_without_median_keeps_old_behaviour(monkeypatch):
    legacy = {k: v for k, v in BASE_GROUP.items() if k != "median_laptime_ms"}    # 旧形式の許可リスト
    assert _call_predict(monkeypatch, legacy, 136_500.0).status == 200
