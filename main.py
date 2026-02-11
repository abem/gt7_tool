import asyncio
import json
import os
import logging
from datetime import datetime
from aiohttp import web
from telemetry import GT7TelemetryClient
from decoder import GT7Decoder

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)
http_logger = logging.getLogger('http')
access_logger = logging.getLogger('access')

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
        logger.info(f"Created log directory: {log_dir}")


def save_lap_to_file(lap_data, lap_num):
    """ラップデータをJSONファイルに保存"""
    timestamp = datetime.now().strftime("%Y-%m-%d_%H_%M_%S")
    # 車種IDがあればファイル名に含める
    car_id = lap_data[0].get("car_id", 0) if lap_data else 0
    filename = f"{log_dir}/{timestamp}_CAR-{car_id}_Lap-{lap_num}.json"

    try:
        with open(filename, 'w') as f:
            json.dump(lap_data, f)
        logger.info(f"Saved lap data: {filename} ({len(lap_data)} samples)")
    except Exception as e:
        logger.error(f"Error saving lap data: {e}", exc_info=True)


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

    logger.info(f"Logging enabled. Data will be saved to: {os.path.abspath(log_dir)}/")

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
                                logger.debug(f"Broadcasting telemetry to {len(websocket_clients)} WebSocket clients")
                                # 切断されたクライアントを除外しながら送信
                                disconnected = set()
                                for ws in websocket_clients:
                                    try:
                                        await ws.send_str(message)
                                    except Exception as e:
                                        logger.warning(f"WebSocket send failed: {e}")
                                        disconnected.add(ws)
                                # 切断されたクライアントを削除
                                websocket_clients.difference_update(disconnected)
                                if disconnected:
                                    logger.info(f"Removed {len(disconnected)} disconnected WebSocket clients")

            await asyncio.sleep(0.01)

    except Exception as e:
        logger.error(f"Telemetry Task Error: {e}", exc_info=True)
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
    remote_addr = request.remote
    user_agent = request.headers.get('User-Agent', 'Unknown')

    logger.info(f"WebSocket connection attempt from {remote_addr}, User-Agent: {user_agent}")

    ws = web.WebSocketResponse()
    await ws.prepare(request)

    logger.info(f"WebSocket client connected: {remote_addr}, User-Agent: {user_agent}")
    logger.info(f"Total WebSocket clients: {len(websocket_clients) + 1}")
    websocket_clients.add(ws)

    try:
        # 接続が続いている限り待機
        async for msg in ws:
            # クライアントからのメッセージは特に処理しない
            logger.info(f"WebSocket message received from {remote_addr}: {msg.type}")
    except Exception as e:
        logger.error(f"WebSocket Error for {remote_addr}: {e}", exc_info=True)
    finally:
        websocket_clients.discard(ws)
        logger.info(f"WebSocket client disconnected: {remote_addr}. Remaining clients: {len(websocket_clients)}")

    return ws


async def index_handler(request):
    """HTMLページを配信"""
    remote_addr = request.remote
    method = request.method
    user_agent = request.headers.get('User-Agent', 'Unknown')

    logger.info(f"Index request - Method: {method}, Path: /, Remote: {remote_addr}, User-Agent: {user_agent}")

    try:
        with open('index.html', 'r') as f:
            content = f.read()
            logger.info(f"Index file served successfully - Content-Type: text/html, Status: 200, Remote: {remote_addr}")
            return web.Response(text=content, content_type='text/html')
    except FileNotFoundError as e:
        logger.error(f"Index file not found - Status: 404, Remote: {remote_addr}, Error: {e}")
        return web.Response(status=404, text="Index file not found")
    except Exception as e:
        logger.error(f"Error serving index file - Remote: {remote_addr}, Error: {e}", exc_info=True)
        return web.Response(status=500, text="Internal server error")


async def static_handler(request):
    """静的ファイル（CSS, JS）を配信"""
    filename = request.match_info['filename']
    remote_addr = request.remote
    method = request.method
    user_agent = request.headers.get('User-Agent', 'Unknown')

    content_types = {
        'css': 'text/css',
        'js': 'application/javascript',
        'html': 'text/html',
        'json': 'application/json',
    }
    ext = filename.split('.')[-1]
    content_type = content_types.get(ext, 'text/plain')

    logger.info(f"Static file request - Method: {method}, Path: /{filename}, Remote: {remote_addr}, User-Agent: {user_agent}")

    try:
        with open(filename, 'r') as f:
            content = f.read()
            logger.info(f"Static file served successfully - File: {filename}, Content-Type: {content_type}, Status: 200, Remote: {remote_addr}")
            return web.Response(text=content, content_type=content_type)
    except FileNotFoundError as e:
        logger.warning(f"Static file not found - File: {filename}, Status: 404, Remote: {remote_addr}")
        return web.Response(status=404, text="File not found")
    except Exception as e:
        logger.error(f"Error serving static file - File: {filename}, Remote: {remote_addr}, Error: {e}", exc_info=True)
        return web.Response(status=500, text="Internal server error")


