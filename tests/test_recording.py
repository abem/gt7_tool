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


def test_checkpoint_appends_only_new_samples(tmp_path, monkeypatch):
    """#621: 5 秒ごとに全体を書き直さず、前回以降のサンプルだけを追記する。"""
    path = str(tmp_path / ".checkpoint.jsonl")
    monkeypatch.setattr(main, "CHECKPOINT_FILE", path)
    monkeypatch.setattr(main, "CHECKPOINT_FILE_LEGACY", str(tmp_path / ".checkpoint.json"))
    parts = [json.dumps(s) for s in SAMPLES]
    written = main._append_checkpoint(parts[:2], 3, 0)
    assert written == 2
    size1 = os.path.getsize(path)
    written = main._append_checkpoint(parts, 3, written)
    assert written == 3
    size2 = os.path.getsize(path)
    assert size2 - size1 == len(parts[2]) + 1                      # 増えた分だけ(3 件目 + 改行)
    assert main._append_checkpoint(parts, 3, written) == 3          # 新しいものが無ければ書かない
    assert os.path.getsize(path) == size2
    lines = open(path).read().splitlines()
    assert json.loads(lines[0]) == {"lap_num": 3}
    assert [json.loads(l) for l in lines[1:]] == SAMPLES
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
    body, n_out, n_all, first, duration_ms, courses = main._load_lap_file(str(path), ["timestamp", "speed_kmh"], 6)
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
    body, _n, _a, _f, duration_ms, _c = main._load_lap_file(str(path), ["timestamp"], 1)
    out = json.loads(body)
    assert [s["timestamp"] for s in out] == [s["timestamp"] for s in data]
    assert abs(duration_ms - round(319 / 60.0 * 1000)) <= 2


def test_repace_ignores_non_string_timestamps():
    """壊れた記録(timestamp が数値など)でも例外にせず、その値は触らない。"""
    data = [{"timestamp": 123}, {"timestamp": None}, {"timestamp": "bad"}] + _lap_with_initial_burst(40, 1)
    changed = main._repace_timestamps(data)
    assert changed == 0 and data[0]["timestamp"] == 123 and data[2]["timestamp"] == "bad"


# ---------------------------------------------------------------- #617 記録の区切り / #618 コース判定

def _pos(x, z, speed_kmh=100):
    return {"position_x": x, "position_z": z, "speed_kmh": speed_kmh}


def test_split_on_lap_count_decrease():
    assert main._record_split_reason((0, 0), _pos(1, 0), 1, 5, 0.017) == "lap_reset"
    assert main._record_split_reason((0, 0), _pos(1, 0), 6, 5, 0.017) is None       # 増えるのは通常の境界
    assert main._record_split_reason(None, _pos(1, 0), 1, 0, 0.017) is None         # 起動直後(0 → 1)


def test_split_on_long_receive_gap():
    assert main._record_split_reason((0, 0), _pos(1, 0), 3, 3, main.RECORD_SPLIT_GAP_S) == "gap"
    assert main._record_split_reason((0, 0), _pos(1, 0), 3, 3, 59.0) is None


def test_split_on_teleport_but_not_on_packet_loss():
    # 瞬間移動: 0.017 秒で 500m
    assert main._record_split_reason((0, 0), _pos(500, 0), 3, 3, 0.017) == "jump"
    # パケットロス: 5 秒間に 200km/h(55m/s)で 320m 進んだ → あり得る距離なので区切らない
    assert main._record_split_reason((0, 0), _pos(320, 0, speed_kmh=200), 3, 3, 5.0) is None
    # 位置が無いサンプルでは判定しない
    assert main._record_split_reason((0, 0), {"speed_kmh": 100}, 3, 3, 0.017) is None
    assert main._record_split_reason(None, _pos(500, 0), 3, 3, 0.017) is None


def test_multi_course_flag_ignores_small_strays():
    data = [{"course": {"id": "spa"}}] * 100 + [{"course": {"id": "nurburgring"}}] * 3
    counts = main._course_counts(data)
    assert counts == {"spa": 100, "nurburgring": 3}
    assert main._is_multi_course(counts) is False
    data += [{"course": {"id": "goodwood"}}] * 50
    assert main._is_multi_course(main._course_counts(data)) is True
    assert main._course_counts([{"x": 1}, {"course": None}]) == {"unknown": 2}


