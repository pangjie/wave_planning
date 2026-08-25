"""Launch the configured browser without visiting the production WMS site."""

from __future__ import annotations

import asyncio
import tempfile

from playwright.async_api import async_playwright


async def main() -> None:
    with tempfile.TemporaryDirectory() as profile:
        async with async_playwright() as playwright:
            context = await playwright.chromium.launch_persistent_context(
                profile,
                channel="chrome",
                headless=True,
            )
            page = context.pages[0]
            await page.goto("data:text/html,<title>browser-ok</title>")
            print(await page.title())
            await context.close()


if __name__ == "__main__":
    asyncio.run(main())

