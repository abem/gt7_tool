import asyncio
import json
import os
import ssl
import logging
import aiohttp
from datetime import datetime
from aiohttp import web
from telemetry import GT7TelemetryClient
from decoder import GT7Decoder, CourseEstimator

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

# 物理計算・燃料計算で使う定数
KMH_TO_MS = 3.6
GRAVITY_MS2 = 9.81
MAX_ACCEL_G = 5.0
MIN_TIME_DELTA = 0.001
REFUEL_JUMP_FRACTION = 0.5

# ネットワーク/設定のデフォルト値
DEFAULT_SEND_PORT = 33739
DEFAULT_RECEIVE_PORT = 33740
DEFAULT_HTTP_PORT = 8080
DEFAULT_HEARTBEAT_INTERVAL = 10


def _int_env(name, default):
    """環境変数を整数で取得。未設定・空・非整数なら default を返す(後方互換)。"""
    value = os.getenv(name)
    if value is None or value == "":
        return default
    try:
        return int(value)
    except ValueError:
        logger.warning(f"Invalid integer for {name}={value!r}; using default {default}")
        return default


def load_config():
    """config.json を読み、環境変数があれば上書きする(env 優先・config.json フォールバック)。

    .env / docker-compose の環境変数で PS5_IP と各ポートを一元管理できる。
    env 未設定の項目は config.json(無ければ defaults)の値を使う。
    """
    defaults = {
        "ps5_ip": "192.168.1.100",
        "send_port": DEFAULT_SEND_PORT,
        "receive_port": DEFAULT_RECEIVE_PORT,
        "http_port": DEFAULT_HTTP_PORT,
        "heartbeat_interval": DEFAULT_HEARTBEAT_INTERVAL,
        "ssl_cert": "ssl/server-cert.pem",
        "ssl_key": "ssl/server-key.pem"
    }
    try:
        with open('config.json', 'r') as f:
            cfg = json.load(f)
    except FileNotFoundError:
        logger.warning("config.json not found, using defaults")
        cfg = defaults
    except json.JSONDecodeError as e:
        logger.error(f"Invalid JSON in config.json: {e}, using defaults")
        cfg = defaults

    if os.getenv("PS5_IP"):
        cfg["ps5_ip"] = os.getenv("PS5_IP")
    cfg["send_port"] = _int_env("SEND_PORT", cfg.get("send_port", DEFAULT_SEND_PORT))
    cfg["receive_port"] = _int_env("RECEIVE_PORT", cfg.get("receive_port", DEFAULT_RECEIVE_PORT))
    cfg["http_port"] = _int_env("HTTP_PORT", cfg.get("http_port", DEFAULT_HTTP_PORT))
    cfg["heartbeat_interval"] = _int_env("HEARTBEAT_INTERVAL", cfg.get("heartbeat_interval", DEFAULT_HEARTBEAT_INTERVAL))
    return cfg


CONFIG = load_config()

# アプリケーション状態: 接続中のWebSocketクライアント一覧
websocket_clients = set()

# アプリケーション状態: テレメトリ監視タスク（on_cleanup でキャンセルするため保持）
_telemetry_supervisor_task = None

LOG_DIR = "gt7data"


def ensure_log_dir():
    if not os.path.exists(LOG_DIR):
        os.makedirs(LOG_DIR)
        logger.info(f"Created log directory: {LOG_DIR}")


def save_lap_to_file(lap_data, lap_num):
    timestamp = datetime.now().strftime("%Y-%m-%d_%H_%M_%S")
    car_id = lap_data[0].get("car_id", 0) if lap_data else 0
    filename = f"{LOG_DIR}/{timestamp}_CAR-{car_id}_Lap-{lap_num}.json"
    try:
        with open(filename, 'w') as f:
            json.dump(lap_data, f)
        logger.info(f"Saved lap data: {filename} ({len(lap_data)} samples)")
    except Exception as e:
        logger.error(f"Error saving lap data: {e}", exc_info=True)


