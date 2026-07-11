"""
GT7デコーダーモジュール

PS5からの暗号化テレメトリーパケットを復号し、解析します。
gt7dashboardの実装を参考にしています。
"""

import struct
import json
import math
import os
import logging

# NOTE: Crypto (pycryptodome) は GT7Decoder の復号処理でのみ必要。
# CourseEstimator は Crypto に非依存なため、トップレベル import を避け
# _try_decrypt 内で遅延 import する。これにより Crypto 未導入環境でも
# `import decoder` が成功し、CourseEstimator/テストが利用可能になる。

logger = logging.getLogger(__name__)


class CourseEstimator:
    """位置座標からコースを推定するクラス。

    main.py が全テレメトリパケットで estimate_course() を呼び、
    結果を course フィールドとして WebSocket クライアントへ配信している。
    """

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
        """位置座標(x, z)からコースを推定

        known_courses と courses(自動収集)を統合し、(x, z) を内包する
        全候補を収集する。bounds 面積が最小=最も具体的なコースを選ぶ。
        fallback:true の超広域ボックス(real_track 等)は通常候補から分離し、
        他に候補が一切無い時のみ低 confidence で返す(シャドウイング解消)。

        戻り値キー (id, name, name_en, name_ja, confidence) は後方互換を維持。
        confidence は 0.0..1.0。
        """
        candidates = []  # 通常候補(具体コース): (area, origin_rank, origin, course)
        fallbacks = []   # fallback:true の巨大ボックス: (area, origin, course)

        # known_courses(origin='known') と courses(origin='auto') を一つに集約。
        # known を先に無条件 return する旧構造は廃止(シャドウの元凶)。
        for origin, course_list in (('known', self.known_courses), ('auto', self.courses)):
            for course in course_list:
                bounds = course.get('bounds', {})
                if not self._point_in_bounds(x, z, bounds):
                    continue
                area = self._bounds_area(bounds)
                if course.get('fallback') is True:
                    fallbacks.append((area, origin, course))
                else:
                    # 面積が小さいほど具体的。同面積なら known を auto より優先。
                    origin_rank = 0 if origin == 'known' else 1
                    candidates.append((area, origin_rank, origin, course))

        if candidates:
            area, _origin_rank, origin, course = min(candidates, key=lambda c: (c[0], c[1]))
            return self._build_result(course, origin, area, is_fallback=False)

        if fallbacks:
            area, origin, course = min(fallbacks, key=lambda c: c[0])
            return self._build_result(course, origin, area, is_fallback=True)

        return {"id": "unknown", "name": "Unknown Track", "confidence": 0}

    @staticmethod
    def _build_result(course, origin, area, is_fallback):
        """選択されたコースから戻り値 dict を構築し confidence を導出"""
        verified = course.get('verified', False)
        if is_fallback:
            confidence = 0.2
        elif verified:
            confidence = 0.9
        else:
            # 推測 bounds(未検証)。面積が小さいほど具体的→やや高め。
            # area<=250000 で 0.7、area>=2,250,000 で 0.4 になる線形。0.4..0.7 にクランプ。
            confidence = 0.7 - (area - 250000) / 4_000_000
            confidence = max(0.4, min(0.7, confidence))

        # UI 契約(websocket.js): id と name は必須。unknown 時は id='unknown'。
        return {
            "id": course.get('id', 'unknown'),
            "name": course.get('name', 'Unknown'),
            "name_en": course.get('name_en', ''),
            "name_ja": course.get('name_ja', ''),
            "confidence": round(confidence, 3),
            "verified": verified,
            "source": 'fallback' if is_fallback else origin,  # 'known'|'auto'|'fallback'
        }

    @staticmethod
    def _bounds_valid(bounds):
        """bounds が4キー全てを持つ有効な矩形かを判定"""
        return bool(bounds) and all(
            k in bounds for k in ('min_x', 'max_x', 'min_z', 'max_z')
        )

    @staticmethod
    def _point_in_bounds(x, z, bounds):
        # 空 dict やキー欠損の bounds は「マッチしない」(旧実装の全マッチ防止)。
        if not CourseEstimator._bounds_valid(bounds):
            return False
        return (
            bounds['min_x'] <= x <= bounds['max_x']
            and bounds['min_z'] <= z <= bounds['max_z']
        )

    @staticmethod
    def _bounds_area(bounds):
        """bounds の面積 (max_x-min_x)*(max_z-min_z) を返す"""
        return (bounds['max_x'] - bounds['min_x']) * (bounds['max_z'] - bounds['min_z'])


