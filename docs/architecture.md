# システムアーキテクチャ

> 本書はシステム構成・ファイル構成・データフローの正（一次情報）です。プロトコル・パケットスキーマの詳細は [API.md](API.md) を参照してください。

## 概要

GT7 Telemetry Dashboardは、クライアント-サーバーアーキテクチャを採用しています。PS5/PS4から送信されるテレメトリデータをPythonバックエンドで受信・処理し、WebSocket経由でウェブフロントエンドに配信します。

## コンポーネント図

```
┌─────────────────────────────────────────────────────────────────┐
│                           PS5/PS4                                │
│                    (Gran Turismo 7)                             │
└────────────────────────────┬────────────────────────────────────┘
                             │ UDP Port 33739/33740
                             │ (暗号化パケット)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Python Backend                              │
│                          main.py                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  telemetry.py - UDP通信管理                               │   │
│  │    • ハートビート送信 (Port 33739)                        │   │
│  │    • テレメトリ受信 (Port 33740)                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                    │
│                              ▼                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  decoder.py - データ復号・解析                            │   │
│  │    • Salsa20復号                                          │   │
│  │    • パケット解析                                         │   │
│  │    • コース推定                                           │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                    │
│                              ▼                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  WebSocket Server                                         │   │
│  │    • クライアント接続管理                                  │   │
│  │    • データ配信                                           │   │
│  │    • HTTPサーバー (ダッシュボード配信)                    │   │
│  └──────────────────────────────────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────────┘
                             │ WebSocket (ws://)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Web Browser                                │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  index.html (HTML構造) + styles.css (スタイル)           │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  constants.js - 共通定数 (配色パレット・チャート設定)    │   │
│  │  common-utils.js - 共通の小さな処理 (距離・中央値・保存) │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  ui_components.js - 定数・ユーティリティ・DOM要素キャッシュ │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  charts.js - uPlotチャート (SPEED, RPM, THROTTLE, BRAKE) │   │
│  │              + 加速度チャート (Canvas)                   │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  steer-response.js - STEER RESPONSE (舵角 vs 実旋回の比較) │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  car-3d.js - CAR ATTITUDE 可視化 (Canvas2D / サス+CoG)   │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  lap-manager.js - ラップタイム記録・履歴管理             │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  telemetry-analysis.js - 距離基準ラップ解析 (デルタ/推定) │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  drive-view.js - DRIVE/ANALYSIS ビュー切替               │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  websocket.js - WebSocket通信・テレメトリデータ処理      │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  REVIEW 系: review-view.js (一覧・A/B・チャート3本)       │   │
│  │    track-map / theory-best / segment-report / lap-trend  │   │
│  │    channel-plots / corner-report / race-metrics (REVIEW) │   │
│  │    replay-mode (全カード再生) / replay-diag (診断ログ)   │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  ライブ補助: laptime-predict (予測) / sector-time (区間)  │   │
│  │    persistent-ref (過去ベスト基準) / audio-callout (音声) │   │
│  │    pit-wall (エンジニア伝言の受信) / voice-command (音声) │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  test-mode.js - テストモード (デモデータ生成)            │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  app.js - エントリーポイント (初期化)                    │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  card-drag.js - ブロックのドラッグ移動 (自由配置)        │   │
│  │  menu.js - フラット1段操作ツールバー (プロキシ駆動)      │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## ファイル構成

### バックエンド (Python)

| ファイル名 | 説明 | 主要なクラス/関数 |
|-----------|------|-----------------|
| `main.py` | エントリーポイント・HTTP/WSサーバ | `FuelTracker`, `websocket_handler`, `telemetry_background_task`, `telemetry_supervisor`, `_heartbeat_loop`, `on_startup`, `on_cleanup` |
| `telemetry.py` | UDP通信管理（非同期・`asyncio.DatagramProtocol` ベース） | `GT7TelemetryClient`, `_TelemetryProtocol` |
| `decoder.py` | パケット復号・解析 (A/B/~ 対応) | `GT7Decoder`, `CourseEstimator` |
| `lapstore.py` | ラップファイル名の規則と、予測の特徴量の列の共有定義（標準ライブラリのみ。`main.py` と `train_laptime_model.py` が参照。#574） | `LAP_FILE_RE`, `FEATURE_COLUMNS`, `FEATURE_QUERY_PARAMS` |
| `train_laptime_model.py` | ラップタイム予測モデルのオフライン学習（コース×車種ごと。時系列の検証と品質ゲート。イメージには入れず、`docker compose run` でマウントして実行。[API.md](API.md) 参照） | `filter_group_outliers`, `_time_ordered_split` |

`main.py` の読み出し API は、周回の詳細の応答・`models/gated_groups.json`・学習済みモデルを、ファイルの更新時刻とサイズを鍵にキャッシュする（#573。再起動なしで新しい内容が使われる）。

### 実行モデルと制約（フロントエンド）

フロントエンド JS を変更する際は、以下の実行モデルを前提にすること:

- **プレーン `<script>` 読み込み**: 全 JS は `index.html` のプレーン `<script>` タグで読み込まれる。読み込み順は `index.html` の記述が正であり、依存関係は「先に読み込まれたファイルの定義を後のファイルが参照する」ことでのみ成立する。
- **単一グローバルスコープ共有**: 全ファイルのトップレベル関数・変数は同一のグローバルスコープを共有する。同名のトップレベル定義は、後から読み込まれた側が先の定義を上書き（シャドウ）する。
- **ES モジュール不使用（意図的）**: `import` / `export` は使わない。モジュール化はリスクの高い構造変更として意図的に見送っている（[CHANGELOG](../CHANGELOG.md) の 2026-07-09 挙動保存リファクタリング参照）。
- **トップレベルシンボルの追加・リネームは全ファイル横断確認が必要**: 名前衝突・シャドウイングが実害バグを生んだ前例（`getSectorClass` の二重定義等）があるため、追加・変更時は全 `*.js` / `*.html` を grep で横断確認すること。`tests/static_check.py` が、ページごとのトップレベルの名前の重複を検出する。
- **読み込み順の要点**: `constants.js` → `common-utils.js`（共通の小さな処理。以降のどのファイルからも使える）→ `ui_components.js` → 各機能 → `websocket.js`（ライブの受信・描画の入口）→ `app.js` → ツールバー系（`card-drag.js` / `menu.js` / `card-groups.js` / `voice-command.js` / `audio-callout.js` / `persistent-ref.js`）。後から読み込まれる機能は、先のファイルの関数を `typeof` で確かめてから呼ぶ（機能が無くても止まらない）。
- **新しいファイルの追加**: `index.html` の `<script>` / `<link>` に足すだけでよい（Dockerfile は `*.html *.js *.css` を一括でコピーする。#575）。Python のモジュールは Dockerfile の `COPY` に名前を足す（`tests/static_check.py` が、`main.py` が import するモジュールの不足を検出する）。

### フロントエンド (HTML/JS/CSS)

| ファイル名 | 説明 | 主要な機能 |
|-----------|------|-----------|
| `index.html` | HTML構造 | ダッシュボードのDOM構造のみ |
| `styles.css` | スタイルシート | 全スタイル定義（APEX Broadcastデザインシステム、レスポンシブ対応含む） |
| `constants.js` | 共通定数 | 配色パレット（COLORS/STATUS）、チャート/マップ/タイヤ温度/更新レート/WebSocket各種設定 |
| `common-utils.js` | 共通の小さな処理（#571） | 走行距離の積算（`gtPathDistance`）、中央値（`gtMedian`）、localStorage の読み書き（`gtStorageGet/Set`、JSON 用）、表示モードの保存名（`GT_VIEW_MODE_STORAGE_KEY`）、ラップタイムの表示（`gtFormatLapMs`）、ツールバーボタンの生成と再試行、表の行のホバー/固定/キーボード操作。名前は `gt` / `GT_` で始める。挙動が違うもの（ライブの距離積算・RACE METRICS の中央値・σ の定義）は寄せていない（理由はファイル冒頭） |
| `review-common.css` | REVIEW の共通スタイル（#572/#598） | REVIEW のカード枠（トラックマップ・区間レポート・ラップ推移・散布図/分布・コーナー別レポート）と、レポート系3つの表の同一ルール |
| `ui_components.js` | 定数・ユーティリティ | 設定定数、ユーティリティ関数、DOM要素キャッシュ |
| `charts.js` | チャート管理 | uPlotチャート初期化・加速度チャート・距離軸解析チャート描画 |
| `steer-response.js` | STEER RESPONSE 可視化 | Canvas2D。舵角(ステアリングホイール角)から期待される旋回(狙い=青破線)と実ヨーレートから求めた旋回(実際=橙実線)を弧で比較。バランス比 \|ω\|/\|ω_exp\| によるアンダー/オーバー判定、車固有の中立ゲイン自動較正。物理導出・較正詳細は [steer-response.md](steer-response.md) 参照 |
| `car-3d.js` | CAR ATTITUDE 可視化 | Canvas2D クォータービュー（固定アングル疑似3D）。ダブルウィッシュボーン・サス、ステア連動タイヤ、重心点 CoG（横G/前後G 荷重移動）、pitch/yaw/roll。※旧 Three.js 3D モデルから移行し、G-FORCE パネルを統合 |
| `lap-manager.js` | ラップ管理 | ラップタイム記録・履歴管理 |
| `telemetry-analysis.js` | 距離基準ラップ解析 | 距離索引、ライブ・タイムデルタ、推定ラップタイム、リファレンス速度重畳、レースエンジニア通知 |
| `drive-view.js` | DRIVE/ANALYSIS ビュー切替 | 走行用最小表示（DRIVE）と解析表示（ANALYSIS）の切替、選択は localStorage に永続化 |
| `review-view.js` + `review.css` | REVIEW ビュー | 過去ラップの一覧（日付グループ・フィルタ）・A/B選択・重ね書き（#554、行の「＋」で最大5本を速度・ペダル入力のチャートへ追加。A/Bと同じ比較可否判定で、比較できない周回は凡例に理由つきで除外）・距離基準チャート3種（速度重畳/タイムデルタ/スロットル・ブレーキ）・比較サマリ。読み出しAPI `/api/laps` を使用 |
| `replay-mode.js` + `replay.css` | 全カード再生モード | 記録済みラップを既存の単一入口 `handleTelemetryMessage` へ供給し、走行中と同一の全カードで時間/距離スクラバー再生。2段ロード（10Hz先行→60Hz背景差替）・倍速・シーク対応 |
| `race-metrics.js` + `race-metrics.css` | RACE METRICS | G-Gダイアグラム・コーナーフェーズ別デルタ・サスペンション変位ヒストグラム・タイヤデグ率+ピットウィンドウ・滑らかさスコア・回生エネルギー/トルク配分。REVIEW/全カード再生下部とライブ（STRATEGYミニカード）に表示。ライブでは、アウトライヤー警告の1枠集約（#555 T8: `rmRaiseAlert`。ANALYSISのみ、DRIVE/REVIEWは従来のトースト）と、FUELカードの目標燃費差分（T9）も担う |
| `track-map.js` + `track-map.css` | REVIEW トラックマップ（#552） | A/B の走行ラインを速度・ブレーキ・スロットルで色分け（Bは白の破線）して描く Canvas2D。`review-view.js` の `reviewNotifyExtras()` から `tmOnReviewCompare` が呼ばれる。区間強調用に `tmHighlightRange` も公開。IIFE で隔離 |
| `theory-best.js` | REVIEW 理論ベスト（#552） | 距離を20等分した仮想区間ごとに A/B の速い方を合成した近似値と、実ベストとの差を要約帯へ表示。コース不一致・走行距離差3%超は算出しない。`tbOnReviewCompare` が唯一のフック |
| `segment-report.js` + `segment-report.css` | REVIEW 区間レポート（#552 T5） | 距離20等分の区間ごとに A/B のタイム・最高速・最低速・最大ブレーキ・平均スロットルを表で表示。行ホバー/タップで `tmHighlightRange` を呼び地図の区間を強調。`srOnReviewCompare` が唯一のフック。トラックマップとの左右並び（`#tm-sr-row`）もここで定義 |
| `channel-plots.js` + `channel-plots.css` | REVIEW 散布図・チャンネル分布（#555 T6/T7） | 任意の2チャンネルの散布図（速度・スロットル・ブレーキ・距離・縦加速度・タイム差）と、1チャンネルの分布（スロットル・ブレーキ・速度・ギア）を A/B で描く Canvas2D。散布図は距離10m格子、分布は記録サンプル（`reviewFetchDetail` の `raw`）から作る。`cpOnReviewCompare` が唯一のフック。IIFE で隔離 |
| `corner-report.js` + `corner-report.css` | REVIEW コーナー別レポート（#561）＋ばらつき CONSISTENCY（#562: 同コース・同車種の直近の周回のコーナーごとの σ と、トラックマップの STABILITY 色分け `tmSetStability`） | A/B の速度の平均の谷からコーナーを検出し、ブレーキ位置・踏み込み・離す位置・最低速度・スロットル位置・立ち上がり速度を A/B で比較。損失の大きい順に、操作の違いを走行順につないだ文章を出す。行ホバーで `tmHighlightRange`。`crOnReviewCompare` が唯一のフック。IIFE で隔離 |
| `audio-callout.js` | 音声の通知（#564） | ブラウザの音声合成で、serious/critical の通知と、ラップ完了のタイム・ベストとの差を読み上げる（ツールバーの AUDIO、既定オフ、再生・REVIEW 中は無効）。`telemetry-analysis.js`・`race-metrics.js` から `acOnNotification` / `acOnLapComplete` を呼ぶ。IIFE で隔離 |
| `persistent-ref.js` + `persistent-ref.css` | 過去の自己ベストを基準にするライブのデルタ（#563） | 車種・コースの DOM 表示を1秒ごとに監視し、過去の同コース・同車種の最速の単独周回を、`analysisState.refLap`（ライブのデルタ・推定ラップの基準）に、その日のベストより速い間だけ入れる。ライブの受信・描画経路には触れない。DELTA VS BEST カードに由来と「過去BEST」の切替。IIFE で隔離（グローバルなし） |
| `lap-trend.js` + `lap-trend.css` | REVIEW ラップ推移（#552 T3） | 同一コース・同一車種のラップタイム推移（uPlot）。ボタン操作時のみ `/api/laps/{file}?every=60` を最大40本・3並列で取得し、距離±3%外を除外。`ltOnReviewCompare` が唯一のフック |
| `laptime-predict.js` | ラップタイム予測（#434 P5） | 画面の表示値を1秒ごとに読み、同コース・同車種の参照距離（複数周回の距離の塊の中央値。#559）から進行度を求めて `/api/predict/laptime` に問い合わせる。モデル無し(404)は5分、該当なしは60秒あけて再試行 |
| `sector-time.js` + `sector-time.css` | 仮想セクタータイム（#436 B4） | 参照ラップの総距離をN等分した「仮想」区間のタイム。`laptime-predict.js` の進行度を読み取り専用で使う |
| `pit-wall.js` / `engineer.html` + `engineer.js` + `engineer.css` | バーチャルピットウォール（#434 P4） | エンジニア役の端末（`/engineer`）から `/ws` へ送った伝言を、ドライバー側で通知トーストに表示し読み上げる |
| `voice-command.js` + `voice-command.css` | 音声コマンド（#436 B3） | ツールバーの VOICE で1発話を認識し、DRIVE/ANALYSIS とカードのグループを切り替える。非対応ブラウザではボタンを作らない |
| `replay-diag.js` | REVIEW 再生の診断ログ（#558） | 再生中の計測値（実際の再生倍率・描画レート・タイマーの遅れ等）を `POST /api/diag` へ送り、`logs/replay_diag.jsonl` に残す |
| `websocket.js` | WebSocket通信 | 接続管理、テレメトリデータ処理（ライブの受信・描画の入口。整理の対象外） |
| `test-mode.js` | テストモード | デモデータ生成、PS5なしの動作確認 |
| `app.js` | エントリーポイント | テストモード・DRIVE/ANALYSIS ビューの初期化（メイン初期化は websocket.js の DOMContentLoaded。`card-drag.js` / `menu.js` は各自 DOMContentLoaded で自己初期化） |
| `card-drag.js` | ブロックのドラッグ移動 | トップレベルブロック（`.card` / `.chart-wrapper` / `.racing-top-bar`）を掴んで自由配置。`position:absolute`＋ドキュメント基準座標でページスクロール追従、localStorage 保存・復元、`window.gt7ResetLayout` 公開 |
| `menu.js` | フラット 1 段操作ツールバー | ヘッダーのタイトル直下に `nav#app-toolbar`（ANALYSIS│DRIVE│REVIEW セグメント / TEST MODE ピル / 整列 / 全画面）を注入。既存の隠しプロキシボタン（`#test-mode-btn` / `#view-mode-btn` / `#review-mode-btn` / `#layout-reset-btn`）を `.click()` で駆動し、状態は MutationObserver（プロキシの class 変化）+ `fullscreenchange` のイベント駆動で同期 |
| `card-groups.js` + `card-groups.css` | カード表示グループ管理 | ヘッダーの CARDS ボタンから、カードを6グループ（CHARTS/PEDALS・DRIVETRAIN/FUEL・STRATEGY/CAR BEHAVIOR/LAP・TIMING/CAR INFO）単位で表示/非表示切替。localStorage 永続化、`storage` イベントでタブ間同期 |

