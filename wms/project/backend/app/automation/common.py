from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
import re

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


# 波次号白名单：仅字母、数字、下划线、连字符（防路径注入与歧义匹配）
WAVE_NO_PATTERN = re.compile(r"[A-Za-z0-9_-]+")


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


@asynccontextmanager
async def open_browser_context(
    settings: Settings,
    *,
    headless: bool,
    downloads_dir: Path | None = None,
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

    async with async_playwright() as playwright:
        context = await playwright.chromium.launch_persistent_context(**launch_options)
        try:
            yield context
        except BaseException:
            # 业务异常路径：close() 失败（如页面/浏览器已断开，报
            # "Target page, context or browser has been closed"）绝不能覆盖
            # 原始异常——否则日志只看到清理错误，第一现场被吞掉。
            try:
                await context.close()
            except Exception:
                pass
            raise
        else:
            await context.close()
