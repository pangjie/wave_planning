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
async def test_close_error_on_success_path_still_surfaces(monkeypatch) -> None:
    """成功路径上 close() 失败仍要暴露（浏览器未正常关闭是真实异常）。"""
    context = _FakeContext(
        close_error=RuntimeError("Target page, context or browser has been closed")
    )
    monkeypatch.setattr(common, "async_playwright", lambda: _FakePlaywright(context))
    settings = Settings.from_environment()

    with pytest.raises(RuntimeError, match="has been closed"):
        async with common.open_browser_context(settings, headless=True):
            pass

    assert context.close_calls == 1
