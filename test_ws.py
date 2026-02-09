#!/usr/bin/env python3
"""Simple WebSocket test client"""
import asyncio
import websockets
import json

async def test_websocket():
    uri = "ws://localhost:8080/ws"
    print(f"Connecting to {uri}...")

    try:
        async with websockets.connect(uri) as ws:
            print("Connected!")

            # メッセージを5つ受信
            for i in range(5):
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    data = json.loads(msg)
                    print(f"Message {i+1}: Speed={data.get('speed_kmh', 0):.1f} km/h, RPM={data.get('rpm', 0):.0f}, Gear={data.get('gear', 0)}")
                except asyncio.TimeoutError:
                    print(f"Timeout waiting for message {i+1}")
                    break

            print("Test complete!")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(test_websocket())
