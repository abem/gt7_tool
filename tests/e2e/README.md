# e2e テスト（ブラウザでの検証）

REVIEW・ライブ表示の動作を、ヘッドレスのブラウザ（Playwright）で確かめるテストです。
本番サーバーや PS5 は使いません。`/api/**` は、実際に記録した周回のフィクスチャに差し替えます。

## 実行

```bash
bash tests/run_all.sh                         # 静的チェック → pytest（コンテナ内）→ e2e の全部
python3 tests/e2e/run_e2e.py                  # e2e だけ（約4分、3本を同時に実行）
python3 tests/e2e/run_e2e.py -k 561 -k golden # 名前で絞る
python3 tests/e2e/e2e_561_corner_report.py    # 1本だけ（静的サーバーは自動で起動）
```

必要なもの: Python 3、`playwright`（chromium）、`Pillow`。`requirements-dev.txt` を参照。

## 構成

| ファイル | 内容 |
|---|---|
| `run_e2e.py` | 全スクリプトを実行して集計する。失敗・時間切れ・集計行なしがあれば、終了コード1 |
| `e2e_env.py` | 置き場所、静的サーバーの自動起動、ゴールデン（保存した期待値）との比較 |
| `corner_common.py` | コーナー別レポート系の共通部（フィクスチャ、独立した Python 実装、ブラウザの操作） |
| `e2e_NNN_*.py` | 検証スクリプト。NNN は、対応する Redmine のチケット番号 |
| `e2e_900_golden.py` | 整理（リファクタリング）の前後で、算出スタイル・表示テキスト・チャートのデータが変わらないことを確かめる |
| `fixtures/fx_trend/` | スパ・車3346 の13周（同じコース・走行距離が揃った周回と、アウトラップ等） |
| `fixtures/fx/` | 東京エクスプレスウェイ東・車2139 の3記録（複数周回を含み、走行距離が揃わない組） |
| `golden/` | ゴールデン（保存した期待値） |
| `out/` | スクリーンショット等の出力（git 管理外） |

## 検証の考え方

- **独立した実装との照合**: 距離の積算・再サンプル・コーナー検出・標準偏差などを、テスト側で Python で実装し直し、画面の値と比べます。
- **ゴールデン**: 同じ環境（ブラウザ・フォント）での前後比較のためのものです。意図して見た目や結果を変えたときは、差分を確認してから作り直します。

```bash
python3 tests/e2e/run_e2e.py --update-golden -k golden -k 554_overlay   # 作り直す
GT7_E2E_GOLDEN_DUMP=1 python3 tests/e2e/e2e_900_golden.py                # 全要素の算出スタイルを out/ へ書き出す（前後で diff）
```

- **時間に敏感な検証**（再生・音声の間隔・読み込みの競合）が不安定なときは、`--jobs 1` で直列に実行します。
