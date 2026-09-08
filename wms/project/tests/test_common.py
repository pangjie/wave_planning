import asyncio
import sqlite3

import pytest

from app.automation import common
from app.core.config import Settings


def test_reset_browser_download_state_preserves_login_and_browsing_data(
    tmp_path,
) -> None:
    """Only Chrome download metadata is reset; login/site state stays intact."""
    default = tmp_path / "Default"
    default.mkdir()
    shared = default / "shared_proto_db"
    shared.mkdir()
    (shared / "000003.log").write_bytes(b"021_download")
    (default / "Cookies").write_bytes(b"login-cookie")

    history = default / "History"
    with sqlite3.connect(history) as connection:
        connection.execute("CREATE TABLE downloads (id INTEGER)")
        connection.execute("CREATE TABLE downloads_url_chains (id INTEGER)")
        connection.execute("CREATE TABLE downloads_slices (id INTEGER)")
        connection.execute("CREATE TABLE urls (id INTEGER)")
        connection.execute("INSERT INTO downloads VALUES (1)")
        connection.execute("INSERT INTO downloads_url_chains VALUES (1)")
        connection.execute("INSERT INTO downloads_slices VALUES (1)")
        connection.execute("INSERT INTO urls VALUES (99)")

    common.reset_browser_download_state(tmp_path)

    assert not shared.exists()
    assert (default / "Cookies").read_bytes() == b"login-cookie"
    with sqlite3.connect(history) as connection:
        assert connection.execute("SELECT count(*) FROM downloads").fetchone() == (0,)
        assert connection.execute(
            "SELECT count(*) FROM downloads_url_chains"
        ).fetchone() == (0,)
        assert connection.execute(
            "SELECT count(*) FROM downloads_slices"
        ).fetchone() == (0,)
        assert connection.execute("SELECT id FROM urls").fetchone() == (99,)


def test_reset_browser_download_state_allows_missing_profile(tmp_path) -> None:
    common.reset_browser_download_state(tmp_path)


class _FakeContext:
    """可编程 close 行为的最小上下文替身。"""

    def __init__(self, close_error: Exception | None = None) -> None:
        self.close_error = close_error
        self.close_calls = 0

    async def close(self) -> None:
        self.close_calls += 1
        if self.close_error is not None:
            raise self.close_error


class _FakePlaywright:
    def __init__(self, context: _FakeContext) -> None:
        self._context = context
        self.chromium = _FakeChromium(context)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc) -> None:
        return None


class _FakeChromium:
    def __init__(self, context: _FakeContext) -> None:
        self._context = context

    async def launch_persistent_context(self, **kwargs):
        return self._context


@pytest.mark.asyncio
async def test_close_error_does_not_mask_original_exception(monkeypatch) -> None:
    """回归：业务异常路径上 close() 失败时，必须保留原始异常（第一现场）。"""
    context = _FakeContext(
        close_error=RuntimeError("Target page, context or browser has been closed")
    )
    monkeypatch.setattr(common, "async_playwright", lambda: _FakePlaywright(context))
    settings = Settings.from_environment()

    with pytest.raises(RuntimeError, match="原始业务错误"):
        async with common.open_browser_context(settings, headless=True):
            raise RuntimeError("原始业务错误")

    assert context.close_calls == 1  # close 仍尽力执行了一次


@pytest.mark.asyncio
async def test_close_error_on_success_path_is_a_visible_warning(monkeypatch) -> None:
    """成功路径的关闭故障可见，但不能覆盖已确认结果。"""
    context = _FakeContext(
        close_error=RuntimeError("Target page, context or browser has been closed")
    )
    monkeypatch.setattr(common, "async_playwright", lambda: _FakePlaywright(context))
    settings = Settings.from_environment()

    warnings = []
    async with common.open_browser_context(settings, headless=True, cleanup_warnings=warnings):
        confirmed = "confirmed result"

    assert confirmed == "confirmed result"
    assert len(warnings) == 1 and "has been closed" in warnings[0]
    assert context.close_calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("body_failure", [None, RuntimeError("original operation"), asyncio.CancelledError()])
async def test_driver_shutdown_error_never_replaces_result_or_original_error(monkeypatch, body_failure):
    context = _FakeContext(close_error=RuntimeError("context close"))

    class Driver(_FakePlaywright):
        async def __aexit__(self, *exc):
            raise RuntimeError("driver close")

    monkeypatch.setattr(common, "async_playwright", lambda: Driver(context))
    warnings = []

    async def execute():
        async with common.open_browser_context(Settings.from_environment(), headless=True, cleanup_warnings=warnings):
            if body_failure is not None:
                raise body_failure
            return "confirmed"

    if body_failure is None:
        assert await execute() == "confirmed"
    else:
        with pytest.raises(type(body_failure)) as raised:
            await execute()
        assert raised.value is body_failure
    assert len(warnings) == 2
    assert "context close" in warnings[0] and "driver close" in warnings[1]


@pytest.mark.asyncio
async def test_launch_failure_still_stops_driver_and_preserves_launch_error(monkeypatch):
    context = _FakeContext()
    driver = _FakePlaywright(context)

    async def launch(**_):
        raise RuntimeError("launch failure")

    driver.chromium.launch_persistent_context = launch

    class Manager(_FakePlaywright):
        async def __aexit__(self, *exc):
            raise RuntimeError("driver failure")

    manager = Manager(context)
    manager.chromium = driver.chromium
    monkeypatch.setattr(common, "async_playwright", lambda: manager)
    warnings = []
    with pytest.raises(RuntimeError, match="launch failure"):
        async with common.open_browser_context(Settings.from_environment(), headless=True, cleanup_warnings=warnings):
            pytest.fail("must not enter")
    assert context.close_calls == 0
    assert "driver failure" in warnings[0]


@pytest.mark.asyncio
async def test_cleanup_warning_collectors_are_scoped_and_inherited_by_child_tasks(monkeypatch):
    monkeypatch.setattr(common, "async_playwright", lambda: _FakePlaywright(_FakeContext()))
    settings = Settings.from_environment()
    outer, inner = [], []

    async def fail():
        raise RuntimeError("failure")

    async with common.open_browser_context(settings, headless=True, cleanup_warnings=outer):
        await asyncio.create_task(common.run_cleanup(fail, "outer child"))
        async with common.open_browser_context(settings, headless=True, cleanup_warnings=inner):
            await common.run_cleanup(fail, "inner")
        await common.run_cleanup(fail, "outer again")
    await common.run_cleanup(fail, "not attached")
    assert len(outer) == 2 and len(inner) == 1
    assert all("outer" in warning for warning in outer)
    assert "inner" in inner[0]


@pytest.mark.asyncio
async def test_cleanup_does_not_swallow_cancellation():
    async def cancelled():
        raise asyncio.CancelledError()

    warnings = []
    with pytest.raises(asyncio.CancelledError):
        await common.run_cleanup(cancelled, "closing", warnings)
    assert warnings == []
