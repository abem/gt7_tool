# GT7 Telemetry Dashboard ドキュメント

## 概要

GT7 Telemetry Dashboardは、グランツーリスモ7 (GT7) のテレメトリデータをリアルタイムで表示・分析するためのツールです。PS5/PS4から送信される車両データを受信し、ウェブブラウザ上で美しいダッシュボードとして表示します。プロジェクト全体の概要は [README](../README.md) を参照してください。

## 主な機能

機能一覧は [README の主な機能](../README.md#主な機能) を参照してください。

## クイックリンク

### ユーザー向け

| ドキュメント | 説明 |
|------------|------|
| [ユーザーガイド](USER_GUIDE.md) | インストールから使用方法までの詳細ガイド |
| [一般的な問題](common-issues.md) | トラブルシューティング |
| [TEST MODEガイド](test-mode.md) | テストモードの使い方 |

### 技術者向け

現行の実装と一致する文書のみを掲載します（振り分け基準: 現行コードと突合済み・内容が古くなっていない文書はここに、実装から乖離した過去のスナップショットは下記「過去の記録」に置きます）。

| ドキュメント | 説明 |
|------------|------|
| [APIドキュメント](API.md) | HTTP/WebSocket API、Pythonモジュールの詳細 |
| [システムアーキテクチャ](architecture.md) | システム構成、ファイル構成、データフロー |
| [STEER RESPONSE 詳説](steer-response.md) | STEER RESPONSE の物理導出・較正詳細・限界（本機能の正） |
| [開発ガイド](development.md) | 変更時の検証手順（回帰テスト・コンテナ反映・headless スモーク） |
| [改修履歴: バックエンド安定化 (2026-07-08)](refactoring-2026-07-08.md) | Salsa20致命バグ修正・UDP非同期化・構成整理の詳細 |
| [ブロックのリサイズ機能設計 (2026-07-11)](plan-block-resize-2026-07-11.md) | リサイズグリップ・保存スキーマ・クランプ処理の設計（現行card-drag.js実装と一致） |
| [変更履歴 (CHANGELOG)](../CHANGELOG.md) | UI 刷新（CAR ATTITUDE / ブロック配置 / 操作ツールバー等）を含む時系列の一次情報 |

### 過去の記録（アーカイブ）

現状の一次情報は上記の [CHANGELOG](../CHANGELOG.md) を参照してください。以下は作業当時のスナップショットで、現行仕様と一致しない場合があります。

| ドキュメント | 説明 |
|------------|------|
| [refactoring-2026-07-09.md](refactoring-2026-07-09.md) | リファクタリング記録 |
| [bugfix-duplicate-definitions-2026-07-09.md](bugfix-duplicate-definitions-2026-07-09.md) | 重複定義バグの修正記録 |
| [bugfix-webgl-graceful-degradation-2026-07-09.md](bugfix-webgl-graceful-degradation-2026-07-09.md) | WebGL 非対応環境でのグレースフルデグラデーション対応記録 |
| [verification_report.md](verification_report.md) | 検証レポート（「テレメトリー→テレメトリ」表記統一の所見を含む。詳細は下記 terminology_fix_list.md） |
| [3D_ROTATION_PLAN.md](3D_ROTATION_PLAN.md) | 3D 回転表現の検討計画 |
| [terminology_fix_list.md](terminology_fix_list.md) | 用語修正リスト（verification_report.md の表記統一所見をファイル別・行別に詳細化したもの。表記統一は対応済み） |
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

インストールと起動手順は [README のクイックスタート](../README.md#クイックスタート) と [ユーザーガイド](USER_GUIDE.md) を参照してください。

## 動作確認

動作確認は headless スモークテスト（Playwright + TEST MODE、PS5 不要）で継続実施しています。手順は [開発ガイド](development.md) を、実施記録は [CHANGELOG](../CHANGELOG.md) を参照してください。

## アーキテクチャ

システム構成とデータフローは [システムアーキテクチャ](architecture.md) を参照してください。

## ライセンス

MIT License（[README](../README.md#ライセンス) 参照）

## サポート

問題が発生した場合は、[一般的な問題](common-issues.md)を参照するか、Issueを作成してください。

---

**最終更新**: 2026-07-18
