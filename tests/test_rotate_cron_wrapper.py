"""scripts/rotate_cron_wrapper.py(#631): 本家の終了コード・例外・タイムアウトのどれでも「通知して終了コード 0」を守ること。

本家 gt7data_rotate.py は呼ばず、subprocess.run を差し替える。
"""
import importlib.util
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))


@pytest.fixture
def wrapper(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("rotate_cron_wrapper",
                                                  os.path.join(ROOT, "scripts", "rotate_cron_wrapper.py"))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    alerts = []
    monkeypatch.setattr(m, "alert", lambda title, body, urgency="critical": alerts.append((title, body, urgency)))
    monkeypatch.setattr(m, "LAST_RUN_FILE", str(tmp_path / "logs" / ".rotate_last_run"))
    m._alerts = alerts
    return m


def marker_age_s(m):
    import datetime
    with open(m.LAST_RUN_FILE) as f:
        return (datetime.datetime.now() - datetime.datetime.fromisoformat(f.read().strip())).total_seconds()


def test_success_passes_output_through_without_alert(wrapper, monkeypatch, capsys):
    m = wrapper
    monkeypatch.setattr(m.subprocess, "run", lambda cmd, **k: subprocess.CompletedProcess(cmd, 0, "moved 3\n", ""))
    assert m.main() == 0
    assert m._alerts == []
    assert capsys.readouterr().out == "moved 3\n"
    assert 0 <= marker_age_s(m) < 60            # 実行の目印(#632 の見張りが読む)


def test_safety_abort_exit3_alerts_with_manual_hint(wrapper, monkeypatch):
    m = wrapper
    monkeypatch.setattr(m.subprocess, "run",
                        lambda cmd, **k: subprocess.CompletedProcess(cmd, 3, "a\nb\nc\nd\ne\nf\n", "ABORT 50%\n"))
    assert m.main() == 0
    assert len(m._alerts) == 1
    title, body, _ = m._alerts[0]
    assert "50%" in title and m.ROTATE_SCRIPT in body and "ABORT 50%" in body
    assert "\na\n" not in body            # 末尾 5 行だけ


def test_refused_exit2_alerts_with_exit_code(wrapper, monkeypatch):
    m = wrapper
    monkeypatch.setattr(m.subprocess, "run", lambda cmd, **k: subprocess.CompletedProcess(cmd, 2, "", "refused\n"))
    assert m.main() == 0
    assert len(m._alerts) == 1 and "拒否" in m._alerts[0][0] and "exit=2" in m._alerts[0][1]


def test_launch_failure_alerts_and_exits_zero(wrapper, monkeypatch):
    """python3 が無い・スクリプトが移動した等: 以前は例外で落ちて通知が出なかった。"""
    m = wrapper
    def run(cmd, **k):
        raise FileNotFoundError(2, "No such file or directory", cmd[0])
    monkeypatch.setattr(m.subprocess, "run", run)
    assert m.main() == 0
    assert len(m._alerts) == 1
    title, body, _ = m._alerts[0]
    assert "例外" in title and "FileNotFoundError" in body
    assert 0 <= marker_age_s(m) < 60            # 失敗しても「実行した」目印は残す


def test_marker_write_failure_does_not_break_alerting(wrapper, monkeypatch, tmp_path):
    m = wrapper
    blocker = tmp_path / "blocker"; blocker.write_text("x")
    monkeypatch.setattr(m, "LAST_RUN_FILE", str(blocker / ".rotate_last_run"))   # ファイルの下 → OSError
    monkeypatch.setattr(m.subprocess, "run", lambda cmd, **k: subprocess.CompletedProcess(cmd, 2, "", "refused\n"))
    assert m.main() == 0
    assert len(m._alerts) == 1 and "exit=2" in m._alerts[0][1]


def test_timeout_alerts_and_exits_zero(wrapper, monkeypatch):
    m = wrapper
    def run(cmd, **k):
        assert k.get("timeout") == m.TIMEOUT_S
        raise subprocess.TimeoutExpired(cmd, k.get("timeout"), output=b"partial", stderr=None)
    monkeypatch.setattr(m.subprocess, "run", run)
    assert m.main() == 0
    assert len(m._alerts) == 1
    title, body, _ = m._alerts[0]
    assert "タイムアウト" in title and "partial" in body and str(m.TIMEOUT_S) in body


def test_runs_rotate_script_with_apply(wrapper, monkeypatch):
    m = wrapper; seen = []
    def run(cmd, **k):
        seen.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, "", "")
    monkeypatch.setattr(m.subprocess, "run", run)
    m.main()
    assert seen == [["python3", m.ROTATE_SCRIPT, "--apply"]]