### 設定ファイル

| ファイル名 | 説明 |
|-----------|------|
| `config.json` | ネットワーク設定（ps5_ip / 各種ポート / heartbeat間隔 / SSL証明書パス）、`recording_enabled`（記録ON/OFF）、`data_retention`（保存ポリシー: enabled/max_total_gb/max_age_days/trash_days） |
| `.env` / `.env.example` | 環境変数による設定上書き（PS5_IP / SEND_PORT / RECEIVE_PORT / HTTP_PORT / HEARTBEAT_INTERVAL）。env優先・config.jsonフォールバック |
| `packet_def.json` | パケット定義（参照用、デコーダは未使用） |
| `course_database.json` | コースデータベース（位置座標→コース推定用） |
| `ssl/server-cert.pem`, `ssl/server-key.pem` | 自己署名SSL証明書（HTTPS/WSS用・gitignore対象）。イメージには入れず、`docker-compose.yml` がホストの `./ssl` を読み取り専用でマウントする（#596）。無ければ平文 HTTP で起動する（起動ログに警告） |

### テスト

| ファイル名 | 説明 |
|-----------|------|
| `tests/run_all.sh` | 静的チェック → pytest（コンテナ内）→ e2e を順に実行（[development.md](development.md)） |
| `tests/static_check.py` | JS の構文・ページごとのトップレベルの名前の重複・読み込むファイルの存在と Dockerfile の COPY への包含・id の重複、Python の構文・未使用 import・重複定義・`main.py` が import するモジュールの COPY への包含 |
| `tests/test_decoder.py` | Salsa20復号・XORフォールバック・parse・CourseEstimator の回帰テスト（pytest） |
| `tests/test_course_detection.py` | コース推定ロジックの検証・DB再生成（`--regenerate`） |
| `tests/test_train_laptime_model.py` | 学習パイプライン（外れ値の除外・時系列の分割・品質ゲート） |
| `tests/test_lapstore.py` | 共有定義の同一性、`scripts/gt7data_rotate.py` の手書きの正規表現との一致、保存ファイル名の書式との一致 |
| `tests/test_api_cache.py` | 読み出し API のキャッシュ（鍵・上限・ファイル更新時の読み直し・応答の同一性） |
| `tests/e2e/` | ヘッドレスのブラウザでの検証（実際に記録した周回のフィクスチャ、独立した Python 実装との照合、ゴールデン）。[tests/e2e/README.md](../tests/e2e/README.md) |

