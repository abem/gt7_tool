import asyncio
import csv
import io
import json
import os
import re
import ssl
import logging
import time
import aiohttp
import joblib
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

# 配信専用キュー(#434 P1-b): telemetry_background_taskの受信ループから配信I/O
# (broadcast_to_clients、低速/無応答クライアントで最大1秒/クライアントの遅延あり)を
# 分離するためのバッファ。telemetry.py側の受信キュー(#434 P1予備調査(b)で確認済み)と
# 同じ「最新優先」ポリシー(満杯時は最古を破棄して最新を積む)を踏襲する。
BROADCAST_QUEUE_MAXSIZE = 16
broadcast_queue = asyncio.Queue(maxsize=BROADCAST_QUEUE_MAXSIZE)

# アプリケーション状態: テレメトリ監視タスク（on_cleanup でキャンセルするため保持）
_telemetry_supervisor_task = None

LOG_DIR = "gt7data"

# インポートしたラップの保存先(#177/#178)。実記録データ(LOG_DIR)とは物理的に
# 完全分離する(実データへの意図しない混入防止)。
IMPORT_LOG_DIR = "gt7data_imported"

# CSVインポートのアップロードサイズ上限(#178)。実測エクスポート比率
# (169.6MB JSON→74MB CSV、#175検証)を踏まえ、実測最大級ラップの全件CSVでも
# 収まるよう100MBを上限としたDoS対策(具体的な悪用防止のための上限値)。
IMPORT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024

# 保存失敗時の退避先(#434 P1)。実データ(LOG_DIR)とは物理的に分離し、再試行後も
# なお書込みに失敗したラップをここへ退避する。ファイル名にLAP_FILE_REと一致しない
# 接尾辞を付けるため、/api/laps一覧走査(_scan_lap_files)には混入しない。
LOG_DIR_FAILED = "gt7data_failed"

# 進行中ラップの周期チェックポイント保存先・間隔(#434 P1)。固定ファイル名1本を
# 上書きすることで、SIGKILL/OOM等でfinally節を経ずに終了した場合の未保存データを
# 一定間隔ごとに縮小する。ファイル名はLAP_FILE_REと一致しない固定名のため
# /api/laps一覧走査には現れない。
CHECKPOINT_FILE = f"{LOG_DIR}/.checkpoint_current_lap.json"
CHECKPOINT_INTERVAL_SEC = 5.0

# save_lap_to_file の書込み失敗時リトライ回数・待機秒数(#434 P1)。
SAVE_RETRY_COUNT = 3
SAVE_RETRY_DELAY_SEC = 0.5

# コース推定ロックインの多数決window件数(#436 B4フォローアップ)。約60Hzで167ms相当。
COURSE_LOCK_VOTE_WINDOW = 10


def ensure_log_dir():
    if not os.path.exists(LOG_DIR):
        os.makedirs(LOG_DIR)
        logger.info(f"Created log directory: {LOG_DIR}")


def save_lap_to_file(lap_data, lap_num):
    # 記録ON/OFF(P1 B案 #124): config.json の recording_enabled (既定 true=従来どおり)。
    # 入口の1分岐のみで、受信・復号・WS配信(ライブ表示)には影響しない。
    if not CONFIG.get("recording_enabled", True):
        return
    timestamp = datetime.now().strftime("%Y-%m-%d_%H_%M_%S")
    car_id = lap_data[0].get("car_id", 0) if lap_data else 0
    filename = f"{LOG_DIR}/{timestamp}_CAR-{car_id}_Lap-{lap_num}.json"

    # 書込み失敗時の再試行(#434 P1): 一時的なI/Oエラーの自己解消を想定し、
    # 短い待機を挟んで規定回数まで再試行してから退避処理へ進む。
    last_error = None
    for attempt in range(1, SAVE_RETRY_COUNT + 1):
        try:
            with open(filename, 'w') as f:
                json.dump(lap_data, f)
            logger.info(f"Saved lap data: {filename} ({len(lap_data)} samples)")
            return
        except Exception as e:
            last_error = e
            logger.warning(
                f"Save attempt {attempt}/{SAVE_RETRY_COUNT} failed for {filename}: {e}"
            )
            if attempt < SAVE_RETRY_COUNT:
                time.sleep(SAVE_RETRY_DELAY_SEC)

    # 全リトライ失敗 → 退避ディレクトリへ(#434 P1)。実データ(LOG_DIR)とは物理分離し、
    # 単純破棄していた旧挙動から変更する。
    try:
        os.makedirs(LOG_DIR_FAILED, exist_ok=True)
        failed_filename = f"{LOG_DIR_FAILED}/{timestamp}_CAR-{car_id}_Lap-{lap_num}_failed.json"
        with open(failed_filename, 'w') as f:
            json.dump(lap_data, f)
        logger.error(
            f"Saved lap data to fallback after {SAVE_RETRY_COUNT} failed attempts: "
            f"{failed_filename} ({len(lap_data)} samples). Last error: {last_error}"
        )
    except Exception as e:
        logger.error(
            f"Lap data LOST: primary and fallback save both failed for lap {lap_num} "
            f"(car_id={car_id}, {len(lap_data)} samples). "
            f"primary_error={last_error} fallback_error={e}",
            exc_info=True
        )


def _save_checkpoint(lap_data, lap_num):
    """進行中ラップの周期チェックポイントを固定ファイルへ上書き保存する(#434 P1)。

    ラップ境界保存(save_lap_to_file)とは独立した安全網であり、失敗しても
    ロギングのみ行い次回間隔で再試行する(例外を上位へ伝播させない)。
    """
    if not lap_data:
        return
    try:
        with open(CHECKPOINT_FILE, 'w') as f:
            json.dump({"lap_num": lap_num, "samples": lap_data}, f)
    except Exception as e:
        logger.warning(f"Checkpoint save failed: {e}")


def _clear_checkpoint():
    """チェックポイントファイルを削除する(#434 P1)。

    ラップ境界での正規保存成功時・正常シャットダウン時に呼び、既に完全保存済み
    ラップの残骸をチェックポイントとして誤認しないようにする。
    """
    try:
        if os.path.exists(CHECKPOINT_FILE):
            os.remove(CHECKPOINT_FILE)
    except Exception as e:
        logger.warning(f"Checkpoint clear failed: {e}")


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
    # list() スナップショット: 送信の await 中に websocket_handler が
    # websocket_clients を変更しても RuntimeError にならないようにする
    for ws in list(websocket_clients):
        try:
            # タイムアウト付き送信: 1クライアントの停滞が全体の配信を止めるのを防ぐ。
            # タイムアウトしたクライアントは切断扱いにして close を試みる。
            await asyncio.wait_for(ws.send_str(message), timeout=1.0)
        except asyncio.TimeoutError:
            disconnected.add(ws)
            try:
                await asyncio.wait_for(ws.close(), timeout=1.0)
            except Exception:
                pass
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
    # try は while の内側に置く: 想定外例外でこのループ自体が死ぬと GT7 が
    # テレメトリ送信を止め、恒久的なサイレント停止になるため、
    # 例外はログして interval 秒後に再試行し続ける（CancelledError のみ終了）。
    while True:
        try:
            await client.send_heartbeat()
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Heartbeat loop error: {e}; retrying in {interval}s", exc_info=True)
            await asyncio.sleep(interval)


