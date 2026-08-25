from __future__ import annotations

import asyncio
import json
import time
from dataclasses import asdict
from datetime import date, datetime
from typing import Literal
from pathlib import Path
from uuid import uuid4

from pydantic import BaseModel, Field

from app.automation import (
    ExportResult,
    WaveGenerateResult,
    WavePickResult,
    WavePrintResult,
    WmsExportAutomation,
    WmsWaveGenerateAutomation,
    WmsWavePickAutomation,
    WmsWavePrintAutomation,
)
from app.core.config import Settings
from app.services.wave_records import upsert_records


JobStatus = Literal["queued", "running", "succeeded", "partial", "failed", "cancelled"]
RunMode = Literal["export", "print_waves", "pick_waves", "generate_waves"]
BrowserMode = Literal["headed", "headless"]


class ActiveJobConflictError(RuntimeError):
    """Raised when a second production task is submitted while one is active."""


class JobEvent(BaseModel):
    """One progress log line emitted by a running job."""
    stage: str
    message: str
    at: str = Field(default_factory=lambda: datetime.now().astimezone().isoformat())


class JobRecord(BaseModel):
    """In-memory projection of a submitted automation job."""
    id: str
    mode: RunMode
    browser_mode: BrowserMode = "headed"
    status: JobStatus = "queued"
    created_at: str = Field(default_factory=lambda: datetime.now().astimezone().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now().astimezone().isoformat())
    events: list[JobEvent] = Field(default_factory=list)
    wave_nos: list[str] = Field(default_factory=list)
    segments: list[dict[str, object]] = Field(default_factory=list)
    result: dict[str, str | int | list[str] | list[dict[str, object]]] | None = None
    error: str | None = None


