# 回归范围：测试基建必须阻止误连真实浏览器/服务。
"""The test harness must fail closed before touching a real browser or service."""

import importlib.util
from pathlib import Path
import socket
import subprocess
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.automation import common
from app.core.config import Settings, get_settings
from app.services.job_manager import JobManager


def test_settings_and_lifespan_use_temporary_paths(tmp_path, isolated_runtime, app):
    assert get_settings() is isolated_runtime
    for path in (isolated_runtime.browser_profile_dir, isolated_runtime.downloads_dir, isolated_runtime.outputs_dir):
        assert path.resolve().is_relative_to(tmp_path.resolve())
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200
        assert app.state.settings is isolated_runtime
        assert app.state.job_manager.wave_records_dir.is_relative_to(tmp_path)
        from app import main
        assert main.frontend_dist.is_relative_to(tmp_path)
        assert main.index_html.is_relative_to(tmp_path)
        assert client.get("/").text == main.index_html.read_text("utf-8")
        assert "Isolated test frontend" in client.get("/").text


def test_job_manager_rejects_unisolated_test_setup(tmp_path):
    with pytest.raises(AssertionError, match="isolated Settings"):
        JobManager(Mock())
    outside = Settings.from_environment().model_copy(update={"outputs_dir": tmp_path.parent})
    with pytest.raises(AssertionError, match="inside tmp_path"):
        JobManager(Mock(), settings=outside)


def test_real_playwright_is_blocked():
    with pytest.raises(AssertionError, match="must mock Playwright"):
        common.async_playwright()


@pytest.mark.parametrize("address", [("127.0.0.1", 8000), ("127.0.0.1", 8001), ("203.0.113.1", 443)])
def test_unowned_network_connections_are_blocked(address):
    with socket.socket() as sock:
        with pytest.raises(AssertionError, match="Network blocked"):
            sock.connect(address)


def test_dns_and_datagrams_are_blocked():
    with pytest.raises(AssertionError, match="Network blocked"):
        socket.getaddrinfo("wms.xlwms.com", 443)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        with pytest.raises(AssertionError, match="Network blocked"):
            sock.sendto(b"test", ("203.0.113.1", 53))


def _load_driver():
    entry = Path(__file__).resolve().parents[1] / "scripts/run_full_auto.py"
    spec = importlib.util.spec_from_file_location("isolated_full_auto", entry)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_full_auto_only_delegates_to_owned_mock_test(monkeypatch):
    run = Mock(return_value=subprocess.CompletedProcess([], 1))
    monkeypatch.setattr(subprocess, "run", run)
    driver = _load_driver()
    run.assert_not_called()  # Importing the old entry point must not start work.
    monkeypatch.setattr(driver.shutil, "which", lambda name: "/test/node")
    monkeypatch.setenv("WMS_BROWSER_PROFILE", "/production/profile")
    monkeypatch.setenv("NODE_OPTIONS", "--require=/production/hook.js")
    assert driver.main([]) == 1  # Preserve test failure instead of swallowing it.
    command = run.call_args.args[0]
    assert command[0] == "/test/node"
    assert command[1].endswith("/planner/test-wms-ui.js")
    assert len(command) == 2
    assert not any(name.startswith("WMS_") for name in run.call_args.kwargs["env"])
    assert "NODE_OPTIONS" not in run.call_args.kwargs["env"]


def test_full_auto_does_not_accept_a_production_url(monkeypatch):
    driver = _load_driver()
    run = Mock()
    monkeypatch.setattr(subprocess, "run", run)
    with pytest.raises(SystemExit) as error:
        driver.main(["--url", "http://127.0.0.1:8001/"])
    assert error.value.code == 2
    run.assert_not_called()
