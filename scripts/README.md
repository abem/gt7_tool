# scripts/ — 開発・検証用スクリプト群

このディレクトリは本番動作に不要なデバッグ・検証・キャプチャ系スクリプトを集約しています。
ダッシュボード本体（`main.py` / `decoder.py` / `telemetry.py`）や Docker イメージには
含まれず、`.gitignore` / `.dockerignore` の対象です。

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

- これらのスクリプトは日常のダッシュボード運用には不要です。
- 古い API を前提としているものがあり、本体改修後に動かない可能性があります。
- 恒久的な単体テストは `tests/` 配下（本番ビルドに含まれる正規テスト）を参照してください。

## ⚠️ git管理について（重要）

**このディレクトリのスクリプト群（README.md を除く26ファイル）は git管理対象外です。**

`.gitignore` のパターン（`debug*.py`, `verify_*.py`, `capture_*.py`, `check_*.py`,
`test_*.py`, `debug*.html`, `test*.html` 等）に一致するため、`git add` されず
コミット履歴にも残りません。ワーキングツリー上にのみ存在します。

- `scripts/README.md`（本ファイル）のみ git追跡対象
- 本番 Docker イメージにも含まれない（`.dockerignore` 対象）
- 別環境へクローンしても `scripts/` の中身は復元されない
- バックアップが必要な場合は、このディレクトリを別途保存すること
