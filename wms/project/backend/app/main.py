# 服务入口：启动时读取配置并取得本机运行锁，创建任务管理器和截单调度器。
# 关闭时先停止截单调度并禁止派发跟随打印，再等待现有任务取消与浏览器清理完成。
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import logging
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse

from app.api.routes import router
from app.automation import (
    WmsExportAutomation,
    WmsWaveGenerateAutomation,
    WmsWavePickAutomation,
    WmsWavePrintAutomation,
)
from app.core.config import get_settings
from app.core.runtime_lock import exclusive_runtime
from app.services.job_manager import JobManager
from app.services.cutoff_schedule import CutoffScheduler


async def _stop_jobs(manager: JobManager, scheduler: CutoffScheduler | None = None) -> None:
    manager.closing = True
    if scheduler:
        await scheduler.stop()
    # cancel() also saves jobs cancelled before their executor's first turn.
    results = await asyncio.gather(
        *(manager.cancel(job_id) for job_id, task in list(manager.tasks.items()) if not task.done()),
        return_exceptions=True,
    )
    for result in results:
        if isinstance(result, BaseException):
            logging.getLogger(__name__).error("停止后台任务时发生异常：%s", result)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    automation_config = settings.load_automation()
    # Ownership must precede JobManager's restart recovery and remain held
    # through browser teardown and final persistence, regardless of the port.
    with exclusive_runtime(settings):
        app.state.settings = settings
        app.state.automation_config = automation_config
        manager = JobManager(
            export_automation=WmsExportAutomation(settings, automation_config),
            wave_pick_automation=WmsWavePickAutomation(settings, automation_config),
            wave_print_automation=WmsWavePrintAutomation(settings, automation_config),
            wave_generate_automation=WmsWaveGenerateAutomation(
                settings, automation_config.wave_generation
            ),
            settings=settings,
        )
        app.state.job_manager = manager
        manager.dispatch_follow_print()
        scheduler = CutoffScheduler(manager, settings.downloads_dir)
        app.state.cutoff_scheduler = scheduler
        scheduler.start()
        try:
            yield
        finally:
            shutdown = asyncio.create_task(_stop_jobs(manager, scheduler))
            interrupted = False
            while not shutdown.done():
                try:
                    await asyncio.shield(shutdown)
                except asyncio.CancelledError:
                    # Do not release the profile while a cancelled executor
                    # is still saving results or closing its browser.
                    interrupted = True
            shutdown.result()
            if interrupted:
                raise asyncio.CancelledError


app = FastAPI(
    title="WMS 网页自动化工具",
    version="0.1.0",
    lifespan=lifespan,
)
app.include_router(router)


frontend_dist = Path(
    os.getenv(
        "WMS_FRONTEND_DIST",
        Path(__file__).resolve().parents[2] / "frontend" / "dist",
    )
).expanduser().resolve()
index_html = frontend_dist / "index.html"
if index_html.is_file():
    @app.get("/{full_path:path}", include_in_schema=False)
    async def frontend(full_path: str) -> FileResponse:
        candidate = (frontend_dist / full_path).resolve()
        # 路径穿越防护：仅允许返回 frontend_dist 内的静态文件
        if full_path and candidate.is_file() and candidate.is_relative_to(frontend_dist):
            return FileResponse(candidate)
        return FileResponse(index_html)
