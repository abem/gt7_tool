import struct
import json
from salsa20 import Salsa20_xor

class GT7Decoder:
    def __init__(self, def_file='packet_def.json'):
        self.key = b'Simulator Interface Packet GT7 ver 0.0'
        with open(def_file, 'r') as f:
            self.definition = json.load(f)

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
            # Add more types (int, short) as needed

        # Computed values / Post-processing
        result["speed_kmh"] = result.get("speed_ms", 0) * 3.6
        result["throttle_pct"] = result.get("throttle", 0) / 2.55
        result["brake_pct"] = result.get("brake", 0) / 2.55

        # Gear logic (masking)
        # Note: Gear logic might need specific adjustment if it shares byte with brake
        # For simplicity, using simple mask if defined
        if "gear_byte" in result:
             result["gear"] = result["gear_byte"] & 0x0F

        return result