### その他

| ファイル名 | 説明 |
|-----------|------|
| `Dockerfile` | Dockerイメージ定義（Python は名前で、画面のファイルは `*.html *.js *.css` を一括でコピー。`.dockerignore` で開発用の物・`ssl/` を除く） |
| `docker-compose.yml` | Docker Compose設定（`network_mode: host`。ボリューム: `gt7data` / `gt7data_imported` / `models` / `logs` / `ssl`(読み取り専用)） |
| `requirements.txt` | Python依存パッケージ（aiohttp / pycryptodome / pytest） |
| `uplot.min.js` | uPlotグラフライブラリ |
| `uplot.min.css` | uPlotスタイルシート |
| `scripts/` | 運用・開発用スクリプト（`gt7data_rotate.py`: 記録の世代管理。root の cron でコンテナ外から実行するため `lapstore.py` を import せず、正規表現の一致は `tests/test_lapstore.py` で固定。[scripts/README.md](../scripts/README.md)）。本番のイメージには入れない |

## データフロー

### 1. 初期化フェーズ

```
1. Dockerコンテナ起動
   └─> main.py 開始
       └─> config.json 読み込み（環境変数があれば上書き: env優先・config.jsonフォールバック）
       └─> HTTP/WebSocketサーバー起動 (Port 8080, HTTPS/WSS)
       └─> on_startup フック発火
           └─> telemetry_supervisor タスク起動 (asyncio.create_task)
               └─> telemetry_background_task 起動
                   └─> GT7TelemetryClient 初期化 (heartbeat_type=b'~')
                   └─> await client.connect() で UDP エンドポイント作成
                   └─> GT7Decoder 初期化 (heartbeat_type=b'~')
                   └─> _heartbeat_loop を独立タスク起動（受信ループから分離）
```

