from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
import re

from playwright.async_api import BrowserContext, Page, TimeoutError as PlaywrightTimeoutError, async_playwright

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
    page: Page,
    selector: str,
    timeout_ms: int,
    err_message: str,
) -> None:
    """Wait for a loading mask to disappear, wrapping timeout as AutomationError."""
    try:
        await page.locator(selector).wait_for(state="hidden", timeout=timeout_ms)
    except PlaywrightTimeoutError as exc:
        raise AutomationError(err_message) from exc


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
        finally:
            await context.close()
