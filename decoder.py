"""
GT7デコーダーモジュール

PS5からの暗号化テレメトリーパケットを復号し、解析します。
gt7dashboardの実装を参考にしています。
"""

import struct
import json
import os
from Crypto.Cipher import Salsa20


class CourseEstimator:
    """位置座標からコースを推定するクラス"""

    def __init__(self, db_file='course_database.json'):
        """
        コース推定器を初期化します

        Args:
            db_file: コースデータベースファイルのパス
        """
        self.courses = []
        self.load_database(db_file)

    def load_database(self, db_file):
        """
        コースデータベースを読み込みます

        Args:
            db_file: コースデータベースファイルのパス
        """
        try:
            if os.path.exists(db_file):
                with open(db_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    # 既存のコースと既知のコースの両方を読み込む
                    self.courses = data.get('courses', [])
                    self.known_courses = data.get('known_courses', [])
                    self.test_mode = data.get('test_mode', {})
                print(f"[COURSE_DB] Loaded {len(self.courses)} auto-generated courses from {db_file}")
                print(f"[COURSE_DB] Loaded {len(self.known_courses)} known courses")
            else:
                print(f"[COURSE_DB] Database file not found: {db_file}")
                self.courses = []
                self.known_courses = []
                self.test_mode = {}
        except Exception as e:
            print(f"[COURSE_DB] Error loading database: {e}")
            self.courses = []
            self.known_courses = []
            self.test_mode = {}

    def estimate_course(self, x, z):
        """
        位置座標からコースを推定します

        Args:
            x: X座標
            z: Z座標

        Returns:
            推定されたコース情報（辞書形式）
        """
        # まず既知のコースをチェック
        if self.known_courses:
            for course in self.known_courses:
                bounds = course.get('bounds', {})
                min_x = bounds.get('min_x', -99999)
                max_x = bounds.get('max_x', 99999)
                min_z = bounds.get('min_z', -99999)
                max_z = bounds.get('max_z', 99999)

                if min_x <= x <= max_x and min_z <= z <= max_z:
                    return {
                        "id": course.get('id', 'unknown'),
                        "name": course.get('name', 'Unknown'),
                        "name_en": course.get('name_en', ''),
                        "name_ja": course.get('name_ja', ''),
                        "confidence": 1.0
                    }

        # 次に自動生成コースをチェック
        if self.courses:
            for course in self.courses:
                bounds = course.get('bounds', {})
                min_x = bounds.get('min_x', -99999)
                max_x = bounds.get('max_x', 99999)
                min_z = bounds.get('min_z', -99999)
                max_z = bounds.get('max_z', 99999)

                if min_x <= x <= max_x and min_z <= z <= max_z:
                    return {
                        "id": course.get('id', 'unknown'),
                        "name": course.get('name', 'Unknown'),
                        "description": course.get('description', ''),
                        "confidence": 0.8
                    }

        # マッチするコースがない場合
        return {"id": "unknown", "name": "Unknown Track", "confidence": 0}

    def update_database_from_data(self, data_points, course_id, course_name):
        """
        テレメトリーデータからコースデータベースを更新します

        Args:
            data_points: 位置座標のリスト [{'x': ..., 'z': ...}, ...]
            course_id: コースID
            course_name: コース名
        """
        if not data_points:
            return

        x_values = [p['x'] for p in data_points]
        z_values = [p['z'] for p in data_points]

        # 既存のコースを探す
        existing_course = None
        for course in self.courses:
            if course.get('id') == course_id:
                existing_course = course
                break

        bounds = {
            'min_x': min(x_values),
            'max_x': max(x_values),
            'min_z': min(z_values),
            'max_z': max(z_values)
        }

        if existing_course:
            # 既存のコースを更新
            existing_course['bounds'] = bounds
            print(f"[COURSE_DB] Updated course: {course_name}")
        else:
            # 新しいコースを追加
            new_course = {
                'id': course_id,
                'name': course_name,
                'bounds': bounds
            }
            self.courses.append(new_course)
            print(f"[COURSE_DB] Added new course: {course_name}")

    def save_database(self, db_file='course_database.json'):
        """
        コースデータベースを保存します

        Args:
            db_file: 保存先ファイルパス
        """
        try:
            data = {
                'courses': self.courses,
                'metadata': {
                    'version': '1.0.0',
                    'description': 'GT7コースデータベース - 位置座標(x, z)からコースを推定',
                    'note': '座標範囲は実際のテレメトリーデータから収集して更新してください'
                }
            }
            with open(db_file, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=4)
            print(f"[COURSE_DB] Saved {len(self.courses)} courses to {db_file}")
        except Exception as e:
            print(f"[COURSE_DB] Error saving database: {e}")


class GT7Decoder:
    """GT7テレメトリーパケットの復号と解析"""

    def __init__(self, def_file='packet_def.json', course_db='course_database.json'):
        """
        デコーダーを初期化します

        Args:
            def_file: パケット定義ファイルのパス
            course_db: コースデータベースファイルのパス
        """
        self.key = b'Simulator Interface Packet GT7 ver 0.0'
        # packet_def.jsonがあれば読み込む
        try:
            with open(def_file, 'r') as f:
                self.definition = json.load(f)
        except:
            self.definition = {"fields": {}}

        # コース推定器を初期化
        self.course_estimator = CourseEstimator(course_db)

        # ログ制御用
        self.parse_count = 0

    def decrypt(self, data: bytes) -> bytes:
        """
        GT7パケットを復号します
        gt7dashboardのsalsa20_dec関数と同じ実装

        Args:
            data: 暗号化されたパケット

        Returns:
            復号されたパケット（失敗時は空のbytes）
        """
        if len(data) < 0x100:
            print(f"[DECRYPT] Packet too small: {len(data)} bytes")
            return b''

        # gt7dashboardと同じIV生成方法
        # Seed IV is always located here
        oiv = data[0x40:0x44]
        iv1 = int.from_bytes(oiv, byteorder='little')
        # Notice DEADBEAF, not DEADBEEF
        iv2 = iv1 ^ 0xDEADBEAF
        iv = bytearray()
        iv.extend(iv2.to_bytes(4, 'little'))
        iv.extend(iv1.to_bytes(4, 'little'))

        try:
            cipher = Salsa20.new(self.key[0:32], bytes(iv))
            ddata = cipher.decrypt(data)
            magic = int.from_bytes(ddata[0:4], byteorder='little')
            if magic != 0x47375330:  # "G7S0"
                print(f"[DECRYPT] Invalid magic: 0x{magic:08X}")
                return b''
            return ddata
        except Exception as e:
            print(f"[ERROR] Decryption Error: {e}")
            return b''

    def parse(self, decrypted_data: bytes) -> dict:
        """
        復号されたパケットを解析します
        gt7dashboardのGTDataクラスと同じフィールドを抽出

        Args:
            decrypted_data: 復号されたパケット

        Returns:
            解析されたデータ
        """
        if not decrypted_data or len(decrypted_data) < 0x128:  # 296バイト以上必要
            print(f"[PARSE] Data too small: {len(decrypted_data)} bytes")
            return None

        try:
            result = {}

            # 基本データ
            result["speed_ms"] = struct.unpack('f', decrypted_data[0x4C:0x4C + 4])[0]
            result["speed_kmh"] = result["speed_ms"] * 3.6

            result["rpm"] = struct.unpack('f', decrypted_data[0x3C:0x3C + 4])[0]
            result["max_rpm"] = 9000  # 固定値（実際の車種によって異なる）

            # ギア
            gear_byte = struct.unpack('B', decrypted_data[0x90:0x90 + 1])[0]
            result["gear"] = gear_byte & 0x0F
            result["gear_byte"] = gear_byte

            # スロットルとブレーキ
            result["throttle"] = struct.unpack('B', decrypted_data[0x91:0x91 + 1])[0]
            result["throttle_pct"] = result["throttle"] / 2.55
            result["brake"] = struct.unpack('B', decrypted_data[0x92:0x92 + 1])[0]
            result["brake_pct"] = result["brake"] / 2.55

            # タイヤ温度
            result["tyre_temp"] = [
                struct.unpack('f', decrypted_data[0x60:0x60 + 4])[0],  # FL
                struct.unpack('f', decrypted_data[0x64:0x64 + 4])[0],  # FR
                struct.unpack('f', decrypted_data[0x68:0x68 + 4])[0],  # RL
                struct.unpack('f', decrypted_data[0x6C:0x6C + 4])[0],  # RR
            ]

            # タイヤ圧（byte値をbarに変換）
            result["tyre_pressure"] = [
                struct.unpack('B', decrypted_data[0x94:0x94 + 1])[0] / 4.0,  # FL
                struct.unpack('B', decrypted_data[0x95:0x95 + 1])[0] / 4.0,  # FR
                struct.unpack('B', decrypted_data[0x96:0x96 + 1])[0] / 4.0,  # RL
                struct.unpack('B', decrypted_data[0x97:0x97 + 1])[0] / 4.0,  # RR
            ]

            # サスペンション高さ
            result["susp_height"] = [
                struct.unpack('f', decrypted_data[0xC4:0xC4 + 4])[0],  # FL
                struct.unpack('f', decrypted_data[0xC8:0xC8 + 4])[0],  # FR
                struct.unpack('f', decrypted_data[0xCC:0xCC + 4])[0],  # RL
                struct.unpack('f', decrypted_data[0xD0:0xD0 + 4])[0],  # RR
            ]

            # タイヤ半径
            result["tyre_radius"] = [
                struct.unpack('f', decrypted_data[0xB4:0xB4 + 4])[0],  # FL
                struct.unpack('f', decrypted_data[0xB8:0xB8 + 4])[0],  # FR
                struct.unpack('f', decrypted_data[0xBC:0xBC + 4])[0],  # RL
                struct.unpack('f', decrypted_data[0xC0:0xC0 + 4])[0],  # RR
            ]

            # ホイールRPS
            result["wheel_rps"] = [
                struct.unpack('f', decrypted_data[0xA4:0xA4 + 4])[0],  # FL
                struct.unpack('f', decrypted_data[0xA8:0xA8 + 4])[0],  # FR
                struct.unpack('f', decrypted_data[0xAC:0xAC + 4])[0],  # RL
                struct.unpack('f', decrypted_data[0xB0:0xB0 + 4])[0],  # RR
            ]

            # 加速度 - GT7テレメトリにはリアルタイム加速度データが含まれていないようです
            # 速度から計算可能ですが、実装していません
            # result["accel_x"] = 0.0  # 前後
            # result["accel_y"] = 0.0  # 左右
            # result["accel_z"] = 0.0  # 上下

            # 位置情報
            result["position_x"] = struct.unpack('f', decrypted_data[0x04:0x04 + 4])[0]
            result["position_y"] = struct.unpack('f', decrypted_data[0x08:0x08 + 4])[0]
            result["position_z"] = struct.unpack('f', decrypted_data[0x0C:0x0C + 4])[0]

            # 燃料
            result["current_fuel"] = struct.unpack('f', decrypted_data[0x44:0x44 + 4])[0]
            result["fuel_capacity"] = struct.unpack('f', decrypted_data[0x48:0x48 + 4])[0]

            # ブースト
            result["boost"] = struct.unpack('f', decrypted_data[0x50:0x50 + 4])[0] - 1

            # パッケージID
            result["package_id"] = struct.unpack('i', decrypted_data[0x70:0x70 + 4])[0]

            # ラップデータ
            result["lap_count"] = struct.unpack('h', decrypted_data[0x74:0x74 + 2])[0]
            result["total_laps"] = struct.unpack('h', decrypted_data[0x76:0x76 + 2])[0]
            result["best_laptime"] = struct.unpack('i', decrypted_data[0x78:0x78 + 4])[0]
            result["last_laptime"] = struct.unpack('i', decrypted_data[0x7C:0x7C + 4])[0]

            # 車種ID
            result["car_id"] = struct.unpack('i', decrypted_data[0x124:0x124 + 4])[0]

            # 最初の数回のみログ
            self.parse_count += 1

            if self.parse_count <= 3:
                print(f"[PARSE] Success! Speed: {result['speed_kmh']:.1f} km/h, RPM: {result['rpm']:.0f}, Gear: {result['gear']}")
            elif self.parse_count == 4:
                print("[PARSE] Receiving data... (suppressing further logs)")

            return result

        except Exception as e:
            print(f"[ERROR] Parse Error: {e}")
            return None