> **再起動安全網**: `telemetry_supervisor` は `telemetry_background_task` を監視し、異常終了時に指数バックオフ（最大60秒）で再起動する。従来の「例外で終了すると受信が完全停止し、かつ気づく手段がない」問題を解消。アプリ終了時は `on_cleanup` フックが supervisor をキャンセルし、supervisor → background_task → heartbeat_task の順で連鎖的にクリーンアップする。

### 2. データ受信フェーズ

```
1. ブラウザでダッシュボードを開く
   └─> WebSocket接続確立 (wss://localhost:8080/ws)

2. PS5にハートビート送信（_heartbeat_loop が heartbeat_interval 秒ごとに送信）
   └─> "~" パケット送信 (Port 33739)
       └─> GT7が全フィールドパケット (344 bytes) の送信を開始

3. テレメトリパケット受信（非同期・イベント駆動）
   └─> UDP Port 33740 で受信 (asyncio.DatagramProtocol)
       └─> 受信キュー（asyncio.Queue, 上限256件）に蓄積
           └─> 溢れ時は古いパケットから破棄（60秒に1回・累積ドロップ数を警告ログ）
       └─> await client.receive() で取り出し（パケット到着まで待機・空ポーリングなし）
       └─> Salsa20復号 (XOR自動フォールバック: A/B/~)
       └─> パケット解析 (サイズに応じてA/B/~フィールドを抽出)
       └─> コース推定
       └─> 燃料計算 (FuelTracker)
       └─> WebSocket経由でブラウザに配信
```

