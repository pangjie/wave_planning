"""Launch the configured browser without visiting the production WMS site."""

from __future__ import annotations

import asyncio
from pathlib import Path
import sys
import tempfile

# 支持从项目目录直接运行，不依赖调用者恰好设置 PYTHONPATH。
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.automation.common import first_page, open_browser_context
from app.core.config import Settings


async def main() -> None:
    configured = Settings.from_environment()
    print(f"浏览器通道：{configured.browser_channel or 'Playwright Chromium'}；"
          f"模式：{'无头' if configured.headless else '有头'}；仅检查临时离线页面。")
    with tempfile.TemporaryDirectory(prefix="wms-browser-smoke-") as temporary:
        root = Path(temporary)
        settings = configured.model_copy(update={
            "browser_profile_dir": root / "profile",
            "downloads_dir": root / "downloads",
            "outputs_dir": root / "outputs",
        })
        warnings: list[str] = []
        # 与生产使用同一启动/收尾实现，但绝不打开生产 profile 或 WMS 页面。
        async with open_browser_context(settings, headless=settings.headless,
                                        downloads_dir=settings.downloads_dir,
                                        cleanup_warnings=warnings) as context:
            page = await first_page(context)
            await page.goto("data:text/html,<title>browser-ok</title>")
            if await page.title() != "browser-ok":
                raise RuntimeError("浏览器未能正确读取离线测试页面。")
        if warnings:
            raise RuntimeError("浏览器已启动，但收尾异常：" + "；".join(warnings))
        print("browser-ok")


if __name__ == "__main__":
    asyncio.run(main())
