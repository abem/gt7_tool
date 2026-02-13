"""
GT7デコーダーモジュール

PS5からの暗号化テレメトリーパケットを復号し、解析します。
gt7dashboardの実装を参考にしています。
"""

import struct
import json
import os
import logging
from Crypto.Cipher import Salsa20

logger = logging.getLogger(__name__)


class CourseEstimator:
    """位置座標からコースを推定するクラス"""

    def __init__(self, db_file='course_database.json'):
        self.courses = []
        self.known_courses = []
        self.test_mode = {}
        self._load_database(db_file)

    def _load_database(self, db_file):
        if not os.path.exists(db_file):
            logger.warning(f"Course database not found: {db_file}")
            return

        try:
            with open(db_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            self.courses = data.get('courses', [])
            self.known_courses = data.get('known_courses', [])
            self.test_mode = data.get('test_mode', {})
            logger.info(
                f"Course DB loaded: {len(self.courses)} auto-generated, "
                f"{len(self.known_courses)} known courses"
            )
        except Exception as e:
            logger.error(f"Failed to load course database: {e}")

    def estimate_course(self, x, z):
        """位置座標(x, z)からコースを推定"""
        for course in self.known_courses:
            if self._point_in_bounds(x, z, course.get('bounds', {})):
                return {
                    "id": course.get('id', 'unknown'),
                    "name": course.get('name', 'Unknown'),
                    "name_en": course.get('name_en', ''),
                    "name_ja": course.get('name_ja', ''),
                    "confidence": 1.0,
                }

        for course in self.courses:
            if self._point_in_bounds(x, z, course.get('bounds', {})):
                return {
                    "id": course.get('id', 'unknown'),
                    "name": course.get('name', 'Unknown'),
                    "description": course.get('description', ''),
                    "confidence": 0.8,
                }

        return {"id": "unknown", "name": "Unknown Track", "confidence": 0}

    @staticmethod
    def _point_in_bounds(x, z, bounds):
        return (
            bounds.get('min_x', -99999) <= x <= bounds.get('max_x', 99999)
            and bounds.get('min_z', -99999) <= z <= bounds.get('max_z', 99999)
        )

    def update_database_from_data(self, data_points, course_id, course_name):
        """テレメトリデータからコースの座標範囲を更新"""
        if not data_points:
            return

        x_values = [p['x'] for p in data_points]
        z_values = [p['z'] for p in data_points]
        bounds = {
            'min_x': min(x_values),
            'max_x': max(x_values),
            'min_z': min(z_values),
            'max_z': max(z_values),
        }

        for course in self.courses:
            if course.get('id') == course_id:
                course['bounds'] = bounds
                logger.info(f"Updated course bounds: {course_name}")
                return

        self.courses.append({'id': course_id, 'name': course_name, 'bounds': bounds})
        logger.info(f"Added new course: {course_name}")

    def save_database(self, db_file='course_database.json'):
        """コースデータベースをファイルに保存"""
        try:
            data = {
                'courses': self.courses,
                'metadata': {
                    'version': '1.0.0',
                    'description': 'GT7コースデータベース - 位置座標(x, z)からコースを推定',
                },
            }
            with open(db_file, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=4)
            logger.info(f"Saved {len(self.courses)} courses to {db_file}")
        except Exception as e:
            logger.error(f"Failed to save course database: {e}")


class GT7Decoder:
    """GT7テレメトリーパケットの復号と解析"""

    SALSA20_KEY = b'Simulator Interface Packet GT7 ver 0.0'
    MAGIC_G7S0 = 0x47375330
    MIN_PACKET_SIZE = 0x100
    MIN_PARSE_SIZE = 0x128  # 296 bytes

    def __init__(self, course_db='course_database.json'):
        self.course_estimator = CourseEstimator(course_db)
        self._parse_count = 0

    def decrypt(self, data: bytes) -> bytes:
        """GT7パケットをSalsa20で復号"""
        if len(data) < self.MIN_PACKET_SIZE:
            logger.warning(f"Packet too small: {len(data)} bytes")
            return b''

        oiv = data[0x40:0x44]
        iv1 = int.from_bytes(oiv, byteorder='little')
        iv2 = iv1 ^ 0xDEADBEAF  # GT7固有のXOR値（DEADBEAFであってDEADBEEFではない）
        iv = iv2.to_bytes(4, 'little') + iv1.to_bytes(4, 'little')

        try:
            cipher = Salsa20.new(self.SALSA20_KEY[:32], bytes(iv))
            decrypted = cipher.decrypt(data)
            magic = int.from_bytes(decrypted[0:4], byteorder='little')
            if magic != self.MAGIC_G7S0:
                logger.warning(f"Invalid magic number: 0x{magic:08X}")
                return b''
            return decrypted
        except Exception as e:
            logger.error(f"Decryption failed: {e}")
            return b''

    def parse(self, decrypted_data: bytes) -> dict:
        """復号済みパケットを解析してテレメトリデータを返す"""
        if not decrypted_data or len(decrypted_data) < self.MIN_PARSE_SIZE:
            logger.warning(f"Data too small for parsing: {len(decrypted_data) if decrypted_data else 0} bytes")
            return None

        try:
            d = decrypted_data
            result = self._extract_fields(d)

            # コース推定
            course_info = self.course_estimator.estimate_course(
                result["position_x"], result["position_z"]
            )
            result["course"] = course_info

            self._parse_count += 1
            if self._parse_count <= 3:
                logger.info(
                    f"Parsed: {result['speed_kmh']:.1f} km/h, "
                    f"RPM: {result['rpm']:.0f}, Gear: {result['gear']}"
                )
            elif self._parse_count == 4:
                logger.info("Telemetry stream active (suppressing per-packet logs)")

            return result

        except Exception as e:
            logger.error(f"Parse failed: {e}", exc_info=True)
            return None

    @staticmethod
    def _extract_fields(d: bytes) -> dict:
        """バイナリデータからテレメトリフィールドを抽出"""
        f = struct.unpack_from

        speed_ms = f('f', d, 0x4C)[0]

        return {
            # 速度
            "speed_ms": speed_ms,
            "speed_kmh": speed_ms * 3.6,

            # エンジン
            "rpm": f('f', d, 0x3C)[0],
            "max_rpm": 9000,

            # ギア・ペダル
            "gear": f('B', d, 0x90)[0] & 0x0F,
            "gear_byte": f('B', d, 0x90)[0],
            "throttle": f('B', d, 0x91)[0],
            "throttle_pct": f('B', d, 0x91)[0] / 2.55,
            "brake": f('B', d, 0x92)[0],
            "brake_pct": f('B', d, 0x92)[0] / 2.55,

            # タイヤ温度 [FL, FR, RL, RR]
            "tyre_temp": [f('f', d, 0x60 + i * 4)[0] for i in range(4)],

            # タイヤ圧 (bar) [FL, FR, RL, RR]
            "tyre_pressure": [f('B', d, 0x94 + i)[0] / 4.0 for i in range(4)],

            # サスペンション高さ [FL, FR, RL, RR]
            "susp_height": [f('f', d, 0xC4 + i * 4)[0] for i in range(4)],

            # タイヤ半径 [FL, FR, RL, RR]
            "tyre_radius": [f('f', d, 0xB4 + i * 4)[0] for i in range(4)],

            # ホイールRPS [FL, FR, RL, RR]
            "wheel_rps": [f('f', d, 0xA4 + i * 4)[0] for i in range(4)],

            # 位置
            "position_x": f('f', d, 0x04)[0],
            "position_y": f('f', d, 0x08)[0],
            "position_z": f('f', d, 0x0C)[0],

            # 燃料
            "current_fuel": f('f', d, 0x44)[0],
            "fuel_capacity": f('f', d, 0x48)[0],

            # ブースト
            "boost": f('f', d, 0x50)[0] - 1,

            # パッケージID
            "package_id": f('i', d, 0x70)[0],

            # ラップ
            "lap_count": f('h', d, 0x74)[0],
            "total_laps": f('h', d, 0x76)[0],
            "best_laptime": f('i', d, 0x78)[0],
            "last_laptime": f('i', d, 0x7C)[0],

            # 車種
            "car_id": f('i', d, 0x124)[0],
        }
