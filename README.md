# GT7 Telemetry Dashboard

PythonとWebSocketを使用した、グランツーリスモ7 (GT7) 用のリアルタイム・テレメトリーダッシュボードです。
PS5/PS4から送信されるテレメトリーパケットを受信・復号（Salsa20）し、WebSocket経由でウェブブラウザ上のダッシュボードに表示します。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Python](https://img.shields.io/badge/python-3.11-blue.svg)

## 特徴
- **リアルタイム表示**: 速度、回転数 (RPM)、ギア、アクセル開度、ブレーキ開度。
- **Webダッシュボード**: HTML/JS製のシンプルなフロントエンド（カスタマイズ容易）。
- **Docker対応**: Docker Compose で環境構築が不要。
- **設定分離**: パケット定義やネットワーク設定をJSONで外出ししているため、コード修正なしで設定変更可能。

## 必須環境
- グランツーリスモ7 が動作する PlayStation 4 または 5
- Docker および Docker Compose

## クイックスタート

1. **IPアドレスの設定**
   `config.json` を編集し、PS5のIPアドレスを設定してください:
   ```json
   {
       "ps5_ip": "192.168.1.10",  <-- ここを自分のPS5のIPに変更
       "gt7_port": 33739,
       "ws_port": 8080,
       "heartbeat_interval": 10
   }
   ```

2. **サーバーの起動**
   ```bash
   docker compose up --build
   ```
   ブラウザが接続すると、ログに `Client connected. Starting stream...` と表示されます。

3. **ダッシュボードを開く**
   `index.html` をウェブブラウザで開いてください。
   
   例 (ローカルファイル):
   `file:///path/to/gt7_tool/index.html`
   （WindowsならエクスプローラーからダブルクリックでOK）

## 構成

- **`main.py`**: エントリーポイント。WebSocketサーバー (`asyncio` + `websockets`) を実行します。
- **`telemetry.py`**: PS5とのUDP通信（ハートビート `A` パケット送信など）を管理します。
- **`decoder.py`**: Salsa20で暗号化されたパケットを復号し、`packet_def.json` に基づいてデータを解析します。
- **`packet_def.json`**: テレメトリーデータのメモリオフセットとデータ型を定義しています。
- **`config.json`**: ネットワーク設定ファイル。

## カスタマイズ方法

新しいデータ項目（例：タイヤ温度、燃料残量、ブースト圧など）を追加したい場合:

1. GT7テレメトリーの仕様（コミュニティ等のドキュメント）でオフセットを探します。
2. `packet_def.json` にフィールドを追加します:
   ```json
   "boost_pressure": {"offset": "0x50", "type": "float"}
   ```
3. `index.html` を編集して、新しいデータを表示するようにします。

## クレジット
このツールは、GT7/GT Sportのテレメトリーに必要なSalsa20復号ロジックを使用しています。
暗号化キー: `Simulator Interface Packet GT7 ver 0.0`

## ライセンス
MIT License
