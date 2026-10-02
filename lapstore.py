#!/usr/bin/env python3
"""ラップファイル・予測特徴量の共有定義(#574)。

main.py(推論API)とtrain_laptime_model.py(オフライン学習パイプライン)の双方が
同じ定義を参照するための、標準ライブラリのみに依存する軽量モジュール。

#560(train/serve mismatch)の再発防止: PREDICT_FEATURE_COLUMNS(main.py側の手書き
コピー)がFEATURE_COLUMNS(train_laptime_model.py)と食い違う余地を無くすため、
列の並びと名前はここで単一定義し、両モジュールはここからimportする。

main.pyはこのモジュール経由でpandas/sklearn/joblib等の重い依存をimportしないこと
(main.pyの起動コストに影響するため)。このファイル自身がstdlibのみに依存することは
tests/test_lapstore.pyのサブプロセス検証で保証する。
"""

import re

# save_lap_to_file(main.py)の命名形式に完全一致するファイルのみを対象にする
# (許可リスト方式: パス区切り・別拡張子・BU等の変則名は正規表現の時点で排除)。
# main.py/train_laptime_model.pyの双方で同一のregexオブジェクトを共有する(#574)。
LAP_FILE_RE = re.compile(
    r'^(\d{4})-(\d{2})-(\d{2})_(\d{2})_(\d{2})_(\d{2})_CAR-(\d+)_Lap-(\d+)\.json$'
)

# ラップタイム予測の特徴量列(train_laptime_model.pyの学習時の列順 = main.pyの
# 推論時の列順)。この並びがモデルの入力列順そのものであり、食い違うと#560と同種の
# train/serve mismatchになる。両モジュールはこのタプルをそのまま使う(手書きコピー禁止)。
FEATURE_COLUMNS = (
    "progress_fraction", "avg_speed_kmh", "max_speed_kmh",
    "avg_throttle_pct", "avg_brake_pct", "avg_tyre_temp",
)

# /api/predict/laptime のクエリパラメータ名(FEATURE_COLUMNSの各列に対応)。
# progress_fractionだけクエリ名が"progress"(フロントエンドのlaptime-predict.jsと
# 既存の互換のため)で、他は列名とクエリ名が同一。
FEATURE_QUERY_PARAMS = {
    "progress_fraction": "progress",
    "avg_speed_kmh": "avg_speed_kmh",
    "max_speed_kmh": "max_speed_kmh",
    "avg_throttle_pct": "avg_throttle_pct",
    "avg_brake_pct": "avg_brake_pct",
    "avg_tyre_temp": "avg_tyre_temp",
}
