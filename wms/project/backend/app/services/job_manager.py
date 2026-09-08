from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import time
from contextlib import suppress
from dataclasses import asdict
from copy import deepcopy
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
from app.services.wave_records import read_records, upsert_records
from app.services.job_plans import save_plan, validate_plan


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
    persistence_error: str | None = None
    batch_id: str | None = None
    plan_id: str | None = None
    has_plan_snapshot: bool = False
    planning_export_file: str | None = None


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
        if not self._persist_enabled:
            return
        try:
            raw = json.loads(self._jobs_file.read_text("utf-8"))
        except FileNotFoundError:
            return
        except (json.JSONDecodeError, UnicodeError) as exc:
            raise ValueError(f"任务历史无法读取，原文件已保留：{self._jobs_file}（{exc}）") from exc
        # 先校验整份文件；不能跳过坏记录后把剩余部分覆盖回去。
        try:
            if not isinstance(raw, list):
                raise ValueError("根节点必须是任务列表")
            loaded: dict[str, JobRecord] = {}
            for item in raw:
                job = JobRecord.model_validate(item)
                datetime.fromisoformat(job.created_at)
                datetime.fromisoformat(job.updated_at)
                if not job.id or job.id in loaded:
                    raise ValueError("任务 ID 为空或重复")
                loaded[job.id] = job
        except ValueError as exc:
            raise ValueError(f"任务历史格式错误，原文件已保留：{self._jobs_file}（{exc}）") from exc
        recovered = False
        for job in loaded.values():
            if job.status in {"queued", "running"}:
                job.status = "failed"
                job.error = "服务重启，原任务已中断；已确认结果已保留，其余操作结果待核对，请勿直接重复执行。"
                job.updated_at = datetime.now().astimezone().isoformat()
                job.events.append(JobEvent(stage="interrupted", message=job.error))
                recovered = True
            if self._retain(job):
                self.jobs[job.id] = job
        if recovered:
            self._persist(force=True)

    def _retain(self, job: JobRecord) -> bool:
        # 跨午夜执行的任务不能被裁掉；重启发现的中断任务至少展示到恢复当天结束。
        return self._same_day(job.created_at) or job.status in {"queued", "running"} or (
            any(event.stage == "interrupted" and self._same_day(event.at) for event in job.events)
        )

    def _persist(self, force: bool = False) -> None:
        """节流写盘：事件流最多每秒写一次；force=True（终态）总是写。"""
        if not self._persist_enabled:
            return
        now = time.monotonic()
        if not force and now - self._last_persist < 1.0:
            return
        data = [job.model_dump(mode="json") for job in self.jobs.values() if self._retain(job)]
        data.sort(key=lambda item: item.get("created_at", ""))
        serialized = json.dumps(data, ensure_ascii=False, indent=1)
        self._jobs_file.parent.mkdir(parents=True, exist_ok=True)
        tmp: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=self._jobs_file.parent,
                prefix=".jobs-", suffix=".tmp", delete=False,
            ) as temporary:
                tmp = Path(temporary.name)
                temporary.write(serialized)
            os.replace(tmp, self._jobs_file)
            self._last_persist = now
        finally:
            if tmp is not None:
                with suppress(FileNotFoundError):
                    tmp.unlink()

    @staticmethod
    def _storage_warning(job: JobRecord, target: str, exc: Exception) -> None:
        message = f"{target}保存失败：{exc}。已确认结果仍保留在当前任务中；请先处理保存问题，勿重复执行 WMS 操作。"
        if job.persistence_error != message:
            job.events.append(JobEvent(stage="persistence_warning", message=message))
        job.persistence_error = message

    def _save_job(self, job: JobRecord, *, force: bool = False) -> bool:
        job.updated_at = datetime.now().astimezone().isoformat()
        try:
            self._persist(force=force)
            return True
        except OSError as exc:
            self._storage_warning(job, "任务记录", exc)
            return False

    def _save_wave_records(self, job: JobRecord) -> bool:
        outcomes = (job.result or {}).get("segments", [])
        try:
            records = []
            submitted = {(s["channel"], s["seg_name"]): s for s in job.segments}
            for outcome in outcomes:
                if not isinstance(outcome, dict) or not outcome.get("wave_no"):
                    continue
                record = dict(outcome)
                if job.plan_id:
                    segment = submitted.get((outcome.get("channel"), outcome.get("seg_name")))
                    if segment is None:
                        raise ValueError("已确认波次无法匹配提交分段")
                    record.update(batch_id=job.batch_id, plan_id=job.plan_id,
                                  job_id=job.id, order_nos=segment["order_nos"])
                records.append(record)
            upsert_records(self.wave_records_dir, records)
            return True
        except (OSError, ValueError) as exc:
            self._storage_warning(job, "波次历史", exc)
            return False

    def create(
        self,
        mode: RunMode,
        browser_mode: BrowserMode = "headed",
        *,
        wave_nos: list[str] | None = None,
        segments: list[dict[str, object]] | None = None,
        batch_id: str | None = None,
        plan_id: str | None = None,
        plan_snapshot: dict | None = None,
    ) -> JobRecord:
        active_job = next(
            (job for job in self.jobs.values() if job.status in {"queued", "running"}),
            None,
        )
        if active_job:
            raise ActiveJobConflictError(
                "已有任务正在排队或执行，请等待当前任务结束后再提交。"
            )
        if mode == "generate_waves":
            # 已知历史不可读取时不要先去 WMS 建立波次。
            read_records(self.wave_records_dir)
        if any(v is not None for v in (batch_id, plan_id, plan_snapshot)):
            if mode != "generate_waves" or not batch_id or not plan_id or plan_snapshot is None:
                raise ValueError("计划身份与快照必须一起提交，且仅用于生成波次")
            validate_plan(plan_snapshot, segments or [])
        job = JobRecord(
            id=uuid4().hex,
            mode=mode,
            browser_mode=browser_mode,
            wave_nos=list(wave_nos or []),
            segments=deepcopy(segments or []),
            batch_id=batch_id, plan_id=plan_id, has_plan_snapshot=plan_snapshot is not None,
        )
        if plan_snapshot is not None:
            # 先保存不可变快照；任一步失败均不得启动生产任务。
            save_plan(self.wave_records_dir, job.id, plan_snapshot)
        job.events.append(JobEvent(stage="queued", message="任务已进入队列。"))
        self.jobs[job.id] = job
        try:
            # 必须先成功保存接受的请求，再安排生产执行；不能被日志节流跳过。
            self._persist(force=True)
        except OSError:
            del self.jobs[job.id]
            raise
        task = asyncio.create_task(self._execute(job.id))
        self.tasks[job.id] = task
        task.add_done_callback(lambda finished: self._release_task(job.id, finished))
        return job

    def _release_task(self, job_id: str, task: asyncio.Task[None]) -> None:
        # A terminal status alone is not enough: browser teardown and final
        # persistence must finish before shutdown stops tracking this executor.
        if self.tasks.get(job_id) is task:
            del self.tasks[job_id]
        if not task.cancelled():
            error = task.exception()
            if error is not None:
                logging.getLogger(__name__).error(
                    "后台任务 %s 意外退出", job_id,
                    exc_info=(type(error), error, error.__traceback__),
                )

    def get(self, job_id: str) -> JobRecord | None:
        return self.jobs.get(job_id)

    def list(self) -> list[JobRecord]:
        # 与 jobs.json 留存口径一致，包含尚在执行或今天恢复的跨日任务。
        return sorted(
            (job for job in self.jobs.values() if self._retain(job)),
            key=lambda item: item.created_at,
            reverse=True,
        )[:50]

    async def cancel(self, job_id: str) -> JobRecord | None:
        job = self.jobs.get(job_id)
        task = self.tasks.get(job_id)
        if not job:
            return None
        if task and not task.done():
            # A second cancellation must not interrupt browser teardown already
            # underway (for example, service shutdown after the user cancelled).
            if not task.cancelling():
                task.cancel()
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                if not task.done():
                    # The caller disappeared, but the executor still owns its
                    # cleanup. It will persist its own terminal state on exit.
                    raise
        if job.status in {"queued", "running"}:
            job.status = "cancelled"
            job.updated_at = datetime.now().astimezone().isoformat()
            if not job.events or job.events[-1].stage != "cancelled":
                job.events.append(JobEvent(stage="cancelled", message="任务已取消。"))
        self._save_job(job, force=True)
        return job

    async def _execute(self, job_id: str) -> None:
        job = self.jobs[job_id]

        async def progress(stage: str, message: str) -> None:
            job.status = "running"
            job.updated_at = datetime.now().astimezone().isoformat()
            job.events.append(JobEvent(stage=stage, message=message))
            # 生成波次逐段上报：立即持久化，保证中断时已完成分段的波次号不丢失
            if stage == "segment_wave" and job.mode == "generate_waves":
                data = json.loads(message)
                if not isinstance(data, dict) or not data.get("wave_no"):
                    raise ValueError("分段成功事件缺少波次号，已停止。")
                if job.result is None:
                    job.result = {"mode": "generate_waves", "segments": []}
                outcomes = job.result.setdefault("segments", [])
                if not any(o.get("wave_no") == data["wave_no"] for o in outcomes):
                    outcomes.append(data)
                job.result["generated_count"] = len(outcomes)
                # 先把业务事实存入任务；索引是派生记录，失败不能丢掉事实。
                job_saved = self._save_job(job, force=True)
                records_saved = self._save_wave_records(job)
                if not job_saved or not records_saved:
                    raise RuntimeError("已确认波次的本地记录保存失败，后续分段已停止；请核对已确认结果，勿重新生成。")
            else:
                # 普通日志写入失败会显示警告；确认波次的检查点必须强制成功。
                self._save_job(job)

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
            for warning in result_data.get("warnings", []):
                if not any(event.message == warning for event in job.events):
                    job.events.append(JobEvent(stage="warning", message=warning))
            completion_stage = (
                "completed_with_warnings"
                if job.status == "partial" or result_data.get("warnings") else "completed"
            )
            job.events.append(
                JobEvent(stage=completion_stage, message=str(result_data["message"]))
            )
        except asyncio.CancelledError:
            job.status = "cancelled"
            job.events.append(JobEvent(stage="cancelled", message="任务已取消。"))
            raise
        except Exception as exc:
            job.status = "failed"
            job.error = str(exc)
            job.events.append(JobEvent(stage="failed", message=str(exc)))
        finally:
            # 保存/索引异常只附警告，不能覆盖已确认的业务结果，也不能再次抛错丢失终态。
            if job.mode == "generate_waves" and job.result:
                self._save_wave_records(job)
            self._save_job(job, force=True)