async def broadcast_consumer_task():
    """配信キューを消費しWebSocketクライアントへ配信する専用タスク(#434 P1-b)。

    telemetry_background_taskの受信ループから配信I/O(broadcast_to_clients)を
    切り離すことで、低速/無応答クライアントによる配信遅延が受信ループ
    (→telemetry.py内部キューの溢れ)へ波及しないようにする。
    """
    while True:
        message = await broadcast_queue.get()
        try:
            await broadcast_to_clients(message)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error(f"Broadcast consumer error: {e}", exc_info=True)


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
    # コース推定ロックイン(#436 B4フォローアップ): course_estimator.estimate_course()
    # 自体(bounds面積最小選択)は無改変。course_database.jsonの特定コースペアの
    # バウンディングボックス重複により、1ラップ中に生の推定値が頻繁に入れ替わる
    # 不安定性が判明した(析の全数調査)ため、ラップ開始からCOURSE_LOCK_VOTE_WINDOW件の
    # 生推定値を多数決し、以後そのラップ中は確定値に凍結する。lap_count変化(増減とも)で
    # リセットする(析調査で実績のある「先頭サンプル=100%内部一貫」のラップ単位の粒度を踏襲)。
    course_lock_id = None       # 確定済みcourse_id(未確定はNone)
    course_lock_result = None   # 確定済みcourse dict(id/name/name_en/name_ja/confidence/verified/source)
    course_vote_counts = {}     # id -> 出現回数(投票window中のみ)
    course_vote_samples = {}    # id -> そのidを得た最初のcourse dict(確定時の代表値)
    course_vote_count = 0       # 投票windowに入れた生サンプル数
    # パケットロス計測(#434 P1): 受理されなかった/破棄されたパケットの累積カウント。
    packet_loss_count = 0
    # 周期的チェックポイント保存(#434 P1): 前回チェックポイントからの経過時間追跡。
    last_checkpoint_time = datetime.now()
    # 配信キュー溢れ計測(#434 P1-b): telemetry.py側のパケットドロップ(packet_loss_count)
    # とは別に、配信側の遅延蓄積(broadcast_queue満杯による最古メッセージ破棄)を計測する。
    broadcast_drop_count = 0

    await client.connect()  # UDP エンドポイント作成（イベントループ上で必要）

    # ハートビート送信を独立タスクで駆動
    heartbeat_task = asyncio.create_task(_heartbeat_loop(client))
    # 配信専用タスクを独立起動(#434 P1-b): 受信ループから配信I/Oを分離する
    broadcast_task = asyncio.create_task(broadcast_consumer_task())

    try:
        while True:
            # パケット到着までイベントループを阻塞せずに待機。
            # 旧 settimeout(1.0) 相当の生存確認は heartbeat_task が担うため不要。
            raw_data = await client.receive()

            if raw_data:
                decrypted = decoder.decrypt(raw_data)
                if not decrypted:
                    # パケットロス計測(#434 P1): 受信したが復号できなかったパケット
                    packet_loss_count += 1
                    continue

                parsed = decoder.parse(decrypted)
                if parsed is None:
                    # パケットロス計測(#434 P1): 復号はできたが解析できなかったパケット
                    packet_loss_count += 1
                    continue

                pid = parsed.get("package_id", 0)
                # 受理条件: 通常は単調増加のみ（重複・順序逆転パケットを除外）。
                # ただしゲーム再起動で package_id が 0 付近にリセットされると
                # 「pid > last_package_id」を二度と満たせず全パケットが弾かれて
                # 無言で固まるため、大幅な後退（1000 超）はリセットとみなして受理する。
                if not (pid > last_package_id or pid < last_package_id - 1000):
                    # パケットロス計測(#434 P1): 受理されなかったパケット
                    # (重複・順序逆転。リセット扱いでもない)
                    packet_loss_count += 1
                    continue

                # パケットロス計測(#434 P1): 単調増加区間で生じた欠番(gap)を損失として
                # 計上する。リセット(大幅後退)直後はgap計算をスキップする(誤検知防止)。
                if last_package_id > 0:
                    gap = pid - last_package_id - 1
                    if gap > 0:
                        packet_loss_count += gap
                last_package_id = pid

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

                # ラップ境界検知(コース推定ロックインの判定にも使うため、lap_count
                # 変化検知より前に前倒しで取得する。値自体は従来どおり)
                lap_count = parsed.get("lap_count", 1)

                # コース推定(#436 B4フォローアップ: ロックイン方式で安定化)
                # estimate_course()自体(bounds面積最小選択)は無改変。ラップ変化
                # (増減とも)でロックをリセットし、開始からCOURSE_LOCK_VOTE_WINDOW件の
                # 生推定値を多数決、以後そのラップ中は確定値に凍結する(析調査で実績の
                # ある「先頭サンプル=100%内部一貫」をラップ単位の粒度で拡張する設計)。
                if lap_count != current_lap_number:
                    course_lock_id = None
                    course_lock_result = None
                    course_vote_counts = {}
                    course_vote_samples = {}
                    course_vote_count = 0

                raw_course = course_estimator.estimate_course(
                    parsed.get("position_x", 0),
                    parsed.get("position_z", 0)
                )
                if course_lock_id is None:
                    cid = raw_course.get("id", "unknown")
                    course_vote_counts[cid] = course_vote_counts.get(cid, 0) + 1
                    course_vote_samples.setdefault(cid, raw_course)
                    course_vote_count += 1
                    if course_vote_count >= COURSE_LOCK_VOTE_WINDOW:
                        course_lock_id = max(course_vote_counts, key=course_vote_counts.get)
                        course_lock_result = course_vote_samples[course_lock_id]
                    parsed["course"] = raw_course
                else:
                    parsed["course"] = course_lock_result

                # 燃料計算
                fuel_data = fuel_tracker.update(
                    parsed.get("current_fuel"),
                    parsed.get("fuel_capacity", 100),
                    current_lap_number
                )
                parsed.update(fuel_data)

                # ラップデータ蓄積・保存（lap_count変化検知）
                current_lap_data.append(parsed)

                # 周期的チェックポイント保存(#434 P1): ラップ境界を待たず一定間隔で
                # current_lap_data を中間保存する。SIGKILL/OOM等でfinally節を経ずに
                # 終了した場合の未保存データを縮小する安全網。既存のラップ保存と同じく
                # ワーカースレッドへオフロードし、受信ループ(イベントループ)を塞がない。
                if (current_time - last_checkpoint_time).total_seconds() >= CHECKPOINT_INTERVAL_SEC:
                    await asyncio.to_thread(_save_checkpoint, current_lap_data, current_lap_number)
                    if packet_loss_count > 0:
                        logger.warning(f"Packet loss count (cumulative): {packet_loss_count}")
                    if broadcast_drop_count > 0:
                        # 配信キュー溢れ計測(#434 P1-b): packet_loss_countとは別指標として明示
                        logger.warning(f"Broadcast queue full, dropped (cumulative): {broadcast_drop_count}")
                    last_checkpoint_time = current_time

                # ラップ境界検出：lap_countが変化したら保存
                # 同期 json 書込はイベントループを数百ms塞ぐためワーカースレッドへ。
                # 旧リストは保存スレッドに渡し切り、以後はここで新リストへ差し替えるので
                # 書込み中のリストが変更されることはない。
                if lap_count > current_lap_number and current_lap_number > 0:
                    await asyncio.to_thread(save_lap_to_file, current_lap_data, current_lap_number)
                    await asyncio.to_thread(_clear_checkpoint)
                    current_lap_data = []
                    last_checkpoint_time = current_time
                current_lap_number = lap_count

                # WebSocket配信(#434 P1-b): 受信ループを配信I/Oから切り離すため、
                # 直接awaitせず非ブロッキングでbroadcast_queueへ積む。実際の送信は
                # broadcast_consumer_taskが独立して行う。満杯時は最古を破棄して
                # 最新を積む(telemetry.py:50-55と同じ「最新優先」ポリシー)。
                message = json.dumps(parsed)
                try:
                    broadcast_queue.put_nowait(message)
                except asyncio.QueueFull:
                    try:
                        broadcast_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                    broadcast_drop_count += 1
                    try:
                        broadcast_queue.put_nowait(message)
                    except asyncio.QueueFull:
                        pass

    except Exception as e:
        logger.error(f"Telemetry task error: {e}", exc_info=True)
    finally:
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass
        broadcast_task.cancel()
        try:
            await broadcast_task
        except asyncio.CancelledError:
            pass
        if current_lap_data:
            save_lap_to_file(current_lap_data, current_lap_number)
            _clear_checkpoint()
        client.close()