> **非同期化のポイント**: 従来は同期ソケット + `settimeout(1.0)` のブロッキング受信と `asyncio.sleep(0.01)` の空ポーリングでイベントループを阻塞していたが、`asyncio.DatagramProtocol` 化によりパケット到着時のみ処理を起動する構造に改善。ハートビート送信は `_heartbeat_loop` に独立タスク化し受信ループから分離（間隔制御は `_heartbeat_loop` 側の `asyncio.sleep` のみに一元化）。

### 3. 表示更新フェーズ

```
1. ブラウザでデータ受信
   └─> JSONデータをパース
       └─> UI要素を更新（DRIVE/ANALYSIS ビューに応じて表示項目を切替）
       └─> チャートデータを追加（更新レート: UI=30fps / チャート=20fps / マップ=10fps）
       └─> CAR ATTITUDE・STEER RESPONSE（いずれも Canvas2D）を更新
```

> **UI レイアウト層（テレメトリと独立）**: `card-drag.js` は各ブロックを掴んで `body` 直下へ `position:absolute` で浮かせ自由配置する（配置は localStorage 保存・ページスクロール追従）。`menu.js` はヘッダーにフラット 1 段の操作ツールバーを生成し、既存の操作ボタンを隠しプロキシとして `.click()` で駆動する（状態は MutationObserver + `fullscreenchange` のイベント駆動で同期）。いずれもテレメトリ更新経路には介入せず、DOM 操作のみで完結する。

