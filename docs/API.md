# GT7 Tool APIドキュメント

## 概要

GT7 Toolは、GT7（グランツーリスモ7）からのテレメトリデータを受信・解析・配信するためのAPIを提供します。

## アーキテクチャ

```
PS5 (GT7) --[UDP]--> Python Backend --[WebSocket]--> Web Dashboard
                      |-- Salsa20復号
                      |-- データ解析
                      |-- コース推定
                      |-- 燃料計算
                      |-- データ保存
```

## HTTP API

### エンドポイント一覧

| エンドポイント | メソッド | 説明 |
|---------------|---------|------|
| `/` | GET | メインダッシュボード (HTML) |
| `/ws` | GET | WebSocket接続エンドポイント |
| `/{filename}` | GET | 静的ファイル配信 |

### 1. メインダッシュボード `/`

**メソッド:** GET

**説明:** メインのウェブダッシュボードを返します

**レスポンス:**
- **Content-Type:** `text/html`
- **ステータス:** 200 OK

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
    "max_rpm": 8500,
    "rpm_alert_min": 7000,
    "gear": 4,
    "suggested_gear": 5,
    "throttle": 128,
    "throttle_pct": 50.2,
    "brake": 0,
    "brake_pct": 0.0,
    "clutch": 0.0,
    "clutch_engagement": 1.0,
    "clutch_gearbox_rpm": 6500.0,
    "tyre_temp": [75.5, 76.2, 78.1, 77.8],
    "susp_height": [0.05, 0.04, 0.06, 0.05],
    "tyre_radius": [0.32, 0.32, 0.32, 0.32],
    "wheel_rps": [25.5, 25.3, 26.1, 25.8],
    "road_plane_x": 0.0,
    "road_plane_y": 1.0,
    "road_plane_z": 0.0,
    "road_plane_distance": 0.33,
    "position_x": 100.5,
    "position_y": 0.0,
    "position_z": -200.3,
    "velocity_x": 10.5,
    "velocity_y": 0.1,
    "velocity_z": -30.2,
    "rotation_pitch": 0.01,
    "rotation_yaw": 0.95,
    "rotation_roll": -0.02,
    "orientation": 0.75,
    "angular_velocity_x": 0.0,
    "angular_velocity_y": 0.1,
    "angular_velocity_z": 0.0,
    "body_height": 0.12,
    "car_max_speed": 320,
    "oil_pressure": 5.2,
    "current_fuel": 45.5,
    "fuel_capacity": 100.0,
    "boost": 0.0,
    "transmission_max_speed": 3.45,
    "gear_ratios": [3.587, 2.022, 1.384, 1.000, 0.861, 0.725, 0.0, 0.0],
    "package_id": 12345,
    "lap_count": 2,
    "total_laps": 5,
    "best_laptime": 90500,
    "last_laptime": 92100,
    "current_laptime": 45230,
    "pre_race_position": 3,
    "num_cars_pre_race": 16,
    "flags": {
        "car_on_track": true,
        "paused": false,
        "loading": false,
        "in_gear": true,
        "has_turbo": true,
        "rev_limiter": false,
        "hand_brake": false,
        "lights": false,
        "high_beams": false,
        "low_beams": false,
        "asm_active": false,
        "tcs_active": false
    },
    "car_id": 2182,
    "course": {
        "id": "suzuka",
        "name": "Suzuka Circuit",
        "confidence": 1.0
    },
    "wheel_rotation": 0.15,
    "body_accel_sway": 0.3,
    "body_accel_heave": -0.1,
    "body_accel_surge": 0.8,
    "throttle_filtered_pct": 45.0,
    "brake_filtered_pct": 0.0,
    "torque_vector": [100.0, 100.0, 0.0, 0.0],
    "energy_recovery": 0.0,
    "accel_g": 0.5,
    "accel_decel": 0.0,
    "fuel_per_lap": 2.15,
    "fuel_laps_remaining": 21.2,
    "timestamp": "2026-02-13T16:30:45.123456"
}
```

### データフィールド詳細

#### 基本データ (Packet A: 296 bytes)

| フィールド | 型 | オフセット | 説明 |
|-----------|------|-----------|------|
| `speed_ms` | float | 0x4C | 速度 (m/s) |
| `speed_kmh` | float | 計算値 | 速度 (km/h) = speed_ms * 3.6 |
| `rpm` | float | 0x3C | エンジン回転数 |
| `max_rpm` | uint16 | 0x8A | RPMアラート上限 (レブリミッター警告) |
| `rpm_alert_min` | uint16 | 0x88 | RPMアラート下限 (シフトインジケーター開始) |
| `gear` | byte | 0x90 (下位4bit) | ギア位置 (0=R, 1-8) |
| `suggested_gear` | byte | 0x90 (上位4bit) | 推奨ギア (0xF=なし) |
| `throttle` | byte | 0x91 | スロットル生値 (0-255) |
| `throttle_pct` | float | 計算値 | スロットル% (0-100) |
| `brake` | byte | 0x92 | ブレーキ生値 (0-255) |
| `brake_pct` | float | 計算値 | ブレーキ% (0-100) |
| `clutch` | float | 0xF4 | クラッチペダル (0.0-1.0) |
| `clutch_engagement` | float | 0xF8 | クラッチ接続度 (0.0-1.0) |
| `clutch_gearbox_rpm` | float | 0xFC | クラッチ後RPM |
| `tyre_temp` | float[4] | 0x60-0x6C | タイヤ温度 [FL,FR,RL,RR] (degC) |
| `road_plane_x/y/z` | float | 0x94-0x9C | 路面法線ベクトル |
| `road_plane_distance` | float | 0xA0 | 路面からの距離 |
| `wheel_rps` | float[4] | 0xA4-0xB0 | ホイール回転速度 [FL,FR,RL,RR] (rad/s) |
| `tyre_radius` | float[4] | 0xB4-0xC0 | タイヤ半径 [FL,FR,RL,RR] (m) |
| `susp_height` | float[4] | 0xC4-0xD0 | サスペンション高さ [FL,FR,RL,RR] |
| `position_x/y/z` | float | 0x04-0x0C | ワールド座標 (m) |
| `velocity_x/y/z` | float | 0x10-0x18 | 速度ベクトル (m/s) |
| `rotation_pitch/yaw/roll` | float | 0x1C-0x24 | 回転 (-1〜1) |
| `orientation` | float | 0x28 | 方角 (1.0=北, 0.0=南) |
| `angular_velocity_x/y/z` | float | 0x2C-0x34 | 角速度 (rad/s) |
| `body_height` | float | 0x38 | 車体高さ |
| `car_max_speed` | uint16 | 0x8C | 車両最高速度 (km/h) |
| `oil_pressure` | float | 0x54 | 油圧 (bar) |
| `current_fuel` | float | 0x44 | 燃料残量 (L) |
| `fuel_capacity` | float | 0x48 | 燃料タンク容量 (L) |
| `boost` | float | 0x50 | ブースト圧 (raw値 - 1.0) |
| `transmission_max_speed` | float | 0x100 | トランスミッション最高速度ギア比 |
| `gear_ratios` | float[8] | 0x104-0x120 | ギア比 [1st-8th] (0=未使用) |
| `package_id` | int32 | 0x70 | パッケージID (重複検出用) |
| `lap_count` | int16 | 0x74 | 現在のラップ数 |
| `total_laps` | int16 | 0x76 | 総ラップ数 |
| `best_laptime` | int32 | 0x78 | ベストラップタイム (ms, -1=未設定) |
| `last_laptime` | int32 | 0x7C | 前回ラップタイム (ms, -1=未設定) |
| `current_laptime` | int32 | 0x80 | 現在ラップ経過時間 (ms) |
| `pre_race_position` | int16 | 0x84 | スタート順位 (レース前のみ、開始後-1) |
| `num_cars_pre_race` | int16 | 0x86 | レース前参加台数 (開始後-1) |
| `flags` | uint16 | 0x8E | フラグビットマスク (下記参照) |
| `car_id` | int32 | 0x124 | 車種ID |

#### 拡張データ (Packet B: 316 bytes, ハートビート `B`)

| フィールド | 型 | オフセット | 説明 |
|-----------|------|-----------|------|
| `wheel_rotation` | float | 0x128 | ステアリング回転角 (rad) |
| `body_accel_sway` | float | 0x130 | 横方向加速度 (横G) |
| `body_accel_heave` | float | 0x134 | 上下方向加速度 |
| `body_accel_surge` | float | 0x138 | 前後方向加速度 (縦G) |

#### 拡張データ (Packet ~: 344 bytes, ハートビート `~`)

| フィールド | 型 | オフセット | 説明 |
|-----------|------|-----------|------|
| `throttle_filtered_pct` | byte | 0x13C | TCS補正後スロットル% |
| `brake_filtered_pct` | byte | 0x13D | ABS補正後ブレーキ% |
| `torque_vector` | float[4] | 0x140-0x14C | トルクベクタリング |
| `energy_recovery` | float | 0x150 | 回生エネルギー (EV/ハイブリッド) |

#### サーバー側計算フィールド

| フィールド | 型 | 説明 |
|-----------|------|------|
| `accel_g` | float | 加速G (速度差分から計算) |
| `accel_decel` | float | 減速G (速度差分から計算) |
| `fuel_per_lap` | float | 1周あたりの燃料消費量 (L) |
| `fuel_laps_remaining` | float | 残り周回数 (燃料ベース) |
| `course` | object | コース推定結果 |
| `timestamp` | string | ISO 8601形式のタイムスタンプ |

#### フラグビットマスク (0x8E)

| ビット | マスク | フラグ名 | 説明 |
|-------|--------|---------|------|
| 0 | 0x0001 | car_on_track | 車がトラック上にいる |
| 1 | 0x0002 | paused | 一時停止中 |
| 2 | 0x0004 | loading | ロード中 |
| 3 | 0x0008 | in_gear | ギアが入っている |
| 4 | 0x0010 | has_turbo | ターボ搭載車 |
| 5 | 0x0020 | rev_limiter | レブリミッター作動中 |
| 6 | 0x0040 | hand_brake | ハンドブレーキ作動中 |
| 7 | 0x0080 | lights | ヘッドライト点灯 |
| 8 | 0x0100 | high_beams | ハイビーム |
| 9 | 0x0200 | low_beams | ロービーム |
| 10 | 0x0400 | asm_active | ASM作動中 |
| 11 | 0x0800 | tcs_active | TCS作動中 |

#### 注意事項

- **タイヤ空気圧**: GT7のテレメトリパケットにタイヤ空気圧データは存在しない。オフセット0x94は路面法線ベクトル。
- **レース順位**: パケットにリアルタイムのレース順位は含まれない。0x84はレース前のスタート順位のみで、レース開始後は-1になる。
- **水温・油温**: 常に固定値（水温≈85, 油温≈110）のため表示から除外。
- **ギア比**: 8速を超えるギアを持つ車両ではcar_id (0x124) が上書きされる可能性がある。

## PythonモジュールAPI

### GT7TelemetryClientクラス

**ファイル:** `telemetry.py`

GT7からのUDP通信を管理するクラスです。

**コンストラクタ:**
```python
def __init__(self, ip: str, send_port: int = 33739,
             receive_port: int = 33740, heartbeat_interval: int = 10,
             heartbeat_type: bytes = b'~')
