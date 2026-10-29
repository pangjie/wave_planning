# 测试隔离公共夹具：替换运行目录和生产自动化入口，防止测试落到真实 profile。
# 需要浏览器行为的单元测试使用 mock；临时服务测试只操作自己创建的进程。
"""Default tests own temporary data and cannot contact production services."""

from __future__ import annotations

import inspect
import ipaddress
import os
from pathlib import Path
import shutil
import socket

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def isolated_runtime(tmp_path: Path, monkeypatch):
    from app.automation import common
    from app.core import config
    from app.services.job_manager import JobManager
    import playwright.async_api

    root = tmp_path / "runtime"
    for name in ("config", "data/browser-profile", "downloads", "outputs", "frontend/dist"):
        (root / name).mkdir(parents=True)
    shutil.copyfile(PROJECT_ROOT / "config/automation.json", root / "config/automation.json")
    for name in tuple(os.environ):
        if name.startswith("WMS_"):
            monkeypatch.delenv(name)
    paths = {
        "WMS_PROJECT_ROOT": root,
        "WMS_AUTOMATION_CONFIG": root / "config/automation.json",
        "WMS_BROWSER_PROFILE": root / "data/browser-profile",
        "WMS_DOWNLOADS_DIR": root / "downloads",
        "WMS_OUTPUTS_DIR": root / "outputs",
        "WMS_FRONTEND_DIST": root / "frontend/dist",
    }
    for name, value in paths.items():
        monkeypatch.setenv(name, str(value))
    monkeypatch.setenv("WMS_BROWSER_CHANNEL", "chrome")
    monkeypatch.setenv("WMS_HEADLESS", "true")
    monkeypatch.setattr(config, "PROJECT_ROOT", root)
    config.get_settings.cache_clear()

    # main may already have been imported during test collection; environment
    # changes alone do not replace its cached static-file paths.
    frontend_dist = root / "frontend/dist"
    index_html = frontend_dist / "index.html"
    index_html.write_text("<!doctype html><title>Isolated test frontend</title>", "utf-8")
    from app import main
    monkeypatch.setattr(main, "frontend_dist", frontend_dist)
    monkeypatch.setattr(main, "index_html", index_html)

    # Without explicit Settings, JobManager can write source-relative wave data.
    # Reject unsafe test setup instead of silently changing the behavior under test.
    original_init = JobManager.__init__
    signature = inspect.signature(original_init)

    def checked_init(self, *args, **kwargs):
        settings = signature.bind(self, *args, **kwargs).arguments.get("settings")
        if settings is None:
            raise AssertionError("Tests must supply isolated Settings to JobManager")
        for value in (settings.browser_profile_dir.parent, settings.downloads_dir, settings.outputs_dir):
            if not value.resolve().is_relative_to(tmp_path.resolve()):
                raise AssertionError("JobManager test data must stay inside tmp_path")
        original_init(self, *args, **kwargs)

    monkeypatch.setattr(JobManager, "__init__", checked_init)

    def no_real_browser(*args, **kwargs):
        raise AssertionError("Default tests must mock Playwright; no production browser may start")

    monkeypatch.setattr(common, "async_playwright", no_real_browser)
    monkeypatch.setattr(playwright.async_api, "async_playwright", no_real_browser)
    try:
        yield config.get_settings()
    finally:
        config.get_settings.cache_clear()


@pytest.fixture
def app(isolated_runtime):
    # Delay main import until the first temporary index exists; static routes
    # are registered conditionally when that module is initially imported.
    from app.main import app
    return app


@pytest.fixture(autouse=True)
def test_network(monkeypatch):
    """Block even localhost services unless this test explicitly owns the endpoint."""
    allowed: set[tuple[str, int]] = set()
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    original_sendto = socket.socket.sendto
    original_getaddrinfo = socket.getaddrinfo

    def allow_loopback(host: str, port: int) -> None:
        if not ipaddress.ip_address(host).is_loopback or not 0 < port < 65536:
            raise AssertionError("Only an owned numeric loopback endpoint can be allowed")
        allowed.add((host, port))

    def check(address):
        if not isinstance(address, tuple) or (str(address[0]), int(address[1])) not in allowed:
            raise AssertionError("Network blocked: explicitly allow only this test's own server")

    def connect(sock, address):
        if sock.family in (socket.AF_INET, socket.AF_INET6):
            check(address)
        return original_connect(sock, address)

    def connect_ex(sock, address):
        if sock.family in (socket.AF_INET, socket.AF_INET6):
            check(address)
        return original_connect_ex(sock, address)

    def sendto(sock, data, *args):
        if sock.family in (socket.AF_INET, socket.AF_INET6):
            check(args[-1])
        return original_sendto(sock, data, *args)

    def getaddrinfo(host, port, *args, **kwargs):
        check((host, port))  # Reject external DNS before calling the OS resolver.
        return original_getaddrinfo(host, port, *args, **kwargs)

    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket.socket, "connect_ex", connect_ex)
    monkeypatch.setattr(socket.socket, "sendto", sendto)
    monkeypatch.setattr(socket, "getaddrinfo", getaddrinfo)
    return allow_loopback
