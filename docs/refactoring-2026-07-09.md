# 改修履歴: フロント/バック横断の挙動保存リファクタリング

> **日付**: 2026-07-09
> **ブランチ**: `refactor/dashboard-2026-07-09`
> **変更規模**: 13ファイル +500/-511（差し引き -11 行）
> **方式**: マルチエージェント・ワークフロー（解析 → 選別 → 適用 → 敵対的レビュー）
> **原則**: **観測可能な挙動を一切変えない**（behavior-preserving）機械的整理のみ

---

## 1. 概要

GT7 Telemetry Dashboard の全ソース（JS 11 + Python 3 + HTML/CSS）を対象に、**挙動を変えない範囲**でのコード整理を実施した。本リポジトリは過去に「Docker 側と gt7_tool 側のドリフト」で苦労した経緯があるため、今回は**リスクの高い構造変更（ファイル分割・クロスファイル記号のリネーム・ES Module 化・シグネチャ変更・視覚に影響する CSS 変更）を意図的に全て除外**し、確実に安全な整理だけに絞った。

ランタイムモデルの制約（プレーン `<script>` 読み込み・共有グローバルスコープ・読み込み順依存）を全エージェントに明示し、**他ファイルから参照される記号は grep 確認の上で一切変更しない**方針を徹底した。

### 実施方式（ワークフロー構成）
1. **解析** — 16ファイルに1体ずつ読み取り専用エージェントを割当て、挙動保存の整理候補を抽出（各記号はツリー全体を grep してクロスファイル参照を確認）
2. **選別** — 1体の統括エージェントが「高確度・低リスク・単一ファイル完結」の項目だけを承認、リスク項目は除外リストへ
3. **適用 + レビュー** — ファイル単位のパイプライン。各ファイルを1体が編集（＝2体が同一ファイルを触らない＝競合なし）し `node --check`/`py_compile` を通した直後、別エージェントがそのファイルの `git diff` を**敵対的に**（挙動変化を疑って）レビュー

---

## 2. 実施内容

| ファイル | 行数 | 主な整理 |
|----------|------|----------|
| `ui_components.js` | 634→606 | 死コード `updateRotation3D()` と関連 DOM 参照を削除（grep で無参照確認）。`drawGForceMeter` の 6 箇所の `/2.0` を `MAX_G` 定数化 |
| `charts.js` | 465→443 | `drawAccelChart` の重複ポリライン描画を `drawSeries()` 局所ヘルパーに統合。`ACCEL_G_FULL_SCALE=10` 定数化。`initCharts` の冗長な `initSucceeded` フラグを除去 |
| `course-map.js` | 253→256 | 局所 `var`→`const`/`let`。グロー半径 `GLOW_RADIUS`・フォント `MAP_FONT` を定数化 |
| `car-3d.js` | 1084→1101 | 全ビルダー関数の局所 `var`→`const`/`let`（トップレベルの `car3DState`/`CAR_3D_CONFIG`/`EXAGGERATION_CONFIG` はクロスファイル参照のため **var のまま温存**）。車体幅 `CAR_BODY_INSET=0.92` 定数化。主要関数に JSDoc |
| `lap-manager.js` | 183→170 | 死コードの「グローバル露出」ブロック（8 個の裸グローバル）を削除（全て無参照を grep 確認）。無名コールバックをアロー化 |
| `telemetry-analysis.js` | 794→800 | 3 箇所の delta リセット処理を `clearDeltaUI()` に集約。局所 `var`→`const`/`let`。グリップ/推定/通知の閾値を定数化 |
| `drive-view.js` | 160→163 | 燃料残周回の閾値 `FUEL_CRIT_LAPS`/`FUEL_WARN_LAPS` を定数化。タイヤループ境界を `els.tyres.length` に |
| `websocket.js` | 782→790 | 波括弧なし `if` の明示化（挙動不変）。燃料/パースエラー閾値を関数局所定数化。`disconnectWebSocket` に JSDoc |
| `test-mode.js` | 489→488 | `DEMO_MAX_RPM=9000` 定数化。2 つのデモブロックで重複していた `lapLen/stepMs/lapNum`（同一式）を集約、`DEMO_LAP_SHORTEN_MS=40` 定数化 |
| `main.py` | 446→459 | 加速度/燃料計算のマジックナンバー（`KMH_TO_MS`・`GRAVITY_MS2` 等）と各ポート/間隔のデフォルト値を定数化（`.get(key, default)` の呼び出し形は温存） |
| `telemetry.py` | 177→183 | ドロップログ間隔・バインドホストをクラス属性化 |
| `decoder.py` | 415→418 | ペダル％除数 `2.55` を `GT7Decoder.PEDAL_PCT_DIVISOR` に |
| `styles.css` | 2092→2086 | **完全一致する重複ルールのみ**をグルーピング統合（`.stat-value`/`.fuel-boost-value`、`.drive-strip-value.best`/`.pb`） |