```

**引数:**
- `ip`: PS5のIPアドレス
- `send_port`: 送信ポート (デフォルト: 33739)
- `receive_port`: 受信ポート (デフォルト: 33740)
- `heartbeat_interval`: ハートビート間隔 (秒)
- `heartbeat_type`: ハートビートタイプ (`b'A'`, `b'B'`, `b'~'`)
  - `b'A'`: 基本パケット (296 bytes)
  - `b'B'`: 拡張パケット (316 bytes) - ステアリング・車体加速度追加
  - `b'~'`: 全フィールドパケット (344 bytes) - フィルタ入力・トルクベクタリング・回生追加

**メソッド:**

| メソッド | 説明 |
|---------|------|
| `send_heartbeat()` | PS5にハートビートパケットを送信 |
| `receive()` | テレメトリパケットを受信 (bytes or None) |
| `close()` | ソケットを閉じる |

### GT7Decoderクラス

**ファイル:** `decoder.py`

GT7テレメトリパケットの復号と解析を行うクラスです。

**コンストラクタ:**
```python
def __init__(self, course_db: str = 'course_database.json',
             heartbeat_type: bytes = b'~')
```

**引数:**
- `course_db`: コースデータベースファイルのパス
- `heartbeat_type`: ハートビートタイプ（復号用XOR値の決定に使用）

**ハートビートタイプとXOR値:**

| タイプ | XOR値 | パケットサイズ |
|-------|-------|--------------|
| `b'A'` | 0xDEADBEAF | 296 bytes |
| `b'B'` | 0xDEADBEEF | 316 bytes |
| `b'~'` | 0x55FABB4F | 344 bytes |

復号時にマジックナンバー検証が失敗した場合、他のXOR値へ自動フォールバックする。

**メソッド:**

| メソッド | 説明 | 戻り値 |
|---------|------|--------|
| `decrypt(data: bytes)` | Salsa20でパケットを復号 | bytes (復号失敗時は空) |
| `parse(decrypted_data: bytes)` | 復号データを解析 | dict or None |

**使用例:**
```python
from telemetry import GT7TelemetryClient
from decoder import GT7Decoder

