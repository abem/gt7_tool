import asyncio
import json
import websockets
import os
from telemetry import GT7TelemetryClient
from decoder import GT7Decoder

# Load Config
def load_config():
    # Allow Env Var override for PS5_IP
    with open('config.json', 'r') as f:
        cfg = json.load(f)
        if os.getenv("PS5_IP"):
            cfg["ps5_ip"] = os.getenv("PS5_IP")
        return cfg

CONFIG = load_config()

async def broadcast_handler(websocket):
    print(f"Client connected. Starting stream...")
    
    client = GT7TelemetryClient(
        CONFIG["ps5_ip"], 
        CONFIG["gt7_port"], 
        CONFIG["heartbeat_interval"]
    )
    decoder = GT7Decoder('packet_def.json')

    try:
        while True:
            # 1. Maintain Connection (Heartbeat)
            client.send_heartbeat()

            # 2. Receive Data
            # Note: In async loop, blocking recv needs care. 
            # Using simple non-blocking/timeout pattern here.
            raw_data = client.receive()

            if raw_data:
                # 3. Decrypt & Parse
                decrypted = decoder.decrypt(raw_data)
                if decrypted:
                    parsed_data = decoder.parse(decrypted)
                    
                    # 4. Send to Web Client
                    await websocket.send(json.dumps(parsed_data))
            
            # Small yield to prevent CPU hogging
            await asyncio.sleep(0.001)

    except websockets.exceptions.ConnectionClosed:
        print("Client disconnected")
    except Exception as e:
        print(f"Stream Error: {e}")
    finally:
        client.close()

async def main():
    port = CONFIG["ws_port"]
    print(f"Starting GT7 Dashboard Server on port {port}...")
    async with websockets.serve(broadcast_handler, "0.0.0.0", port):
        await asyncio.Future()  # Run forever

if __name__ == "__main__":
    asyncio.run(main())