class GT7Decoder:
    """GT7テレメトリーパケットの復号と解析"""

    SALSA20_KEY = b'Simulator Interface Packet GT7 ver 0.0'
    MAGIC_G7S0 = 0x47375330
    MIN_PACKET_SIZE = 0x100
    MIN_PARSE_SIZE = 0x128  # 296 bytes (Packet A)

    # ペダル値(0-255)をパーセント(0-100)へ変換する除数 (255 / 100)
    PEDAL_PCT_DIVISOR = 2.55

    # ハートビートタイプ別XOR値
    XOR_MAP = {
        b'A': 0xDEADBEAF,
        b'B': 0xDEADBEEF,
        b'~': 0x55FABB4F,
    }

    def __init__(self, heartbeat_type=b'~'):
        self._parse_count = 0
        self.heartbeat_type = heartbeat_type
        self._xor_value = self.XOR_MAP.get(heartbeat_type, 0xDEADBEAF)

    def _try_decrypt(self, data: bytes, xor_value: int) -> bytes:
        """指定のXOR値でSalsa20復号を試行"""
        # 遅延 import: CourseEstimator は Crypto 非依存のため、復号時のみ読み込む。
        # これにより Crypto 未導入環境でも `import decoder` が成功する。
        from Crypto.Cipher import Salsa20
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

            # コース推定はmain.pyで実行
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
    def _quat(d, f):
        """パケットから単位クォータニオン (x, y, z, w) を読む"""
        return (f('f', d, 0x1C)[0], f('f', d, 0x20)[0], f('f', d, 0x24)[0], f('f', d, 0x28)[0])

    @staticmethod
    def _quat_pitch(d, f):
        x, y, z, w = GT7Decoder._quat(d, f)
        fy = 2 * (y * z - w * x)                       # 車体前方ベクトルの上下成分
        return -math.asin(max(-1.0, min(1.0, fy)))     # 正=機首上げ

    @staticmethod
    def _quat_yaw(d, f):
        x, y, z, w = GT7Decoder._quat(d, f)
        fx = 2 * (x * z + w * y)
        fz = 1 - 2 * (x * x + y * y)
        return math.atan2(-fx, -fz)                    # 前方=-Z 規約。±π, 0=北

    @staticmethod
    def _quat_roll(d, f):
        x, y, z, w = GT7Decoder._quat(d, f)
        ry = 2 * (x * y + w * z)                       # 車体右ベクトルの上下成分
        return math.asin(max(-1.0, min(1.0, ry)))      # 正=右ロール

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
            "throttle_pct": f('B', d, 0x91)[0] / GT7Decoder.PEDAL_PCT_DIVISOR,
            "brake": f('B', d, 0x92)[0],
            "brake_pct": f('B', d, 0x92)[0] / GT7Decoder.PEDAL_PCT_DIVISOR,

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

            # 回転: 真のオイラー角(rad)。パケット 0x1C-0x28 はオイラー角ではなく
            # 単位クォータニオン(x,y,z,w) — 実走2万フレームで x²+y²+z²+w²=1.0000 を確認。
            # 旧実装は成分をラジアン扱いしており、yaw は無意味な値・pitch/roll は約半分だった。
            # 検証: yaw は速度ベクトル方位と中央値0.18°で一致 / corr(sin(pitch), vy/v)=+0.97 /
            #       roll は右輪サス圧縮差と正相関(17万フレーム)。
            "rotation_pitch": GT7Decoder._quat_pitch(d, f),   # 正=機首上げ
            "rotation_yaw": GT7Decoder._quat_yaw(d, f),       # 世界ヘディング ±π(0=北)
            "rotation_roll": GT7Decoder._quat_roll(d, f),     # 正=右ロール

            # 方角 = クォータニオン w 成分 (1.0=北, 0.0=南)。HDG 表示が使用。
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
            result["throttle_filtered_pct"] = f('B', d, 0x13C)[0] / GT7Decoder.PEDAL_PCT_DIVISOR
            result["brake_filtered_pct"] = f('B', d, 0x13D)[0] / GT7Decoder.PEDAL_PCT_DIVISOR
            result["torque_vector"] = [f('f', d, 0x140 + i * 4)[0] for i in range(4)]
            result["energy_recovery"] = f('f', d, 0x150)[0]

        return result
