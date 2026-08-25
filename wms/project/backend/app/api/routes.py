from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, model_validator

from app.automation.common import WAVE_NO_PATTERN
from app.services.job_manager import (
    ActiveJobConflictError,
    BrowserMode,
    JobManager,
    JobRecord,
    RunMode,
)


router = APIRouter(prefix="/api")


class CreateJobRequest(BaseModel):
    mode: RunMode = "export"
    browser_mode: BrowserMode = "headed"
    confirm_production: bool = False
    wave_nos: list[str] = Field(default_factory=list)
    segments: list[dict[str, object]] = Field(default_factory=list)

    @model_validator(mode="after")
    def require_production_confirmation(self) -> "CreateJobRequest":
        if not self.confirm_production:
            operation = {
                "export": "正式导出",
                "print_waves": "选中波次打印",
                "pick_waves": "批量波次拣货",
                "generate_waves": "生成波次",
            }.get(self.mode, "生产操作")
            raise ValueError(f"{operation}必须显式确认生产操作。")
        if self.mode == "generate_waves":
            normalized_segments: list[dict[str, object]] = []
            for seg in self.segments:
                channel = str(seg.get("channel", "")).strip()
                seg_name = str(seg.get("seg_name", "")).strip()
                order_nos: list[str] = []
                seen: set[str] = set()
                for raw in (seg.get("order_nos") or []):
                    no = str(raw).strip()
                    if not no or no in seen:
                        continue
                    if not WAVE_NO_PATTERN.fullmatch(no):
                        raise ValueError(f"出库单号格式异常：{no}")
                    seen.add(no)
                    order_nos.append(no)
                if not channel or not seg_name or not order_nos:
                    raise ValueError("生成波次的每个分段必须包含渠道、分段名与至少一个出库单号。")
                normalized_segments.append({
                    "channel": channel, "seg_name": seg_name, "order_nos": order_nos,
                })
            if not normalized_segments:
                raise ValueError("生成波次时必须至少提供一个分段。")
            self.segments = normalized_segments
        elif self.mode in {"print_waves", "pick_waves"}:
            normalized: list[str] = []
            seen: set[str] = set()
            for raw in self.wave_nos:
                wave_no = raw.strip()
                if not wave_no or wave_no in seen:
                    continue
                if not WAVE_NO_PATTERN.fullmatch(wave_no):
                    raise ValueError(f"波次号格式异常：{wave_no}")
                seen.add(wave_no)
                normalized.append(wave_no)
            if not normalized:
                if self.mode == "print_waves":
                    raise ValueError("打印选中波次时必须至少提供一个波次号。")
            limit = 100 if self.mode == "print_waves" else 500  # 与 config.wave_printing.max_selected_waves 对齐
            if len(normalized) > limit:
                operation = "打印" if self.mode == "print_waves" else "拣货"
                raise ValueError(f"一次最多{operation} {limit} 个不同波次。")
            self.wave_nos = normalized
        else:
            self.wave_nos = []
        return self


def get_manager(request: Request) -> JobManager:
    return request.app.state.job_manager


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/wave-records", response_model=list[dict[str, object]])
async def wave_records(request: Request) -> list[dict[str, object]]:
    """已生成波次的分段记录（渠道/分段/波次号），供规划页回填波次表并标记完成。"""
    from app.services.wave_records import read_records

    data_dir = request.app.state.settings.browser_profile_dir.parent
    return read_records(data_dir)


@router.post("/wave-records/clear")
async def clear_wave_records(request: Request) -> dict[str, str]:
    """导入新订单文件时清理既往波次历史（分段波次记录不跨批次保留）。"""
    from app.services.wave_records import clear_records

    data_dir = request.app.state.settings.browser_profile_dir.parent
    clear_records(data_dir)
    return {"status": "ok"}


@router.post("/jobs", response_model=JobRecord, status_code=status.HTTP_202_ACCEPTED)
async def create_job(
    payload: CreateJobRequest,
    manager: JobManager = Depends(get_manager),
) -> JobRecord:
    try:
        return manager.create(
            payload.mode,
            payload.browser_mode,
            wave_nos=payload.wave_nos,
            segments=payload.segments,
        )
    except ActiveJobConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.get("/jobs", response_model=list[JobRecord])
async def list_jobs(manager: JobManager = Depends(get_manager)) -> list[JobRecord]:
    return manager.list()


@router.get("/jobs/{job_id}", response_model=JobRecord)
async def get_job(job_id: str, manager: JobManager = Depends(get_manager)) -> JobRecord:
    job = manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在。")
    return job


