"""lapstore.py(main.py/train_laptime_model.py共有定義)のテスト(#574)。

実行(コンテナ内、または scikit-learn/pandas がある環境):
    python -m pytest tests/test_lapstore.py
"""
import asyncio
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import lapstore  # noqa: E402
import main  # noqa: E402
import train_laptime_model as t  # noqa: E402


def test_lap_file_regex_is_shared_object_in_both_modules():
    assert main.LAP_FILE_RE is lapstore.LAP_FILE_RE
    assert t.LAP_FILE_RE is lapstore.LAP_FILE_RE


def test_feature_columns_are_shared_tuple_in_both_modules():
    assert main.PREDICT_FEATURE_COLUMNS is lapstore.FEATURE_COLUMNS
    assert t.FEATURE_COLUMNS is lapstore.FEATURE_COLUMNS
    assert lapstore.FEATURE_COLUMNS == (
        "progress_fraction", "avg_speed_kmh", "max_speed_kmh",
        "avg_throttle_pct", "avg_brake_pct", "avg_tyre_temp",
    )


def test_lapstore_imports_only_stdlib():
    """フレッシュなサブプロセスでlapstoreをimportしても、pandas/sklearn/numpyが
    importされないこと(main.pyがこのモジュール経由で重い依存を引き込まないため)。
    """
    repo = os.path.join(os.path.dirname(__file__), "..")
    code = (
        "import sys, lapstore; "
        "heavy = [m for m in ('pandas', 'numpy', 'sklearn', 'joblib') if m in sys.modules]; "
        "print(','.join(heavy))"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], cwd=repo, capture_output=True, text=True, check=True
    )
    assert result.stdout.strip() == ""


def test_predict_handler_passes_features_in_column_order(monkeypatch):
    """各クエリパラメータへ列ごとに異なる値を与え、_predict_laptimeに渡される
    feature_valuesがPREDICT_FEATURE_COLUMNS(= lapstore.FEATURE_COLUMNS)の順序と
    完全一致すること(#574、手書きの並び替えで食い違わないことの確認)。
    """
    from aiohttp.test_utils import make_mocked_request

    captured = {}

    def fake_predict(model_path, feature_values):
        captured["feature_values"] = feature_values
        return 61_000.0

    group = {"car_id": 1, "model_path": "m", "mae_ms": 1000.0, "mae_pct": 1.6, "n_laps": 20,
             "algorithm": "ridge", "median_laptime_ms": 60_000.0}
    monkeypatch.setattr(main, "_load_gated_groups", lambda: {"c__1": group})
    monkeypatch.setattr(main, "_predict_laptime", fake_predict)

    # 列ごとに一意な値を割り当てる(progress_fraction=0.11, avg_speed_kmh=22.0, ...)
    distinct_values = {
        "progress_fraction": 0.11, "avg_speed_kmh": 22.0, "max_speed_kmh": 33.0,
        "avg_throttle_pct": 44.0, "avg_brake_pct": 5.0, "avg_tyre_temp": 66.0,
    }
    query = "&".join(
        f"{lapstore.FEATURE_QUERY_PARAMS[col]}={distinct_values[col]}"
        for col in lapstore.FEATURE_COLUMNS
    )
    q = f"/api/predict/laptime?course=c&car_id=1&{query}"
    resp = asyncio.new_event_loop().run_until_complete(
        main.api_predict_laptime_handler(make_mocked_request("GET", q)))

    assert resp.status == 200
    expected = [distinct_values[col] for col in lapstore.FEATURE_COLUMNS]
    assert captured["feature_values"] == expected
