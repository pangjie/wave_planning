from __future__ import annotations

from contextlib import asynccontextmanager
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from app.api.routes import router
from app.automation import (
    WmsExportAutomation,
    WmsWaveGenerateAutomation,
    WmsWavePickAutomation,
    WmsWavePrintAutomation,
)
from app.core.config import get_settings
from app.services.job_manager import JobManager


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    automation_config = settings.load_automation()
    app.state.settings = settings
    app.state.automation_config = automation_config
    app.state.job_manager = JobManager(
        export_automation=WmsExportAutomation(settings, automation_config),
        wave_pick_automation=WmsWavePickAutomation(settings, automation_config),
        wave_print_automation=WmsWavePrintAutomation(settings, automation_config),
        wave_generate_automation=WmsWaveGenerateAutomation(
            settings, automation_config.wave_generation
        ),
        settings=settings,
    )
    yield


app = FastAPI(
    title="WMS 网页自动化工具",
    version="0.1.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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
