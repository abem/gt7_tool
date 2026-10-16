# scripts/ — 開発・検証用スクリプト群

このディレクトリは、本番動作に不要なデバッグ・検証・キャプチャ系スクリプトと、
**ホストの cron で稼働する運用スクリプト**（後述「運用スクリプト」）を置いています。
ダッシュボード本体（`main.py` / `decoder.py` / `telemetry.py` / `lapstore.py`）や Docker イメージには含まれません。
デバッグ系は `.gitignore` / `.dockerignore` の対象、運用スクリプトは git追跡対象です。

## 運用スクリプト（git追跡対象・ホストの cron で稼働）

2026-09-15 に、週次ローテーションが失敗し続けたのに誰にも通知が届かず、gt7data が 73GB まで
肥大化してディスクが 100% になった事故の再発防止として作られたものです。**本番のホストで稼働しています。**
変更すると次回の cron 実行から挙動が変わるため、修正時は `disk_guard_test.py` で確認してください。

| ファイル | 役割 | 稼働 |
|----------|------|------|
| `gt7data_rotate.py` | gt7data の保存ポリシー（期限切れの trash 退避・削除）。既定は dry-run、`--apply` で実行 | `rotate_cron_wrapper.py` 経由で、root の cron（週次、日曜 03:00）が実行。実行ごとのログは `scripts/logs/rotate_*.log` |
| `retrain_cron_wrapper.py` | ラップタイム予測モデルの週次再学習（#626）。`docker compose run` で `train_laptime_model.py` を実行し、`scripts/logs/retrain_*.log` に記録（最新 12 本を残す）。失敗（docker が見つからない等の例外も含む）・品質ゲートを通る組の減少を通知。タイムアウト時はコンテナ `gt7_tool_retrain` を止める。終了コードは常に 0 | **登録を確認済み（2026-10-15）**: 利用者 abem の crontab（docker を使えるため root 不要）に `0 4 * * 0 /usr/bin/python3 /home/abem/Projects/gt7/gt7_tool/scripts/retrain_cron_wrapper.py`（週次ローテーションの後。初回は 2026-10-19） |
| `rotate_cron_wrapper.py` | 週次 rotate の終了コードを見て、0 以外なら通知する。本家を起動できない例外・2 時間のタイムアウトでも通知して終了コードは常に 0（#631。テストは `tests/test_rotate_cron_wrapper.py`） | **稼働を確認済み（2026-09-30）**: root の crontab に `0 3 * * 0 python3 …/rotate_cron_wrapper.py >> scripts/logs/rotate_cron.log 2>&1`（週次、日曜 03:00）が登録済み |
| `disk_guard.py` | ディスク使用率の監視（85% 警告 / 90% 緊急）。**「/」と、gt7data が載るファイルシステム（現在は /data）の両方**を見る。緊急時は gt7data の新規対象を trash へ退避（物理削除はしない）。**週次ジョブの見張り（#632）**: 各ラッパーが実行のたびに書く目印 `scripts/logs/.rotate_last_run` / `.retrain_last_run` が 8 日より古ければ「週次ジョブが実行されていない」を通知（24 時間に 1 回。目印が無ければ `rotate_*.log` / `retrain_*.log` の名前の日付で代替。どちらも無い種類は見ない） | root の cron（`0 */4 * * *`、4時間ごと。**稼働を確認済み**、`scripts/logs/disk_guard.log` に「/」と gt7data の両方の使用率が出る） |
| `alert_notify.py` | 通知の共通部。`~/DISK_ALERT.txt` への追記と `notify-send` の二経路 | 上記から呼ばれる |
| `disk_guard_test.py` | `disk_guard.py` のモックテスト（ディスク・通知・削除に触れない）。`python3 -B scripts/disk_guard_test.py` | 手動 |

`retrain_cron_wrapper.py` / `rotate_cron_wrapper.py` のテストは `tests/test_retrain_cron_wrapper.py` / `tests/test_rotate_cron_wrapper.py`（`bash tests/run_all.sh` の pytest に含まれる）。`disk_guard.py` のテストは `scripts/disk_guard_test.py`（手動。pytest には含まれない）。

- スクリプト内のパス（`/home/abem/Projects/gt7/gt7_tool` 等）は、このホスト専用の固定値です。
- 通知先: `~/DISK_ALERT.txt`（一次記録）と、abem の GNOME セッションへのデスクトップ通知。

## 分類

| 系統 | ファイル例 | 目的 |
|------|------------|------|
| **デバッグ** | `debug_*.py`, `debug*.html` | 個別機能の単発検証・要素分解デバッグ |
| **検証** | `verify_*.py`, `auto_verify.py` | HTTP / WebSocket / テストモードの統合検証 |
| **キャプチャ** | `capture_*.py`, `visual_regression_test.py` | スクリーンショット取得・ビジュアル回帰テスト |
| **データ確認** | `check_*.py` | テレメトリデータ構造の確認 |
| **その他** | `force_chart_update.py`, `test_uplot.html`, `test_mode_debug.html` | 単発検証・UI 実験 |

## 実行方法

各スクリプトはリポジトリルート（`gt7_tool/`）をカレントディレクトリとして実行することを前提としています:

```bash
cd /home/abem/Projects/gt7/gt7_tool
python scripts/verify_http.py
```

## 注意

- **ホストのファイアウォール（ufw）**: 本番コンテナは `network_mode: host` で動くため、ufw を有効にするときは `8080/tcp`（LAN からのダッシュボード）と `33740/udp`（PS5 からのテレメトリ）を明示的に許可する必要があります。2026-10-09 に別作業で ufw が有効化され、10-16 まで両方が遮断されて記録が止まっていました（#639。手順は [docs/common-issues.md](../docs/common-issues.md) の接続関連）。
- これらのスクリプトは日常のダッシュボード運用には不要です。
- 古い API を前提としているものがあり、本体改修後に動かない可能性があります。
- 恒久的なテストは `tests/` 配下を参照してください（単体テスト・静的チェック・ブラウザでの e2e。`bash tests/run_all.sh` で全部を実行。本番のイメージには含めません）。

## ⚠️ git管理について（重要）

**デバッグ・検証系のスクリプト（約26ファイル）は git管理対象外です。**

`.gitignore` のパターン（`debug*.py`, `verify_*.py`, `capture_*.py`, `check_*.py`,
`test_*.py`, `debug*.html`, `test*.html` 等）に一致するため、`git add` されず
コミット履歴にも残りません。ワーキングツリー上にのみ存在します。

- git追跡対象: `README.md`、運用スクリプト（上表）、`*_smoke.py`
- 本番 Docker イメージにも含まれない（`.dockerignore` 対象）
- 別環境へクローンしても、デバッグ系スクリプトは復元されない（運用スクリプトは復元される）
- デバッグ系のバックアップが必要な場合は、このディレクトリを別途保存すること
- 新しいテストを `test_*.py` という名前にすると `.gitignore` に一致して追跡されない。
  追跡したいテストは `*_test.py`（例: `disk_guard_test.py`）にすること
