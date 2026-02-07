import socket
import time

class GT7TelemetryClient:
    def __init__(self, ip, port, heartbeat_interval=10):
        self.ip = ip
        self.port = port
        self.heartbeat_interval = heartbeat_interval
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(('0.0.0.0', self.port))
        self.sock.settimeout(0.1)
        self.last_heartbeat = 0

    def send_heartbeat(self):
        """Sends the wakeup packet to PS5"""
        now = time.time()
        if now - self.last_heartbeat > self.heartbeat_interval:
            try:
                print(f"Sending heartbeat to {self.ip}:{self.port}")
                self.sock.sendto(b'A', (self.ip, self.port))
                self.last_heartbeat = now
            except Exception as e:
                print(f"Heartbeat failed: {e}")

    def receive(self):
        """Tries to receive a packet"""
        try:
            data, _ = self.sock.recvfrom(4096)
            return data
        except socket.timeout:
            return None
        except Exception as e:
            print(f"Receive Error: {e}")
            return None

    def close(self):
        self.sock.close()
