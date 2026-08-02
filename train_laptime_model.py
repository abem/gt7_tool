#!/usr/bin/env python3
"""ラップタイム予測MLパイプライン(#434 P5 Stage1)。

コース×車種(course.id × car_id)の組み合わせごとに、ラップ進行度の複数チェックポイント
(25/50/75%時点)における走行特徴量から、最終ラップタイム(last_laptime)を予測する回帰
モデルを学習・検証する。

このスクリプトはgt7data/(既存の実測ラップデータ)を読み取り専用で走査するだけで、
ライブ受信経路(decoder.py/telemetry.py/main.pyのtelemetry_background_task/
broadcast_to_clients/broadcast_consumer_task)には一切触れない、独立実行のオフライン
学習パイプラインである(#434 P5指示書の大原則)。

使い方:
    python3 train_laptime_model.py [--log-dir gt7data] [--model-dir models]
                                    [--min-group-size 10] [--summary-out <path>]

出力:
    models/<course_id>__<car_id>.joblib  … 学習済みモデル(コース×車種別、gt7dataとは
                                            物理分離。.gitignoreでGit管理対象外)
    標準出力・戻り値としてのサマリ辞書(件数・MAE/RMSE・使用アルゴリズム等)
"""

import argparse
import json
import os
import re
import sys
from collections import defaultdict

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error
from sklearn.model_selection import GroupShuffleSplit
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

LAP_FILE_RE = re.compile(
    r'^(\d{4})-(\d{2})-(\d{2})_(\d{2})_(\d{2})_(\d{2})_CAR-(\d+)_Lap-(\d+)\.json$'
)

# review-view.js/telemetry-analysis.js/replay-mode.jsと同じ閾値(precedent踏襲)。
# 1フレーム弦長がこれ超は瞬間移動(pit/respawn)とみなし距離加算をスキップする。
DISCONTINUITY_M = 120

# ラップタイム(last_laptime、ms)の妥当性範囲。実データ調査(#434 P5予備調査時)で
# 868,933サンプル(通常ラップの100倍超)の異常ファイルを確認済みのため、
# 明らかに非現実的な値を持つラップはラベルとして採用しない。
MIN_LAPTIME_MS = 5_000
MAX_LAPTIME_MS = 1_800_000

# ラップ進行度チェックポイント。各ラップから複数の学習サンプルを生成する
# (Stage2のライブ推論=走行中の逐次予測を模した設計。予備調査(a)で提案した方式)。
CHECKPOINT_FRACTIONS = (0.25, 0.5, 0.75)

FEATURE_COLUMNS = (
    "progress_fraction", "avg_speed_kmh", "max_speed_kmh",
    "avg_throttle_pct", "avg_brake_pct", "avg_tyre_temp",
)


def _iter_lap_files(log_dir):
    for fn in sorted(os.listdir(log_dir)):
        if LAP_FILE_RE.match(fn):
            yield fn, os.path.join(log_dir, fn)


def _cumulative_distance(samples):
    """position_x/position_zの前フレーム差分から累積距離(m)を計算する。

    DISCONTINUITY_M超のフレームは瞬間移動(pit/respawn)とみなし距離加算をスキップする
    (review-view.js等と同じ方針)。位置情報が欠損するサンプルは直前の累積値を維持する。
    """
    dist = []
    total = 0.0
    prev = None
    for s in samples:
        x = s.get("position_x")
        z = s.get("position_z")
        if x is None or z is None:
            dist.append(total)
            continue
        if prev is not None:
            dx = x - prev[0]
            dz = z - prev[1]
            chord = (dx * dx + dz * dz) ** 0.5
            if chord <= DISCONTINUITY_M:
                total += chord
        prev = (x, z)
        dist.append(total)
    return dist


def _extract_checkpoint_rows(file_id, samples, course_id, car_id, last_laptime):
    """1ラップから、進行度チェックポイントごとの特徴量行を生成する。"""
    if len(samples) < 10:
        return []
    cum_dist = _cumulative_distance(samples)
    total_dist = cum_dist[-1] if cum_dist else 0.0
    if total_dist <= 0:
        return []

    rows = []
    for frac in CHECKPOINT_FRACTIONS:
        target_dist = total_dist * frac
        idx = 0
        for i, d in enumerate(cum_dist):
            if d <= target_dist:
                idx = i
            else:
                break
        window = samples[:idx + 1]
        if len(window) < 5:
            continue

        speeds = [w.get("speed_kmh") or 0.0 for w in window]
        throttles = [w.get("throttle_pct") or 0.0 for w in window]
        brakes = [w.get("brake_pct") or 0.0 for w in window]
        tyre_temp_means = []
        for w in window:
            tt = w.get("tyre_temp")
            if isinstance(tt, list) and len(tt) == 4 and all(isinstance(v, (int, float)) for v in tt):
                tyre_temp_means.append(sum(tt) / 4)

        rows.append({
            "file": file_id,
            "course_id": course_id,
            "car_id": car_id,
            "progress_fraction": frac,
            "avg_speed_kmh": float(np.mean(speeds)),
            "max_speed_kmh": float(np.max(speeds)),
            "avg_throttle_pct": float(np.mean(throttles)),
            "avg_brake_pct": float(np.mean(brakes)),
            "avg_tyre_temp": float(np.mean(tyre_temp_means)) if tyre_temp_means else np.nan,
            "last_laptime": float(last_laptime),
        })
    return rows


