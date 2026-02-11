# GT7 Tool APIドキュメント

## 概要

GT7 Toolは、GT7（グランツーリスモ7）からのテレメトリデータを受信・解析・配信するためのAPIを提供します。

## アーキテクチャ

```
PS5 (GT7) --[UDP]--> Python Backend --[WebSocket]--> Web Dashboard
                      |-- Salsa20復号
                      |-- データ解析
                      |-- コース推定
                      |-- データ保存
```

## HTTP API

### エンドポイント一覧

| エンドポイント | メソッド | 説明 |
|---------------|---------|------|
| `/` | GET | メインダッシュボード (HTML) |
| `/ws` | GET | WebSocket接続エンドポイント |
| `/debug` | GET | デバッグ情報 (JSON) |
| `/{filename}` | GET | 静的ファイル配信 |

### 1. メインダッシュボード `/`

**メソッド:** GET

**説明:** メインのウェブダッシュボードを返します

**レスポンス:**
- **Content-Type:** `text/html`
- **ステータス:** 200 OK

**例:**
```bash
curl http://localhost:8080/
```

### 2. WebSocketエンドポイント `/ws`

**メソッド:** WebSocket (GET)

**説明:** テレメトリデータのリアルタイムストリームを受信します

**接続例:**
```javascript
const ws = new WebSocket('ws://localhost:8080/ws');

ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    console.log(data);
};
```

**メッセージ形式 (受信データ):**
```json
{
    "speed_kmh": 150.5,
    "speed_ms": 41.8,
    "rpm": 6500.0,
    "max_rpm": 9000,
    "gear": 4,
    "throttle": 128,
    "throttle_pct": 50.2,
    "brake": 0,
    "brake_pct": 0.0,
    "tyre_temp": [75.5, 76.2, 78.1, 77.8],
    "susp_height": [0.05, 0.04, 0.06, 0.05],
    "tyre_radius": [0.32, 0.32, 0.32, 0.32],
    "wheel_rps": [25.5, 25.3, 26.1, 25.8],
    "position_x": 100.5,
    "position_y": 0.0,
    "position_z": -200.3,
    "course": {
        "id": "suzuka",
        "name": "スズカ サーキット",
        "confidence": 1.0
    },
    "current_fuel": 45.5,
    "fuel_capacity": 100.0,
    "boost": 0.0,
    "package_id": 12345,
    "lap_count": 2,
    "total_laps": 5,
    "best_laptime": 90500,
    "last_laptime": 92100,
    "car_id": 2182,
    "timestamp": "2026-02-11T16:30:45.123456"
}
```

**データフィールド詳細:**

| フィールド | 型 | 説明 |
|-----------|------|------|
| `speed_kmh` | float | 速度 (km/h) |
| `speed_ms` | float | 速度 (m/s) |
| `rpm` | float | エンジン回転数 |
| `max_rpm` | int | 最大回転数 |
| `gear` | int | ギア位置 (0=R, 1-6, N=ニュートラル) |
| `throttle` | int | スロットル生値 (0-255) |
| `throttle_pct` | float | スロットル百分比 (0-100) |
| `brake` | int | ブレーキ生値 (0-255) |
| `brake_pct` | float | ブレーキ百分比 (0-100) |
| `tyre_temp` | array[4] | タイヤ温度 [FL, FR, RL, RR] (C) |
| `susp_height` | array[4] | サスペンション高さ [FL, FR, RL, RR] (m) |
| `tyre_radius` | array[4] | タイヤ半径 [FL, FR, RL, RR] (m) |
| `wheel_rps` | array[4] | ホイール回転数/秒 [FL, FR, RL, RR] |
| `position_x` | float | X座標 (m) |
| `position_y` | float | Y座標 (m) - 高さ |
| `position_z` | float | Z座標 (m) |
| `course` | object | コース情報 (推定) |
| `current_fuel` | float | 現在の燃料残量 (L) |
| `fuel_capacity` | float | 燃料タンク容量 (L) |
| `boost` | float | ブースト圧 (bar-1) |
| `package_id` | int | パッケージID (重複検出用) |
| `lap_count` | int | 現在のラップ数 |
| `total_laps` | int | 総ラップ数 |
| `best_laptime` | int | ベストラップタイム (ms) |
| `last_laptime` | int | 前回のラップタイム (ms) |
| `car_id` | int | 車種ID |
| `timestamp` | string | ISO 8601形式のタイムスタンプ |

