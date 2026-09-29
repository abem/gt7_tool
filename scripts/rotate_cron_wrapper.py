#!/usr/bin/env python3
"""週次 gt7data_rotate.py --apply のcronラッパー。

本家スクリプトの exit code (0=正常/2=拒否/3=50%セーフティ中断) を見て、
0以外なら alert_notify 経由で必ず人に通知する。

2026-09-15 以前はこのチェックが無く、rotate_cron.log に ERROR が書かれる
だけで誰も見ておらず、6週間気づかれないままディスクが100%まで埋まった。
このラッパーは「本家の安全設計(無条件の上書きフラグを設けない)」には一切
手を加えない。人に判断を委ねるという設計意図はそのまま維持し、その"人に
判断を委ねる"通知だけを確実に届くようにする。
"""
import subprocess
import sys

sys.path.insert(0, "/home/abem/Projects/gt7/gt7_tool/scripts")
from alert_notify import alert

ROTATE_SCRIPT = "/home/abem/Projects/gt7/gt7_tool/scripts/gt7data_rotate.py"

proc = subprocess.run(
    ["python3", ROTATE_SCRIPT, "--apply"],
    capture_output=True, text=True,
)
sys.stdout.write(proc.stdout)
sys.stderr.write(proc.stderr)

if proc.returncode != 0:
    tail = "\n".join((proc.stdout + proc.stderr).strip().splitlines()[-5:])
    if proc.returncode == 3:
        title = "gt7data rotate: 50%セーフティで中断"
        body = ("候補の50%を超える対象が検出されたため自動実行を中断しました。"
                f"要手動確認(sudo python3 {ROTATE_SCRIPT} で詳細確認)。\n{tail}")
    else:
        title = "gt7data rotate: 実行拒否/エラー"
        body = f"exit={proc.returncode}\n{tail}"
    alert(title, body)

sys.exit(0)  # cron自体を失敗扱いにしない(通知は済んでいるため)