def build_dataset(log_dir):
    """gt7data/を走査し、特徴量DataFrameと除外件数の内訳を返す(読み取り専用)。"""
    rows = []
    skipped = defaultdict(int)
    total_files = 0

    for fn, path in _iter_lap_files(log_dir):
        total_files += 1
        try:
            with open(path) as f:
                data = json.load(f)
        except Exception:
            skipped["parse_error"] += 1
            continue
        if not isinstance(data, list) or len(data) < 10:
            skipped["too_short"] += 1
            continue

        first = data[0] if isinstance(data[0], dict) else {}
        last = data[-1] if isinstance(data[-1], dict) else {}

        course = first.get("course")
        course_id = course.get("id") if isinstance(course, dict) else None
        if not course_id or course_id == "unknown":
            skipped["unknown_course"] += 1
            continue

        car_id = first.get("car_id")
        if car_id is None:
            skipped["missing_car_id"] += 1
            continue

        llt = last.get("last_laptime")
        if not isinstance(llt, (int, float)) or not (MIN_LAPTIME_MS <= llt <= MAX_LAPTIME_MS):
            skipped["invalid_laptime"] += 1
            continue

        lap_rows = _extract_checkpoint_rows(fn, data, course_id, car_id, llt)
        if not lap_rows:
            skipped["feature_extraction_failed"] += 1
            continue
        rows.extend(lap_rows)

    df = pd.DataFrame(rows)
    if not df.empty and df["avg_tyre_temp"].isna().any():
        df["avg_tyre_temp"] = df["avg_tyre_temp"].fillna(df["avg_tyre_temp"].median())
    return df, dict(skipped), total_files


def _group_train_test_split(df, test_size=0.2, random_state=42):
    """同一ラップ(file)のチェックポイント行がtrain/testに分かれないよう、
    ラップ単位でグループ分割する(リーク防止)。
    """
    splitter = GroupShuffleSplit(n_splits=1, test_size=test_size, random_state=random_state)
    train_idx, test_idx = next(splitter.split(df, groups=df["file"]))
    return df.iloc[train_idx], df.iloc[test_idx]


def train_and_evaluate_group(df_group):
    """1つのコース×車種グループについて、Ridge/RandomForestを比較しMAE/RMSEの
    良い方を採用する。"""
    n_laps = df_group["file"].nunique()
    train_df, test_df = _group_train_test_split(df_group)

    X_train = train_df[list(FEATURE_COLUMNS)].values
    y_train = train_df["last_laptime"].values
    X_test = test_df[list(FEATURE_COLUMNS)].values
    y_test = test_df["last_laptime"].values

    candidates = {
        "ridge": Pipeline([("scale", StandardScaler()), ("model", Ridge(alpha=1.0))]),
        "random_forest": RandomForestRegressor(
            n_estimators=200, max_depth=4, min_samples_leaf=2, random_state=42
        ),
    }

    best = None
    for name, model in candidates.items():
        model.fit(X_train, y_train)
        pred = model.predict(X_test)
        mae = float(mean_absolute_error(y_test, pred))
        rmse = float(mean_squared_error(y_test, pred) ** 0.5)
        result = {"algorithm": name, "model": model, "mae_ms": mae, "rmse_ms": rmse}
        if best is None or mae < best["mae_ms"]:
            best = result

    return {
        "n_laps": int(n_laps),
        "n_train_rows": int(len(train_df)),
        "n_test_rows": int(len(test_df)),
        "algorithm": best["algorithm"],
        "mae_ms": best["mae_ms"],
        "rmse_ms": best["rmse_ms"],
        "mean_laptime_ms": float(df_group["last_laptime"].mean()),
        "_model": best["model"],
    }


def run(log_dir, model_dir, min_group_size, summary_out=None):
    df, skipped, total_files = build_dataset(log_dir)
    os.makedirs(model_dir, exist_ok=True)

    if df.empty:
        return {
            "total_files_scanned": total_files, "skipped": skipped,
            "groups": {}, "note": "no usable data",
        }

    group_sizes = df.groupby(["course_id", "car_id"])["file"].nunique()
    trainable_groups = group_sizes[group_sizes >= min_group_size].index.tolist()
    excluded_groups = group_sizes[group_sizes < min_group_size].to_dict()

    group_results = {}
    for course_id, car_id in trainable_groups:
        key = f"{course_id}__{car_id}"
        sub = df[(df["course_id"] == course_id) & (df["car_id"] == car_id)]
        try:
            result = train_and_evaluate_group(sub)
        except ValueError as e:
            # GroupShuffleSplitがラップ数不足で分割できない等
            group_results[key] = {"error": str(e)}
            continue
        model = result.pop("_model")
        model_path = os.path.join(model_dir, f"{key}.joblib")
        joblib.dump(model, model_path)
        result["model_path"] = model_path
        group_results[key] = result

    summary = {
        "total_files_scanned": total_files,
        "skipped": skipped,
        "min_group_size": min_group_size,
        "checkpoint_fractions": list(CHECKPOINT_FRACTIONS),
        "feature_columns": list(FEATURE_COLUMNS),
        "trained_groups": group_results,
        "excluded_groups_below_threshold": {
            f"{c}__{car}": n for (c, car), n in excluded_groups.items()
        },
    }

    if summary_out:
        with open(summary_out, "w") as f:
            json.dump(summary, f, indent=2, ensure_ascii=False)

    return summary


def main():
    parser = argparse.ArgumentParser(description="GT7 ラップタイム予測MLパイプライン(#434 P5 Stage1)")
    parser.add_argument("--log-dir", default="gt7data")
    parser.add_argument("--model-dir", default="models")
    parser.add_argument("--min-group-size", type=int, default=10)
    parser.add_argument("--summary-out", default="models/training_summary.json")
    args = parser.parse_args()

    summary = run(args.log_dir, args.model_dir, args.min_group_size, args.summary_out)
    print(json.dumps(
        {k: v for k, v in summary.items()}, indent=2, ensure_ascii=False
    ))


if __name__ == "__main__":
    main()