# バーチャルピットウォール(#434 P4): エンジニア役からのメッセージ本文の長さ上限。
MAX_ENGINEER_MESSAGE_LEN = 200
# 既知のseverity値(未知値はnoticeへフォールバック)。既存の.engineer-alert CSS分類
# (styles.css、good/warning/serious/critical)と、通常の指示メッセージ用に新設した
# noticeで揃える(フロント側のクラス名と1対1対応させ、表示側で追加の変換をしない)。
ENGINEER_MESSAGE_SEVERITIES = frozenset(("notice", "good", "warning", "serious", "critical"))

# ドライバーレスポンスタップボタン(#436 T2): DRIVE view上のタップボタンから送る
# 許可された応答値(#436原文の例に準拠、3種固定)。
DRIVER_RESPONSE_VALUES = frozenset(("OK", "COPY", "RE-PLAN"))


async def websocket_handler(request):
    """WebSocket接続を処理"""
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    logger.info(f"WebSocket client connected. Total: {len(websocket_clients) + 1}")
    websocket_clients.add(ws)

    try:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                # バーチャルピットウォール(#434 P4 / #436 T2): エンジニア↔ドライバーの
                # メッセージ受信。テレメトリ配信(broadcast_queue、P1-b)とは別経路で
                # 直接配信する(低頻度・欠落厳禁のため、高頻度テレメトリ向けの
                # 「最新優先」破棄ポリシーを持つbroadcast_queueは経由しない)。
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue
                if not isinstance(data, dict):
                    continue
                msg_type = data.get("type")
                if msg_type == "engineer_message":
                    text = str(data.get("text", "")).strip()[:MAX_ENGINEER_MESSAGE_LEN]
                    if not text:
                        continue
                    severity = data.get("severity")
                    if severity not in ENGINEER_MESSAGE_SEVERITIES:
                        severity = "notice"
                    await broadcast_to_clients(json.dumps({
                        "type": "engineer_message",
                        "text": text,
                        "severity": severity,
                    }))
                elif msg_type == "driver_response":
                    # #436 T2: ドライバー→エンジニアの応答(OK/COPY/RE-PLANの3種固定)。
                    response = data.get("response")
                    if response not in DRIVER_RESPONSE_VALUES:
                        continue
                    await broadcast_to_clients(json.dumps({
                        "type": "driver_response",
                        "response": response,
                    }))
            elif msg.type == aiohttp.WSMsgType.ERROR:
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


async def engineer_handler(request):
    """バーチャルピットウォール(#434 P4): エンジニア役端末向けページを配信。

    index_handlerと同じパターン(専用ルートで固定ファイルを返す)。static_handler
    (.js/.css許可リスト方式)は.htmlを配信しない設計のため、engineer.html配信専用の
    ルートをここに新設する(static_handlerの許可リスト自体は変更しない)。
    """
    return web.FileResponse('engineer.html', headers={'Cache-Control': 'no-cache'})


async def static_handler(request):
    """静的ファイル（CSS, JS等）を配信"""
    filename = request.match_info['filename']

    if filename == 'favicon.ico':
        return web.Response(status=204)

    # 意図: リポジトリ直下の UI アセットのみ配信（鍵・設定・ソースの漏えい防止）。
    # 許可リスト方式: パス区切りを含まず、拡張子が .js / .css のものだけを配信し、
    # ssl 秘密鍵・config.json・Python ソース・gt7data 等へのアクセスを遮断する。
    if '/' in filename or not filename.endswith(('.js', '.css')):
        return web.Response(status=404, text="File not found")

    filepath = filename

    if not os.path.isfile(filepath):
        return web.Response(status=404, text="File not found")

    # no-cache: ブラウザは ETag で必ず再検証する（デプロイ後に古い JS/CSS を掴み続けるのを防ぐ）
    return web.FileResponse(filepath, headers={'Cache-Control': 'no-cache'})