---

## 3. 検証方法と結果

| 検証 | 方法 | 結果 |
|------|------|------|
| 構文 | 全 JS に `node --check`、全 PY に `python3 -m py_compile` | ✅ 全通過 |
| クロスファイル参照 | 削除した全記号（`updateRotation3D`・`rotationCube` 系・lap-manager の 8 裸グローバル）を `*.js`/`*.html` で独立 grep | ✅ 裸参照ゼロ＝真に死コード |
| 挙動保存レビュー | ファイル毎に `git diff` を敵対的レビュー（別エージェント） | ✅ 13/13 が behavior-preserving、blocker 0 |
| **E2E スモーク** | Playwright（headless Chromium）で静的配信したダッシュボードを読み込み、**TEST MODE** を有効化して UI 駆動を確認（PS5 不要） | ✅ リファクタ前後で同一挙動 |

### E2E スモークの実測（リファクタ後）
- グローバル配線: `initTestMode`/`startTestMode`=function、`uPlot`=function、`THREE`=object ✅
- TEST MODE 有効化後: `speed` 0→190、`rpm` 0→4653、`gear` N→2（＝デモデータが UI を駆動）✅
- **未捕捉 JS 例外: 0 件**、想定外の console error: 0 件（バックエンド WebSocket 接続失敗のみ想定内）✅
- リファクタ前（`main` 相当の pristine コピー）でも同一に PASS ＝**回帰なし**

### ⚠️ 検証の限界（正直な記載）
- 実機（PS5）の実テレメトリでは未確認。検証は **TEST MODE（クライアント側デモデータ）＋ headless スモーク＋構文/静的解析＋独立 grep 監査**による。ただし今回の変更は全て挙動保存の機械的整理であり、実データ経路のロジックは変更していない。
- CSS は**完全一致重複ルールの統合のみ**でピクセル単位の視覚回帰試験は未実施（統合前後で宣言集合は不変）。

---

## 4. 意図的に見送った項目（今後の検討課題）

安全性を優先し、以下は**今回は適用せず**除外した。特に上 2 件は**潜在バグ**として記録する。

1. 🐛 **`showConnectionError` の二重定義** — `ui_components.js:611` の定義が `websocket.js:767`（後読み込み）で上書きシャドウされている。クロスファイル衝突のため今回は不介入。**専用の修正で一本化すべき。**
2. 🐛 **`getSectorClass` の二重定義** — `websocket.js` と `test-mode.js` で**閾値の異なる**同名関数が定義され、読み込み順で片方が勝つ。要一本化。
3. `car-3d.js` トップレベル `var`→`const`（`car3DState` 等）— 他ファイルから参照される共有記号のため温存。
4. `main.py` の `CONFIG.get(key, default)`→`CONFIG[key]` — 欠損キー時にデフォルト返却から `KeyError` 送出へ**挙動が変わる**ため不採用（＝正しく温存）。
5. CSS の未参照デザイントークン削除・色リテラルのトークン化 — 視覚ドリフトのリスクで除外。
6. `car-3d.js` の材質生成ヘルパー抽出／`renderDemoFrame`（約190行）の分割 — 描画コードに不釣り合いなチャーン/回帰リスク。
7. `constants.js` の未読取ミラー定数（`accentPurple`・`OPTIMAL_LOW`）— CSS パレットの意図的なドキュメント的ミラーのため温存。

---

## 5. まとめ

観測挙動を変えずに、死コード除去・マジックナンバーの定数化・`var`→`const`/`let`・重複統合・JSDoc 付与を 13 ファイルに適用した。**構文・独立 grep 監査・ファイル毎の敵対的レビュー・E2E スモーク**の 4 層で回帰なしを確認済み。潜在バグ 2 件（二重定義）を今後の課題として明文化した。
