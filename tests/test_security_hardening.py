"""Claude Security スキャン(#640)への対応の特性テスト。

#641: UDP の送信元フィルタ(telemetry.py)、非有限 float・過大パケットの破棄(decoder.py)、
      ラップ境界でも短い断片を捨てる(main._flush_recording)。
#642 / #643 の HTTP 側は tests/test_http_hardening.py。
"""
import asyncio
import math
import os
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402
import telemetry  # noqa: E402
from decoder import GT7Decoder  # noqa: E402


# ---------------------------------------------------------------- 送信元フィルタ(#641)

def _protocol(allowed_ip):
    q = asyncio.Queue(maxsize=8)
    seen = []
    p = telemetry._TelemetryProtocol(q, lambda data, addr: seen.append(addr), allowed_ip)
    return p, q, seen


def test_datagram_from_other_host_is_dropped_before_queue():
    async def run():
        p, q, seen = _protocol("192.168.1.128")
        p.datagram_received(b"x" * 300, ("192.168.1.50", 33740))
        p.datagram_received(b"y" * 300, ("192.168.1.128", 33740))
        assert q.qsize() == 1 and q.get_nowait()[0] == b"y" * 300
        assert seen == [("192.168.1.128", 33740)]          # 最初のパケットの通知も偽物では出ない
        assert p._rejected_since_log == 0 and p._last_reject_log > 0   # 1 回目の拒否で警告を出した
    asyncio.run(run())


def test_any_source_when_filter_disabled():
    async def run():
        p, q, seen = _protocol(None)
        p.datagram_received(b"x" * 300, ("10.0.0.9", 1))
        assert q.qsize() == 1
    asyncio.run(run())


def test_client_passes_its_ip_as_allowed_source_unless_opted_out():
    c = telemetry.GT7TelemetryClient("192.168.1.128")
    assert c.accept_any_source is False
    c2 = telemetry.GT7TelemetryClient("192.168.1.128", accept_any_source=True)
    assert c2.accept_any_source is True


# ---------------------------------------------------------------- decoder(#641)

def _plain_packet(**floats_at):
    buf = bytearray(0x128)
    struct.pack_into('<I', buf, 0x00, 0x47375330)
    for offset, value in floats_at.items():
        struct.pack_into('<f', buf, int(offset, 16), value)
    return bytes(buf)


def test_parse_drops_packet_with_nan_or_inf():
    d = GT7Decoder()
    assert d.parse(_plain_packet()) is not None                       # 基準: ゼロ埋めは解析できる
    assert d.parse(_plain_packet(**{"0x4C": float("nan")})) is None   # speed_ms = NaN
    assert d.parse(_plain_packet(**{"0x3C": float("inf")})) is None   # rpm = +Inf
    assert d.parse(_plain_packet(**{"0x60": -float("inf")})) is None  # tyre_temp[0] = -Inf(リストの中)
    assert d._non_finite_count == 3


def test_has_non_finite_walks_nested_values():
    f = GT7Decoder._has_non_finite
    assert f({"a": 1.0, "b": [0.0, float("nan")]}) is True
    assert f({"a": 1.0, "b": [0.0, 2.5], "c": {"d": -1.0}, "e": None, "s": "x"}) is False
    assert f(math.inf) is True and f(3) is False


def test_decrypt_rejects_oversized_datagram():
    d = GT7Decoder()
    assert d.decrypt(b"\0" * (GT7Decoder.MAX_PACKET_SIZE + 1)) == b""
    assert GT7Decoder.MAX_PACKET_SIZE >= 0x158          # 現行の最大(Packet ~)は通る


# ---------------------------------------------------------------- ラップ境界の短い断片(#641)

def test_flush_recording_drops_fragment_below_min_samples(monkeypatch):
    saved = []
    monkeypatch.setattr(main, "save_lap_to_file", lambda parts, lap, car: saved.append((len(parts), lap, car)))
    short = ["{}"] * (main.RECORD_MIN_SAMPLES - 1)
    assert main._flush_recording(short, 3, 63, "lap_boundary") is False
    assert saved == []
    enough = ["{}"] * main.RECORD_MIN_SAMPLES
    assert main._flush_recording(enough, 3, 63, "lap_boundary") is True
    assert saved == [(main.RECORD_MIN_SAMPLES, 3, 63)]
