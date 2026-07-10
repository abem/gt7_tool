# GT7 Telemetry Dashboard ドキュメント

## 概要

GT7 Telemetry Dashboardは、グランツーリスモ7 (GT7) のテレメトリデータをリアルタイムで表示・分析するためのツールです。PS5/PS4から送信される車両データを受信し、ウェブブラウザ上で美しいダッシュボードとして表示します。

## 主な機能

- **リアルタイムテレメトリ表示**: 速度、RPM、ギア（推奨ギア含む）、ステアリング角度
- **ペダル入力**: 生値 + TCS/ABS補正後の値をオーバーレイ表示
- **タイヤ詳細情報**: 4輪の温度、サスペンション高さ、ホイール回転速度、タイヤ半径
- **車体情報**: 横G/前後G（CAR ATTITUDE の重心点 CoG）、車体加速度（sway/heave/surge・BODY ACCEL）、路面法線
- **駆動系**: ギア比表示、トルクベクタリング、回生エネルギー
- **燃料管理**: 残量、消費量/周、残り周回予測
- **STEER RESPONSE**: 舵角（ステアリングホイール角）から期待される旋回（狙い=青破線）と実ヨーレートから求めた旋回（実際=橙実線）を弧で比較。バランス比 |ω|/|ω_exp| でアンダー/オーバー判定、車固有の中立ゲインを実走行から自動較正
- **コース自動推定**: 位置座標から走行中のコースを自動判定
- **ラップタイム記録**: ラップタイム、ベストタイム、セクタータイム
- **距離基準ラップ解析**: ライブ・タイムデルタ、推定ラップタイム、リファレンス速度重畳、レースエンジニア通知、グリップ状態・一貫性σ
- **車体姿勢 (CAR ATTITUDE)**: Canvas2D クォータービューで、ダブルウィッシュボーン・サス、ステア連動タイヤ、重心点 CoG（横 G / 前後 G 荷重移動）、pitch/yaw/roll を可視化
- **レイアウト操作**: 全ブロックをドラッグで自由配置（配置は保存・スクロール追従）、ヘッダーの操作メニューバー（表示 / モード / 配置 / 設定）
- **テストモード**: PS5なしで動作確認が可能
- **全パケット対応**: Packet A/B/~ の3種類に対応
- **HTTPS/WSS対応**: SSL証明書による暗号化通信

## クイックリンク

### ユーザー向け

| ドキュメント | 説明 |
|------------|------|
| [ユーザーガイド](USER_GUIDE.md) | インストールから使用方法までの詳細ガイド |
| [一般的な問題](common-issues.md) | トラブルシューティング |
| [TEST MODEガイド](test-mode.md) | テストモードの使い方 |

### 技術者向け

| ドキュメント | 説明 |
|------------|------|
| [APIドキュメント](API.md) | HTTP/WebSocket API、Pythonモジュールの詳細 |
| [システムアーキテクチャ](architecture.md) | システム構成、ファイル構成、データフロー |
| [改修履歴: バックエンド安定化 (2026-07-08)](refactoring-2026-07-08.md) | Salsa20致命バグ修正・UDP非同期化・構成整理の詳細 |
| [変更履歴 (CHANGELOG)](../CHANGELOG.md) | UI 刷新（CAR ATTITUDE / ブロック配置 / メニューバー等）を含む時系列の一次情報 |

### 過去の記録（アーカイブ）

現状の一次情報は上記の [CHANGELOG](../CHANGELOG.md) を参照してください。以下は作業当時のスナップショットで、現行仕様と一致しない場合があります。

