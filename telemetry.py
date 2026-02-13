import socket
import time
import logging

logger = logging.getLogger(__name__)


class GT7TelemetryClient:
    def __init__(self, ip, send_port=33739, receive_port=33740, heartbeat_interval=10):
        self.ip = ip
        self.send_port = send_port
        self.receive_port = receive_port
        self.heartbeat_interval = heartbeat_interval
        self.last_heartbeat = 0
        self.packets_received = 0

        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(('0.0.0.0', self.receive_port))
        self.sock.settimeout(1.0)

    def send_heartbeat(self):
        """PS5にウェイクアップパケットを送信"""
        now = time.time()
        if now - self.last_heartbeat < self.heartbeat_interval:
            return

        try:
            self.sock.sendto(b'A', (self.ip, self.send_port))
            self.last_heartbeat = now
            if self.packets_received == 0:
                logger.info(f"Heartbeat sent to {self.ip}:{self.send_port} - waiting for data...")
            else:
                logger.debug(f"Heartbeat sent. {self.packets_received} packets received so far")
        except Exception as e:
            logger.error(f"Heartbeat failed: {e}")

    def receive(self):
        """テレメトリパケットを受信"""
        try:
            data, addr = self.sock.recvfrom(4096)
            self.packets_received += 1
            if self.packets_received == 1:
                logger.info(f"Started receiving data: {len(data)} bytes from {addr}")
            return data
        except socket.timeout:
            return None
        except Exception as e:
            logger.error(f"Receive error: {e}")
            return None

    def close(self):
        self.sock.close()
        logger.info("Telemetry client closed")