### 3. デバッグエンドポイント `/debug`

**メソッド:** GET

**説明:** サーバーの診断情報を返します

**レスポンス例:**
```json
{
    "current_working_directory": "/app",
    "app_directory": "/app",
    "files": [
        {
            "name": "index.html",
            "path": "/app/index.html",
            "exists": true,
            "size": 59037,
            "is_directory": false,
            "is_file": true
        }
    ],
    "index_html_preview": {
        "path": "/app/index.html",
        "first_200_bytes": "...",
        "first_200_bytes_utf8": "<!DOCTYPE html>...",
        "bytes_read": 200
    },
    "errors": []
}
```

## PythonモジュールAPI

### GT7TelemetryClientクラス

**ファイル:** `telemetry.py`

GT7からのUDP通信を管理するクラスです。

**コンストラクタ:**
```python
def __init__(self, ip: str, send_port: int = 33739,
             receive_port: int = 33740, heartbeat_interval: int = 10)
```

**引数:**
- `ip`: PS5のIPアドレス
- `send_port`: 送信ポート (デフォルト: 33739)
- `receive_port`: 受信ポート (デフォルト: 33740)
- `heartbeat_interval`: ハートビート間隔 (秒)

**メソッド:**

| メソッド | 説明 |
|---------|------|
| `send_heartbeat()` | PS5にハートビートパケットを送信 |
| `receive()` | テレメトリパケットを受信 (bytes or None) |
| `close()` | ソケットを閉じる |

**使用例:**
```python
from telemetry import GT7TelemetryClient

client = GT7TelemetryClient("192.168.1.10")
client.send_heartbeat()
data = client.receive()
if data:
    print(f"Received {len(data)} bytes")
client.close()
```

### GT7Decoderクラス

**ファイル:** `decoder.py`

GT7テレメトリパケットの復号と解析を行うクラスです。

**コンストラクタ:**
```python
def __init__(self, def_file: str = 'packet_def.json',
             course_db: str = 'course_database.json')
```

**引数:**
- `def_file`: パケット定義ファイルのパス
- `course_db`: コースデータベースファイルのパス

**メソッド:**

| メソッド | 説明 | 戻り値 |
|---------|------|--------|
| `decrypt(data: bytes)` | Salsa20でパケットを復号 | bytes (復号失敗時は空) |
| `parse(decrypted_data: bytes)` | 復号データを解析 | dict or None |

**使用例:**
```python
from decoder import GT7Decoder

decoder = GT7Decoder()
raw_data = client.receive()
decrypted = decoder.decrypt(raw_data)
if decrypted:
    parsed = decoder.parse(decrypted)
    print(f"Speed: {parsed['speed_kmh']} km/h")
    print(f"Course: {parsed['course']['name']}")
```

### CourseEstimatorクラス

**ファイル:** `decoder.py`

位置座標からコースを推定するクラスです。

**コンストラクタ:**
```python
def __init__(self, db_file: str = 'course_database.json')
```

**メソッド:**

| メソッド | 説明 | 戻り値 |
|---------|------|--------|
| `load_database(db_file)` | コースデータベースを読み込み | None |
| `estimate_course(x, z)` | 座標からコースを推定 | dict |
| `update_database_from_data(data_points, course_id, course_name)` | データからコース情報を更新 | None |
| `save_database(db_file)` | コースデータベースを保存 | None |

**使用例:**
```python
from decoder import CourseEstimator

estimator = CourseEstimator('course_database.json')
course_info = estimator.estimate_course(100.5, -200.3)
print(f"Course: {course_info['name']}")
print(f"Confidence: {course_info['confidence']}")
```

