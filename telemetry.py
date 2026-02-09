import socket
import time

class GT7TelemetryClient:
    def __init__(self, ip, send_port=33739, receive_port=33740, heartbeat_interval=10):
        self.ip = ip
        self.send_port = send_port
        self.receive_port = receive_port
        self.heartbeat_interval = heartbeat_interval
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(('0.0.0.0', self.receive_port))
        self.sock.settimeout(1.0)
        self.last_heartbeat = 0
        self.packets_received = 0

    def send_heartbeat(self):
        """Sends the wakeup packet to PS5"""
        now = time.time()
        if now - self.last_heartbeat > self.heartbeat_interval:
            try:
                self.sock.sendto(b'A', (self.ip, self.send_port))
                self.last_heartbeat = now
                # 最初のハートビート時のみログ
                if self.packets_received == 0:
                    print(f"[Heartbeat] Sending to {self.ip}:{self.send_port} - waiting for data...")
                elif self.packets_received > 0:
                    print(f"[Stats] Receiving data! {self.packets_received} packets received")
            except Exception as e:
                print(f"[ERROR] Heartbeat failed: {e}")

    def receive(self):
        """Tries to receive a packet"""
        try:
            data, addr = self.sock.recvfrom(4096)
            self.packets_received += 1
            # 最初のパケット受信時のみログ
            if self.packets_received == 1:
                print(f"[RX] Started receiving {len(data)} bytes from {addr}")
            return data
        except socket.timeout:
            return None
        except Exception as e:
            print(f"[ERROR] Receive Error: {e}")
            return None

    def close(self):
        self.sock.close()
