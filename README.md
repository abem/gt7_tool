# GT7 Telemetry Dashboard

A real-time telemetry dashboard for Gran Turismo 7 using Python and WebSocket.
This tool captures telemetry packets from PS5/PS4, decrypts them (Salsa20), and broadcasts them to a web-based dashboard via WebSocket.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Python](https://img.shields.io/badge/python-3.11-blue.svg)

## Features
- **Real-time Data**: Speed, RPM, Gear, Throttle, Brake.
- **Web Dashboard**: Simple HTML/JS frontend (customizable).
- **Dockerized**: Easy setup with Docker Compose.
- **Configurable**: Packet definitions and network settings are separated in JSON files.

## Prerequisites
- PlayStation 4 or 5 with Gran Turismo 7
- Docker & Docker Compose

## Quick Start

1. **Configure IP Address**
   Edit `config.json` and set your PS5's IP address:
   ```json
   {
       "ps5_ip": "192.168.1.10",  <-- Change this
       "gt7_port": 33739,
       "ws_port": 8080,
       "heartbeat_interval": 10
   }
   ```

2. **Start the Server**
   ```bash
   docker compose up --build
   ```
   You should see `Client connected. Starting stream...` in the logs when the browser connects.

3. **Open Dashboard**
   Open `index.html` in your web browser.
   
   Example (Local file):
   `file:///path/to/gt7_tool/index.html`

## Architecture

- **`main.py`**: Entry point. Runs the WebSocket server (`asyncio` + `websockets`).
- **`telemetry.py`**: Handles UDP communication with PS5 (including Heartbeat `A` packets).
- **`decoder.py`**: Decrypts Salsa20 encrypted packets and parses fields based on `packet_def.json`.
- **`packet_def.json`**: Defines memory offsets and data types for telemetry fields.
- **`config.json`**: Network configuration.

## Customization

To add more data fields (e.g., Tire Temp, Fuel, Boost):

1. Find the offset in GT7 telemetry documentation (community resources).
2. Add the field to `packet_def.json`:
   ```json
   "boost_pressure": {"offset": "0x50", "type": "float"}
   ```
3. Update `index.html` to visualize the new data.

## Credits
This tool uses the Salsa20 decryption logic required for GT7/GT Sport telemetry.
Encryption key: `Simulator Interface Packet GT7 ver 0.0`

## License
MIT License
