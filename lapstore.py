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


# ---------------------------------------------------------------- 受信時刻の並べ直し(#602)

def _median(values):
    a = sorted(values)
    n = len(a)
    return a[n // 2] if n % 2 else (a[n // 2 - 1] + a[n // 2]) / 2.0


PACE_MIN_SAMPLES = 10     # 本来の間隔(中央値)を決めるのに要る、正の差の個数
PACE_MIN_SPACING = 0.95   # 隣り合うサンプルの間隔の下限(本来の間隔に対する割合。受信の揺らぎは許す)


def repace_timestamps(ts, gap_s):
    """記録の受信時刻(絶対秒。無いものは None)の、詰まった区間を本来の間隔で並べ直す(#602)。

    サーバーは受信時刻を付ける。保存などで一時的に止まった直後は、たまったパケットが
    ほぼ同じ時刻で記録される(ラップの先頭で 1〜3.5 秒ぶん)。そのままだと、再生がその区間だけ
    数倍速になり、ラップ時間の近似も短くなる。
    受信時刻は「遅れる」ことはあっても「早まる」ことはない。そこで末尾(止まりが終わった、最も
    信用できる時刻)から前へ向かい、各サンプルを「次のサンプルより本来の間隔(正の差の中央値 ×
    PACE_MIN_SPACING)以上前」まで戻す。詰まっていない所は変わらず、詰まった塊は本来の間隔で
    前へ広がる(途中の短い止まりは、その前の空きへ収まる)。
    間引く前の全サンプル(60Hz)で行うこと(間引いた後では塊の大きさが分からない)。
    @return 並べ直した絶対秒の一覧(無いものは None のまま)。
    """
    n = len(ts)
    valid = [i for i in range(n) if ts[i] is not None]
    dts = []
    for k in range(1, len(valid)):
        dt = ts[valid[k]] - ts[valid[k - 1]]
        if 0 < dt < gap_s:
            dts.append(dt)
    adj = list(ts)
    if len(dts) < PACE_MIN_SAMPLES:
        return adj
    min_dt = _median(dts) * PACE_MIN_SPACING
    for k in range(len(valid) - 2, -1, -1):
        i, nxt = valid[k], valid[k + 1]
        if adj[nxt] - adj[i] >= gap_s:
            continue                       # 記録の中断はそのまま
        limit = adj[nxt] - min_dt
        if adj[i] > limit:
            adj[i] = limit
    return adj


def pace_timestamps(ts, gap_s):
    """repace_timestamps のうえで、各サンプルの経過秒を作る。

    差が gap_s 以上は記録の中断とみなし、経過秒に加えない(その位置を gaps に入れる)。
    @return (t, gaps): t[i] は経過秒(受信時刻の無いサンプルは直前の値)。
    """
    adj = repace_timestamps(ts, gap_s)
    t = [0.0] * len(ts)
    gaps = []
    clock = 0.0
    prev_adj = None
    for i, a in enumerate(adj):
        if a is not None:
            if prev_adj is not None:
                dt = a - prev_adj
                if dt >= gap_s:
                    gaps.append(i)
                elif dt > 0:
                    clock += dt
            prev_adj = a
        t[i] = clock
    return t, gaps
