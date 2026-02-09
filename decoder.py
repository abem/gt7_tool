import struct
import json
from salsa20 import Salsa20_xor

class GT7Decoder:
    def __init__(self, def_file='packet_def.json'):
        self.key = b'Simulator Interface Packet GT7 ver 0.0'
        with open(def_file, 'r') as f:
            self.definition = json.load(f)
        self.tyre_history = []  # タイヤ温度の履歴保存

    def decrypt(self, data):
        """Decrypts the GT7 packet using Salsa20"""
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

    def parse(self, decrypted_data):
        """Parses the decrypted data based on JSON definition"""
        if not decrypted_data:
            return None

        result = {}
        fields = self.definition.get("fields", {})

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
                # Handle float arrays (e.g., tyre temperature)
                array_len = meta["length"]
                array_data = []
                for i in range(array_len):
                    val = struct.unpack('<f', decrypted_data[offset + (i * 4):offset + ((i + 1) * 4)])[0]
                    array_data.append(val)
                result[name] = array_data

        # Computed values / Post-processing
        result["speed_kmh"] = result.get("speed_ms", 0) * 3.6
        result["throttle_pct"] = result.get("throttle", 0) / 2.55
        result["brake_pct"] = result.get("brake", 0) / 2.55

        # Gear logic (masking)
        if "gear_byte" in result:
             result["gear"] = result["gear_byte"] & 0x0F

        # タイヤスリップ率と接地率の計算
        result["slip_ratio"] = []
        result["load_ratio"] = []
        result["brake_temp"] = []

        if "wheel_rps" in result and "speed_ms" in result:
            wheel_rps = result["wheel_rps"]
            speed_ms = result["speed_ms"]
            # スリップ率: (wheelSpeed - vehicleSpeed) / max(wheelSpeed, vehicleSpeed)
            for i, rps in enumerate(wheel_rps):
                wheel_kmh = rps * 2 * 3.14159 * result.get("tyre_radius", [0.3])[i] * 3.6
                if wheel_kmh > speed_ms:
                    slip = (wheel_kmh - speed_ms) / wheel_kmh * 100
                else:
                    slip = 0
                result["slip_ratio"].append(min(max(slip, 0), 100))

        # 接地率: 1 - (suspensionTravel / maxTravel)
        # 最大サスペンションストロークは概ね50mmと仮定
        if "susp_height" in result:
            for i, height in enumerate(result["susp_height"]):
                max_travel = 50.0
                travel = (max_travel - height)  # サスペンションが伸びているほど接地率は低い
                load_ratio = 1 - (travel / max_travel)
                result["load_ratio"].append(min(max(load_ratio, 0), 1))

        # ブレーキ温度
        if "brake_temp" in result:
            for i, temp in enumerate(result["brake_temp"]):
                result["brake_temp"][i] = temp

        # タイヤ温度の履歴を保存（最新10点）
        if "tyre_temp" in result:
            tyre_temp = result["tyre_temp"]
            self.tyre_history.append(tyre_temp.copy())
            if len(self.tyre_history) > 10:
                self.tyre_history.pop(0)

        return result