async def debug_handler(request):
    """サーバー診断情報を返すデバッグエンドポイント"""
    debug_info = {
        "current_working_directory": os.getcwd(),
        "app_directory": "/app",
        "files": [],
        "index_html_preview": None,
        "errors": []
    }

    app_dir = "/app"
    index_html_path = os.path.join(app_dir, "index.html")

    try:
        if os.path.exists(app_dir):
            try:
                entries = os.listdir(app_dir)
                for entry in entries:
                    full_path = os.path.join(app_dir, entry)
                    try:
                        stat_info = os.stat(full_path)
                        file_info = {
                            "name": entry,
                            "path": full_path,
                            "exists": True,
                            "size": stat_info.st_size,
                            "is_directory": os.path.isdir(full_path),
                            "is_file": os.path.isfile(full_path)
                        }
                        debug_info["files"].append(file_info)
                    except Exception as e:
                        debug_info["errors"].append({
                            "type": "file_stat_error",
                            "path": full_path,
                            "error": str(e)
                        })
            except Exception as e:
                debug_info["errors"].append({
                    "type": "directory_list_error",
                    "path": app_dir,
                    "error": str(e)
                })
        else:
            debug_info["errors"].append({
                "type": "directory_not_found",
                "path": app_dir,
                "error": f"Directory {app_dir} does not exist"
            })
    except Exception as e:
        debug_info["errors"].append({
            "type": "unexpected_error",
            "error": str(e)
        })

    # Read first 200 bytes of index.html
    try:
        if os.path.exists(index_html_path):
            with open(index_html_path, 'rb') as f:
                preview_bytes = f.read(200)
                debug_info["index_html_preview"] = {
                    "path": index_html_path,
                    "first_200_bytes": preview_bytes.hex(),
                    "first_200_bytes_utf8": preview_bytes.decode('utf-8', errors='replace'),
                    "bytes_read": len(preview_bytes)
                }
        else:
            debug_info["errors"].append({
                "type": "file_not_found",
                "path": index_html_path,
                "error": f"index.html not found at {index_html_path}"
            })
    except Exception as e:
        debug_info["errors"].append({
            "type": "index_html_read_error",
            "path": index_html_path,
            "error": str(e)
        })

    return web.json_response(debug_info)


@web.middleware
async def logging_middleware(request, handler):
    """Middleware to log all HTTP requests"""
    start_time = datetime.now()
    remote_addr = request.remote
    method = request.method
    path = request.path
    user_agent = request.headers.get('User-Agent', 'Unknown')
    query_string = request.query_string

    # Log incoming request
    logger.info(f"HTTP Request - {method} {path} from {remote_addr}")
    if query_string:
        logger.debug(f"Query string: {query_string}")
    logger.debug(f"Headers: User-Agent={user_agent}")

    try:
        response = await handler(request)
        duration = (datetime.now() - start_time).total_seconds()

        # Log response details
        status_code = response.status
        content_type = response.headers.get('Content-Type', 'N/A')

        if status_code >= 400:
            logger.warning(f"HTTP Response - Status: {status_code}, Content-Type: {content_type}, Duration: {duration:.3f}s, Remote: {remote_addr}")
        else:
            logger.info(f"HTTP Response - Status: {status_code}, Content-Type: {content_type}, Duration: {duration:.3f}s, Remote: {remote_addr}")

        return response

    except web.HTTPException as e:
        duration = (datetime.now() - start_time).total_seconds()
        logger.warning(f"HTTP Exception - Status: {e.status}, Path: {path}, Duration: {duration:.3f}s, Remote: {remote_addr}, Error: {e.text}")
        raise
    except Exception as e:
        duration = (datetime.now() - start_time).total_seconds()
        logger.error(f"Unhandled exception - Method: {method}, Path: {path}, Duration: {duration:.3f}s, Remote: {remote_addr}, Error: {e}", exc_info=True)
        raise


async def on_startup(app):
    """アプリ起動時にバックグラウンドタスクを開始"""
    logger.info("Starting telemetry background task...")
    asyncio.create_task(telemetry_background_task())


def main():
    port = CONFIG.get("http_port", 8080)
    ws_port = CONFIG.get("ws_port", 8080)

    # Create app with logging middleware
    app = web.Application(middlewares=[logging_middleware])
    app.router.add_get('/', index_handler)
    app.router.add_get('/{filename}', static_handler)
    app.router.add_get('/ws', websocket_handler)
    app.router.add_get('/debug', debug_handler)

    app.on_startup.append(on_startup)

    logger.info(f"Starting GT7 Dashboard Server on port {port}...")
    logger.info(f"HTTP: http://0.0.0.0:{port}")
    logger.info(f"WebSocket: ws://0.0.0.0:{port}/ws")
    print(f"Starting GT7 Dashboard Server on port {port}...")
    print(f"HTTP: http://0.0.0.0:{port}")
    print(f"WebSocket: ws://0.0.0.0:{port}/ws")

    web.run_app(app, host='0.0.0.0', port=port)


if __name__ == "__main__":
    main()
