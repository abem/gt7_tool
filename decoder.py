"""
GT7デコーダーモジュール

PS5からの暗号化テレメトリーパケットを復号し、解析します。
"""

import struct
import json
from salsa20 import Salsa20_xor
from math_utils import calculate_slip_ratio, calculate_load_ratio, get_temp_color
from tyre_helper import TyreHistory


class GT7Decoder:
    """GT7テレメトリーパケットの復号と解析"""

    def __init__(self, def_file='packet_def.json', max_history: int = 10):
        """
        デコーダーを初期化します

        Args:
            def_file: パケット定義ファイルのパス
            max_history: タイヤ温度履歴の最大数
        """
        self.key = b'Simulator Interface Packet GT7 ver 0.0'
        with open(def_file, 'r') as f:
            self.definition = json.load(f)
        self.tyre_history = TyreHistory(max_history)

    def decrypt(self, data: bytes) -> bytes:
        """
        GT7パケットを復号します

        Args:
            data: 暗号化されたパケット

        Returns:
            復号されたパケット
        """
        if len(data) < 0x100:
            return None

        # IV generation from nonces
        nonce1 = struct.unpack('<I', data[0x40:0x44])[0]
        nonce2 = struct.unpack('<I', data[0x44:0x48])[0]
        iv = struct.pack('<I', nonce2 ^ 0xDEADBEAF) + struct.pack('<I', nonce1 ^ 0xDEADBEAF)

        try:
            return Salsa20_xor(data[0:0x198], bytes(8), self.key[0:32])
        except Exception as e:
            print(f"Decryption Error: {e}")
            return None

    def parse(self, decrypted_data: bytes) -> dict:
        """
        復号されたパケットを解析します

        Args:
            decrypted_data: 復号されたパケット

        Returns:
            解析されたデータ
        """
        if not decrypted_data:
            return None

        result = {}
        fields = self.definition.get("fields", {})

        # 各フィールドを解析
        for name, meta in fields.items():
            offset = int(meta["offset"], 16)
            data_type = meta["type"]

            if data_type == "float":
                val = struct.unpack('<f', decrypted_data[offset:offset+4])[0]
                result[name] = val
            elif data_type == "byte":
                val = decrypted_data[offset]
                result[name] = val
            elif data_type == "array_float":
                # フロート配列の処理（タイヤ温度など）
                array_len = meta["length"]
                array_data = []
                for i in range(array_len):
                    val = struct.unpack('<f', decrypted_data[offset + (i * 4):offset + ((i + 1) * 4)])[0]
                    array_data.append(val)
                result[name] = array_data

        # 計算値の処理
        result["speed_kmh"] = result.get("speed_ms", 0) * 3.6
        result["throttle_pct"] = result.get("throttle", 0) / 2.55
        result["brake_pct"] = result.get("brake", 0) / 2.55

        # ギアロジック
        if "gear_byte" in result:
            result["gear"] = result["gear_byte"] & 0x0F

        # タイヤスリップ率と接地率の計算
        result["slip_ratio"] = []
        result["load_ratio"] = []
        result["brake_temp"] = []

        if "wheel_rps" in result and "speed_ms" in result:
            wheel_rps = result["wheel_rps"]
            speed_ms = result["speed_ms"]

            # 各タイヤのスリップ率を計算
            for i, rps in enumerate(wheel_rps):
                wheel_kmh = rps * 2 * 3.14159 * result.get("tyre_radius", [0.3])[i] * 3.6
                slip_ratio = calculate_slip_ratio(wheel_kmh, speed_ms * 3.6)
                result["slip_ratio"].append(slip_ratio)

        # 接地率の計算
        if "susp_height" in result:
            for i, height in enumerate(result["susp_height"]):
                load_ratio = calculate_load_ratio(height)
                result["load_ratio"].append(load_ratio)

        # ブレーキ温度
        if "brake_temp" in result:
            result["brake_temp"] = result["brake_temp"]

        # タイヤ温度履歴を保存
        if "tyre_temp" in result:
            self.tyre_history.add(result["tyre_temp"])

        return result