@router.post("/jobs/{job_id}/cancel", response_model=JobRecord)
async def cancel_job(job_id: str, manager: JobManager = Depends(get_manager)) -> JobRecord:
    job = await manager.cancel(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在。")
    return job


@router.post("/exports")
async def save_export(request: Request, filename: str = "") -> dict[str, str]:
    """保存规划工具生成的 Excel 到项目输出目录，供日志提供下载链接。

    仅接受 xlsx 字节流；文件名做安全清洗后补全 .xlsx 后缀。
    """
    name = re.sub(r"[^\w\u4e00-\u9fff.()-]", "_", filename or "波次规划.xlsx").strip()
    if not name.endswith(".xlsx"):
        name += ".xlsx"
    body = await request.body()
    if not body or len(body) < 1000 or not body[:4] == b"PK\x03\x04":
        raise HTTPException(status_code=400, detail="导出文件内容无效。")
    outputs_dir = Path(request.app.state.settings.outputs_dir)
    outputs_dir.mkdir(parents=True, exist_ok=True)
    target = outputs_dir / name
    counter = 1
    while target.exists():
        target = outputs_dir / f"{name[:-5]}-{counter}.xlsx"
        counter += 1
    target.write_bytes(body)
    return {"file": target.name, "url": f"/api/exports/{target.name}"}


@router.get("/exports", response_model=list[dict[str, object]])
async def list_exports(request: Request) -> list[dict[str, object]]:
    """当天的全部波次规划导出文件（刷新页面后可随时翻阅并下载，最新在前）。"""
    from datetime import datetime

    outputs_dir = Path(request.app.state.settings.outputs_dir)
    cutoff = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    items: list[dict[str, object]] = []
    if outputs_dir.is_dir():
        for path in sorted(
            outputs_dir.glob("*.xlsx"), key=lambda p: p.stat().st_mtime, reverse=True
        )[:50]:
            if path.stat().st_mtime < cutoff:
                continue
            try:
                items.append({
                    "file": path.name,
                    "url": f"/api/exports/{path.name}",
                    "size": path.stat().st_size,
                    "modified_at": path.stat().st_mtime,
                })
            except OSError:
                continue
    return items


@router.get("/exports/{name}")
async def download_export(name: str, request: Request) -> FileResponse:
    """下载项目输出目录内的导出文件（白名单校验）。"""
    outputs_dir = Path(request.app.state.settings.outputs_dir).resolve()
    path = (outputs_dir / name).resolve()
    if path.parent != outputs_dir or not path.is_file():
        raise HTTPException(status_code=404, detail="导出文件不存在。")
    return FileResponse(
        path,
        filename=path.name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@router.get("/jobs/{job_id}/merged")
async def merged_pdf(
    job_id: str,
    request: Request,
    manager: JobManager = Depends(get_manager),
) -> FileResponse:
    """下载打印任务的合并 PDF（仅限项目输出目录内的文件）。"""
    job = manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在。")
    result = job.result or {}
    path_str = result.get("merged_file")
    if not path_str:
        raise HTTPException(status_code=404, detail="该任务没有合并文档。")
    outputs_dir = Path(request.app.state.settings.outputs_dir).resolve()
    path = Path(str(path_str)).expanduser().resolve()
    if path.parent != outputs_dir:
        raise HTTPException(status_code=403, detail="文件路径不在允许的输出目录内。")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="合并文档不存在。")
    return FileResponse(path, filename=path.name, media_type="application/pdf")


@router.get("/jobs/{job_id}/file")
async def export_file(
    job_id: str,
    request: Request,
    manager: JobManager = Depends(get_manager),
) -> FileResponse:
    """下载某个任务结果中的导出文件（仅限项目下载目录内的文件）。

    供波次规划工具在导出任务成功后自动拉取 ParcelOutbound_*.xlsx 并导入分析。
    """
    job = manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在。")
    result = job.result or {}
    path_str = result.get("downloaded_file")
    if not path_str:
        raise HTTPException(status_code=404, detail="该任务没有可下载的导出文件。")
    downloads_dir = Path(request.app.state.settings.downloads_dir).resolve()
    path = Path(str(path_str)).expanduser().resolve()
    if path.parent != downloads_dir:
        raise HTTPException(status_code=403, detail="文件路径不在允许的下载目录内。")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="导出文件不存在。")
    return FileResponse(
        path,
        filename=path.name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
