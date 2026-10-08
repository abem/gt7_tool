"""#602 記録の受信時刻と保存: 受信時刻は受信コールバックで付く、保存の出力は json.dump と同一、
時刻軸の並べ直し(pace_timestamps)の規則。

実行(コンテナ内):
    python -m pytest tests/test_recording.py
"""
import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import lapstore  # noqa: E402
import main  # noqa: E402
import telemetry  # noqa: E402

SAMPLES = [
    {"car_id": 63, "lap_count": 3, "speed_kmh": 100.5, "timestamp": "2026-10-08T17:41:46.104000", "course": {"id": "goodwood", "name_ja": ""}},
    {"car_id": 63, "lap_count": 3, "speed_kmh": 101.0, "timestamp": "2026-10-08T17:41:46.121000", "course": {"id": "goodwood", "name_ja": ""}},
    {"car_id": 63, "lap_count": 3, "speed_kmh": None, "timestamp": "2026-10-08T17:41:46.138000", "flags": [1, 2]},
]


def test_receive_uses_time_stamped_in_datagram_callback():
    """受信コールバックで付けた時刻が receive() の後に読める(取り出しが遅れても変わらない)。"""
    async def run():
        c = telemetry.GT7TelemetryClient("127.0.0.1", 33739, 33740, 10)
        c._queue = asyncio.Queue(maxsize=4)
        c._connected = True
        p = telemetry._TelemetryProtocol(c._queue, lambda d, a: None)
        before = time.time()
        p.datagram_received(b"abc", ("127.0.0.1", 1))
        after = time.time()
        await asyncio.sleep(0.05)              # 取り出しが遅れても、受信時刻は届いた時のまま
        data = await c.receive()
        assert data == b"abc"
        assert before <= c.last_recv_ts <= after
        assert c.last_recv_ts < time.time() - 0.04
    asyncio.run(run())


def test_save_lap_to_file_output_identical_to_json_dump(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "LOG_DIR", str(tmp_path))
    parts = [json.dumps(s) for s in SAMPLES]
    main.save_lap_to_file(parts, 3, 63)
    files = os.listdir(tmp_path)
    assert len(files) == 1 and lapstore.LAP_FILE_RE.match(files[0]) and "_CAR-63_Lap-3.json" in files[0]
    body = open(os.path.join(tmp_path, files[0])).read()
    assert body == json.dumps(SAMPLES)
    assert json.loads(body) == SAMPLES


def test_checkpoint_output_identical_to_json_dump(tmp_path, monkeypatch):
    path = str(tmp_path / ".checkpoint.json")
    monkeypatch.setattr(main, "CHECKPOINT_FILE", path)
    parts = [json.dumps(s) for s in SAMPLES]
    main._save_checkpoint(parts, 3)
    body = open(path).read()
    assert body == json.dumps({"lap_num": 3, "samples": SAMPLES})
    main._clear_checkpoint()
    assert not os.path.exists(path)


# ---------------------------------------------------------------- pace_timestamps

def _axis(dts, first=1000.0):
    ts = [first]
    for dt in dts:
        ts.append(ts[-1] + dt)
    return ts


def test_pace_keeps_well_paced_recording_unchanged():
    ts = _axis([1 / 60.0] * 300)
    t, gaps = lapstore.pace_timestamps(ts, 2.0)
    assert gaps == []
    assert abs(t[-1] - 300 / 60.0) < 1e-6
    assert all(abs((t[i] - t[i - 1]) - 1 / 60.0) < 1e-9 for i in range(1, len(t)))


def test_pace_spreads_initial_burst_and_lengthens():
    """ファイルの先頭で 20 パケットが同じ時刻: 本来の間隔(の 95%以上)で前へ広がり、全体が約 19 間隔ぶん長くなる。"""
    ts = _axis([0.0] * 19 + [1 / 60.0] * 300)
    t, gaps = lapstore.pace_timestamps(ts, 2.0)
    assert gaps == []
    for i in range(1, 20):
        assert 0.95 / 60.0 - 1e-9 <= (t[i] - t[i - 1]) <= 1 / 60.0 + 1e-9
    assert 300 / 60.0 + 19 * 0.95 / 60.0 - 1e-6 <= t[-1] <= 319 / 60.0 + 1e-6
    for i in range(21, len(t)):
        assert abs((t[i] - t[i - 1]) - 1 / 60.0) < 1e-9       # 詰まっていない所は変わらない