# ================================================================
#  過去ラップ読み出しAPI (P1-3 A案)
#
#  ライブ配信(/ws)とは完全に分離した読み取り専用エンドポイント。
#  gt7data/ への書込・削除は一切行わない。仕様は
#  docs/P1詳細計画書_セッションレビューと保存ポリシー_20260716.md §2.1。
# ================================================================

# save_lap_to_file の命名形式に完全一致するファイルのみをAPIの対象にする
# (許可リスト方式: パス区切り・別拡張子・BU等の変則名は正規表現の時点で排除)
LAP_FILE_RE = re.compile(
    r'^(\d{4})-(\d{2})-(\d{2})_(\d{2})_(\d{2})_(\d{2})_CAR-(\d+)_Lap-(\d+)\.json$'
)

# 詳細APIの既定射影: REVIEWビューの距離基準比較に必要な最小フィールド集合
DEFAULT_LAP_FIELDS = (
    "timestamp", "current_laptime", "speed_kmh", "throttle_pct", "brake_pct",
    "position_x", "position_z", "gear", "lap_count", "last_laptime"
)

API_LAPS_LIMIT_DEFAULT = 200
API_LAPS_LIMIT_MAX = 1000
API_LAPS_EVERY_DEFAULT = 6   # 60Hz記録を約10Hzへ間引き
API_LAPS_EVERY_MAX = 60

# CSVエクスポート(#174/#175)の既定射影: 記録済み全フィールド(実サンプルの実測キー一覧に基づく)。
# JSON応答の既定(DEFAULT_LAP_FIELDS、REVIEW距離チャート用の最小集合)とは別に、
# CSVは「表示されていない値も含め外部ツールで独自集計したい」という用途のため全件を既定とする。
CSV_ALL_FIELDS = ("timestamp",) + tuple(sorted((
    "accel_decel", "accel_g", "angular_velocity_x", "angular_velocity_y", "angular_velocity_z",
    "best_laptime", "body_accel_heave", "body_accel_surge", "body_accel_sway", "body_height",
    "boost", "brake", "brake_filtered_pct", "brake_pct", "car_id", "car_max_speed",
    "clutch", "clutch_engagement", "clutch_gearbox_rpm", "course", "current_fuel",
    "current_laptime", "energy_recovery", "flags", "fuel_capacity", "fuel_consumed",
    "fuel_laps_remaining", "fuel_per_lap", "gear", "gear_ratios", "lap_count",
    "laps_since_refuel", "last_laptime", "max_rpm", "num_cars_pre_race", "oil_pressure",
    "orientation", "package_id", "position_x", "position_y", "position_z",
    "pre_race_position", "road_plane_distance", "road_plane_x", "road_plane_y", "road_plane_z",
    "rotation_pitch", "rotation_roll", "rotation_yaw", "rpm", "rpm_alert_min",
    "speed_kmh", "speed_ms", "suggested_gear", "susp_height", "throttle",
    "throttle_filtered_pct", "throttle_pct", "torque_vector", "total_laps",
    "transmission_max_speed", "tyre_radius", "tyre_temp", "velocity_x", "velocity_y",
    "velocity_z", "wheel_rotation", "wheel_rps",
)))

# CSV変換(#174仕様書§2)における配列/辞書フィールドの列展開ルール
CSV_WHEEL_FIELDS = ("tyre_temp", "susp_height", "wheel_rps", "tyre_radius", "torque_vector")
CSV_WHEEL_SUFFIXES = ("fl", "fr", "rl", "rr")
CSV_FLAG_KEYS = (
    "car_on_track", "paused", "loading", "in_gear", "has_turbo", "rev_limiter",
    "hand_brake", "lights", "high_beams", "low_beams", "asm_active", "tcs_active",
)
CSV_COURSE_KEYS = ("id", "name_ja", "name_en", "confidence", "verified", "source")


def _csv_columns(fields):
    """CSV列名一覧を、要求フィールド順を保ちつつ配列/辞書型を展開して生成する(#174仕様書§2)。"""
    columns = []
    for name in fields:
        if name in CSV_WHEEL_FIELDS:
            columns.extend(f"{name}_{suf}" for suf in CSV_WHEEL_SUFFIXES)
        elif name == "gear_ratios":
            columns.extend(f"gear_ratios_{i}" for i in range(1, 9))
        elif name == "flags":
            columns.extend(f"flag_{k}" for k in CSV_FLAG_KEYS)
        elif name == "course":
            columns.extend(f"course_{k}" for k in CSV_COURSE_KEYS)
        else:
            columns.append(name)
    return columns


def _csv_row(sample, fields):
    """1サンプルをCSV列順の値リストへ変換する(欠損時は空文字)。"""
    row = []
    for name in fields:
        v = sample.get(name)
        if name in CSV_WHEEL_FIELDS:
            if isinstance(v, list) and len(v) == 4:
                row.extend(v)
            else:
                row.extend([""] * 4)
        elif name == "gear_ratios":
            if isinstance(v, list):
                vals = (list(v) + [""] * 8)[:8]
                row.extend(vals)
            else:
                row.extend([""] * 8)
        elif name == "flags":
            if isinstance(v, dict):
                row.extend(int(bool(v.get(k))) for k in CSV_FLAG_KEYS)
            else:
                row.extend([""] * len(CSV_FLAG_KEYS))
        elif name == "course":
            if isinstance(v, dict):
                row.extend(v.get(k, "") for k in CSV_COURSE_KEYS)
            else:
                row.extend([""] * len(CSV_COURSE_KEYS))
        else:
            row.append(v if v is not None else "")
    return row


def _samples_to_csv(samples, fields):
    """射影済みサンプル一覧をCSV文字列(UTF-8 BOM付き)へ変換する(#174仕様書§2/§3準拠)。"""
    buf = io.StringIO()
    buf.write('﻿')  # UTF-8 BOM(Excelでの文字化け回避)
    writer = csv.writer(buf)
    columns = _csv_columns(fields)
    writer.writerow(columns)
    for s in samples:
        writer.writerow(_csv_row(s, fields))
    return buf.getvalue()


# FastF1連携(#434 P2)の既定フィールド集合。FastF1のCar Data/Position Data列
# (Speed/RPM/nGear/Throttle/Brake/X/Y/Z/Date/Status/LapNumber/LapTime)に
# 改名・単位変換で対応できるフィールドのみを含む(部分互換方針、予備調査報告§(b)参照)。
# CSV_ALL_FIELDSとは独立(既存format=csvの列構成に影響を与えないため)。
FASTF1_FIELDS = (
    "timestamp", "speed_kmh", "rpm", "gear", "throttle_pct", "brake_pct",
    "position_x", "position_y", "position_z", "flags", "lap_count", "last_laptime",
)