def calculate_acceleration(speed_kmh, last_speed_kmh, time_delta):
    """速度差分から加速G/減速Gを計算"""
    if time_delta <= MIN_TIME_DELTA:
        return 0.0, 0.0

    speed_delta_ms = (speed_kmh - last_speed_kmh) / KMH_TO_MS
    accel_g = max(-MAX_ACCEL_G, min(MAX_ACCEL_G, speed_delta_ms / time_delta / GRAVITY_MS2))

    if accel_g > 0:
        return accel_g, 0.0
    else:
        return 0.0, abs(accel_g)


class FuelTracker:
    """燃料消費の追跡"""

    def __init__(self):
        self.last_fuel = None
        self.total_consumed = 0.0
        self.laps_at_refuel = 0

    def update(self, current_fuel, fuel_capacity, current_lap):
        """燃料データを更新し、計算結果を返す"""
        result = {}

        if current_fuel is None or fuel_capacity <= 0:
            self.last_fuel = current_fuel
            return result

        fuel_consumed = 0.0
        if self.last_fuel is not None:
            fuel_consumed = self.last_fuel - current_fuel
            if fuel_consumed > 0:
                self.total_consumed += fuel_consumed
            # 給油検出（燃料が急増した場合）
            if fuel_consumed < -(fuel_capacity * REFUEL_JUMP_FRACTION):
                self.total_consumed = 0.0
                self.laps_at_refuel = current_lap

        laps_since_refuel = current_lap - self.laps_at_refuel
        fuel_per_lap = self.total_consumed / laps_since_refuel if laps_since_refuel > 0 else 0

        result["fuel_consumed"] = round(fuel_consumed, 2)
        result["fuel_per_lap"] = round(fuel_per_lap, 2)
        result["laps_since_refuel"] = laps_since_refuel
        result["fuel_laps_remaining"] = round(current_fuel / fuel_per_lap, 1) if fuel_per_lap > 0 else 0

        self.last_fuel = current_fuel
        return result


async def broadcast_to_clients(message):
    """WebSocketクライアントにメッセージを配信"""
    if not websocket_clients:
        return

    disconnected = set()
    for ws in websocket_clients:
        try:
            await ws.send_str(message)
        except Exception:
            disconnected.add(ws)

    if disconnected:
        websocket_clients.difference_update(disconnected)
        logger.info(f"Removed {len(disconnected)} disconnected client(s). Active: {len(websocket_clients)}")


async def _heartbeat_loop(client):
    """ハートビート送信を独立周期で回すタスク。

    受信ループから分離することで、パケット未着時でも定期送信を維持し、
    かつ受信処理がハートビート間隔に引きずられないようにする。
    """
    interval = client.heartbeat_interval
    try:
        while True:
            await client.send_heartbeat()
            await asyncio.sleep(interval)
    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.error(f"Heartbeat loop error: {e}", exc_info=True)


