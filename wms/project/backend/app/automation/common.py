from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from contextvars import ContextVar
from pathlib import Path
import re
import shutil
import sqlite3
import sys

from playwright.async_api import (
    BrowserContext,
    Frame,
    Locator,
    Page,
    TimeoutError as PlaywrightTimeoutError,
    async_playwright,
)

from app.core.config import Settings


ProgressCallback = Callable[[str, str], Awaitable[None]]
_cleanup_warnings: ContextVar[list[str] | None] = ContextVar("wms_cleanup_warnings", default=None)
logger = logging.getLogger(__name__)


def record_cleanup_warning(label: str, exc: Exception, warnings: list[str] | None = None) -> None:
    """Report housekeeping faults separately from confirmed business outcomes."""
    message = f"{label}失败：{exc}。已确认的业务结果保留，不会因此重新执行。"
    collector = warnings if warnings is not None else _cleanup_warnings.get()
    if collector is not None:
        collector.append(message)
    logger.warning(message, exc_info=True)


async def run_cleanup(
    action: Callable[[], Awaitable[object]], label: str, warnings: list[str] | None = None,
) -> bool:
    try:
        await action()
        return True
    except Exception as exc:
        # Cancellation remains cancellation; only ordinary housekeeping errors
        # become warnings. Never call a fallible progress callback in cleanup.
        record_cleanup_warning(label, exc, warnings)
        return False


# 波次号白名单：仅字母、数字、下划线、连字符（防路径注入与歧义匹配）
WAVE_NO_PATTERN = re.compile(r"[A-Za-z0-9_-]+")


class CheckpointError(RuntimeError):
    """A durable execution boundary could not be saved; do not continue."""


class AutomationError(RuntimeError):
    """An automation failure safe to expose in the job log."""


class SearchResultNotAppliedError(AutomationError):
    """搜索后结果疑似仍是上一次查询的残留（总数与上一分段数量相同）。"""


def resolve_headless(settings: Settings, headless: bool | None) -> bool:
    """Resolve a per-job browser choice against the environment default."""
    return settings.headless if headless is None else headless


async def first_page(context: BrowserContext) -> Page:
    """Reuse the first open page of a fresh context, creating one when empty."""
    return context.pages[0] if context.pages else await context.new_page()


async def wait_for_loading(
    page: Page | Frame,
    selector: str,
    timeout_ms: int,
    err_message: str,
) -> None:
    """Wait for a loading mask to disappear, wrapping timeout as AutomationError."""
    try:
        await page.locator(selector).wait_for(state="hidden", timeout=timeout_ms)
    except PlaywrightTimeoutError as exc:
        raise AutomationError(err_message) from exc


async def wait_for_input_value(
    locator: Locator, expected: str, timeout_ms: int
) -> str:
    """轮询输入框当前值直到等于期望或超时，返回最后一次读到的值（调用方负责比对报错）。"""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_ms / 1000
    current = ""
    while loop.time() < deadline:
        current = (await locator.input_value()).strip()
        if current == expected:
            return current
        await asyncio.sleep(0.1)
    return current


def normalize_wave_nos(raw_items: list[str]) -> list[str]:
    """去空白、去空项、按出现顺序去重；格式与数量校验由调用方按各自错误语义负责。"""
    out: list[str] = []
    seen: set[str] = set()
    for raw in raw_items:
        wave_no = str(raw).strip()
        if not wave_no or wave_no in seen:
            continue
        seen.add(wave_no)
        out.append(wave_no)
    return out


def reset_browser_download_state(profile_dir: Path) -> None:
    """Remove Chrome's persisted download state without touching login data.

    Chrome 152 on macOS can crash on the second headless download when the
    persistent profile still contains the previous download in both History and
    shared_proto_db (the ``021_download`` namespace). Cookies, local/session
    storage, saved logins and site permissions live elsewhere and are preserved.
    """
    default_dir = profile_dir / "Default"
    if not default_dir.is_dir():
        return

    shared_proto_db = default_dir / "shared_proto_db"
    try:
        if shared_proto_db.is_symlink() or shared_proto_db.is_file():
            shared_proto_db.unlink()
        elif shared_proto_db.is_dir():
            shutil.rmtree(shared_proto_db)
    except OSError as exc:
        raise AutomationError(f"无法清理浏览器下载元数据库：{exc}") from exc

    history = default_dir / "History"
    if not history.is_file():
        return
    download_tables = ("downloads_slices", "downloads_url_chains", "downloads")
    try:
        with sqlite3.connect(history, timeout=5) as connection:
            existing = {
                str(row[0])
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
            for table in download_tables:
                if table in existing:
                    connection.execute(f"DELETE FROM {table}")
    except sqlite3.Error as exc:
        raise AutomationError(f"无法清理浏览器下载历史：{exc}") from exc


@asynccontextmanager
async def open_browser_context(
    settings: Settings,
    *,
    headless: bool,
    downloads_dir: Path | None = None,
    cleanup_warnings: list[str] | None = None,
) -> AsyncIterator[BrowserContext]:
    """Open and reliably close the shared persistent WMS browser profile."""
    settings.browser_profile_dir.mkdir(parents=True, exist_ok=True)
    launch_options: dict[str, object] = {
        "user_data_dir": str(settings.browser_profile_dir),
        "headless": headless,
        "viewport": {"width": 1440, "height": 900},
    }
    if settings.browser_channel:
        launch_options["channel"] = settings.browser_channel
    if downloads_dir:
        downloads_dir.mkdir(parents=True, exist_ok=True)
        launch_options.update(
            accept_downloads=True,
            downloads_path=str(downloads_dir),
        )

    collector = cleanup_warnings if cleanup_warnings is not None else []
    token = _cleanup_warnings.set(collector)
    try:
        playwright_manager = async_playwright()
        playwright = await playwright_manager.__aenter__()
        try:
            context = await playwright.chromium.launch_persistent_context(**launch_options)
            try:
                yield context
            finally:
                await run_cleanup(context.close, "关闭专用浏览器")
        finally:
            exit_info = sys.exc_info()
            await run_cleanup(
                lambda: playwright_manager.__aexit__(*exit_info), "关闭浏览器驱动",
            )
    finally:
        _cleanup_warnings.reset(token)
