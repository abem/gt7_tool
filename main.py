import asyncio
import json
import os
import logging
import aiohttp
from datetime import datetime
from aiohttp import web
from telemetry import GT7TelemetryClient
from decoder import GT7Decoder

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)


def load_config():
    defaults = {
        "ps5_ip": "192.168.1.100",
        "send_port": 33739,
        "receive_port": 33740,
        "http_port": 18080,
        "heartbeat_interval": 10
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
    return cfg


CONFIG = load_config()

# アプリケーション状態: 接続中のWebSocketクライアント一覧
websocket_clients = set()

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
    if time_delta <= 0.001:
        return 0.0, 0.0

    speed_delta_ms = (speed_kmh - last_speed_kmh) / 3.6
    accel_g = max(-5.0, min(5.0, speed_delta_ms / time_delta / 9.81))

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
            if fuel_consumed < -(fuel_capacity * 0.5):
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


async def telemetry_background_task():
    """バックグラウンドでGT7からのテレメトリデータを受信し続けるタスク"""
    client = GT7TelemetryClient(
        CONFIG["ps5_ip"],
        CONFIG.get("send_port", 33739),
        CONFIG.get("receive_port", 33740),
        CONFIG["heartbeat_interval"]
    )
    decoder = GT7Decoder()
    fuel_tracker = FuelTracker()

    ensure_log_dir()
    logger.info(f"Logging enabled. Data will be saved to: {os.path.abspath(LOG_DIR)}/")

    last_package_id = 0
    last_speed_kmh = 0.0
    last_time = datetime.now()
    current_lap_data = []
    current_lap_number = 0

    try:
        while True:
            client.send_heartbeat()
            raw_data = client.receive()

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

                        # 燃料計算
                        fuel_data = fuel_tracker.update(
                            parsed.get("current_fuel"),
                            parsed.get("fuel_capacity", 100),
                            current_lap_number
                        )
                        parsed.update(fuel_data)

                        # ラップデータ蓄積・保存
                        current_lap_data.append(parsed)
                        # 固定サンプル数トリガー（lap_count変化検知ではない）
                        if len(current_lap_data) >= 1800:
                            save_lap_to_file(current_lap_data, current_lap_number)
                            current_lap_data = []
                            current_lap_number += 1

                        # WebSocket配信
                        await broadcast_to_clients(json.dumps(parsed))

            await asyncio.sleep(0.01)

    except Exception as e:
        logger.error(f"Telemetry task error: {e}", exc_info=True)
    finally:
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
    return web.FileResponse('index.html')


async def static_handler(request):
    """静的ファイル（CSS, JS等）を配信"""
    filename = request.match_info['filename']

    # パストラバーサル防止
    if '..' in filename or filename.startswith('/'):
        return web.Response(status=403, text="Forbidden")

    if not os.path.isfile(filename):
        return web.Response(status=404, text="File not found")

    return web.FileResponse(filename)


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


async def on_startup(app):
    logger.info("Starting telemetry background task...")
    asyncio.create_task(telemetry_background_task())


def main():
    port = CONFIG.get("http_port", 8080)

    app = web.Application(middlewares=[logging_middleware])
    app.router.add_get('/', index_handler)
    app.router.add_get('/ws', websocket_handler)
    app.router.add_get('/{filename}', static_handler)

    app.on_startup.append(on_startup)

    logger.info(f"Starting GT7 Dashboard Server on port {port}...")
    logger.info(f"HTTP: http://0.0.0.0:{port}")
    logger.info(f"WebSocket: ws://0.0.0.0:{port}/ws")

    web.run_app(app, host='0.0.0.0', port=port)


if __name__ == "__main__":
    main()
