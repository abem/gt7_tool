# GT7 Tool ログ

**日時:** 2026-02-09 22:00 GMT+9

## 重要な項目

### 1. サーバーの起動状況
- ✅ Dockerコンテナが正常に起動している
- ✅ サーバーがポート8080でリッスン中: `Server is ready. Listening on ws://0.0.0.0:8080`

### 2. WebSocket接続エラー
- ❌ WebSocket接続でエラーが発生している
- エラーメッセージ: `websockets.exceptions.InvalidUpgrade: invalid Connection header: keep-alive`
- 原因: ブラウザが `Connection: keep-alive` ヘッダーを送信していて、websocketsライブラリがこれを正しく処理できない

### 3. PS5の設定
- IPアドレス: `192.168.1.10`
- ポート: `33739` (GT7テレメトリ)
- ホストビット間隔: `10` 秒

### 4. 使用ライブラリ
- Python: 3.11
- websockets: 13.1
- salsa20: 0.3.0

### 5. Docker設定
- ネットワークモード: host
- ホストマウント: `./` → `/app`

## トラブルシューティング

### 現在の問題
websocketsライブラリのバージョン（13.1/14.x）で、ブラウザのHTTP/1.1 `Connection: keep-alive` ヘッダーを正しく処理できない問題がある。

### 解決策の候補
1. 別のWebSocketライブラリ（aiohttpなど）を使用する
2. websockets 10.xにダウングレードする
3. HTTP/1.1のヘッダー処理をカスタマイズする

## 次のアクション
1. ブラウザで http://localhost:8080 にアクセスして、実際のエラーメッセージを確認
2. WebSocketライブラリのバージョンを変更して、問題を解決する