# ---------------------------------------------------------------- #628 運転支援の作動ビット

def test_aid_bits_flags_and_abs_estimate():
    base = {"brake_pct": 0, "speed_kmh": 180, "wheel_rps": [-170] * 4, "tyre_radius": [0.3] * 4,
            "flags": {"tcs_active": False, "asm_active": False}}
    assert lapstore.aid_bits(base) == 0
    assert lapstore.aid_bits(dict(base, flags={"tcs_active": True})) == lapstore.AID_TCS
    assert lapstore.aid_bits(dict(base, flags={"asm_active": True, "tcs_active": True})) == lapstore.AID_TCS | lapstore.AID_ASM
    # (a) ペダル値より補正後が 3% 以上弱い
    assert lapstore.aid_bits(dict(base, brake_pct=60, brake_filtered_pct=52)) == lapstore.AID_ABS
    assert lapstore.aid_bits(dict(base, brake_pct=60, brake_filtered_pct=58.5)) == 0
    # (b) 制動中の車輪のスリップ 10%(車速 50m/s、前輪 45m/s)
    assert lapstore.aid_bits(dict(base, brake_pct=100, brake_filtered_pct=100, wheel_rps=[-150, -150, -170, -170])) == lapstore.AID_ABS
    assert lapstore.aid_bits(dict(base, brake_pct=100, brake_filtered_pct=100, wheel_rps=[-164] * 4)) == 0
    # 制動していない・低速・配列が短い → スリップでは判定しない
    assert lapstore.aid_bits(dict(base, brake_pct=0, wheel_rps=[-100] * 4)) == 0
    assert lapstore.aid_bits(dict(base, speed_kmh=5, brake_pct=100, wheel_rps=[0] * 4)) == 0
    assert lapstore.aid_bits(dict(base, brake_pct=100, wheel_rps=[-150, -150], tyre_radius=[0.3, 0.3])) == 0
    assert lapstore.aid_bits({"speed_kmh": 100}) == 0


def test_load_lap_file_adds_virtual_aids_field_only_when_requested(tmp_path):
    data = _lap_with_initial_burst(60, 1)
    for i, s in enumerate(data):
        s["flags"] = {"tcs_active": 20 <= i < 30}
        s["brake_pct"] = 50 if i >= 40 else 0
        s["brake_filtered_pct"] = 40 if i >= 40 else 0
    path = tmp_path / "2026-10-08_17_41_46_CAR-63_Lap-3.json"
    path.write_text(json.dumps(data))
    body, n, _a, _f, _d, _c = main._load_lap_file(str(path), ["speed_kmh", "aids"], 1)
    out = json.loads(body)
    assert [s["aids"] for s in out[18:32]] == [0, 0] + [lapstore.AID_TCS] * 10 + [0, 0]
    assert all(s["aids"] == lapstore.AID_ABS for s in out[40:])
    assert "flags" not in out[0]
    body, n, _a, _f, _d, _c = main._load_lap_file(str(path), ["speed_kmh"], 1)
    assert "aids" not in json.loads(body)[0]


def test_load_lap_file_aids_or_across_decimation_window(tmp_path):
    """every>1 のとき、残すサンプルの間に収まる短い作動(1〜2 サンプル)も消えずに帯に残る。"""
    data = _lap_with_initial_burst(60, 1)
    for i, s in enumerate(data):
        s["flags"] = {"tcs_active": i in (22, 23)}          # 残らないサンプル(18,24 が残る)だけで作動
        s["brake_pct"] = 50 if i == 45 else 0                # 1 サンプルだけの ABS
        s["brake_filtered_pct"] = 40 if i == 45 else 0
    path = tmp_path / "2026-10-08_17_41_46_CAR-63_Lap-3.json"
    path.write_text(json.dumps(data))
    body, n, _a, _f, _d, _c = main._load_lap_file(str(path), ["speed_kmh", "aids"], 6)
    out = json.loads(body)
    assert n == 10 and len(out) == 10
    aids = [s["aids"] for s in out]
    assert aids[3] == lapstore.AID_TCS and aids[7] == lapstore.AID_ABS      # 18..23 と 42..47 の窓
    assert sum(1 for a in aids if a) == 2