async def telemetry_background_task():
    """バックグラウンドでGT7からのテレメトリデータを受信し続けるタスク。

    受信は asyncio.DatagramProtocol ベースの await client.receive() で待機する。
    旧実装の asyncio.sleep(0.01) ポーリングは廃止し、パケット到着時のみ処理する。
    ハートビートは _heartbeat_loop に独立タスク化して受信ループから分離。
    """
    client = GT7TelemetryClient(
        CONFIG["ps5_ip"],
        CONFIG.get("send_port", DEFAULT_SEND_PORT),
        CONFIG.get("receive_port", DEFAULT_RECEIVE_PORT),
        CONFIG["heartbeat_interval"]
    )
    decoder = GT7Decoder()
    course_estimator = CourseEstimator()
    fuel_tracker = FuelTracker()

    ensure_log_dir()
    logger.info(f"Logging enabled. Data will be saved to: {os.path.abspath(LOG_DIR)}/")

    last_package_id = 0
    last_speed_kmh = 0.0
    last_time = datetime.now()
    current_lap_data = []
    current_lap_number = 0

    await client.connect()  # UDP エンドポイント作成（イベントループ上で必要）

    # ハートビート送信を独立タスクで駆動
    heartbeat_task = asyncio.create_task(_heartbeat_loop(client))

    try:
        while True:
            # パケット到着までイベントループを阻塞せずに待機。
            # 旧 settimeout(1.0) 相当の生存確認は heartbeat_task が担うため不要。
            raw_data = await client.receive()

            if raw_data:
                decrypted = decoder.decrypt(raw_data)
                if decrypted:
                    parsed = decoder.parse(decrypted)
                    if parsed and parsed.get("package_id", 0) > last_package_id:
                        last_package_id = parsed["package_id"]

                        current_time = datetime.now()
                        parsed["timestamp"] = current_time.isoformat()

                        # 加速度計算
                        time_delta = (current_time - last_time).total_seconds()
                        accel_g, decel_g = calculate_acceleration(
                            parsed["speed_kmh"], last_speed_kmh, time_delta
                        )
                        parsed["accel_g"] = accel_g
                        parsed["accel_decel"] = decel_g
                        last_speed_kmh = parsed["speed_kmh"]
                        last_time = current_time

                        # コース推定
                        course_info = course_estimator.estimate_course(
                            parsed.get("position_x", 0),
                            parsed.get("position_z", 0)
                        )
                        parsed["course"] = course_info

                        # 燃料計算
                        fuel_data = fuel_tracker.update(
                            parsed.get("current_fuel"),
                            parsed.get("fuel_capacity", 100),
                            current_lap_number
                        )
                        parsed.update(fuel_data)

                        # ラップデータ蓄積・保存（lap_count変化検知）
                        lap_count = parsed.get("lap_count", 1)
                        current_lap_data.append(parsed)

                        # ラップ境界検出：lap_countが変化したら保存
                        if lap_count > current_lap_number and current_lap_number > 0:
                            save_lap_to_file(current_lap_data, current_lap_number)
                            current_lap_data = []
                        current_lap_number = lap_count

                        # WebSocket配信
                        await broadcast_to_clients(json.dumps(parsed))

    except Exception as e:
        logger.error(f"Telemetry task error: {e}", exc_info=True)
    finally:
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass
        if current_lap_data:
            save_lap_to_file(current_lap_data, current_lap_number)
        client.close()


async def websocket_handler(request):
    """WebSocket接続を処理"""
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    logger.info(f"WebSocket client connected. Total: {len(websocket_clients) + 1}")
    websocket_clients.add(ws)

    try:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.ERROR:
                logger.warning(f"WebSocket error: {ws.exception()}")
                break
    except Exception as e:
        logger.error(f"WebSocket handler error: {e}", exc_info=True)
    finally:
        websocket_clients.discard(ws)
        logger.info(f"WebSocket client disconnected. Remaining: {len(websocket_clients)}")

    return ws


async def index_handler(request):
    """メインダッシュボードを配信"""
    # no-cache: ブラウザは ETag で必ず再検証する（デプロイ後に古い JS/HTML を掴み続けるのを防ぐ）
    return web.FileResponse('index.html', headers={'Cache-Control': 'no-cache'})


async def static_handler(request):
    """静的ファイル（CSS, JS等）を配信"""
    filename = request.match_info['filename']

    if filename == 'favicon.ico':
        return web.Response(status=204)

    # パストラバーサル防止
    if '..' in filename or filename.startswith('/'):
        return web.Response(status=403, text="Forbidden")

    # node_modules配下のファイルも許可
    filepath = filename
    
    if not os.path.isfile(filepath):
        return web.Response(status=404, text="File not found")

    # no-cache: ブラウザは ETag で必ず再検証する（デプロイ後に古い JS/CSS を掴み続けるのを防ぐ）
    return web.FileResponse(filepath, headers={'Cache-Control': 'no-cache'})


@web.middleware
async def logging_middleware(request, handler):
    start_time = datetime.now()
    try:
        response = await handler(request)
        duration = (datetime.now() - start_time).total_seconds()
        logger.info(f"{request.method} {request.path} -> {response.status} ({duration:.3f}s)")
        return response
    except web.HTTPException as e:
        duration = (datetime.now() - start_time).total_seconds()
        logger.warning(f"{request.method} {request.path} -> {e.status} ({duration:.3f}s)")
        raise
    except Exception as e:
        duration = (datetime.now() - start_time).total_seconds()
        logger.error(f"{request.method} {request.path} -> ERROR ({duration:.3f}s): {e}", exc_info=True)
        raise