## 暗号化

GT7のテレメトリパケットはSalsa20で暗号化されています。ハートビートとして送信するバイト値（`A` / `B` / `~`）により返却パケットのサイズと収録フィールドが変わり、デフォルトでは全フィールドを取得できる `~`（344 bytes）を使用します。暗号化キー・IV 生成・XOR 値・マジックナンバーなど復号仕様の詳細は [API.md](API.md) を参照してください。

## コース推定

GT7のテレメトリパケットにはコースIDが含まれていないため、位置座標 (X, Z) からコースを推定します。

### 推定アルゴリズム

1. 現在の座標 (X, Z) を取得
2. コースデータベースの各コースの境界と比較
3. 座標が含まれるコースを特定
4. 複数のコースに含まれる場合、過去の履歴から判定

※ 推定結果は WS の `course` フィールドとして配信される。REVIEW ビューの比較サマリ・全カード再生の再生バータイトルにコース名として表示される（review-view.js / replay-mode.js）。

## テストモード

PS5がなくてもダッシュボードの動作を確認できる機能です。

### デモデータ生成

- 事前定義されたコース座標（スズカサーキット）
- ランダムに変化する速度、RPM、ギア
- シミュレートされたペダル入力
- タイヤ温度の変化

## データ保存

受信したテレメトリデータは `gt7data/` ディレクトリに保存されます。