def test_pace_moves_mid_lap_burst_back_into_preceding_stall():
    """途中で 0.1 秒止まり、その後 6 パケットが同じ時刻: 止まっていた時間へ戻り、全体の長さは変わらない。"""
    normal = [1 / 60.0] * 100
    ts = _axis(normal + [0.1] + [0.0] * 5 + normal)
    t, gaps = lapstore.pace_timestamps(ts, 2.0)
    assert gaps == []
    assert abs(t[-1] - (200 / 60.0 + 0.1)) < 1e-6          # 合計は受信時刻の差のまま
    dts = [t[i] - t[i - 1] for i in range(1, len(t))]
    assert min(dts) >= 0.95 / 60.0 - 1e-9                      # 同じ時刻の塊が無くなる
    assert max(dts) < 0.1 - 4 * 0.95 / 60.0                    # 0.1 秒の空きへ戻る
    assert t[:100] == lapstore.pace_timestamps(_axis(normal), 2.0)[0][:100]   # 止まる前は変わらない


def test_pace_true_pause_is_a_gap_and_not_counted():
    ts = _axis([1 / 60.0] * 100 + [30.0] + [1 / 60.0] * 100)
    t, gaps = lapstore.pace_timestamps(ts, 2.0)
    assert gaps == [101]
    assert abs(t[-1] - 200 / 60.0) < 1e-6


def test_pace_missing_timestamps_carry_previous_value():
    ts = _axis([1 / 60.0] * 50)
    ts[10] = None
    ts[11] = None
    t, gaps = lapstore.pace_timestamps(ts, 2.0)
    assert t[10] == t[9] and t[11] == t[9]
    assert abs(t[-1] - 50 / 60.0) < 1e-6


def _lap_with_initial_burst(n=320, burst=20):
    """60Hz の周回。先頭 burst 件が同じ受信時刻(保存中に止まった分)。"""
    from datetime import datetime, timedelta
    base = datetime(2026, 10, 8, 17, 41, 46)
    data = []
    sec = 0.0
    for i in range(n):
        data.append({"timestamp": (base + timedelta(seconds=sec)).isoformat(), "speed_kmh": 100 + i, "position_x": i, "position_z": 0})
        if i >= burst - 1:
            sec += 1 / 60.0
    return data


def test_load_lap_file_repaces_initial_burst_before_decimation(tmp_path):
    """読み出し(間引き前)で先頭の塊が本来の間隔になり、間引いた応答の timestamp も、所要時間の近似も正しい。"""
    from datetime import datetime
    data = _lap_with_initial_burst()
    path = tmp_path / "2026-10-08_17_41_46_CAR-63_Lap-3.json"
    path.write_text(json.dumps(data))
    body, n_out, n_all, first, duration_ms = main._load_lap_file(str(path), ["timestamp", "speed_kmh"], 6)
    out = json.loads(body)
    assert n_all == 320 and n_out == len(out) == 54
    ts = [datetime.fromisoformat(s["timestamp"]).timestamp() for s in out]
    dts = [ts[i] - ts[i - 1] for i in range(1, len(ts))]
    assert all(0.095 - 0.002 <= d <= 0.1 + 0.002 for d in dts), dts[:6]   # 先頭も約 6/60 秒間隔
    assert abs(duration_ms - round(319 / 60.0 * 1000)) <= 25                # 先頭の 19 間隔は 95% で広げる
    assert out[0]["speed_kmh"] == 100 and out[-1]["speed_kmh"] == 100 + 318


def test_load_lap_file_leaves_well_paced_recording_unchanged(tmp_path):
    data = _lap_with_initial_burst(burst=1)
    path = tmp_path / "2026-10-08_17_41_46_CAR-63_Lap-3.json"
    path.write_text(json.dumps(data))
    body, _n, _a, _f, duration_ms = main._load_lap_file(str(path), ["timestamp"], 1)
    out = json.loads(body)
    assert [s["timestamp"] for s in out] == [s["timestamp"] for s in data]
    assert abs(duration_ms - round(319 / 60.0 * 1000)) <= 2
