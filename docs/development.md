# 開発ガイド（変更時の検証手順）

コードを変更した際の検証手順をまとめます。フロントエンド実行モデルの制約（プレーン `<script>` 読み込み / 単一グローバルスコープ共有 / ES モジュール不使用）は [architecture.md](architecture.md) の「実行モデルと制約」を参照してください。

## 1. 回帰テスト（Python）

リポジトリ直下で実行します（`decoder` モジュール解決のため `PYTHONPATH=.` が必要）:

```bash
cd <リポジトリ直下>
PYTHONPATH=. python3 -m pytest tests/ -q
```

- `tests/test_decoder.py`: Salsa20 復号・XOR フォールバック・parse・CourseEstimator の回帰テスト
- `tests/test_course_detection.py`: コース推定ロジックの検証
- `pycryptodome` と `pytest` が必要（`requirements.txt` 参照）
- コンテナ内には `tests/` がコピーされていないため、**ホスト側で実行**すること

## 2. 構文チェック

編集したファイル単位で素早く確認できます:

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
