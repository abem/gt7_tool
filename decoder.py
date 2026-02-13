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
                'known_courses': self.known_courses,
                'test_mode': self.test_mode,
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
    MIN_PARSE_SIZE = 0x128  # 296 bytes (Packet A)

    # ハートビートタイプ別XOR値
    XOR_MAP = {
        b'A': 0xDEADBEAF,
        b'B': 0xDEADBEEF,
        b'~': 0x55FABB4F,
    }

    def __init__(self, course_db='course_database.json', heartbeat_type=b'~'):
        self.course_estimator = CourseEstimator(course_db)
        self._parse_count = 0
        self.heartbeat_type = heartbeat_type
        self._xor_value = self.XOR_MAP.get(heartbeat_type, 0xDEADBEAF)

    def _try_decrypt(self, data: bytes, xor_value: int) -> bytes:
        """指定のXOR値でSalsa20復号を試行"""
        oiv = data[0x40:0x44]
        iv1 = int.from_bytes(oiv, byteorder='little')
        iv2 = iv1 ^ xor_value
        iv = iv2.to_bytes(4, 'little') + iv1.to_bytes(4, 'little')

        cipher = Salsa20.new(self.SALSA20_KEY[:32], bytes(iv))
        decrypted = cipher.decrypt(data)
        magic = int.from_bytes(decrypted[0:4], byteorder='little')
        if magic == self.MAGIC_G7S0:
            return decrypted
        return b''

    def decrypt(self, data: bytes) -> bytes:
        """GT7パケットをSalsa20で復号（XOR自動フォールバック付き）"""
        if len(data) < self.MIN_PACKET_SIZE:
            logger.warning(f"Packet too small: {len(data)} bytes")
            return b''

        try:
            # 現在のXOR値で復号を試行
            result = self._try_decrypt(data, self._xor_value)
            if result:
                return result

            # フォールバック: 他のXOR値を試す
            for hb_type, xor_val in self.XOR_MAP.items():
                if xor_val == self._xor_value:
                    continue
                result = self._try_decrypt(data, xor_val)
                if result:
                    logger.info(f"XOR fallback: switched to heartbeat type '{hb_type.decode()}'")
                    self._xor_value = xor_val
                    self.heartbeat_type = hb_type
                    return result

            logger.warning("Decryption failed: no valid XOR value found")
            return b''
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

            # コース推定（無効化）
            # course_info = self.course_estimator.estimate_course(
            #     result["position_x"], result["position_z"]
            # )
            # result["course"] = course_info
            result["course"] = {"id": "unknown", "name": "", "confidence": 0}

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
        gear_byte = f('B', d, 0x90)[0]
        rpm_alert_max = f('H', d, 0x8A)[0]
        flags_raw = f('H', d, 0x8E)[0]

        # スタート順位・参加台数 (レース前のみ有効、開始後は-1)
        pre_race_position = f('h', d, 0x84)[0]
        num_cars_pre_race = f('h', d, 0x86)[0]
        suggested = gear_byte >> 4

        result = {
            # 速度
            "speed_ms": speed_ms,
            "speed_kmh": speed_ms * 3.6,

            # エンジン
            "rpm": f('f', d, 0x3C)[0],
            "max_rpm": rpm_alert_max if rpm_alert_max > 0 else 9000,
            "rpm_alert_min": f('H', d, 0x88)[0],

            # ギア・ペダル
            "gear": gear_byte & 0x0F,
            "suggested_gear": suggested if suggested < 15 else None,
            "throttle": f('B', d, 0x91)[0],
            "throttle_pct": f('B', d, 0x91)[0] / 2.55,
            "brake": f('B', d, 0x92)[0],
            "brake_pct": f('B', d, 0x92)[0] / 2.55,

            # クラッチ
            "clutch": f('f', d, 0xF4)[0],
            "clutch_engagement": f('f', d, 0xF8)[0],
            "clutch_gearbox_rpm": f('f', d, 0xFC)[0],

            # タイヤ温度 [FL, FR, RL, RR]
            "tyre_temp": [f('f', d, 0x60 + i * 4)[0] for i in range(4)],

            # 路面法線ベクトル
            "road_plane_x": f('f', d, 0x94)[0],
            "road_plane_y": f('f', d, 0x98)[0],
            "road_plane_z": f('f', d, 0x9C)[0],
            "road_plane_distance": f('f', d, 0xA0)[0],

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

            # 速度ベクトル (m/s)
            "velocity_x": f('f', d, 0x10)[0],
            "velocity_y": f('f', d, 0x14)[0],
            "velocity_z": f('f', d, 0x18)[0],

            # 回転 (-1〜1)
            "rotation_pitch": f('f', d, 0x1C)[0],
            "rotation_yaw": f('f', d, 0x20)[0],
            "rotation_roll": f('f', d, 0x24)[0],

            # 方角 (1.0=北, 0.0=南)
            "orientation": f('f', d, 0x28)[0],

            # 角速度 (rad/s)
            "angular_velocity_x": f('f', d, 0x2C)[0],
            "angular_velocity_y": f('f', d, 0x30)[0],
            "angular_velocity_z": f('f', d, 0x34)[0],

            # 車体
            "body_height": f('f', d, 0x38)[0],
            "car_max_speed": f('H', d, 0x8C)[0],
            "oil_pressure": f('f', d, 0x54)[0],

            # 燃料
            "current_fuel": f('f', d, 0x44)[0],
            "fuel_capacity": f('f', d, 0x48)[0],

            # ブースト
            "boost": f('f', d, 0x50)[0] - 1,

            # トランスミッション
            "transmission_max_speed": f('f', d, 0x100)[0],

            # ギア比 [1st - 8th]
            "gear_ratios": [f('f', d, 0x104 + i * 4)[0] for i in range(8)],

            # パッケージID
            "package_id": f('i', d, 0x70)[0],

            # ラップ
            "lap_count": f('h', d, 0x74)[0],
            "total_laps": f('h', d, 0x76)[0],
            "best_laptime": f('i', d, 0x78)[0],
            "last_laptime": f('i', d, 0x7C)[0],
            "current_laptime": f('i', d, 0x80)[0],

            # レース (スタート前のみ有効、開始後は-1)
            "pre_race_position": pre_race_position if pre_race_position >= 0 else None,
            "num_cars_pre_race": num_cars_pre_race if num_cars_pre_race >= 0 else None,

            # フラグ
            "flags": {
                "car_on_track": bool(flags_raw & 0x0001),
                "paused": bool(flags_raw & 0x0002),
                "loading": bool(flags_raw & 0x0004),
                "in_gear": bool(flags_raw & 0x0008),
                "has_turbo": bool(flags_raw & 0x0010),
                "rev_limiter": bool(flags_raw & 0x0020),
                "hand_brake": bool(flags_raw & 0x0040),
                "lights": bool(flags_raw & 0x0080),
                "high_beams": bool(flags_raw & 0x0100),
                "low_beams": bool(flags_raw & 0x0200),
                "asm_active": bool(flags_raw & 0x0400),
                "tcs_active": bool(flags_raw & 0x0800),
            },

            # 車種
            "car_id": f('i', d, 0x124)[0],
        }

        # Packet B 拡張フィールド (316 bytes以上)
        if len(d) >= 0x13C:
            result["wheel_rotation"] = f('f', d, 0x128)[0]
            result["body_accel_sway"] = f('f', d, 0x130)[0]
            result["body_accel_heave"] = f('f', d, 0x134)[0]
            result["body_accel_surge"] = f('f', d, 0x138)[0]

        # Packet ~ 拡張フィールド (344 bytes以上)
        if len(d) >= 0x158:
            result["throttle_filtered_pct"] = f('B', d, 0x13C)[0] / 2.55
            result["brake_filtered_pct"] = f('B', d, 0x13D)[0] / 2.55
            result["torque_vector"] = [f('f', d, 0x140 + i * 4)[0] for i in range(4)]
            result["energy_recovery"] = f('f', d, 0x150)[0]

        return result
