#!/usr/bin/env python3
"""週次の、ラップタイム予測モデルの再学習(#626)。

train_laptime_model.py(イメージに含めない学習パイプライン)を docker compose run で実行し、
結果を scripts/logs/retrain_<日時>.log に残す。失敗、または品質ゲートを通った組(gated_groups.json)
が前回より減ったときは alert_notify 経由で人に通知する。モデルはサーバーがファイルの更新を検知して
読み込み直す(#573)ため、再起動は要らない。

利用者の crontab(docker を使えるため root は不要)に、週次ローテーション(日曜 03:00)の後に登録する:
    0 4 * * 0 /usr/bin/python3 /home/abem/Projects/gt7/gt7_tool/scripts/retrain_cron_wrapper.py

手動実行:  python3 scripts/retrain_cron_wrapper.py        (終了コードは常に 0。結果はログと通知で伝える)
           python3 scripts/retrain_cron_wrapper.py --dry-run  (コマンドを表示するだけ)
"""
import datetime
import fcntl
import json
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG_DIR = os.path.join(REPO, "scripts", "logs")
LOCK_FILE = os.path.join(LOG_DIR, ".retrain.lock")
GATED_GROUPS = os.path.join(REPO, "models", "gated_groups.json")
SUMMARY = os.path.join(REPO, "models", "training_summary.json")
TIMEOUT_S = 3600

sys.path.insert(0, os.path.join(REPO, "scripts"))
from alert_notify import alert  # noqa: E402

TRAIN_CMD = [
    "docker", "compose", "run", "--rm", "--no-deps", "-T",
    "-v", f"{REPO}/train_laptime_model.py:/app/train_laptime_model.py:ro",
    "-v", f"{REPO}/lapstore.py:/app/lapstore.py:ro",
    "gt7_tool", "python", "-B", "train_laptime_model.py",
]


def gated_count(path=GATED_GROUPS):
    """品質ゲートを通った(コース×車種の)組の数。ファイルが無い・壊れているときは None。"""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return len(data) if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def summary_line(path=SUMMARY):
    """training_summary.json の要点を 1 行にする(無ければ None)。"""
    try:
        with open(path, encoding="utf-8") as f:
            s = json.load(f)
    except (OSError, ValueError):
        return None
    return ("files=%s trained=%s gated=%s excluded=%s gate_mae_pct=%s" % (
        s.get("total_files_scanned"), len(s.get("trained_groups") or {}), s.get("gated_groups_count"),
        len(s.get("excluded_groups_below_threshold") or {}), s.get("quality_gate_mae_pct")))


def main(argv):
    if "--dry-run" in argv:
        print(" ".join(TRAIN_CMD))
        return 0
    os.makedirs(LOG_DIR, exist_ok=True)
    lock = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("retrain: already running; skipped")
        return 0
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = os.path.join(LOG_DIR, f"retrain_{stamp}.log")
    before = gated_count()
    try:
        proc = subprocess.run(TRAIN_CMD, cwd=REPO, capture_output=True, text=True, timeout=TIMEOUT_S)
        rc, out, err = proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as e:
        rc, out, err = -1, (e.stdout or ""), (e.stderr or "") + f"\n[timeout after {TIMEOUT_S}s]"
    after = gated_count()
    line = summary_line()
    with open(log_path, "w", encoding="utf-8") as f:
        f.write(f"# {stamp} cmd: {' '.join(TRAIN_CMD)}\n# exit={rc} gated {before} -> {after}\n# summary: {line}\n")
        f.write(out)
        if err:
            f.write("\n--- stderr ---\n" + err)
    tail = "\n".join((out + err).strip().splitlines()[-5:])
    if rc != 0:
        alert("予測モデルの再学習: 失敗", f"exit={rc} log={log_path}\n{tail}")
    elif before is not None and after is not None and after < before:
        alert("予測モデルの再学習: 品質ゲートを通る組が減った",
              f"{before} -> {after} 組。log={log_path}\n{line}", urgency="normal")
    print(f"retrain: exit={rc} gated {before} -> {after} log={log_path}\n{line}")
    return 0     # cron 自体を失敗扱いにしない(通知は済んでいる)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
