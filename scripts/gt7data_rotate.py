#!/usr/bin/env python3
"""gt7data ローテーション (P1 B案 / Redmine #124)

gt7data/ のラップ記録を「期間・容量上限」でローテーションする運用スクリプト。
設計: docs/P1詳細計画書_セッションレビューと保存ポリシー_20260716.md §3
(計最終承認済み。閾値の既定値は提案値であり、本番適用=enabled:true 化は采承認後の別工程)

安全設計(多重防護):
  1. dry-run 既定: 引数なしでは対象一覧と削減見込みの表示・ログ記録のみ。
     ファイルシステムへの変更は --apply 指定時のみ。
  2. 設定ゲート: config.json の data_retention.enabled が false のままでは
     --apply を拒否する。上書きフラグ(--force 等)は意図的に設けない。
     有効化は設定変更(=采承認の証跡)を必ず経由させる。
  3. trash方式(2段階削除): 対象は即時削除せず gt7data_trash/YYYYMMDD/ へ
     rename(同一ファイルシステム内move)する。これが「削除前BU」に相当する。
     物理削除は trash 内で trash_days 経過したものだけ。
  4. 保護リスト: <data-dir>/.rotate_keep に記載されたファイル名は常に対象外
     (ベストラップ等の手動ピン留め)。
  5. 50%セーフティ: 対象が候補総数の50%を超える場合は誤設定とみなし中断する。
  6. 命名一致のみ: main.py の保存命名(LAP_FILE_RE)に完全一致するファイルだけを
     扱う。変則名・BU・他ファイルには一切触れない。
  7. 権限: --apply 時に書込権限を事前確認し、不足時は部分実行せず明確に停止する。

exit code: 0=正常(dry-run含む) / 2=拒否(無効設定・権限・設定不備) / 3=50%セーフティ中断
"""

import argparse
import json
import logging
import os
import re
import shutil
import sys
from datetime import datetime, timedelta

# main.py の save_lap_to_file 命名形式と同一(完全一致のみ対象)
LAP_FILE_RE = re.compile(
    r'^(\d{4})-(\d{2})-(\d{2})_(\d{2})_(\d{2})_(\d{2})_CAR-(\d+)_Lap-(\d+)\.json$'
)

KEEP_FILENAME = ".rotate_keep"
SAFETY_FRACTION = 0.5

# 既定パス: このスクリプトの親ディレクトリ(=リポジトリルート)基準
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DEFAULTS = {
    "enabled": False,
    "max_total_gb": 20,
    "max_age_days": 180,
    "trash_days": 14,
}


def setup_logging(log_dir):
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(
        log_dir, f"rotate_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log")
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(log_path), logging.StreamHandler(sys.stdout)],
    )
    return log_path


def load_retention_config(config_path):
    """config.json から data_retention 設定を読む。無い項目は既定値。"""
    try:
        with open(config_path) as f:
            cfg = json.load(f)
    except FileNotFoundError:
        logging.error(f"config not found: {config_path}")
        return None
    except json.JSONDecodeError as e:
        logging.error(f"config parse error: {config_path}: {e}")
        return None
    retention = dict(DEFAULTS)
    retention.update(cfg.get("data_retention", {}))
    return retention


def parse_recorded_at(name):
    m = LAP_FILE_RE.match(name)
    if not m:
        return None
    y, mo, d, h, mi, s = (int(x) for x in m.groups()[:6])
    try:
        return datetime(y, mo, d, h, mi, s)
    except ValueError:
        return None