client = GT7TelemetryClient("192.168.1.10")
decoder = GT7Decoder()

client.send_heartbeat()
raw_data = client.receive()
if raw_data:
    decrypted = decoder.decrypt(raw_data)
    if decrypted:
        parsed = decoder.parse(decrypted)
        print(f"Speed: {parsed['speed_kmh']:.1f} km/h")
        print(f"Gear: {parsed['gear']}, Ratios: {parsed['gear_ratios']}")
        print(f"Course: {parsed['course']['name']}")
client.close()
```

### CourseEstimatorクラス

**ファイル:** `decoder.py`

位置座標からコースを推定するクラスです。

**メソッド:**

| メソッド | 説明 | 戻り値 |
|---------|------|--------|
| `estimate_course(x, z)` | 座標からコースを推定 | dict |
| `update_database_from_data(data_points, course_id, course_name)` | データからコース情報を更新 | None |
| `save_database(db_file)` | コースデータベースを保存 | None |

## パケット復号仕様

GT7のテレメトリパケットはSalsa20で暗号化されています。

**暗号化キー:** `Simulator Interface Packet GT7 ver 0.0` (先頭32バイトを使用)

**IV生成方法:**
```python
# Seed IV is at offset 0x40
oiv = data[0x40:0x44]
iv1 = int.from_bytes(oiv, byteorder='little')
# XOR値はハートビートタイプにより異なる
iv2 = iv1 ^ xor_value  # A: 0xDEADBEAF, B: 0xDEADBEEF, ~: 0x55FABB4F
iv = iv2.to_bytes(4, 'little') + iv1.to_bytes(4, 'little')
```

**マジックナンバー:** `0x47375330` ("G7S0", リトルエンディアン)

## 設定ファイル

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

## 参考資料

パケット構造の解析は以下のプロジェクトを参考にしています:
- [Nenkai/PDTools](https://github.com/Nenkai/PDTools) - オリジナルのリバースエンジニアリング
- [granturismo PyPI package](https://pypi.org/project/granturismo/) - Python実装
- [snipem/gt7dashboard](https://github.com/snipem/gt7dashboard) - ダッシュボード実装

---

**最終更新**: 2026-02-13