## コースデータベースAPI

### データベース構造

`course_database.json` の構造:

```json
{
    "courses": [
        {
            "id": "suzuka",
            "name": "スズカ サーキット",
            "name_en": "Suzuka Circuit",
            "name_ja": "鈴鹿サーキット",
            "bounds": {
                "min_x": -500.0,
                "max_x": 500.0,
                "min_z": -500.0,
                "max_z": 500.0
            }
        }
    ],
    "known_courses": [
        {
            "id": "daytona",
            "name": "デイトナ・インターナショナル・スピードウェイ",
            "bounds": { ... }
        }
    ],
    "test_mode": {
        "demo_course": {
            "id": "demo",
            "name": "Demo Track"
        }
    },
    "metadata": {
        "version": "1.0.0",
        "description": "GT7コースデータベース"
    }
}
```

### 新しいコースを追加する

コースデータベースに新しいコースを追加するには、`test_course_detection.py` を使用します。

```bash
python3 test_course_detection.py --data-dir gt7data
```

または、手動で `course_database.json` を編集します。

## 設定ファイルAPI

### config.json

```json
{
    "ps5_ip": "192.168.1.10",
    "send_port": 33739,
    "receive_port": 33740,
    "http_port": 8080,
    "heartbeat_interval": 10
}
```

**環境変数による設定上書き:**

| 環境変数 | 説明 |
|---------|------|
| `PS5_IP` | PS5のIPアドレス |

**例:**
```bash
docker compose run -e PS5_IP=192.168.1.20 app
```

### packet_def.json

パケット定義ファイルは、テレメトリデータのオフセットとデータ型を定義します。

```json
{
    "fields": {
        "position_x": {"offset": "0x04", "type": "float"},
        "speed_ms": {"offset": "0x4C", "type": "float"},
        "rpm": {"offset": "0x3C", "type": "float"},
        "gear_byte": {"offset": "0x92", "type": "byte"},
        "tyre_temp": {"offset": "0x140", "type": "array_float", "length": 4}
    }
}
```

## エラーコード

| コード | 説明 |
|-------|------|
| 404 | ファイルが見つかりません |
| 500 | サーバー内部エラー |

## ログ形式

ログは標準出力に出力されます。

```
[PARSE] Success! Speed: 150.5 km/h, RPM: 6500, Gear: 4, Course: スズカ サーキット
[COURSE_DB] Loaded 100 courses from course_database.json
[Heartbeat] Sending to 192.168.1.10:33739 - waiting for data...
[RX] Started receiving 296 bytes from ('192.168.1.10', 33740)
```

## パケット復号仕様

GT7のテレメトリパケットはSalsa20で暗号化されています。

**暗号化キー:** `Simulator Interface Packet GT7 ver 0.0`

**IV生成方法:**
```python
# Seed IV is at offset 0x40
oiv = data[0x40:0x44]
iv1 = int.from_bytes(oiv, byteorder='little')
iv2 = iv1 ^ 0xDEADBEAF  # 注意: DEADBEAF ではなく DEADBEAF
iv = iv2.to_bytes(4, 'little') + iv1.to_bytes(4, 'little')
```

**マジックナンバー:** `0x47375330` ("G7S0")

## テストモードAPI

### TEST MODEの有効化

WebSocket接続後に、ダッシュボード上の「TEST MODE」ボタンをクリックすると、デモデータが表示されます。

**デモデータ生成:**
```javascript
const demoData = {
    position_x: point.x,
    position_y: 0,
    position_z: point.z,
    speed_kmh: point.speed,
    rpm: 3000 + Math.random() * 4000,
    gear: Math.floor(Math.random() * 6) + 1,
    throttle_pct: Math.random() * 100,
    brake_pct: Math.random() * 30,
    course: { name: 'スズカ サーキット (Demo)', confidence: 1.0 }
};
```

## ライセンス

MIT License