# GT7の position_x/y/z(メートル)をFastF1のX/Y/Z単位(1/10m)へ揃える倍率。
FASTF1_POSITION_UNIT_SCALE = 10

# FastF1列名への対応。座標軸(X/Y/Z)は本ツール側の慣習(position_y=高さ)を
# そのまま踏襲し、F1側の軸慣習との厳密な整合は行わない(予備調査報告の質問事項3、
# 計承認2026-08-02。本Phaseのスコープ外)。
_FASTF1_COLUMN_NAMES = {
    "timestamp": "Date",
    "speed_kmh": "Speed",
    "rpm": "RPM",
    "gear": "nGear",
    "throttle_pct": "Throttle",
    "brake_pct": "Brake",
    "position_x": "X",
    "position_y": "Y",
    "position_z": "Z",
    "flags": "Status",
    "lap_count": "LapNumber",
    "last_laptime": "LapTime",
}


def _fastf1_columns(fields):
    """FastF1列名一覧を、要求フィールド順を保ちつつ生成する(#434 P2)。"""
    return [_FASTF1_COLUMN_NAMES.get(name, name) for name in fields]


def _fastf1_row(sample, fields):
    """1サンプルをFastF1列規約の値リストへ変換する(#434 P2、予備調査報告§(b)の対応表準拠)。

    Brake: 連続値(0-100%)をFastF1のbool規約(0%超=True)へ変換(情報量は落ちる、部分互換)。
    X/Y/Z: メートル→1/10m単位へ換算。
    Status: flags.car_on_track(bool)をOnTrack/OffTrack文字列へ変換。
    """
    row = []
    for name in fields:
        v = sample.get(name)
        if name == "brake_pct":
            row.append("True" if (v or 0) > 0 else "False")
        elif name in ("position_x", "position_y", "position_z"):
            row.append(v * FASTF1_POSITION_UNIT_SCALE if isinstance(v, (int, float)) else "")
        elif name == "flags":
            row.append("OnTrack" if isinstance(v, dict) and v.get("car_on_track") else "OffTrack")
        else:
            row.append(v if v is not None else "")
    return row


def _samples_to_fastf1_csv(samples, fields):
    """射影済みサンプル一覧をFastF1互換CSV文字列(UTF-8 BOM付き)へ変換する(#434 P2)。"""
    buf = io.StringIO()
    buf.write('﻿')  # UTF-8 BOM(Excelでの文字化け回避)
    writer = csv.writer(buf)
    writer.writerow(_fastf1_columns(fields))
    for s in samples:
        writer.writerow(_fastf1_row(s, fields))
    return buf.getvalue()


# _csv_row では素通し(str(v))される整数フィールド。CSVからの逆変換時、これらは
# decoder.py上の型(int)を保つため float() ではなく int(float()) で復元する
# (car_id/lap_count等はファイル名導出・#177調査報告§2にも使うため型の正確性が必要)。
_CSV_INT_FIELDS = frozenset((
    "gear", "suggested_gear", "throttle", "brake", "rpm_alert_min", "max_rpm",
    "car_max_speed", "package_id", "lap_count", "total_laps", "best_laptime",
    "last_laptime", "current_laptime", "pre_race_position", "num_cars_pre_race",
    "car_id", "laps_since_refuel",
))


def _valid_csv_columns():
    """本ツールがエクスポートし得る全CSV列名の集合(アップロードのヘッダ検証用、#178)。"""
    return set(_csv_columns(CSV_ALL_FIELDS))


def _csv_num(v):
    """CSV文字列値をfloatへ変換する(空文字は欠損としてNone)。"""
    if v is None or v == "":
        return None
    return float(v)


def _csv_row_to_sample(row):
    """CSVの1行(列名→文字列値の辞書、csv.DictReader形式)を、_csv_row/_csv_columns の
    変換規則を反転してサンプル辞書へ復元する(#178)。値の型変換に失敗した場合は
    ValueError/TypeErrorがそのまま伝播し、呼び出し元(_parse_and_convert_csv)で
    ファイル全体の拒否につながる(部分取込は行わない、#177調査報告§4)。
    """
    sample = {}
    consumed = set()

    for name in CSV_WHEEL_FIELDS:
        cols = [f"{name}_{suf}" for suf in CSV_WHEEL_SUFFIXES]
        if all(c in row for c in cols):
            sample[name] = [_csv_num(row[c]) for c in cols]
            consumed.update(cols)

    gear_cols = [f"gear_ratios_{i}" for i in range(1, 9)]
    if all(c in row for c in gear_cols):
        sample["gear_ratios"] = [_csv_num(row[c]) for c in gear_cols]
        consumed.update(gear_cols)

    flag_cols = {k: f"flag_{k}" for k in CSV_FLAG_KEYS}
    if all(c in row for c in flag_cols.values()):
        sample["flags"] = {k: row[col] not in ("", "0") for k, col in flag_cols.items()}
        consumed.update(flag_cols.values())

    course_cols = {k: f"course_{k}" for k in CSV_COURSE_KEYS}
    if all(c in row for c in course_cols.values()):
        course = {}
        for k, col in course_cols.items():
            v = row[col]
            if k == "confidence":
                course[k] = _csv_num(v)
            elif k == "verified":
                course[k] = v not in ("", "0", "False", "false")
            else:
                course[k] = v
        sample["course"] = course
        consumed.update(course_cols.values())

    for col, v in row.items():
        if col is None or col in consumed:
            continue
        if col == "timestamp":
            sample["timestamp"] = v
        elif v is None or v == "":
            continue
        elif col in _CSV_INT_FIELDS:
            sample[col] = int(float(v))
        else:
            sample[col] = float(v)

    return sample


def _parse_and_convert_csv(text):
    """CSVテキスト(本ツールが出力した#174/#175形式)を検証しつつサンプル配列へ変換する
    (#178)。ヘッダの列名が既知のCSV列集合の部分集合であること・timestamp/car_id列が
    存在すること・各行の値変換が成功することを要求し、いずれか一つでも満たさない場合は
    ファイル全体をValueErrorで拒否する(#177調査報告§4のリスク対策を実装)。
    to_thread で実行すること(大型CSVのパースがイベントループを塞ぎ得るため)。
    """
    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None:
        raise ValueError("empty CSV: no header row")

    header = set(reader.fieldnames)
    unknown = header - _valid_csv_columns()
    if unknown:
        raise ValueError(f"unknown CSV column(s): {', '.join(sorted(unknown))}")
    if "timestamp" not in header:
        raise ValueError("missing required column: timestamp")
    if "car_id" not in header:
        raise ValueError("missing required column: car_id")

    samples = []
    for i, row in enumerate(reader):
        try:
            sample = _csv_row_to_sample(row)
        except (ValueError, TypeError) as e:
            raise ValueError(f"row {i + 2}: {e}") from e
        if not sample.get("timestamp"):
            raise ValueError(f"row {i + 2}: missing timestamp value")
        if sample.get("car_id") is None:
            raise ValueError(f"row {i + 2}: missing car_id value")
        samples.append(sample)

    if not samples:
        raise ValueError("CSV has no data rows")
    return samples


