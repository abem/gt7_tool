#!/usr/bin/env python3
"""ディスク使用率監視(gt7data肥大化の再発防止 / Redmine #124関連)。

2026-09-15: gt7data_rotate.py --apply が50%セーフティで6週連続abortし
続けたが、Discord通知用 `message` CLIもメール送信も未設定でcronから誰にも
届かず、誰も気づかないままgt7dataが73GBまで肥大化しディスクが100%に達し、
openclawゲートウェイまで巻き添えでクラッシュした。

このスクリプトは rotate の成否に依存しない独立系統として、ディスク使用率
そのものを直接監視する(原因がgt7data以外でも検知できる)。

段階的対応:
  - WARN_PCT (85%): アラート通知のみ + 期限切れtrash(trash_days超過分。
    既存ポリシーで承認済みの物理削除)を掃除。
  - EMERGENCY_PCT (90%): アラートを即時発報 + gt7dataの新規対象を
    trashへ退避(50%セーフティは当日の手動対応と同じ手法でバッチ分割して
    回避。ただし物理削除はしない=14日猶予は維持)。
    非期限切れtrashの早期物理削除は本スクリプトでは行わない
    (本家スクリプトの「上書きフラグを意図的に設けない」設計意図を尊重し、
    最終判断は常に人に委ねる)。
"""
import json
import os
import shutil
import sys
from datetime import datetime, timedelta

sys.path.insert(0, "/home/abem/Projects/gt7/gt7_tool/scripts")
from alert_notify import alert
import gt7data_rotate as R

REPO_ROOT = "/home/abem/Projects/gt7/gt7_tool"
DATA_DIR = os.path.join(REPO_ROOT, "gt7data")
TRASH_DIR = os.path.join(REPO_ROOT, "gt7data_trash")
CONFIG_PATH = os.path.join(REPO_ROOT, "config.json")
STATE_FILE = os.path.join(REPO_ROOT, "scripts", "logs", "disk_guard_state.json")

WARN_PCT = 85
EMERGENCY_PCT = 90
BATCH = 1200
COOLDOWN_HOURS = {"warn": 12, "emergency": 3}


def disk_pct(path="/"):
    du = shutil.disk_usage(path)
    return du.used / du.total * 100, du.free / (1024 ** 3)


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)


def should_alert(state, level):
    last = state.get(f"last_alert_{level}")
    if not last:
        return True
    return datetime.now() - datetime.fromisoformat(last) >= timedelta(
        hours=COOLDOWN_HOURS[level])


def mark_alerted(state, level):
    state[f"last_alert_{level}"] = datetime.now().isoformat()
    save_state(state)


def emergency_stage_to_trash(retention):
    """新規対象をtrashへ退避する(物理削除はしない)。50%セーフティの
    バッチ回避手法は2026-09-15の手動対応(staged_rotate.py)と同一。"""
    now = datetime.now()
    dest = os.path.join(TRASH_DIR, now.strftime("%Y%m%d"))
    os.makedirs(dest, exist_ok=True)
    moved_total = 0
    for _ in range(20):  # 暴走防止の上限(candidates全件を回るには十分な回数)
        keep = R.load_keep_list(DATA_DIR)
        candidates, _ = R.scan_candidates(DATA_DIR)
        targets, _ = R.select_targets(candidates, keep, retention, now)
        if not targets:
            break
        batch = targets[:BATCH]
        for c, _ in batch:
            os.rename(os.path.join(DATA_DIR, c["name"]),
                      os.path.join(dest, c["name"]))
        moved_total += len(batch)
    return moved_total


def main():
    pct, free_gb = disk_pct("/")
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} disk / = {pct:.1f}% "
          f"(free {free_gb:.1f}GB)")
    if pct < WARN_PCT:
        return 0

    state = load_state()
    retention = R.load_retention_config(CONFIG_PATH)
    purged = R.purge_trash(TRASH_DIR, retention["trash_days"], apply=True,
                            now=datetime.now()) if retention else []
    if purged:
        print(f"purged expired trash: {purged}")

    if pct < EMERGENCY_PCT:
        if should_alert(state, "warn"):
            alert(
                "ディスク使用率 警告 (gt7data_guard)",
                f"/ が{pct:.1f}%使用中(空き{free_gb:.1f}GB)。"
                f"gt7data rotateログの確認を推奨します。"
                f"期限切れtrash自動削除: {len(purged)}件。",
                urgency="normal",
            )
            mark_alerted(state, "warn")
        return 0

    # EMERGENCY_PCT 以上
    moved = 0
    if retention and retention.get("enabled") and os.access(DATA_DIR, os.W_OK):
        moved = emergency_stage_to_trash(retention)
    pct_after, free_after = disk_pct("/")
    print(f"emergency: moved {moved} files to trash; "
          f"disk now {pct_after:.1f}% (free {free_after:.1f}GB)")

    if should_alert(state, "emergency"):
        alert(
            "ディスク使用率 緊急 (gt7data_guard)",
            f"/ が{pct:.1f}%使用(空き{free_gb:.1f}GB)。"
            f"gt7data新規対象{moved}件をtrashへ退避しましたが、"
            f"trashはディスク上に残るため空き容量はまだ増えていません"
            f"(現在{pct_after:.1f}%/空き{free_after:.1f}GB)。"
            f"trashの早期物理削除が必要か至急確認してください。",
            urgency="critical",
        )
        mark_alerted(state, "emergency")
    return 0


if __name__ == "__main__":
    sys.exit(main())
