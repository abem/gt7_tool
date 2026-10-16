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
import glob
import json
import os
import shutil
import subprocess
import sys
import traceback

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG_DIR = os.path.join(REPO, "scripts", "logs")
LOCK_FILE = os.path.join(LOG_DIR, ".retrain.lock")
LAST_RUN_FILE = os.path.join(LOG_DIR, ".retrain_last_run")   # 実行の目印(#632 の見張りが読む。--dry-run では書かない)
GATED_GROUPS = os.path.join(REPO, "models", "gated_groups.json")
SUMMARY = os.path.join(REPO, "models", "training_summary.json")
TIMEOUT_S = 3600
KEEP_LOGS = 12                       # retrain_*.log をこの数まで残す(週次なので約 3 か月)
CONTAINER_NAME = "gt7_tool_retrain"  # タイムアウト時に止める相手を特定するための名前

sys.path.insert(0, os.path.join(REPO, "scripts"))
from alert_notify import alert  # noqa: E402


def docker_bin():
    """docker の実体。cron の PATH には /usr/local/bin や /snap/bin が無いことがあるので、よくある場所も見る。"""
    found = shutil.which("docker")
    if found:
        return found
    for cand in ("/usr/bin/docker", "/usr/local/bin/docker", "/snap/bin/docker"):
        if os.access(cand, os.X_OK):
            return cand
    return "docker"     # 見つからなければそのまま(FileNotFoundError になり、失敗として通知される)


DOCKER = docker_bin()
TRAIN_CMD = [
    DOCKER, "compose", "run", "--rm", "--no-deps", "-T", "--name", CONTAINER_NAME,
    "-v", f"{REPO}/train_laptime_model.py:/app/train_laptime_model.py:ro",
    "-v", f"{REPO}/lapstore.py:/app/lapstore.py:ro",
    "gt7_tool", "python", "-B", "train_laptime_model.py",
]


def kill_container(name=CONTAINER_NAME):
    """タイムアウトで docker クライアントを殺してもコンテナは残るので、名前で止めて消す。失敗しても例外にしない。"""
    try:
        subprocess.run([DOCKER, "rm", "-f", name], capture_output=True, text=True, timeout=60)
    except Exception as e:          # noqa: BLE001  ここでの失敗は後続の通知に含めるだけ
        return f"[container cleanup failed: {e}]"
    return f"[container {name} removed]"


def prune_logs(log_dir=None, keep=None):
    """古い retrain_*.log を消して keep 個だけ残す(放っておくと無限に増える)。"""
    keep = KEEP_LOGS if keep is None else keep
    logs = sorted(glob.glob(os.path.join(log_dir or LOG_DIR, "retrain_*.log")))
    for old in logs[:-keep] if keep > 0 else logs:
        try:
            os.remove(old)
        except OSError:
            pass


def gated_count(path=None):
    """品質ゲートを通った(コース×車種の)組の数。ファイルが無い・壊れているときは None。"""
    try:
        with open(path or GATED_GROUPS, encoding="utf-8") as f:
            data = json.load(f)
        return len(data) if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def summary_line(path=None):
    """training_summary.json の要点を 1 行にする(無ければ None)。"""
    try:
        with open(path or SUMMARY, encoding="utf-8") as f:
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
        proc = subprocess.run(TRAIN_CMD, cwd=REPO, capture_output=True, text=True,
                              errors="replace", timeout=TIMEOUT_S)
        rc, out, err = proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as e:
        # クライアントを殺してもコンテナはデーモン側で動き続け、models/ に書き込みうるので明示的に止める
        rc, out = -1, _text(e.stdout)
        err = _text(e.stderr) + f"\n[timeout after {TIMEOUT_S}s] " + kill_container()
    except Exception:               # noqa: BLE001  docker が見つからない(cron の PATH)など。黙って落ちないことが最優先
        rc, out, err = -2, "", "[wrapper exception]\n" + traceback.format_exc()
    mark_last_run()
    after = gated_count()
    line = summary_line()
    try:
        with open(log_path, "w", encoding="utf-8") as f:
            f.write(f"# {stamp} cmd: {' '.join(TRAIN_CMD)}\n# exit={rc} gated {before} -> {after}\n# summary: {line}\n")
            f.write(out)
            if err:
                f.write("\n--- stderr ---\n" + err)
        prune_logs()
    except OSError as e:
        err += f"\n[log write failed: {e}]"
    tail = "\n".join((out + err).strip().splitlines()[-5:])
    if rc != 0:
        alert("予測モデルの再学習: 失敗", f"exit={rc} log={log_path}\n{tail}")
    elif before is not None and after is not None and after < before:
        alert("予測モデルの再学習: 品質ゲートを通る組が減った",
              f"{before} -> {after} 組。log={log_path}\n{line}", urgency="normal")
    print(f"retrain: exit={rc} gated {before} -> {after} log={log_path}\n{line}")
    return 0     # cron 自体を失敗扱いにしない(通知は済んでいる)


def mark_last_run(path=None):
    """実行の目印に現在時刻(ISO)を書く。失敗しても本体のログ・通知は妨げない。"""
    path = path or LAST_RUN_FILE
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(datetime.datetime.now().isoformat(timespec="seconds") + "\n")
    except OSError as e:
        print(f"retrain: last-run marker failed: {e}")


def _text(v):
    """TimeoutExpired の stdout/stderr は bytes のことがある。"""
    if v is None:
        return ""
    return v.decode("utf-8", "replace") if isinstance(v, bytes) else str(v)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
