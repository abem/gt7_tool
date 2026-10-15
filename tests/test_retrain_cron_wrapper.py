"""scripts/retrain_cron_wrapper.py(#626): どんな失敗でも「ログを書き、通知し、終了コード 0」を守ること。

docker を呼ぶ代わりに subprocess.run を差し替える。実際の学習は tests/test_train_laptime_model.py が担う。
"""
import fcntl
import importlib.util
import json
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))


@pytest.fixture
def wrapper(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("retrain_cron_wrapper",
                                                  os.path.join(ROOT, "scripts", "retrain_cron_wrapper.py"))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    logs = tmp_path / "logs"; models = tmp_path / "models"; models.mkdir()
    monkeypatch.setattr(m, "LOG_DIR", str(logs))
    monkeypatch.setattr(m, "LOCK_FILE", str(logs / ".lock"))
    monkeypatch.setattr(m, "GATED_GROUPS", str(models / "gated_groups.json"))
    monkeypatch.setattr(m, "SUMMARY", str(models / "training_summary.json"))
    monkeypatch.setattr(m, "REPO", str(tmp_path))
    alerts = []
    monkeypatch.setattr(m, "alert", lambda title, body, urgency="critical": alerts.append((title, body, urgency)))
    m._alerts = alerts; m._models = models
    return m


def write_gated(m, n):
    with open(m.GATED_GROUPS, "w") as f:
        json.dump({f"c{i}|car{i}": {} for i in range(n)}, f)


def log_text(m):
    files = sorted(p for p in os.listdir(m.LOG_DIR) if p.startswith("retrain_"))
    assert len(files) == 1, files
    return open(os.path.join(m.LOG_DIR, files[0]), encoding="utf-8").read()


def test_success_without_decrease_does_not_alert(wrapper, monkeypatch):
    m = wrapper; write_gated(m, 11)
    monkeypatch.setattr(m.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a[0], 0, "trained ok\n", ""))
    assert m.main([]) == 0
    assert m._alerts == []
    assert "exit=0 gated 11 -> 11" in log_text(m)


def test_gated_decrease_alerts_normal(wrapper, monkeypatch):
    m = wrapper; write_gated(m, 15)
    def run(cmd, **k):
        write_gated(m, 11)          # 学習でゲート通過の組が減った
        return subprocess.CompletedProcess(cmd, 0, "", "")
    monkeypatch.setattr(m.subprocess, "run", run)
    assert m.main([]) == 0
    assert len(m._alerts) == 1 and "減った" in m._alerts[0][0] and "15 -> 11" in m._alerts[0][1]
    assert m._alerts[0][2] == "normal"


def test_docker_missing_still_logs_alerts_and_exits_zero(wrapper, monkeypatch):
    """cron の PATH に docker が無い → FileNotFoundError。黙って落ちてはいけない(#626 レビュー指摘)。"""
    m = wrapper; write_gated(m, 11)
    def run(cmd, **k):
        raise FileNotFoundError(2, "No such file or directory", cmd[0])
    monkeypatch.setattr(m.subprocess, "run", run)
    assert m.main([]) == 0
    assert len(m._alerts) == 1 and "失敗" in m._alerts[0][0] and "exit=-2" in m._alerts[0][1]
    txt = log_text(m)
    assert "exit=-2" in txt and "FileNotFoundError" in txt


def test_nonzero_exit_alerts_with_tail(wrapper, monkeypatch):
    m = wrapper; write_gated(m, 11)
    monkeypatch.setattr(m.subprocess, "run",
                        lambda cmd, **k: subprocess.CompletedProcess(cmd, 1, "line1\n", "Traceback\nValueError: boom\n"))
    assert m.main([]) == 0
    assert len(m._alerts) == 1 and "exit=1" in m._alerts[0][1] and "ValueError: boom" in m._alerts[0][1]


def test_timeout_removes_named_container(wrapper, monkeypatch):
    """タイムアウトで docker クライアントを殺してもコンテナは残るので、名前で rm -f する。"""
    m = wrapper; write_gated(m, 11); calls = []
    def run(cmd, **k):
        calls.append(cmd)
        if cmd[1] == "compose":
            raise subprocess.TimeoutExpired(cmd, k.get("timeout"), output=b"partial", stderr=None)
        return subprocess.CompletedProcess(cmd, 0, "", "")
    monkeypatch.setattr(m.subprocess, "run", run)
    assert m.main([]) == 0
    assert any(c[1:3] == ["rm", "-f"] and c[3] == m.CONTAINER_NAME for c in calls), calls
    assert "--name" in calls[0] and m.CONTAINER_NAME in calls[0]
    assert len(m._alerts) == 1 and "exit=-1" in m._alerts[0][1]
    txt = log_text(m)
    assert "partial" in txt and "timeout after" in txt and "removed" in txt


def test_second_instance_is_skipped_while_locked(wrapper, monkeypatch):
    m = wrapper; os.makedirs(m.LOG_DIR, exist_ok=True)
    holder = open(m.LOCK_FILE, "w"); fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
    called = []
    monkeypatch.setattr(m.subprocess, "run", lambda *a, **k: called.append(a))
    try:
        assert m.main([]) == 0
    finally:
        holder.close()
    assert called == [] and m._alerts == []


def test_prune_logs_keeps_newest(wrapper):
    m = wrapper; os.makedirs(m.LOG_DIR, exist_ok=True)
    for i in range(20):
        open(os.path.join(m.LOG_DIR, f"retrain_202601{i:02d}_000000.log"), "w").close()
    open(os.path.join(m.LOG_DIR, "rotate_20260101_000000.log"), "w").close()
    m.prune_logs()
    left = sorted(os.listdir(m.LOG_DIR))
    assert len([p for p in left if p.startswith("retrain_")]) == m.KEEP_LOGS
    assert "retrain_20260119_000000.log" in left and "retrain_20260100_000000.log" not in left
    assert "rotate_20260101_000000.log" in left           # 他のログには触らない


def test_dry_run_prints_command_only(wrapper, monkeypatch, capsys):
    m = wrapper
    monkeypatch.setattr(m.subprocess, "run", lambda *a, **k: pytest.fail("must not run"))
    assert m.main(["--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "compose run" in out and "--name " + m.CONTAINER_NAME in out
    assert not os.path.exists(m.LOG_DIR)