def _write_imported_lap(samples):
    """検証済みサンプル配列を IMPORT_LOG_DIR へ書き込み、割当てたファイル名を返す。

    ファイル名はクライアント指定(元アップロードファイル名)を一切使わず、サンプル自身の
    timestamp/car_id/lap_count から導出したうえで LAP_FILE_RE に自己適合させる
    (パストラバーサル対策、#177調査報告§4)。衝突時は Lap 番号をインクリメントして
    再試行する。to_thread で実行すること(json.dumpsが大型ファイルで重いため)。
    """
    first = samples[0]
    ts = datetime.fromisoformat(first["timestamp"])
    car_id = max(int(first.get("car_id") or 0), 0)
    lap_num = max(int(first.get("lap_count") or 0), 0)
    base = ts.strftime("%Y-%m-%d_%H_%M_%S")

    os.makedirs(IMPORT_LOG_DIR, exist_ok=True)
    for attempt in range(1000):
        filename = f"{base}_CAR-{car_id}_Lap-{lap_num + attempt}.json"
        if not LAP_FILE_RE.match(filename):
            continue
        filepath = os.path.join(IMPORT_LOG_DIR, filename)
        if os.path.exists(filepath):
            continue
        with open(filepath, 'w') as f:
            json.dump(samples, f)
        return filename
    return None


def _parse_lap_filename(name):
    """ラップファイル名をメタデータへ解釈する。形式不一致は None。"""
    m = LAP_FILE_RE.match(name)
    if not m:
        return None
    y, mo, d, h, mi, s, car, lap = m.groups()
    return {
        "file": name,
        "recorded_at": f"{y}-{mo}-{d}T{h}:{mi}:{s}",
        "car_id": int(car),
        "lap_number": int(lap),
    }


def _int_query(request, name, default, lo, hi):
    """整数クエリを検証つきで取得する。範囲外・非整数は ValueError。"""
    raw = request.query.get(name)
    if raw is None or raw == "":
        return default
    value = int(raw)  # 非整数は ValueError をそのまま上げる
    if value < lo or value > hi:
        raise ValueError(f"{name} out of range [{lo},{hi}]: {value}")
    return value


def _scan_lap_files(date_filter, car_id_filter, log_dir=LOG_DIR, source="recorded"):
    """log_dir を走査しメタデータ一覧を返す(内容は読まない。to_thread で実行)。
    log_dir/source は#177/#178のインポート一覧統合用(既定はgt7data/・recordedで従来どおり)。
    """
    entries = []
    try:
        with os.scandir(log_dir) as it:
            for entry in it:
                if not entry.is_file():
                    continue
                meta = _parse_lap_filename(entry.name)
                if meta is None:
                    continue
                if date_filter and not entry.name.startswith(date_filter):
                    continue
                if car_id_filter is not None and meta["car_id"] != car_id_filter:
                    continue
                meta["size_bytes"] = entry.stat().st_size
                meta["source"] = source
                entries.append(meta)
    except FileNotFoundError:
        # ディレクトリ未作成は初回起動直後の正常状態 → 空一覧
        return []
    entries.sort(key=lambda m: m["recorded_at"], reverse=True)
    return entries


async def api_laps_list_handler(request):
    """GET /api/laps — 過去ラップの一覧(ファイル名メタのみ・軽量)。
    include_imported=true(#177/#178)指定時のみ gt7data_imported/ も合わせて走査する
    (既定は従来どおり gt7data/ のみ。既存呼び出し元の挙動は無変更)。
    """
    try:
        limit = _int_query(request, "limit", API_LAPS_LIMIT_DEFAULT, 1, API_LAPS_LIMIT_MAX)
        offset = _int_query(request, "offset", 0, 0, 10**9)
        car_id = _int_query(request, "car_id", None, 0, 10**9) if request.query.get("car_id") else None
        date_filter = request.query.get("date")
        if date_filter and not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date_filter):
            raise ValueError(f"invalid date: {date_filter}")
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)

    include_imported = request.query.get("include_imported") == "true"
    entries = await asyncio.to_thread(_scan_lap_files, date_filter, car_id, LOG_DIR, "recorded")
    if include_imported:
        imported = await asyncio.to_thread(
            _scan_lap_files, date_filter, car_id, IMPORT_LOG_DIR, "imported"
        )
        entries = entries + imported
        entries.sort(key=lambda m: m["recorded_at"], reverse=True)

    return web.json_response(
        {"total": len(entries), "laps": entries[offset:offset + limit]},
        headers={'Cache-Control': 'no-cache'}
    )


def _load_lap_file(path, fields, every, output_format='json'):
    """ラップJSONを読み、間引き+射影した samples を指定形式の文字列で返す。

    to_thread で実行する。大型ファイル(実測最大84MB)では json の parse も
    dumps(またはCSV変換)もイベントループを塞ぎ得るため、直列化までこの関数内で済ませる。
    output_format: 'json'(既定、従来どおり)・'csv'(#174/#175)・'fastf1'(#434 P2)。
    """
    with open(path, 'r') as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError("lap file is not a sample array")
    samples = [
        {k: s[k] for k in fields if k in s}
        for s in data[::every]
        if isinstance(s, dict)
    ]
    first = data[0] if data and isinstance(data[0], dict) else {}
    duration_ms = _lap_duration_approx_ms(data)
    if output_format == 'csv':
        body = _samples_to_csv(samples, fields)
    elif output_format == 'fastf1':
        body = _samples_to_fastf1_csv(samples, fields)
    else:
        body = json.dumps(samples)
    return body, len(samples), len(data), first, duration_ms


# 受信時刻差がこれ以上のサンプル間は「記録の中断」(メニュー放置・一時停止等)と
# みなし、所要時間の近似に算入しない。実測: 2026-07-15ファイルに83,926sの単一
# ギャップがあり、単純な先頭↔最終差(84,195s)は無意味、クランプ後(268.9s)は
# サンプル数/60Hz(270s)と一致。
LAP_DURATION_GAP_S = 2.0


