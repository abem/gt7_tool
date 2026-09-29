#!/usr/bin/env python3
"""gt7data関連の運用アラート共通ヘルパー。

このマシンには Discord 通知用の `message` CLI やメール送信(sendmail/mail)が
インストールされておらず、cronから確実に届く通知手段が無かった。これが
「週次ローテーションが50%セーフティで6週連続abortし続けたが誰も気づかず、
gt7dataが73GBまで肥大化してディスクが100%埋まった」の直接原因(2026-09-15)。

再発防止のため、確実に到達する2経路で通知する:
  1. ~/DISK_ALERT.txt への追記(いつでも参照可能な一次記録)
  2. abemのGNOMEセッションへの notify-send(デスクトップ通知、即時可視化)
どちらか一方が失敗しても他方は独立して機能するようフェイルセーフにする。
"""
import subprocess
from datetime import datetime

ALERT_FILE = "/home/abem/DISK_ALERT.txt"
ABEM_DISPLAY = "DISPLAY=:0"
ABEM_DBUS = "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus"


def alert(title, body, urgency="critical"):
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {title}: {body}\n"
    try:
        with open(ALERT_FILE, "a") as f:
            f.write(line)
        subprocess.run(["chown", "abem:abem", ALERT_FILE], check=False)
    except Exception as e:
        print(f"alert_notify: failed to write {ALERT_FILE}: {e}")

    try:
        subprocess.run(
            ["runuser", "-u", "abem", "--",
             "env", ABEM_DISPLAY, ABEM_DBUS,
             "notify-send", "-u", urgency, title, body],
            timeout=10, check=False,
        )
    except Exception as e:
        print(f"alert_notify: notify-send failed: {e}")
