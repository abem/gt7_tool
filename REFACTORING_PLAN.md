# GT7 Tool リファクタリング計画

## 現状分析

### ファイル構成
```
app.js           - エントリーポイント（最小化済み）
car-3d.js        - 3D車両モデル（Three.js）
charts.js        - チャート描画（uPlot）
constants.js     - 定数定義
course-map.js    - コースマップ描画
decoder.py       - パケット復号
index.html       - メインHTML
lap-manager.js   - ラップ管理
main.py          - Pythonサーバー
styles.css       - スタイルシート
telemetry.py     - テレメトリ受信
test-glass.js    - テストスクリプト（削除候補）
test-mode.js     - テストモード
ui_components.js - UI要素キャッシュ・ユーティリティ
uplot.min.js     - チャートライブラリ（minified）
websocket.js     - WebSocket通信
```

### 依存関係グラフ
```
index.html
    ↓
app.js → websocket.js → ui_components.js → constants.js
       ↓                ↓
       test-mode.js     charts.js
       ↓                ↓
       car-3d.js        course-map.js
                        ↓
                        lap-manager.js
```

## リファクタリング項目

### Phase 1: コード整理（優先度：高）

#### 1.1 未使用コードの削除
- [ ] `test-glass.js` を削除または `tests/` に移動
- [ ] `ui_components.js` の未使用要素（`angX`, `angY`, `angZ`, `rotationCube`等）を削除
- [ ] `decoder.py` の `CourseEstimator` 統合確認（main.py側で処理済み）

#### 1.2 重複コードの統合
- [ ] `updatePositionText()` と `updateTyreState()` の重複確認
- [ ] `formatLapTime()` の使用箇所確認

#### 1.3 JavaScript依存関係の明確化
- [ ] 各ファイルの `@depends` コメントを確認・更新
- [ ] 循環依存の確認

### Phase 2: 機能改善（優先度：中）

#### 2.1 エラーハンドリング強化
- [ ] WebSocket接続エラーのユーザー通知改善
- [ ] 要素取得時のnullチェック統一

#### 2.2 パフォーマンス最適化
- [ ] DOM要素キャッシュの確認（`cacheElements()`）
- [ ] チャート更新頻度の調整
- [ ] 3Dレンダリングのフレームレート制御

#### 2.3 UI/UX改善
- [ ] CAR ATTITUDEセクションの角速度表示改善（完了）
- [ ] レスポンシブデザイン確認

### Phase 3: 保守性向上（優先度：低）

#### 3.1 ドキュメント整備
- [ ] README.md更新
- [ ] インストール手順の明確化

#### 3.2 テスト環境
- [ ] `test-glass.js` を正式なテストスイートに統合
- [ ] 手動テストチェックリスト作成

## 実行順序

1. **Phase 1.1** - 未使用コード削除（最も効果的）
2. **Phase 1.2** - 重複コード統合
3. **Phase 2.1** - エラーハンドリング
4. **Phase 2.2** - パフォーマンス最適化
5. **Phase 3** - ドキュメント・テスト

## 進捗

- [x] ANGULAR VELOCITY 3DをCAR ATTITUDEに統合
- [x] websocket.js末尾の不完全なコードを補完
- [x] 二重初期化の削除
- [ ] 未使用コードの削除
- [ ] 重複コードの統合
- [ ] エラーハンドリング強化

---
作成日: 2026-03-12
作業者: Lacia (OpenClaw Agent)