def _lap_duration_approx_ms(data):
    """ラップ所要時間の近似(ms)を受信 timestamp のクランプ付き差分合計で求める。

    注意: decoder.py が current_laptime に格納する値(パケット 0x80)は実際には
    「ゲーム内時刻の進行 ms」でありラップ経過時間ではない(実データで機械確認:
    全サンプル定数 or 日時起点の単調増加。2026-07-16 計承認の是正案(a))。
    そのため v1/v2 共通で受信時刻 dt(< LAP_DURATION_GAP_S)の合計を使う。
    ラップ確定値(次ラップの last_laptime)ではない点は「approx」の名で明示する。
    _load_lap_file と同じワーカースレッド内で呼ぶこと(全サンプル走査のため)。
    """
    total_s = 0.0
    prev = None
    for s in data:
        if not isinstance(s, dict):
            continue
        raw = s.get("timestamp")
        if not raw:
            continue
        try:
            t = datetime.fromisoformat(raw)
        except ValueError:
            continue
        if prev is not None:
            dt = (t - prev).total_seconds()
            if 0 < dt < LAP_DURATION_GAP_S:
                total_s += dt
        prev = t
    return round(total_s * 1000) if total_s > 0 else None


async def api_lap_detail_handler(request):
    """GET /api/laps/{file} — 単一ラップの取得(fields射影+every間引き)。
    format=csv(#174/#175)・format=fastf1(#434 P2)指定時はCSVダウンロード応答
    (既定json応答・format=csvの列構成は無変更)。
    """
    name = request.match_info["file"]
    meta = _parse_lap_filename(name)
    if meta is None:
        return web.json_response({"error": "not found"}, status=404)
    filepath = os.path.join(LOG_DIR, name)
    if not os.path.isfile(filepath):
        # gt7data/ に無ければインポート分(#177/#178)を探す(一覧でオプトイン
        # 表示されたインポート済みラップの詳細取得・CSV変換・再生に必要)
        filepath = os.path.join(IMPORT_LOG_DIR, name)
        if not os.path.isfile(filepath):
            return web.json_response({"error": "not found"}, status=404)

    try:
        every = _int_query(request, "every", API_LAPS_EVERY_DEFAULT, 1, API_LAPS_EVERY_MAX)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)

    output_format = request.query.get("format", "json")
    if output_format not in ("json", "csv", "fastf1"):
        return web.json_response({"error": f"invalid format: {output_format}"}, status=400)

    fields_raw = request.query.get("fields")
    if fields_raw:
        # 未知フィールド名はエラーにせず単に無視される(前方互換: 射影で自然に落ちる)
        fields = tuple(f.strip() for f in fields_raw.split(',') if f.strip())
    elif output_format == "csv":
        fields = CSV_ALL_FIELDS  # CSV既定は全件(#174仕様書§2)。JSON既定(DEFAULT_LAP_FIELDS)とは別枠
    elif output_format == "fastf1":
        fields = FASTF1_FIELDS  # FastF1互換列のみ(#434 P2、予備調査報告§(b)の対応表準拠)
    else:
        fields = DEFAULT_LAP_FIELDS

    try:
        body_data, samples_returned, samples_total, first, duration_ms = await asyncio.to_thread(
            _load_lap_file, filepath, fields, every, output_format
        )
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as e:
        logger.error(f"Corrupt lap file {name}: {e}")
        return web.json_response({"error": "corrupt file"}, status=500)

    if output_format == "csv":
        csv_name = re.sub(r'\.json$', '.csv', name)
        return web.Response(
            text=body_data, content_type='text/csv', charset='utf-8',
            headers={
                'Cache-Control': 'no-cache',
                'Content-Disposition': f'attachment; filename="{csv_name}"',
            }
        )

    if output_format == "fastf1":
        # #434 P2: FastF1互換CSV(既存csvダウンロードと別枠、ファイル名で区別)
        fastf1_name = re.sub(r'\.json$', '_fastf1.csv', name)
        return web.Response(
            text=body_data, content_type='text/csv', charset='utf-8',
            headers={
                'Cache-Control': 'no-cache',
                'Content-Disposition': f'attachment; filename="{fastf1_name}"',
            }
        )

    # スキーマ世代: 2026-07系(v2)は lap_count を持つ。2026-02系(v1)は持たない。
    schema = "v2" if "lap_count" in first else "v1"
    course = None
    course_raw = first.get("course")
    if isinstance(course_raw, dict):
        course = {k: course_raw.get(k) for k in ("id", "name_ja", "name_en")}

    meta.update({
        "samples_total": samples_total,
        "samples_returned": samples_returned,
        "every": every,
        "schema": schema,
        "course": course,
        "laptime_ms_approx": duration_ms,
    })
    # samples は to_thread 内で直列化済み。meta だけここで dumps して結合する
    body = '{"meta": ' + json.dumps(meta) + ', "samples": ' + body_data + '}'
    return web.Response(
        text=body, content_type='application/json',
        headers={'Cache-Control': 'no-cache'}
    )


async def api_laps_import_handler(request):
    """POST /api/laps/import — 自前CSV(#174/#175形式)からラップをインポートする(#178)。

    multipart/form-data の "file" パートを受け取り、検証+逆変換(_parse_and_convert_csv)を
    to_thread で実行後、既存v2スキーマ(JSONサンプル配列)として IMPORT_LOG_DIR
    (gt7data_imported/)へ保存する。実記録データ(LOG_DIR)には一切書き込まない
    (#177調査報告§4のリスク対策)。ライブ受信経路(telemetry.py/decoder.py/websocket)には
    一切触れない。
    """
    try:
        reader = await request.multipart()
    except Exception:
        return web.json_response({"error": "invalid multipart request"}, status=400)

    field = None
    async for part in reader:
        if part.name == "file":
            field = part
            break
    if field is None:
        return web.json_response({"error": "missing 'file' field"}, status=400)

    chunks = []
    total = 0
    while True:
        chunk = await field.read_chunk(size=65536)
        if not chunk:
            break
        total += len(chunk)
        if total > IMPORT_MAX_UPLOAD_BYTES:
            return web.json_response(
                {"error": f"file too large (max {IMPORT_MAX_UPLOAD_BYTES} bytes)"}, status=413
            )
        chunks.append(chunk)

    try:
        text = b"".join(chunks).decode("utf-8-sig")
    except UnicodeDecodeError:
        return web.json_response({"error": "file is not valid UTF-8"}, status=400)

    try:
        samples = await asyncio.to_thread(_parse_and_convert_csv, text)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)

    filename = await asyncio.to_thread(_write_imported_lap, samples)
    if filename is None:
        return web.json_response({"error": "could not allocate a unique filename"}, status=500)

    logger.info(f"Imported lap data: {IMPORT_LOG_DIR}/{filename} ({len(samples)} samples)")
    return web.json_response({"file": filename, "samples": len(samples)}, status=201)


