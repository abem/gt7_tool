"""
GT7 テレメトリクライアント（非同期版）

PS5/PS4 からの UDP テレメトリパケットを asyncio ベースで受信する。
従来の同期ソケット + ブロッキング recvfrom() + asyncio.sleep ポーリング構成を
asyncio.DatagramProtocol に置き換え、イベントループを阻塞せずに
パケット到着時のみ処理を起動できるようにした。

API（main.py からの使用順序）:
    client = GT7TelemetryClient(ip, ...)
    await client.connect()        # UDP エンドポイント作成
    await client.send_heartbeat() # ハートビート送信
    data = await client.receive() # パケット受信（到着まで await）
    client.close()
"""

import asyncio
import logging
import time

logger = logging.getLogger(__name__)


class _TelemetryProtocol(asyncio.DatagramProtocol):
    """UDP パケットを受信してキューに積むプロトコル。

    受信コールバックはイベントループ上で呼ばれるため、ロック不要の
    asyncio.Queue にパケットを蓄積する。main.py 側は await receive() で取り出す。
    """

    # キュー溢れ警告のログ間引き間隔（秒）。この間隔に1回だけ累積ドロップ数を出す。
    _DROP_LOG_INTERVAL_SEC = 60.0

    def __init__(self, queue: asyncio.Queue, on_first_packet):
        self._queue = queue
        self._on_first_packet = on_first_packet
        self.transport = None
        # キュー溢れの監視用カウンタ（ログ洪水を防ぐため間引いて出力）
        self._dropped_since_log = 0
        self._last_drop_log = 0.0

    def connection_made(self, transport):  # noqa: D401 - asyncio API 実装
        self.transport = transport
        sockname = transport.get_extra_info('sockname')
        logger.info(f"UDP listener bound to {sockname}")

    def datagram_received(self, data, addr):  # noqa: D401 - asyncio API 実装
        # キューが溢れる場合は古いパケットから破棄（テレメトリは過去値より最新値優先）
        dropped = False
        if self._queue.full():
            try:
                self._queue.get_nowait()
                dropped = True
            except asyncio.QueueEmpty:
                pass
        try:
            self._queue.put_nowait((data, addr))
        except asyncio.QueueFull:
            # 満杯ならこの1パケットを捨てる（受信レート>>消費レート時の安全装置）
            dropped = True

        # 溢れが起きている場合は間引いて警告（1分に1回・累積ドロップ数を通知）
        # → 「テレメトリが遅い/飛ぶ」不具合の原因診断を可能にする
        if dropped:
            self._dropped_since_log += 1
            now = time.monotonic()
            if now - self._last_drop_log >= self._DROP_LOG_INTERVAL_SEC:
                logger.warning(
                    f"Telemetry queue overflow: dropped {self._dropped_since_log} packet(s) "
                    f"in the last interval (queue max={self._queue.maxsize}). "
                    f"Consumer is slower than producer."
                )
                self._dropped_since_log = 0
                self._last_drop_log = now

        self._on_first_packet(data, addr)

    def error_received(self, exc):  # noqa: D401 - asyncio API 実装
        logger.error(f"UDP receive error: {exc}")


class GT7TelemetryClient:
    """GT7 テレメトリを非同期受信するクライアント。

    旧 API との差分:
      - receive() は async def（パケット到着まで await で待機）
      - send_heartbeat() は async def
      - 追加: await connect() でエンドポイント作成（旧: __init__ 内で即 bind）
      - settimeout は廃止（非同期待機で不要）
    """

    # 受信キュー上限。過剰に溜め込まない安全装置。
    QUEUE_MAXSIZE = 256

    # UDP 受信ソケットのバインド先ホスト（全インターフェースで待ち受け）。
    BIND_HOST = '0.0.0.0'

    def __init__(self, ip, send_port=33739, receive_port=33740,
                 heartbeat_interval=10, heartbeat_type=b'~'):
        self.ip = ip
        self.send_port = send_port
        self.receive_port = receive_port
        self.heartbeat_interval = heartbeat_interval
        self.heartbeat_type = heartbeat_type
        # 最終ハートビート送信時刻（記録専用・間隔制御は _heartbeat_loop 側が担う）。
        # デバッグ/観測用に残しており、送信経路の健全性確認等で参照する用途。
        self.last_heartbeat = 0.0
        self.packets_received = 0

        # 非同期受信キュー。connect() 時にイベントループが確定してから生成する。
        self._queue = None
        self._transport = None
        self._connected = False

    async def connect(self):
        """UDP エンドポイントを作成し、受信を開始する。

        旧実装の __init__ 内 bind に相当。イベントループ上で動作するため、
        プロトコル/トランスポートの生成は __init__ ではなくここで行う。
        """
        loop = asyncio.get_running_loop()
        self._queue = asyncio.Queue(maxsize=self.QUEUE_MAXSIZE)

        def _on_first_packet(data, addr):
            if self.packets_received == 0:
                logger.info(f"Started receiving data: {len(data)} bytes from {addr}")

        transport, protocol = await loop.create_datagram_endpoint(
            lambda: _TelemetryProtocol(self._queue, _on_first_packet),
            local_addr=(self.BIND_HOST, self.receive_port),
        )
        self._transport = transport
        self._connected = True
        logger.info(
            f"GT7TelemetryClient ready: listening {self.BIND_HOST}:{self.receive_port}, "
            f"heartbeat -> {self.ip}:{self.send_port}"
        )

    async def send_heartbeat(self):
        """PS5 にウェイクアップパケットを1つ送信する。

        間隔制御は呼び出し側（main.py の _heartbeat_loop が asyncio.sleep で制御）に
        一元化しており、本メソッドは呼ばれるたびに無条件で1パケット送信する。
        二重の間隔チェックによる送信漏れを避けるため、ここでは時間判定しない。
        """
        if not self._connected or self._transport is None:
            return

        try:
            self._transport.sendto(self.heartbeat_type, (self.ip, self.send_port))
            self.last_heartbeat = time.monotonic()
            if self.packets_received == 0:
                logger.info(f"Heartbeat sent to {self.ip}:{self.send_port} - waiting for data...")
            else:
                logger.debug(f"Heartbeat sent. {self.packets_received} packets received so far")
        except Exception as e:
            logger.error(f"Heartbeat failed: {e}")

    async def receive(self):
        """テレメトリパケットを1つ受信して返す。

        パケットが到着するまでイベントループを阻塞せずに待機する。
        タイムアウト相当の動作が必要な呼び出し側は asyncio.wait_for で包むこと。
        戻り値は bytes（旧実装互換）。addr は内部利用のみ。

        注意: asyncio.CancelledError は握りつぶさず re-raise する。
        呼び出し元のタスクがキャンセルされた場合は正しく終了できるようにするため。
        """
        if not self._connected or self._queue is None:
            return None
        data, _addr = await self._queue.get()
        self.packets_received += 1
        return data

    def close(self):
        """トランスポートを閉じる"""
        if self._transport is not None:
            try:
                self._transport.close()
            except Exception as e:
                logger.warning(f"Error closing transport: {e}")
        self._connected = False
        logger.info("Telemetry client closed")
