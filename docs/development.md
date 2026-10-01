# 開発ガイド（変更時の検証手順）

コードを変更した際の検証手順をまとめます。フロントエンド実行モデルの制約（プレーン `<script>` 読み込み / 単一グローバルスコープ共有 / ES モジュール不使用）は [architecture.md](architecture.md) の「実行モデルと制約」を参照してください。

## 1. テスト（1つのコマンドで全部）

```bash
cd <リポジトリ直下>
bash tests/run_all.sh
```

次の3つを順に実行し、1つでも失敗すれば終了コード1で終わります（本番サーバー・PS5 は不要）。

| 段階 | 内容 | 単体での実行 |
|---|---|---|
| 静的チェック | JS の構文、**トップレベルの名前の重複**（単一グローバルスコープでの上書き）、HTML が読み込むファイルの存在と Dockerfile の COPY への包含、id の重複、Python の構文・未使用 import・重複定義 | `python3 tests/static_check.py` |
| Python の単体テスト | `tests/test_*.py`（復号・コース推定・学習パイプライン・予測 API）。scikit-learn 等が要るため、**コンテナのイメージ内**で実行（リポジトリを読み取り専用でマウント） | `docker compose run --rm --no-deps -T -v "$PWD:/src:ro" -w /src gt7_tool python -B -m pytest tests -q -p no:cacheprovider` |
| e2e | ヘッドレスのブラウザで、REVIEW・ライブ表示を、実際に記録した周回のフィクスチャで検証（約4分）。詳細は [tests/e2e/README.md](../tests/e2e/README.md) | `python3 tests/e2e/run_e2e.py` |

- e2e には、ホストに `playwright`（chromium）と `Pillow` が必要です（`requirements-dev.txt`）。
- **整理（リファクタリング）のとき**: 変更の前に全テストが通ることを確認し、変更の後に同じ結果になることを確かめます。`e2e_900_golden.py` が、全要素の算出スタイル・表示テキスト・チャートのデータを、保存した期待値と比べます。意図して結果を変えたときだけ、差分を確認してから `python3 tests/e2e/run_e2e.py --update-golden -k golden -k 554_overlay` で作り直します。
- 復号・コース推定だけなら、ホストでも実行できます: `PYTHONPATH=. python3 -m pytest tests/test_decoder.py tests/test_course_detection.py -q`（`pycryptodome` と `pytest` が必要）。

## 2. 構文チェック

編集したファイル単位で素早く確認できます（全体は `python3 tests/static_check.py`）:

```bash
node --check <file>.js        # JavaScript
python3 -m py_compile <file>.py   # Python
```

## 3. コンテナへの反映

Dockerfile はソースを COPY する方式のため、コード変更は**再ビルドしないと反映されません**:

```bash
docker compose up --build -d
```

`docker compose restart` ではイメージが更新されず、変更は反映されない点に注意してください。

## 4. headless スモークテスト（TEST MODE）

PS5 なしでダッシュボードの動作確認ができます:

1. コンテナを起動し、ブラウザで `https://localhost:8080` を開く（HTTPS。自己署名証明書の警告は「詳細設定」から続行）
2. ヘッダーのツールバーにある **● TEST MODE** ボタン（`#tb-test`）をクリック（もう一度クリックすると停止。実行中はピルが点灯しドットが点滅）
3. 以下を確認する:
   - 主要ペイン（速度 / RPM / ギア、チャート 4 枚、CAR ATTITUDE、STEER RESPONSE 等）が描画・更新されること
   - ブラウザの開発者コンソールに未捕捉例外（エラー）が **0 件**であること

このスモークは Playwright による headless 自動化でも継続実施しています。TEST MODE 自体の詳細は [test-mode.md](test-mode.md) を参照してください。

## 5. コースデータベースの再生成

手順は [USER_GUIDE.md](USER_GUIDE.md) の「新しいコースを学習させる」節を参照してください（`--regenerate` は本番 `course_database.json` を上書きする破壊的操作。`--output` で別ファイルに出力して試せます）。

---

**最終更新**: 2026-07-11
