# 変更履歴 (CHANGELOG)

このファイルは GT7 Telemetry Dashboard の主要な変更を時系列でまとめたものです。
「何を・どう直したか」を確認できる一次資料として維持します。

形式: 日付ごとに `feat`(機能) / `fix`(修正) / `refactor`(整理) / `docs`(文書) で分類。

---

## 2026-06-14 — 改修一回目（コース判定修正・設定一元化・HTTPS）

### fix: コース判定ロジックのシャドウイング解消
- **問題**: `known_courses` の `real_track`(bounds ±10000) が先頭一致で評価され、ほぼ全座標にマッチして confidence 1.0 "Current Track" を返し、自動収集コース 19 件が到達不能（シャドウイング）だった。さらに原点中心の同一 placeholder bounds(±500 等)で複数コースが判別不能、first-match で非決定的だった。
- **修正** (`decoder.py` `CourseEstimator`):
  - (x, z) を内包する全候補を `known`/`auto` 横断で収集し、**bounds 面積が最小=最も具体的**なコースを選択（同面積は `known` 優先）。決定的。
  - `real_track` 等の超広域ボックスは `fallback:true` として分離し、**他に候補が無い時のみ低 confidence(0.2)** で返す。
  - confidence を出自・検証状態・面積から導出（`verified:true`→0.9 / 未検証→0.4–0.7 / fallback→0.2）。
  - 空・キー欠損 bounds は「マッチしない」よう厳格化（旧実装の全マッチ防止）。
  - 戻り値キー(`id`/`name`/`name_en`/`name_ja`/`confidence`)は後方互換維持。`verified`/`source` を追加。
- **データ** (`course_database.json` v1.2.0): 推測 bounds に `verified:false` を明示（**虚偽の精密値は作らない**）。`real_track` に `fallback:true`。実観測座標(x:-6〜90, z:1280〜1395)に整合する `grand_valley` を `verified:true`。
- **テスト** (`test_course_detection.py`): 重複定義を廃し `from decoder import CourseEstimator` に統一。実観測座標・シャドウ解消・最小面積・後方互換など 9 項目を検証（全 PASS）。
- **補足**: `decoder.py` の `parse()` では引き続きコース推定は無効（`course=unknown`）。未検証 bounds で誤コース表示を避けるため。実走テレメトリで bounds を検証後に有効化予定。

### refactor: Crypto を遅延 import 化
- `decoder.py` のトップレベル `from Crypto.Cipher import Salsa20` を `_try_decrypt` 内の遅延 import に変更。`CourseEstimator` が暗号ライブラリ非依存になり、Crypto 未導入環境でも `import decoder` とテストが可能。

### feat: 設定の一元管理（.env）
- `.env.example` を追加（コミット用テンプレート、実 IP はプレースホルダ）。`.env` は `.gitignore` 済み。
- `main.py` `load_config()` を拡張し、`PS5_IP` に加え `SEND_PORT`/`RECEIVE_PORT`/`HTTP_PORT`/`HEARTBEAT_INTERVAL` も環境変数で上書き可能に（`_int_env` ヘルパー、未設定時は `config.json` フォールバック＝後方互換）。

### feat: HTTPS 対応（既存）
- WebSocket/HTTP を SSL 化（`config.json` の `ssl_cert`/`ssl_key`、`ssl/` 配下の証明書）。`https://<host>:8080`、WebSocket は `wss://`。

---

## 2026-06 以前の主な変更

### feat — レーシングダッシュボード強化
- セクタータイム表示、テストモードの大幅強化、ラップ情報・デルタ表示・右パネルの改善、視覚効果とレスポンシブ対応の強化（Phase 2 & 3）。

### 2026-03-12 — refactor
- ANGULAR VELOCITY 3D セクションを CAR ATTITUDE に統合、未使用コード削除、`websocket.js` 末尾の不完全コードを補完。

### 2026-02-14 — feat: 3D 車両モデルリデザイン
- BoxGeometry の直方体からミッドシップスポーツカー風プロファイルへ。Shape + ExtrudeGeometry による車体造形、5 スポーク風ホイール、丸型 4 灯テールライト、リアウイング等。

### 2026-02-13 — feat/fix/refactor
- 全テレメトリフィールド対応（ハートビート `~`、Packet ~ 344 bytes 全フィールド）。
- バグ修正: タイヤ圧(0x94)→路面法線ベクトル、レース順位(0x84)→スタート順位+参加台数。
- バックエンド/フロントエンドのリファクタリング（グローバル変数排除、FuelTracker 導入、index.html 分割）。

### 2026-02-11 — docs
- API ドキュメント・ユーザーガイド追加。実機テスト全項目 PASS。

### 2026-02-09 — feat
- コース推定・マップ表示機能、テストモード、タイヤ詳細表示。

---

> モーション演出の詳細な変更履歴は [CHANGELOG_MOTION_EFFECTS.md](CHANGELOG_MOTION_EFFECTS.md) を参照。