### 保存条件

- ラップが完了したとき
- 車種IDが変わったとき

### ファイル名形式

```
{timestamp}_CAR-{car_id}_Lap-{lap_num}.json
```

## スケーラビリティ

### 同時接続

- 複数のブラウザから同時にアクセス可能
- 各クライアントは独立したWebSocket接続

### データ配信

- 1つのPS5接続に対して、複数のクライアントに配信
- 約60Hzでデータ更新

## セキュリティ

### デフォルト設定

- HTTP/WebSocketサーバは `0.0.0.0:8080` でリッスン（同一ネットワーク内の端末からアクセス可能）
- **HTTPS/WSS がデフォルト**（`ssl/server-cert.pem` / `server-key.pem` の自己署名証明書を使用）。証明書が未配置の場合は平文 HTTP にフォールバック
- 静的ファイル配信はパストラバーサル対策済み（`..` / 先頭 `/` を拒否）
- `.env` / `ssl/` は `.gitignore` / `.dockerignore` でコミット・本番イメージから除外（`ssl/` は `docker-compose.yml` が読み取り専用でマウントする。#596）

### 推奨設定

- ファイアウォールで必要なポート（UDP 33740 受信 / TCP 8080 配信）のみ開放
- 自己署名証明書を信頼できるCA運用に置き換えるか、用途に応じて mTLS を検討

---

**最終更新**: 2026-10-09
