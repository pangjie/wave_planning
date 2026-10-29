# 回归范围：模拟 PID 复用与进程命令变化，验证身份核对。
"""A19 identities and PID reuse are simulated; unit tests never send signals."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

import pytest


ENTRY = Path(__file__).resolve().parents[1] / "scripts/service_identity.py"
spec = importlib.util.spec_from_file_location("service_identity", ENTRY)
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)


def command(project, port=800, host="127.0.0.1", executable=None):
    return f"{executable or sys.executable} -m uvicorn app.main:app --app-dir {project / 'backend'} --host {host} --port {port}"


@pytest.mark.parametrize("change", ["port-prefix", "project", "python", "extra-argument", "missing-app-dir", "exact"])
def test_complete_command_not_substring_match(tmp_path, change):
    project = tmp_path / "project with spaces"
    text = command(project)
    if change == "port-prefix": text = command(project, port=8001)
    if change == "project": text = command(tmp_path / "other project")
    if change == "python": text = command(project, executable=str(tmp_path / "other-python"))
    if change == "extra-argument": text += " --port 8001"
    if change == "missing-app-dir": text = text.replace(f" --app-dir {project / 'backend'}", "")
    assert identity.matches_command(text, project, "127.0.0.1", 800) is (change == "exact")


@pytest.mark.parametrize("change", ["pid", "project", "port", "python", "started", "command", "host", "missing", "broken", "valid"])
def test_stored_identity_must_match_current_process(tmp_path, monkeypatch, change):
    pid_file = tmp_path / "service.pid"
    snapshot = {"command": command(tmp_path), "started": "Mon Sep  7 10:00:00 2026"}
    monkeypatch.setattr(identity, "process_snapshot", lambda _: dict(snapshot))
    identity.record(pid_file, 1234, tmp_path, "127.0.0.1", 800)
    path = identity.identity_path(pid_file)
    original = path.read_bytes()
    data = json.loads(original)
    if change == "pid": data["pid"] = 5678
    if change == "project": data["project"] = str(tmp_path / "other")
    if change == "port": data["port"] = 8001
    if change == "python": data["python"] = str(tmp_path / "other-python")
    if change == "host": data["host"] = "0.0.0.0"
    if change == "started": snapshot["started"] = "Mon Sep  7 10:01:00 2026"  # same PID reused
    if change == "command": snapshot["command"] = command(tmp_path, port=8001)
    path.write_text(json.dumps(data))
    if change == "missing": path.unlink()
    if change == "broken": path.write_text("{broken")
    if change in {"missing", "broken"}:
        with pytest.raises((OSError, ValueError)):
            identity.verify(pid_file, 1234, tmp_path, 800)
    else:
        assert identity.verify(pid_file, 1234, tmp_path, 800) is (change == "valid")


def test_record_failure_preserves_existing_identity(tmp_path, monkeypatch):
    pid_file = tmp_path / "service.pid"
    target = identity.identity_path(pid_file)
    target.write_text("original")
    monkeypatch.setattr(identity, "process_snapshot", lambda _: {"command": command(tmp_path), "started": "start"})
    def fail(*_): raise OSError("disk full")
    monkeypatch.setattr(identity.os, "replace", fail)
    with pytest.raises(OSError, match="disk full"):
        identity.record(pid_file, 1234, tmp_path, "127.0.0.1", 800)
    assert target.read_text() == "original"
    assert not list(tmp_path.glob(".service-identity-*.tmp"))


def test_unreadable_process_cannot_verify(tmp_path, monkeypatch):
    monkeypatch.setattr(identity.subprocess, "run", lambda *args, **kwargs: subprocess.CompletedProcess(args, 1, "", "denied"))
    with pytest.raises(ValueError, match="无法读取进程身份"):
        identity.process_snapshot(1234)


@pytest.mark.parametrize("platform,command_locale", [("darwin", "en_US.UTF-8"), ("linux", "C.UTF-8")])
def test_process_snapshot_preserves_unicode_command_and_stable_timestamp(tmp_path, monkeypatch, platform, command_locale):
    text = command(tmp_path / "波次规划 with spaces")
    calls = []
    monkeypatch.setattr(identity.sys, "platform", platform)

    def ps(args, **kwargs):
        calls.append(kwargs["env"]["LC_ALL"])
        value = text if args[-1] == "command=" else "Mon Sep  7 10:00:00 2026"
        if args[-1] == "command=" and kwargs["env"]["LC_ALL"] == "C":
            value = "escaped non-ASCII path"
        return subprocess.CompletedProcess(args, 0, value + "\n", "")

    monkeypatch.setattr(identity.subprocess, "run", ps)
    assert identity.process_snapshot(1234) == {"command": text, "started": "Mon Sep  7 10:00:00 2026"}
    assert calls == [command_locale, "C"]