class JobManager:
    """In-memory job registry with a single-browser concurrency guard."""

    def __init__(
        self,
        export_automation: WmsExportAutomation,
        wave_pick_automation: WmsWavePickAutomation | None = None,
        wave_print_automation: WmsWavePrintAutomation | None = None,
        wave_generate_automation: WmsWaveGenerateAutomation | None = None,
        settings: Settings | None = None,
    ) -> None:
        self.export_automation = export_automation
        self.wave_pick_automation = wave_pick_automation
        self.wave_print_automation = wave_print_automation
        self.wave_generate_automation = wave_generate_automation
        # 波次记录目录：data/（与浏览器配置同级）
        self.wave_records_dir = (
            settings.browser_profile_dir.parent
            if settings
            else Path(__file__).resolve().parents[3] / "data"
        )
        # 任务日志持久化（仅当天）：data/jobs.json；测试未提供 settings 时不落盘
        self._jobs_file = self.wave_records_dir / "jobs.json"
        self._persist_enabled = settings is not None
        self._last_persist = 0.0
        self.jobs: dict[str, JobRecord] = {}
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self._load_persisted()
        self._run_lock = asyncio.Lock()

    @staticmethod
    def _same_day(created_at: str) -> bool:
        try:
            return datetime.fromisoformat(created_at).date() == date.today()
        except ValueError:
            return False

    def _load_persisted(self) -> None:
        if not self._persist_enabled or not self._jobs_file.is_file():
            return
        try:
            raw = json.loads(self._jobs_file.read_text("utf-8"))
        except Exception:
            return
        for item in raw if isinstance(raw, list) else []:
            try:
                job = JobRecord.model_validate(item)
            except Exception:
                continue
            if self._same_day(job.created_at):
                self.jobs[job.id] = job

    def _persist(self, force: bool = False) -> None:
        """节流写盘：事件流最多每秒写一次；force=True（终态）总是写。"""
        if not self._persist_enabled:
            return
        now = time.monotonic()
        if not force and now - self._last_persist < 1.0:
            return
        self._last_persist = now
        try:
            data = [
                job.model_dump(mode="json")
                for job in self.jobs.values()
                if self._same_day(job.created_at)
            ]
            data.sort(key=lambda item: item.get("created_at", ""))
            self._jobs_file.write_text(
                json.dumps(data, ensure_ascii=False, indent=1), "utf-8"
            )
        except Exception:
            pass

    def create(
        self,
        mode: RunMode,
        browser_mode: BrowserMode = "headed",
        *,
        wave_nos: list[str] | None = None,
        segments: list[dict[str, object]] | None = None,
    ) -> JobRecord:
        active_job = next(
            (job for job in self.jobs.values() if job.status in {"queued", "running"}),
            None,
        )
        if active_job:
            raise ActiveJobConflictError(
                "已有任务正在排队或执行，请等待当前任务结束后再提交。"
            )
        job = JobRecord(
            id=uuid4().hex,
            mode=mode,
            browser_mode=browser_mode,
            wave_nos=list(wave_nos or []),
            segments=list(segments or []),
        )
        job.events.append(JobEvent(stage="queued", message="任务已进入队列。"))
        self.jobs[job.id] = job
        self.tasks[job.id] = asyncio.create_task(self._execute(job.id))
        self._persist()
        return job

    def get(self, job_id: str) -> JobRecord | None:
        return self.jobs.get(job_id)

    def list(self) -> list[JobRecord]:
        return sorted(self.jobs.values(), key=lambda item: item.created_at, reverse=True)[:50]

    async def cancel(self, job_id: str) -> JobRecord | None:
        job = self.jobs.get(job_id)
        task = self.tasks.get(job_id)
        if not job:
            return None
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        if job.status in {"queued", "running"}:
            job.status = "cancelled"
            job.updated_at = datetime.now().astimezone().isoformat()
            if not job.events or job.events[-1].stage != "cancelled":
                job.events.append(JobEvent(stage="cancelled", message="任务已取消。"))
        return job

    async def _execute(self, job_id: str) -> None:
        job = self.jobs[job_id]

        async def progress(stage: str, message: str) -> None:
            job.status = "running"
            job.updated_at = datetime.now().astimezone().isoformat()
            job.events.append(JobEvent(stage=stage, message=message))
            self._persist()
            # 生成波次逐段上报：立即持久化，保证中断时已完成分段的波次号不丢失
            if stage == "segment_wave" and job.mode == "generate_waves":
                try:
                    data = json.loads(message)
                    if isinstance(data, dict) and data.get("wave_no"):
                        upsert_records(self.wave_records_dir, [data])
                except Exception:
                    pass

        try:
            async with self._run_lock:
                if job.mode == "generate_waves":
                    if not self.wave_generate_automation:
                        raise RuntimeError("生成波次自动化尚未配置。")
                    result: WaveGenerateResult | WavePickResult | WavePrintResult | ExportResult = (
                        await self.wave_generate_automation.run(
                            progress,
                            headless=job.browser_mode == "headless",
                            segments=job.segments,
                        )
                    )
                elif job.mode == "pick_waves":
                    if not self.wave_pick_automation:
                        raise RuntimeError("波次拣货自动化尚未配置。")
                    result: WavePickResult | WavePrintResult | ExportResult = (
                        await self.wave_pick_automation.run(
                            progress,
                            headless=job.browser_mode == "headless",
                            wave_nos=job.wave_nos,
                        )
                    )
                elif job.mode == "print_waves":
                    if not self.wave_print_automation:
                        raise RuntimeError("选中波次打印自动化尚未配置。")
                    result = await self.wave_print_automation.run(
                        progress,
                        wave_nos=job.wave_nos,
                        headless=job.browser_mode == "headless",
                    )
                else:
                    result = await self.export_automation.run(
                        progress,
                        headless=job.browser_mode == "headless",
                    )
                result_data = {
                    key: value
                    for key, value in asdict(result).items()
                    if value is not None
                }
            job.status = "partial" if (result_data.get("failed_wave_nos") or result_data.get("failed_count")) else "succeeded"
            job.result = result_data
            # 生成波次：把带波次号的分段结果持久化，供规划页回填波次表
            if job.mode == "generate_waves":
                seg_outcomes = result_data.get("segments")
                if isinstance(seg_outcomes, list):
                    upsert_records(
                        self.wave_records_dir,
                        [
                            dict(o)
                            for o in seg_outcomes
                            if isinstance(o, dict) and o.get("wave_no")
                        ],
                    )
            completion_stage = (
                "completed_with_warnings" if job.status == "partial" else "completed"
            )
            job.events.append(
                JobEvent(stage=completion_stage, message=str(result_data["message"]))
            )
            self._persist(force=True)
        except asyncio.CancelledError:
            job.status = "cancelled"
            job.events.append(JobEvent(stage="cancelled", message="任务已取消。"))
            self._persist(force=True)
            raise
        except Exception as exc:
            job.status = "failed"
            job.error = str(exc)
            job.events.append(JobEvent(stage="failed", message=str(exc)))
        finally:
            job.updated_at = datetime.now().astimezone().isoformat()
