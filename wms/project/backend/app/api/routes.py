from __future__ import annotations

import re
import os
import tempfile
from contextlib import suppress
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, model_validator

from app.automation.common import WAVE_NO_PATTERN
from app.core.config import AutomationConfig
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
    batch_id: str | None = None
    plan_id: str | None = None
    plan_snapshot: dict | None = None

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
                raw_channel = seg.get("channel", "")
                raw_seg_name = seg.get("seg_name", "")
                raw_order_nos = seg.get("order_nos", [])
                if not isinstance(raw_channel, str) or not isinstance(raw_seg_name, str):
                    raise ValueError("生成波次的渠道和分段名必须是字符串。")
                if not isinstance(raw_order_nos, list):
                    raise ValueError("生成波次的出库单号必须是字符串列表。")
                channel = raw_channel.strip()
                seg_name = raw_seg_name.strip()
                order_nos: list[str] = []
                seen: set[str] = set()
                for raw in raw_order_nos:
                    if not isinstance(raw, str):
                        raise ValueError("生成波次的每个出库单号必须是字符串。")
                    no = raw.strip()
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
            self.wave_nos = normalized
        else:
            self.wave_nos = []
        if any(v is not None for v in (self.batch_id, self.plan_id, self.plan_snapshot)):
            if self.mode != "generate_waves" or not self.batch_id or not self.plan_id or self.plan_snapshot is None:
                raise ValueError("计划身份与快照必须一起提交，且仅用于生成波次")
            from app.services.job_plans import validate_plan
            validate_plan(self.plan_snapshot, self.segments)
        return self

    def validate_wave_limit(self, config: AutomationConfig) -> None:
        """数量限制与执行器共用服务启动快照；普通结构校验不再读取磁盘。"""
        if self.mode not in {"print_waves", "pick_waves"}:
            return
        limit = (config.wave_printing.max_selected_waves if self.mode == "print_waves"
                 else config.wave_picking.max_selected_waves)
        if len(self.wave_nos) > limit:
            operation = "打印" if self.mode == "print_waves" else "拣货"
            raise ValueError(f"一次最多{operation} {limit} 个不同波次。")


def get_manager(request: Request) -> JobManager:
    return request.app.state.job_manager


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/wave-records", response_model=list[dict[str, object]])
async def wave_records(request: Request, batch_id: str | None = None, plan_id: str | None = None) -> list[dict[str, object]]:
    """已生成波次的分段记录（渠道/分段/波次号），供规划页回填波次表并标记完成。"""
    from app.services.wave_records import read_records

    data_dir = request.app.state.settings.browser_profile_dir.parent
    try:
        return read_records(data_dir, batch_id=batch_id, plan_id=plan_id)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=f"波次历史读取失败：{exc}") from exc


@router.post("/wave-records/clear")
async def clear_wave_records(request: Request, batch_id: str | None = None, plan_id: str | None = None) -> dict[str, str]:
    """仅清理指定批次的指定计划；无身份旧客户端不影响新计划记录。"""
    from app.services.wave_records import clear_records

    data_dir = request.app.state.settings.browser_profile_dir.parent
    try:
        clear_records(data_dir, batch_id=batch_id, plan_id=plan_id)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=f"波次历史未清空，原记录已保留：{exc}") from exc
    return {"status": "ok"}


@router.post("/jobs", response_model=JobRecord, status_code=status.HTTP_202_ACCEPTED)
async def create_job(
    payload: CreateJobRequest,
    request: Request,
    manager: JobManager = Depends(get_manager),
) -> JobRecord:
    try:
        payload.validate_wave_limit(request.app.state.automation_config)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    try:
        return manager.create(
            payload.mode,
            payload.browser_mode,
            wave_nos=payload.wave_nos,
            segments=payload.segments,
            batch_id=payload.batch_id, plan_id=payload.plan_id, plan_snapshot=payload.plan_snapshot,
        )
    except ActiveJobConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=503, detail=f"本地记录无法保存或读取，未启动 WMS 任务：{exc}"
        ) from exc


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


class RetryJobRequest(BaseModel):
    confirm_production: bool = False


@router.post("/jobs/{job_id}/retry", response_model=JobRecord, status_code=202)
async def retry_job(job_id: str, payload: RetryJobRequest, manager: JobManager = Depends(get_manager)) -> JobRecord:
    if not payload.confirm_production:
        raise HTTPException(status_code=422, detail="重试需要确认生产操作。")
    try:
        return manager.retry(job_id)
    except (ActiveJobConflictError, ValueError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=503, detail=f"续跑记录无法读取或保存，未启动：{exc}") from exc


@router.get("/jobs/{job_id}/plan")
async def get_job_plan(job_id: str, manager: JobManager = Depends(get_manager)) -> dict:
    from app.services.job_plans import read_plan
    job = manager.get(job_id)
    if not job or not job.has_plan_snapshot:
        raise HTTPException(status_code=404, detail="此任务没有提交时的计划快照，不能用当前计划替代。")
    try:
        snapshot = read_plan(manager.wave_records_dir, job.id, job.segments)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=f"提交计划快照读取失败：{exc}") from exc
    return {"batch_id": job.batch_id, "plan_id": job.plan_id, "snapshot": snapshot}


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


@router.post("/jobs/{job_id}/planning-export")
async def save_job_export(job_id: str, request: Request, manager: JobManager = Depends(get_manager)) -> dict[str, str]:
    """按任务只保存一份规划表；响应丢失或页面刷新后的重试不会新建副本。"""
    job = manager.get(job_id)
    if not job or not job.has_plan_snapshot:
        raise HTTPException(status_code=404, detail="任务没有提交计划快照。")
    if job.status in {"queued", "running"}:
        raise HTTPException(status_code=409, detail="任务尚未结束，请等待执行和清理完成后导出。")
    body = await request.body()
    if len(body) < 1000 or body[:4] != b"PK\x03\x04":
        raise HTTPException(status_code=400, detail="导出文件内容无效。")
    outputs_dir = Path(request.app.state.settings.outputs_dir)
    version = f"-r{job.attempt}" if job.attempt > 1 else ""
    name = f"波次规划{job.created_at[:10].replace('-', '')}-{job.id}{version}.xlsx"
    target = outputs_dir / name
    tmp = None
    try:
        outputs_dir.mkdir(parents=True, exist_ok=True)
        # 以下写入无 await；单机服务的请求不会在存在检查与替换之间交错。
        if not target.exists():
            with tempfile.NamedTemporaryFile(dir=outputs_dir, prefix=".planning-", suffix=".tmp", delete=False) as stream:
                tmp = Path(stream.name)
                stream.write(body)
            os.replace(tmp, target)
        else:
            with target.open("rb") as stream:
                if target.stat().st_size < 1000 or stream.read(4) != b"PK\x03\x04":
                    raise ValueError("已有规划导出文件不完整，已保留原文件，请先核对")
        job.planning_export_file = name
        if not manager._save_job(job, force=True):
            raise OSError("文件已保存，但任务记录未确认；可以重试保存，不会重复生成文件")
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    finally:
        if tmp is not None:
            with suppress(FileNotFoundError):
                tmp.unlink()
    return {"file": name, "url": f"/api/exports/{name}"}


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
