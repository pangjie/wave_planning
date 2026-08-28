from __future__ import annotations

import os
from pathlib import Path
import socket
import subprocess


PROJECT_ROOT = Path(__file__).resolve().parents[1]
START_SCRIPT = PROJECT_ROOT / "scripts" / "start.sh"


def run_script(*args: str, timeout: float = 20) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(START_SCRIPT), *args],
        cwd=PROJECT_ROOT,
        text=True,
        capture_output=True,
        timeout=timeout,
        env={**os.environ, "HOST": "127.0.0.1", "PORT": "8000"},
        check=False,
    )


def unused_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def test_start_script_help_and_validation() -> None:
    help_result = run_script("--help")
    assert help_result.returncode == 0
    assert "start|stop|restart|status" in help_result.stdout

    invalid_port = run_script("start", "--port", "70000")
    assert invalid_port.returncode == 2
    assert "1 到 65535" in invalid_port.stderr

    missing_value = run_script("start", "--ip")
    assert missing_value.returncode == 2
    assert "缺少参数值" in missing_value.stderr


def test_start_status_restart_and_stop(tmp_path: Path) -> None:
    port = unused_port()
    log_file = tmp_path / "service.log"
    pid_file = tmp_path / "service.pid"
    common = (
        "--ip",
        "0.0.0.0",
        "--port",
        str(port),
        "--log",
        str(log_file),
        "--pid-file",
        str(pid_file),
    )

    try:
        started = run_script("start", *common)
        assert started.returncode == 0, started.stderr
        assert "服务启动成功" in started.stdout
        first_pid = int(pid_file.read_text("utf-8").strip())

        status = run_script("status", *common)
        assert status.returncode == 0, status.stderr
        assert f"PID {first_pid}" in status.stdout
        assert "运行中且健康" in status.stdout

        restarted = run_script("restart", *common)
        assert restarted.returncode == 0, restarted.stderr
        second_pid = int(pid_file.read_text("utf-8").strip())
        assert second_pid != first_pid
        assert "服务启动成功" in restarted.stdout

        stopped = run_script("stop", *common)
        assert stopped.returncode == 0, stopped.stderr
        assert "服务已停止" in stopped.stdout
        assert not pid_file.exists()

        stopped_status = run_script("status", *common)
        assert stopped_status.returncode == 1
        assert "服务未运行" in stopped_status.stdout
    finally:
        run_script("stop", *common)
