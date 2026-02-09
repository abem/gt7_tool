import asyncio
import json
import os
from datetime import datetime
from aiohttp import web
from telemetry import GT7TelemetryClient
from decoder import GT7Decoder

# Load Config
def load_config():
    with open('config.json', 'r') as f:
        cfg = json.load(f)
        if os.getenv("PS5_IP"):
            cfg["ps5_ip"] = os.getenv("PS5_IP")
        return cfg

CONFIG = load_config()

# グローバル変数：接続中のWebSocketクライアント
websocket_clients = set()

# テレメトリクライアントとデコーダー
telemetry_client = None
decoder = None

# ログデータ用
current_lap_data = []
all_laps = []
current_lap_number = 0
last_lap_ticks = 0
log_dir = "gt7data"


def ensure_log_dir():
    """ログディレクトリが存在することを確認"""
    if not os.path.exists(log_dir):
        os.makedirs(log_dir)
        print(f"Created log directory: {log_dir}")


def save_lap_to_file(lap_data, lap_num):
    """ラップデータをJSONファイルに保存"""
    timestamp = datetime.now().strftime("%Y-%m-%d_%H_%M_%S")
    # 車種IDがあればファイル名に含める
    car_id = lap_data[0].get("car_id", 0) if lap_data else 0
    filename = f"{log_dir}/{timestamp}_CAR-{car_id}_Lap-{lap_num}.json"

    try:
        with open(filename, 'w') as f:
            json.dump(lap_data, f)
        print(f"Saved lap data: {filename} ({len(lap_data)} samples)")
    except Exception as e:
        print(f"Error saving lap data: {e}")


async def telemetry_background_task():
    """バックグラウンドでGT7からのテレメトリデータを受信し続けるタスク"""
    global telemetry_client, decoder
    global current_lap_data, current_lap_number, last_lap_ticks

    telemetry_client = GT7TelemetryClient(
        CONFIG["ps5_ip"],
        CONFIG.get("send_port", 33739),
        CONFIG.get("receive_port", 33740),
        CONFIG["heartbeat_interval"]
    )
    decoder = GT7Decoder('packet_def.json')

    ensure_log_dir()

    last_package_id = 0

    print(f"Logging enabled. Data will be saved to: {os.path.abspath(log_dir)}/")

    try:
        while True:
            # 1. メンテナンス（Heartbeat）
            telemetry_client.send_heartbeat()

            # 2. データ受信
            raw_data = telemetry_client.receive()

            if raw_data:
                # 3. 復号と解析
                decrypted = decoder.decrypt(raw_data)
                if decrypted:
                    parsed_data = decoder.parse(decrypted)

                    if parsed_data:
                        # パッケージIDチェック（重複除外）
                        package_id = parsed_data.get("package_id", 0)
                        if package_id > last_package_id:
                            last_package_id = package_id

                            # タイムスタンプを追加
                            parsed_data["timestamp"] = datetime.now().isoformat()

                            # ラップデータを収集
                            current_lap_data.append(parsed_data)

                            # ラップ変化を検出（gt7dashboardの実装を参考）
                            # パケット内のラップ番号を取得（0x74バイト目）
                            # ただしdecoder.parseで取得していないので、gearなどを基準に判定
                            # ここでは簡易的に一定数のサンプルで保存

                            # 定期的にログを保存（60fps × 30秒 = 1800サンプルで区切る）
                            if len(current_lap_data) >= 1800:
                                save_lap_to_file(current_lap_data.copy(), current_lap_number)
                                all_laps.extend(current_lap_data)
                                current_lap_data = []
                                current_lap_number += 1

                            # 4. WebSocketクライアントにブロードキャスト
                            if websocket_clients:
                                message = json.dumps(parsed_data)
                                print(f"[WS] Broadcasting to {len(websocket_clients)} clients")
                                # 切断されたクライアントを除外しながら送信
                                disconnected = set()
                                for ws in websocket_clients:
                                    try:
                                        await ws.send_str(message)
                                    except Exception as e:
                                        print(f"[WS] Send failed: {e}")
                                        disconnected.add(ws)
                                # 切断されたクライアントを削除
                                websocket_clients.difference_update(disconnected)
                                if disconnected:
                                    print(f"[WS] Removed {len(disconnected)} disconnected clients")

            await asyncio.sleep(0.01)

    except Exception as e:
        print(f"Telemetry Task Error: {e}")
        # エラー時にも現在のラップデータを保存
        if current_lap_data:
            save_lap_to_file(current_lap_data.copy(), current_lap_number)
    finally:
        # 終了時に残りのデータを保存
        if current_lap_data:
            save_lap_to_file(current_lap_data.copy(), current_lap_number)
        telemetry_client.close()


async def websocket_handler(request):
    """WebSocket接続を処理"""
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    print(f"[WS] Client connected: {request.remote}")
    print(f"[WS] Total clients: {len(websocket_clients) + 1}")
    websocket_clients.add(ws)

    try:
        # 接続が続いている限り待機
        async for msg in ws:
            # クライアントからのメッセージは特に処理しない
            print(f"[WS] Received message from client: {msg}")
    except Exception as e:
        print(f"[WS] WebSocket Error: {e}")
    finally:
        websocket_clients.discard(ws)
        print(f"[WS] Client disconnected. Remaining: {len(websocket_clients)}")

    return ws


async def index_handler(request):
    """HTMLページを配信"""
    with open('index.html', 'r') as f:
        return web.Response(text=f.read(), content_type='text/html')


async def static_handler(request):
    """静的ファイル（CSS, JS）を配信"""
    filename = request.match_info['filename']
    content_types = {
        'css': 'text/css',
        'js': 'application/javascript',
    }
    ext = filename.split('.')[-1]
    content_type = content_types.get(ext, 'text/plain')

    try:
        with open(filename, 'r') as f:
            return web.Response(text=f.read(), content_type=content_type)
    except FileNotFoundError:
        return web.Response(status=404, text="File not found")


async def on_startup(app):
    """アプリ起動時にバックグラウンドタスクを開始"""
    print("Starting telemetry background task...")
    asyncio.create_task(telemetry_background_task())


def main():
    port = CONFIG.get("http_port", 8080)
    ws_port = CONFIG.get("ws_port", 8080)

    app = web.Application()
    app.router.add_get('/', index_handler)
    app.router.add_get('/{filename}', static_handler)
    app.router.add_get('/ws', websocket_handler)

    app.on_startup.append(on_startup)

    print(f"Starting GT7 Dashboard Server on port {port}...")
    print(f"HTTP: http://0.0.0.0:{port}")
    print(f"WebSocket: ws://0.0.0.0:{port}/ws")

    web.run_app(app, host='0.0.0.0', port=port)


if __name__ == "__main__":
    main()