async def telemetry_supervisor():
    """telemetry_background_task を監視し、異常終了時に再起動する安全網。

    従来構造では telemetry_background_task が例外で終了するとテレメトリ受信が
    完全に停止し、かつそれに気づく手段がなかった（asyncio.create_task は一度きり）。
    本関数はタスク終了を検知し、バックオフ付きで再起動する。

    再起動ポリシー:
      - 連続失敗が続く場合は指数バックオフ（最大60秒）で再試行
      - CancelledError は再起動せずそのまま終了（シャットダウン時）
    """
    backoff = 1.0
    max_backoff = 60.0
    while True:
        task = asyncio.create_task(telemetry_background_task())
        try:
            await task
        except asyncio.CancelledError:
            # サーバーシャットダウン等の正常キャンセル → 再起動しない
            logger.info("Telemetry task cancelled, supervisor exiting.")
            raise
        except Exception:
            # telemetry_background_task 内で catch されなかった例外（通常は catch 済みで
            # タスクは正常終了するが、念のためここでも捕捉）
            logger.exception(
                f"Telemetry task crashed, restarting in {backoff:.0f}s..."
            )
        else:
            # 正常終了（finally まで到達）した場合も再起動
            logger.warning(
                f"Telemetry task ended unexpectedly, restarting in {backoff:.0f}s..."
            )

        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, max_backoff)


async def on_startup(app):
    """アプリ起動時にテレメトリ監視タスクを開始する。

    生成した supervisor タスクは _telemetry_supervisor_task に保持し、
    on_cleanup で明示的にキャンセル・待機してクリーンに終了させる。
    """
    global _telemetry_supervisor_task
    logger.info("Starting telemetry background task (supervised)...")
    _telemetry_supervisor_task = asyncio.create_task(telemetry_supervisor())


async def on_cleanup(app):
    """アプリ終了時にテレメトリ監視タスクをキャンセルしてクリーンアップする。

    telemetry_supervisor は CancelledError を「正常なシャットダウン」として扱い、
    そのまま終了する設計。本フックがそのキャンセルを発火する唯一の経路。
    プロセス終了時の asyncio の暗黙タスク破棄に頼らない明示的な終了処理。
    """
    global _telemetry_supervisor_task
    if _telemetry_supervisor_task is not None and not _telemetry_supervisor_task.done():
        _telemetry_supervisor_task.cancel()
        try:
            await _telemetry_supervisor_task
        except asyncio.CancelledError:
            pass
        logger.info("Telemetry supervisor shut down.")
    _telemetry_supervisor_task = None


def build_ssl_context():
    """設定された証明書/鍵が存在すればSSLコンテキストを構築する。無ければNone（平文HTTP）。"""
    cert = CONFIG.get("ssl_cert")
    key = CONFIG.get("ssl_key")
    if not cert or not key:
        return None
    if not (os.path.isfile(cert) and os.path.isfile(key)):
        logger.warning(f"SSL cert/key not found (cert={cert}, key={key}); falling back to HTTP")
        return None
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    return ctx


def main():
    port = CONFIG.get("http_port", 8080)
    ssl_context = build_ssl_context()
    scheme = "https" if ssl_context else "http"
    ws_scheme = "wss" if ssl_context else "ws"

    app = web.Application(middlewares=[logging_middleware])
    app.router.add_get('/', index_handler)
    app.router.add_get('/ws', websocket_handler)
    app.router.add_get('/{filename:.*}', static_handler)

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    logger.info(f"Starting GT7 Dashboard Server on port {port}...")
    logger.info(f"{scheme.upper()}: {scheme}://0.0.0.0:{port}")
    logger.info(f"WebSocket: {ws_scheme}://0.0.0.0:{port}/ws")

    web.run_app(app, host='0.0.0.0', port=port, ssl_context=ssl_context)


if __name__ == "__main__":
    main()