| ドキュメント | 説明 |
|------------|------|
| [refactoring-2026-07-08.md](refactoring-2026-07-08.md) | バックエンド安定化（Salsa20修正・UDP非同期化）の詳細 |
| [refactoring-2026-07-09.md](refactoring-2026-07-09.md) | リファクタリング記録 |
| [bugfix-duplicate-definitions-2026-07-09.md](bugfix-duplicate-definitions-2026-07-09.md) | 重複定義バグの修正記録 |
| [bugfix-webgl-graceful-degradation-2026-07-09.md](bugfix-webgl-graceful-degradation-2026-07-09.md) | WebGL 非対応環境でのグレースフルデグラデーション対応記録 |
| [verification_report.md](verification_report.md) | 検証レポート |
| [3D_ROTATION_PLAN.md](3D_ROTATION_PLAN.md) | 3D 回転表現の検討計画 |
| [terminology_fix_list.md](terminology_fix_list.md) | 用語修正リスト |
| [archive/CHANGELOG_MOTION_EFFECTS.md](archive/CHANGELOG_MOTION_EFFECTS.md) | 旧 Three.js 3D モデル時代のモーション演出パラメータ変遷記録 |
| [archive/PLAN_ANGULAR_VELOCITY_IMPROVEMENT.md](archive/PLAN_ANGULAR_VELOCITY_IMPROVEMENT.md) | ANGULAR VELOCITY 3D 表示の改善計画書 |
| [archive/PLAN_CAR_ATTITUDE_MOUSE_CONTROL.md](archive/PLAN_CAR_ATTITUDE_MOUSE_CONTROL.md) | CAR ATTITUDE マウス操作対応の計画書 |
| [archive/PLAN_CAR_DESIGN_IMPROVEMENT.md](archive/PLAN_CAR_DESIGN_IMPROVEMENT.md) | 3D車両モデルのデザイン改善計画書 |
| [archive/PLAN_EXAGGERATED_CAR_MOTION.md](archive/PLAN_EXAGGERATED_CAR_MOTION.md) | 3D車両モデルの振動・ピッチ・ロール演出強化計画書 |
| [archive/PLAN_MOTION_IMPROVEMENT.md](archive/PLAN_MOTION_IMPROVEMENT.md) | 3D車両モデルの挙動改善計画書 |
| [archive/PLAN_REFACTORING.md](archive/PLAN_REFACTORING.md) | リファクタリング計画書（旧計画。後続の [REFACTORING_PLAN.md](archive/REFACTORING_PLAN.md) とは別文書） |
| [archive/PROPOSAL_RACING_DASHBOARD.md](archive/PROPOSAL_RACING_DASHBOARD.md) | レーシングテレメトリダッシュボード改善提案書 |
| [archive/QA_REPORT.md](archive/QA_REPORT.md) | QA レビューレポート |
| [archive/REFACTORING_PLAN.md](archive/REFACTORING_PLAN.md) | リファクタリング計画（現状分析含む） |
| [archive/REFACTORING_REPORT.md](archive/REFACTORING_REPORT.md) | リファクタリング完了レポート |
| [archive/TROUBLESHOOTING.md](archive/TROUBLESHOOTING.md) | グラフ表示不具合（uPlot CDN 読み込み障害・解決済み）の対応履歴 |

### その他のドキュメント

| ドキュメント | 説明 | 場所 |
|------------|------|------|
| README | プロジェクト概要、クイックスタート | ルートディレクトリ |
| CHANGELOG.md | 変更履歴（時系列・最新の一次情報） | ルートディレクトリ |
| DOCS_PLAN.md | ドキュメント整備計画（旧・参考） | ルートディレクトリ |

## クイックスタート

### 必要な環境

- **グランツーリスモ7** (PS5/PS4)
- **Docker** (version 20.10以上)
- **Docker Compose** (version 2.0以上)

### インストール手順

1. リポジトリをクローン
   ```bash
   git clone <リポジトリURL>
   cd gt7_tool
   ```

2. config.jsonを編集（PS5のIPアドレスを設定）
   ```json
   {
       "ps5_ip": "192.168.1.10",
       "send_port": 33739,
       "receive_port": 33740,
       "http_port": 8080,
       "heartbeat_interval": 10
   }
   ```

3. Dockerを起動
   ```bash
   docker compose up --build
   ```

4. ブラウザでダッシュボードを開く
   ```
   https://localhost:8080
   （HTTPS。自己署名証明書の警告は「詳細設定」から続行）
   ```

詳細な手順は[ユーザーガイド](USER_GUIDE.md)を参照してください。

## 動作確認

動作確認は headless スモークテスト（Playwright + TEST MODE、PS5 不要）で継続実施しています。詳細は [CHANGELOG](../CHANGELOG.md) を参照してください。

## アーキテクチャ

```
PS5 (GT7) --[UDP]--> Python Backend --[WebSocket]--> Web Dashboard
                      |-- Salsa20復号
                      |-- データ解析
                      |-- コース推定
                      |-- データ保存
```

## ライセンス

MIT License

## サポート

問題が発生した場合は、[一般的な問題](common-issues.md)を参照するか、Issueを作成してください。

---

**最終更新**: 2026-07-10