def load_keep_list(data_dir):
    """保護リスト(.rotate_keep)。1行1ファイル名、#始まりはコメント。"""
    path = os.path.join(data_dir, KEEP_FILENAME)
    keep = set()
    if os.path.isfile(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    keep.add(line)
    return keep


def scan_candidates(data_dir):
    """命名一致ファイルのみを (recorded_at昇順) で返す。変則名は対象外として記録。"""
    candidates = []
    skipped = []
    with os.scandir(data_dir) as it:
        for e in it:
            if not e.is_file():
                continue
            if e.name == KEEP_FILENAME:
                continue
            rec = parse_recorded_at(e.name)
            if rec is None:
                skipped.append(e.name)
                continue
            candidates.append(
                {"name": e.name, "recorded_at": rec, "size": e.stat().st_size})
    candidates.sort(key=lambda c: c["recorded_at"])  # 古い順
    return candidates, skipped


def select_targets(candidates, keep, retention, now):
    """選定ロジック(優先順: 保護リスト → 年齢 → 容量)。"""
    age_limit = now - timedelta(days=retention["max_age_days"])
    cap_bytes = retention["max_total_gb"] * (1024 ** 3)

    targets = []       # (candidate, reason)
    kept = []
    remaining = []
    for c in candidates:
        if c["name"] in keep:
            kept.append(c)
        elif c["recorded_at"] < age_limit:
            targets.append((c, "age"))
        else:
            remaining.append(c)

    remaining_total = sum(c["size"] for c in remaining) + sum(c["size"] for c in kept)
    # 容量超過分を古い順に対象へ(保護分は除外済み。保護分のサイズは総量に含める)
    for c in remaining:
        if remaining_total <= cap_bytes:
            break
        targets.append((c, "size"))
        remaining_total -= c["size"]
    return targets, kept


def purge_trash(trash_dir, trash_days, apply, now):
    """trash 内で trash_days を経過した日付サブディレクトリを物理削除する。"""
    purged = []
    if not os.path.isdir(trash_dir):
        return purged
    cutoff = now - timedelta(days=trash_days)
    for sub in sorted(os.listdir(trash_dir)):
        path = os.path.join(trash_dir, sub)
        if not os.path.isdir(path) or not re.fullmatch(r"\d{8}", sub):
            continue
        sub_date = datetime.strptime(sub, "%Y%m%d")
        if sub_date <= cutoff:
            n = len(os.listdir(path))
            if apply:
                shutil.rmtree(path)
            purged.append((sub, n))
    return purged


def main():
    parser = argparse.ArgumentParser(
        description="gt7data rotation (dry-run by default)")
    parser.add_argument("--apply", action="store_true",
                        help="実際に rename/削除を行う(既定は dry-run 表示のみ)")
    parser.add_argument("--data-dir", default=os.path.join(REPO_ROOT, "gt7data"))
    parser.add_argument("--trash-dir", default=None,
                        help="既定: <data-dir>の隣の gt7data_trash")
    parser.add_argument("--config", default=os.path.join(REPO_ROOT, "config.json"))
    parser.add_argument("--log-dir",
                        default=os.path.join(REPO_ROOT, "scripts", "logs"))
    args = parser.parse_args()

    data_dir = os.path.abspath(args.data_dir)
    trash_dir = os.path.abspath(args.trash_dir) if args.trash_dir else os.path.join(
        os.path.dirname(data_dir), "gt7data_trash")

    log_path = setup_logging(args.log_dir)
    mode = "APPLY" if args.apply else "DRY-RUN"
    logging.info(f"=== gt7data rotate [{mode}] data={data_dir} trash={trash_dir}")

    retention = load_retention_config(args.config)
    if retention is None:
        return 2
    logging.info(f"retention config: {retention}")

    # 設定ゲート: enabled:false のままの --apply は拒否(上書き手段なし)
    if args.apply and not retention.get("enabled"):
        logging.error(
            "REFUSED: data_retention.enabled=false のため --apply を拒否します。"
            "有効化は config.json の変更(采承認)を経てください。")
        return 2

    if not os.path.isdir(data_dir):
        logging.error(f"data dir not found: {data_dir}")
        return 2

    # 権限事前確認(--apply時)。部分実行を避けるため実処理前に検査する
    if args.apply and not os.access(data_dir, os.W_OK):
        logging.error(f"REFUSED: no write permission on {data_dir} "
                      "(root所有の場合は sudo で実行)")
        return 2

    now = datetime.now()
    keep = load_keep_list(data_dir)
    candidates, skipped = scan_candidates(data_dir)
    targets, kept = select_targets(candidates, keep, retention, now)

    total_size = sum(c["size"] for c in candidates)
    target_size = sum(c["size"] for c, _ in targets)
    logging.info(f"candidates={len(candidates)} ({total_size/1e9:.2f}GB), "
                 f"keep-protected={len(kept)}, non-matching-skipped={len(skipped)}")
    for name in skipped:
        logging.info(f"  SKIP(non-matching): {name}")
    for c in kept:
        logging.info(f"  KEEP(.rotate_keep): {c['name']}")
    for c, reason in targets:
        logging.info(f"  TARGET({reason}): {c['name']} "
                     f"({c['size']/1e6:.1f}MB, {c['recorded_at']:%Y-%m-%d})")
    logging.info(f"targets={len(targets)} ({target_size/1e9:.2f}GB reclaim)")

    # 50% セーフティ
    if candidates and len(targets) > SAFETY_FRACTION * len(candidates):
        logging.error(
            f"SAFETY ABORT: 対象 {len(targets)}件 が候補 {len(candidates)}件 の50%を"
            "超えています。設定(max_total_gb/max_age_days)を確認してください。"
            "(dry-run/apply とも実処理は行いません)")
        return 3

    # trash の期限切れ表示(実削除は --apply 時のみ)
    purged = purge_trash(trash_dir, retention["trash_days"], apply=False, now=now)
    for sub, n in purged:
        logging.info(f"  TRASH-PURGE{'(予定)' if not args.apply else ''}: "
                     f"{sub}/ ({n} files, {retention['trash_days']}日経過)")

    if not args.apply:
        logging.info(f"DRY-RUN 完了(変更なし)。log: {log_path}")
        return 0

    # ---- APPLY ----
    dest = os.path.join(trash_dir, now.strftime("%Y%m%d"))
    os.makedirs(dest, exist_ok=True)
    moved = 0
    for c, reason in targets:
        src = os.path.join(data_dir, c["name"])
        dst = os.path.join(dest, c["name"])
        os.rename(src, dst)  # 同一FS内move(コピーではない)
        moved += 1
    logging.info(f"moved {moved} files -> {dest}")

    purged = purge_trash(trash_dir, retention["trash_days"], apply=True, now=now)
    for sub, n in purged:
        logging.info(f"purged trash: {sub}/ ({n} files)")

    logging.info(f"APPLY 完了。log: {log_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
