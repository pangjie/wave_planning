# 回归范围：临时服务进程的启动、停止、重启及身份检查。
from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
from urllib.error import HTTPError
from urllib.request import urlopen

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]


@dataclass
class ScriptRunner:
    root: Path
    env: dict[str, str]

    def __call__(self, *args: str, timeout: float = 20) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(self.root / "scripts/start.sh"), *args],
            cwd=self.root, text=True, capture_output=True, timeout=timeout,
            env=self.env, check=False,
        )


@pytest.fixture
def script_runner(tmp_path: Path) -> ScriptRunner:
    # Test the real management script against a disposable health-only app.
    # No production app, existing PID, or browser session is copied here.
    root = tmp_path / "波次规划 service"
    for name in ("scripts", "backend/app", "frontend/dist", "data/profile", "downloads", "outputs", "config"):
        (root / name).mkdir(parents=True)
    shutil.copy2(PROJECT_ROOT / "scripts/start.sh", root / "scripts/start.sh")
    shutil.copy2(PROJECT_ROOT / "scripts/service_identity.py", root / "scripts/service_identity.py")
    # Reuse installed dependencies without modifying them, not just the executable:
    # Python needs the venv metadata and site-packages. Bytecode is disabled.
    assert (Path(sys.prefix) / "pyvenv.cfg").is_file(), "Run with the project virtualenv"
    (root / ".venv").symlink_to(sys.prefix, target_is_directory=True)
    shutil.copyfile(Path(__file__).parent / "support/health_app.py", root / "backend/app/main.py")
    (root / "backend/app/__init__.py").touch()
    (root / "frontend/dist/index.html").write_text("<!doctype html><title>Isolated test</title>", "utf-8")
    shutil.copyfile(PROJECT_ROOT / "config/automation.json", root / "config/automation.json")
    env = {name: os.environ[name] for name in ("PATH", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT") if name in os.environ}
    env.update({
        "HOST": "127.0.0.1", "PORT": "8000", "PYTHONDONTWRITEBYTECODE": "1",
        "WMS_PROJECT_ROOT": str(root),
        "WMS_BROWSER_PROFILE": str(root / "data/profile"),
        "WMS_DOWNLOADS_DIR": str(root / "downloads"),
        "WMS_OUTPUTS_DIR": str(root / "outputs"),
        "WMS_AUTOMATION_CONFIG": str(root / "config/automation.json"),
        "WMS_FRONTEND_DIST": str(root / "frontend/dist"),
    })
    return ScriptRunner(root, env)


def unused_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def test_start_script_help_and_validation(script_runner) -> None:
    help_result = script_runner("--help")
    assert help_result.returncode == 0
    assert "start|stop|restart|status" in help_result.stdout

    # Parse a wide bind address without starting a listener on all interfaces.
    assert script_runner("--ip", "0.0.0.0", "--help").returncode == 0
    invalid_port = script_runner("start", "--port", "70000")
    assert invalid_port.returncode == 2
    assert "1 到 65535" in invalid_port.stderr

    missing_value = script_runner("start", "--ip")
    assert missing_value.returncode == 2
    assert "缺少参数值" in missing_value.stderr


def test_script_environment_does_not_inherit_production_paths(script_runner) -> None:
    for name, value in script_runner.env.items():
        if name.startswith("WMS_"):
            assert Path(value).is_relative_to(script_runner.root)
    assert "PYTHONPATH" not in script_runner.env
    assert "HTTPS_PROXY" not in script_runner.env
    assert "ALL_PROXY" not in script_runner.env


def test_start_status_restart_and_stop(script_runner, test_network) -> None:
    port = unused_port()
    test_network("127.0.0.1", port)
    log_file = script_runner.root / "service.log"
    pid_file = script_runner.root / "data/service.pid"
    common = (
        "--ip",
        "127.0.0.1",
        "--port",
        str(port),
        "--log",
        str(log_file),
        "--pid-file",
        str(pid_file),
    )

    try:
        started = script_runner("start", *common)
        assert started.returncode == 0, started.stderr + started.stdout
        assert "服务启动成功" in started.stdout
        first_pid = int(pid_file.read_text("utf-8").strip())
        identity_file = pid_file.with_name(pid_file.name + ".identity.json")
        first_identity = json.loads(identity_file.read_text())
        assert first_identity["pid"] == first_pid
        assert first_identity["project"] == str(script_runner.root.resolve())
        assert first_identity["port"] == port
        repeated = script_runner("start", *common)
        assert repeated.returncode == 0
        assert "服务已经运行" in repeated.stdout
        assert int(pid_file.read_text().strip()) == first_pid
        assert json.loads(identity_file.read_text()) == first_identity

        with urlopen(f"http://127.0.0.1:{port}/__test/runtime", timeout=3) as response:
            paths = json.load(response)
        assert paths and all(Path(value).is_relative_to(script_runner.root) for value in paths.values())
        with pytest.raises(HTTPError) as denied:
            urlopen(f"http://127.0.0.1:{port}/api/jobs", timeout=3)
        assert denied.value.code == 404  # The fixture has no business operations.

        status = script_runner("status", *common)
        assert status.returncode == 0, status.stderr
        assert f"PID {first_pid}" in status.stdout
        assert "运行中且健康" in status.stdout

        restarted = script_runner("restart", *common)
        assert restarted.returncode == 0, restarted.stderr
        second_pid = int(pid_file.read_text("utf-8").strip())
        assert second_pid != first_pid
        assert json.loads(identity_file.read_text())["pid"] == second_pid
        assert "服务启动成功" in restarted.stdout

        stopped = script_runner("stop", *common)
        assert stopped.returncode == 0, stopped.stderr
        assert "服务已停止" in stopped.stdout
        assert not pid_file.exists()
        assert not identity_file.exists()

        stopped_status = script_runner("status", *common)
        assert stopped_status.returncode == 1
        assert "服务未运行" in stopped_status.stdout
    finally:
        cleanup = script_runner("stop", *common)
        assert cleanup.returncode == 0, cleanup.stdout + cleanup.stderr


def test_wrong_or_missing_identity_never_stops_our_fixture(script_runner, test_network):
    port = unused_port()
    test_network("127.0.0.1", port)
    pid_file = script_runner.root / "data/owned.pid"
    identity_file = pid_file.with_name(pid_file.name + ".identity.json")
    args = ("--port", str(port), "--pid-file", str(pid_file))
    original = None
    try:
        started = script_runner("start", *args)
        assert started.returncode == 0, started.stdout + started.stderr
        original = identity_file.read_bytes()
        for mutation in ("missing", "broken", "started", "project", "port"):
            data = json.loads(original)
            if mutation == "missing": identity_file.unlink()
            elif mutation == "broken": identity_file.write_text("{broken")
            else:
                data[mutation] = {"started": "old process birth", "project": str(script_runner.root / "other"), "port": port + 1}[mutation]
                identity_file.write_text(json.dumps(data))
            result = script_runner("stop", *args)
            assert result.returncode == 2, result.stdout + result.stderr
            assert "拒绝停止" in result.stderr
            assert pid_file.exists()
            with urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2) as response:
                assert response.status == 200
            identity_file.write_bytes(original)
        prefix = str(port)[:-1]
        wrong_port = script_runner("stop", "--port", prefix, "--pid-file", str(pid_file))
        assert wrong_port.returncode == 2
        assert script_runner("status", *args).returncode == 0
    finally:
        if original is not None:
            identity_file.write_bytes(original)
        cleanup = script_runner("stop", *args)
        assert cleanup.returncode == 0, cleanup.stdout + cleanup.stderr


@pytest.mark.parametrize("invalid", ["0", "1", "-1", "garbage", "99999999999999999999999"])
def test_invalid_pid_never_becomes_signal_target(script_runner, invalid):
    pid_file = script_runner.root / "data/invalid.pid"
    pid_file.write_text(invalid + "\n")
    result = script_runner("stop", "--pid-file", str(pid_file))
    assert result.returncode == 0
    assert "没有有效 PID 文件" in result.stdout
    assert pid_file.read_text() == invalid + "\n"


@pytest.mark.parametrize("identity_changed", [False, True])
def test_forced_stop_rechecks_identity_without_sending_real_signals(identity_changed):
    source = (PROJECT_ROOT / "scripts/start.sh").read_text()
    # Run the actual stop function, but replace every process/filesystem side
    # effect with shell functions. No PID from this test is ever signalled.
    stop_function = source.split("stop_service() {", 1)[1].split("\nstatus_service() {", 1)[0]
    program = "stop_service() {" + stop_function + r'''
PID_FILE=fixture-only
task_test_checks=0
task_test_forced=false
read_pid() { printf '1234\n'; }
process_alive() { [[ "$task_test_forced" == false ]]; }
pid_matches_service() {
  task_test_checks=$((task_test_checks + 1))
  [[ "$TASK_TEST_CHANGE" == false || "$task_test_checks" -eq 1 ]]
}
kill() { printf 'MOCK_SIGNAL %s\n' "$*"; if [[ "$1" == -9 ]]; then task_test_forced=true; fi; }
sleep() { :; }
remove_owned_pid() { printf 'MOCK_REMOVE\n'; }
stop_service
task_test_result=$?
printf 'IDENTITY_CHECKS %s\n' "$task_test_checks"
exit "$task_test_result"
'''
    result = subprocess.run(["bash"], input=program, text=True, capture_output=True, timeout=5,
                            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "TASK_TEST_CHANGE": str(identity_changed).lower()})
    assert "MOCK_SIGNAL 1234" in result.stdout
    assert "IDENTITY_CHECKS 2" in result.stdout
    if identity_changed:
        assert result.returncode == 2
        assert "MOCK_SIGNAL -9" not in result.stdout
        assert "MOCK_REMOVE" not in result.stdout
    else:
        assert result.returncode == 0
        assert "MOCK_SIGNAL -9 1234" in result.stdout
        assert "MOCK_REMOVE" in result.stdout