# ================================================================
#  ラップタイム予測ライブ推論API (#434 P5 Stage2)
#
#  train_laptime_model.py(オフライン学習パイプライン)が生成した学習済みモデルを
#  用いた読み取り専用の推論エンドポイント。ライブ受信経路(decoder.py/telemetry.py/
#  telemetry_background_task/broadcast_to_clients/broadcast_consumer_task、
#  P1/P1-b実装分)には一切触れない、独立したモジュールレベル関数。
#
#  品質ゲート(采指示2026-08-02厳守): MAE%が QUALITY_GATE_MAE_PCT(train_laptime_model.py
#  で定義、既定3.0)を超えるコース×車種の組み合わせは本APIから一切提供しない
#  (中間帯の個別許容なし)。閾値判定はtrain_laptime_model.py側で完結しており、
#  models/gated_groups.json に事前フィルタ済みの許可リストとして書き出される。
#  本APIはそのリストに存在する組み合わせのみを扱う(ここで閾値を再判定しない)。
# ================================================================

PREDICT_MODEL_DIR = "models"
PREDICT_GATED_GROUPS_FILE = os.path.join(PREDICT_MODEL_DIR, "gated_groups.json")

# train_laptime_model.py の FEATURE_COLUMNS と同一順序(モデル入力の列順を一致させる)。
PREDICT_FEATURE_COLUMNS = (
    "progress_fraction", "avg_speed_kmh", "max_speed_kmh",
    "avg_throttle_pct", "avg_brake_pct", "avg_tyre_temp",
)


def _load_gated_groups():
    """品質ゲート済みグループ一覧(models/gated_groups.json)を読み込む(#434 P5 Stage2)。

    train_laptime_model.pyが生成する小さな許可リストファイル。ファイル不在・破損時は
    空dict(=全リクエストが404、安全側にフォールバック)。
    """
    if not os.path.isfile(PREDICT_GATED_GROUPS_FILE):
        return {}
    try:
        with open(PREDICT_GATED_GROUPS_FILE) as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to load {PREDICT_GATED_GROUPS_FILE}: {e}")
        return {}


def _float_query_required(request, name, lo=None, hi=None):
    """必須の浮動小数点クエリパラメータを取得する(#434 P5 Stage2)。

    欠落・非数値・範囲外はValueError(呼び出し元で400に変換する)。
    """
    raw = request.query.get(name)
    if raw is None or raw == "":
        raise ValueError(f"missing required query parameter: {name}")
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(f"invalid float for {name}: {raw!r}")
    if lo is not None and value < lo or hi is not None and value > hi:
        raise ValueError(f"{name} out of range [{lo},{hi}]: {value}")
    return value


def _predict_laptime(model_path, feature_values):
    """joblibモデルをロードし推論する(#434 P5 Stage2、同期関数)。

    joblib.load()のデシリアライズコストがイベントループを塞がないよう、
    呼び出し元は必ずasyncio.to_thread経由で呼ぶこと(既存の_load_lap_fileと同じ方針)。
    """
    model = joblib.load(model_path)
    prediction = model.predict([feature_values])
    return float(prediction[0])


async def api_predict_laptime_handler(request):
    """GET /api/predict/laptime — 品質ゲート済み(MAE<=3%)グループのみラップタイムを
    推論する(#434 P5 Stage2)。

    クエリ: course, car_id(組み合わせの特定) / progress, avg_speed_kmh, max_speed_kmh,
    avg_throttle_pct, avg_brake_pct, avg_tyre_temp(train_laptime_model.pyと同じ特徴量)。
    品質ゲート対象外(MAE>3%・未学習の組み合わせ)は404。
    """
    course = request.query.get("course")
    car_id_raw = request.query.get("car_id")
    if not course or not car_id_raw:
        return web.json_response({"error": "course and car_id are required"}, status=400)

    gated = _load_gated_groups()
    key = f"{course}__{car_id_raw}"
    group = gated.get(key)
    if group is None:
        return web.json_response(
            {"error": "no quality-gated model for this course/car_id combination"},
            status=404,
        )

    try:
        progress = _float_query_required(request, "progress", lo=0.0, hi=1.0)
        avg_speed_kmh = _float_query_required(request, "avg_speed_kmh", lo=0.0)
        max_speed_kmh = _float_query_required(request, "max_speed_kmh", lo=0.0)
        avg_throttle_pct = _float_query_required(request, "avg_throttle_pct", lo=0.0, hi=100.0)
        avg_brake_pct = _float_query_required(request, "avg_brake_pct", lo=0.0, hi=100.0)
        avg_tyre_temp = _float_query_required(request, "avg_tyre_temp")
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)

    feature_values = [
        progress, avg_speed_kmh, max_speed_kmh,
        avg_throttle_pct, avg_brake_pct, avg_tyre_temp,
    ]

    try:
        predicted_ms = await asyncio.to_thread(_predict_laptime, group["model_path"], feature_values)
    except Exception as e:
        logger.error(f"Prediction failed for {key}: {e}", exc_info=True)
        return web.json_response({"error": "prediction failed"}, status=500)

    return web.json_response(
        {
            "course": course,
            "car_id": group.get("car_id", car_id_raw),
            "predicted_laptime_ms": round(predicted_ms, 1),
            "mae_ms": group["mae_ms"],
            "mae_pct": group["mae_pct"],
            "n_laps": group["n_laps"],
            "algorithm": group.get("algorithm"),
        },
        headers={'Cache-Control': 'no-cache'},
    )


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
    # 読み出しAPIはワイルドカード静的ルート(/{filename})より前に登録する
    app.router.add_get('/api/laps', api_laps_list_handler)
    app.router.add_post('/api/laps/import', api_laps_import_handler)
    app.router.add_get('/api/laps/{file}', api_lap_detail_handler)
    app.router.add_get('/api/predict/laptime', api_predict_laptime_handler)
    app.router.add_get('/', index_handler)
    app.router.add_get('/engineer', engineer_handler)
    app.router.add_get('/ws', websocket_handler)
    app.router.add_get('/{filename:.*}', static_handler)

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    logger.info(f"Starting GT7 Dashboard Server on port {port}...")
    logger.info(f"{scheme.upper()}: {scheme}://0.0.0.0:{port}")
    logger.info(f"WebSocket: {ws_scheme}://0.0.0.0:{port}/ws")

    # access_log=None: アクセスログは logging_middleware が出すため、
    # aiohttp デフォルトの access log と二重出力になるのを抑止する
    web.run_app(app, host='0.0.0.0', port=port, ssl_context=ssl_context, access_log=None)


if __name__ == "__main__":
    main()
