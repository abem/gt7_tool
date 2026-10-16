#!/usr/bin/env python3
"""週次 gt7data_rotate.py --apply のcronラッパー。

本家スクリプトの exit code (0=正常/2=拒否/3=50%セーフティ中断) を見て、
0以外なら alert_notify 経由で必ず人に通知する。

2026-09-15 以前はこのチェックが無く、rotate_cron.log に ERROR が書かれる
だけで誰も見ておらず、6週間気づかれないままディスクが100%まで埋まった。
このラッパーは「本家の安全設計(無条件の上書きフラグを設けない)」には一切
手を加えない。人に判断を委ねるという設計意図はそのまま維持し、その"人に
判断を委ねる"通知だけを確実に届くようにする。

2026-10-16 (#631): 本家を起動できない(python3 が無い・スクリプトの移動・OSError)
ときや、ハングしたときも、黙って落ちずに通知して終了コード 0 で抜ける
(#626 の retrain 側ラッパーと同じ形)。終了コード -1=タイムアウト、-2=ラッパー例外。
"""
import subprocess
import sys
import traceback

sys.path.insert(0, "/home/abem/Projects/gt7/gt7_tool/scripts")
from alert_notify import alert

ROTATE_SCRIPT = "/home/abem/Projects/gt7/gt7_tool/scripts/gt7data_rotate.py"
TIMEOUT_S = 2 * 3600   # 通常は数秒〜数十秒(rename のみ)。これを超えたら異常として止めて通知する


def _text(v):
    """TimeoutExpired の stdout/stderr は bytes のことがある。"""
    if v is None:
        return ""
    return v.decode("utf-8", "replace") if isinstance(v, bytes) else str(v)


def main():
    try:
        proc = subprocess.run(
            ["python3", ROTATE_SCRIPT, "--apply"],
            capture_output=True, text=True, errors="replace", timeout=TIMEOUT_S,
        )
        rc, out, err = proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as e:
        rc, out = -1, _text(e.stdout)
        err = _text(e.stderr) + f"\n[timeout after {TIMEOUT_S}s]"
    except Exception:               # noqa: BLE001  黙って落ちないことが最優先
        rc, out, err = -2, "", "[wrapper exception]\n" + traceback.format_exc()
    sys.stdout.write(out)
    sys.stderr.write(err)

    if rc != 0:
        tail = "\n".join((out + err).strip().splitlines()[-5:])
        if rc == 3:
            title = "gt7data rotate: 50%セーフティで中断"
            body = ("候補の50%を超える対象が検出されたため自動実行を中断しました。"
                    f"要手動確認(sudo python3 {ROTATE_SCRIPT} で詳細確認)。\n{tail}")
        elif rc == -1:
            title = "gt7data rotate: タイムアウト"
            body = f"{TIMEOUT_S}秒を超えたため中断しました。本家を手動で確認してください。\n{tail}"
        elif rc == -2:
            title = "gt7data rotate: ラッパー例外"
            body = f"本家を起動できませんでした(python3 / {ROTATE_SCRIPT} を確認)。\n{tail}"
        else:
            title = "gt7data rotate: 実行拒否/エラー"
            body = f"exit={rc}\n{tail}"
        alert(title, body)

    return 0  # cron自体を失敗扱いにしない(通知は済んでいるため)


if __name__ == "__main__":
    sys.exit(main())
