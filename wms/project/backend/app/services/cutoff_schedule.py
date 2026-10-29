# 每日截单状态机；配置和运行历史持久化，导出阶段复用普通导出任务。
# 服务运行时才推进；产出文件后由用户在前端点击加载，不在后台执行规划分析。
"""One daily cutoff, driven by the existing server and existing job manager."""
from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import logging
import os
from pathlib import Path
from uuid import uuid4
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field, field_validator

from app.services.job_manager import ActiveJobConflictError, JobManager
from app.services.cutoff_merge import merge_orders


class CutoffConfig(BaseModel):
    enabled: bool = False
    cutoff_time: str = "07:00"
    timezone: str = "America/New_York"
    advance_minutes: int = Field(default=30, ge=1, le=720)

    @field_validator("cutoff_time")
    @classmethod
    def valid_time(cls, value):
        if len(value) != 5 or datetime.strptime(value, "%H:%M").strftime("%H:%M") != value:
            raise ValueError("截单时间必须为 HH:MM")
        return value

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value):
        try:
            ZoneInfo(value)
        except (KeyError, ValueError) as exc:
            raise ValueError("请选择有效 IANA 时区") from exc
        return value


def now_utc():
    return datetime.now(timezone.utc)


def occurrence(config: CutoffConfig, after: datetime) -> datetime:
    # 使用配置时区的日历时间；选择预导出尚未开始的下一次截单。
    # UTC 往返校验跳过夏令时不存在的本地时刻，避免用固定 24 小时推算日期。
    """Next occurrence whose pre-export has not started. Fold=0, skip DST gaps."""
    zone = ZoneInfo(config.timezone)
    date = after.astimezone(zone).date()
    hour, minute = map(int, config.cutoff_time.split(":"))
    for offset in range(4):
        day = date + timedelta(days=offset)
        local = datetime(day.year, day.month, day.day, hour, minute, tzinfo=zone)
        utc = local.astimezone(timezone.utc)
        if utc.astimezone(zone).replace(tzinfo=None) != local.replace(tzinfo=None):
            continue
        if utc - timedelta(minutes=config.advance_minutes) > after:
            return utc
    raise ValueError("无法确定下次截单时间")


class CutoffScheduler:
    # 每次运行：base → waiting → delta → merge → succeeded；出错记录 failed_stage。
    # 调度依赖服务进程存活，不负责唤醒 macOS。WMS 操作复用 JobManager 的占用控制。
    def __init__(self, manager: JobManager, downloads: Path):
        self.manager = manager
        self.root = downloads / "scheduled"
        self.path = manager.wave_records_dir / "cutoff-schedule.json"
        self.config = CutoffConfig()
        self.next_cutoff: str | None = None
        self.runs: list[dict] = []
        self.error: str | None = None
        self.stop_event = asyncio.Event()
        self.worker = None
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text("utf-8"))
                self.config = CutoffConfig.model_validate(data["config"])
                self.next_cutoff = data["next_cutoff"]
                if self.next_cutoff:
                    datetime.fromisoformat(self.next_cutoff)
                self.runs = data["runs"]
                if not isinstance(self.runs, list):
                    raise ValueError("执行记录格式错误")
                for run in self.runs:
                    datetime.fromisoformat(run["cutoff"])
                    datetime.fromisoformat(run["base_at"])
                    if run["status"] not in {"pending", "waiting", "base", "delta", "merge", "succeeded", "failed", "missed"}:
                        raise ValueError("未知执行状态")
            except (OSError, ValueError, KeyError, TypeError) as exc:
                self.error = f"截单记录读取失败，调度已停用，原文件保留：{exc}"
                self.config.enabled = False

    def save(self):
        # 同目录临时文件 + fsync + replace 防止读到半份 JSON。写盘异常向上传播；
        # 原文件保留，但这不等于所有内存状态已回滚，loop 会暂停并暴露 error。
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(f".cutoff-{uuid4().hex}.tmp")
        try:
            with tmp.open("w", encoding="utf-8") as stream:
                json.dump({"config": self.config.model_dump(), "next_cutoff": self.next_cutoff, "runs": self.runs}, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(tmp, self.path)
        finally:
            tmp.unlink(missing_ok=True)

    # 返回界面需要的副本并附当前导出事件，内部检查点不作为用户日志展示。
    def snapshot(self):
        config = self.config.model_dump()
        cutoff = datetime.fromisoformat(self.next_cutoff) if self.next_cutoff else None
        runs = deepcopy(self.runs[-30:][::-1])
        for run in runs:
            job = self.manager.get(run.get("job_id") or "")
            run["current_events"] = [e.model_dump() for e in job.events if e.stage != "export_checkpoint"] if job else []
        busy = any(j.schedule_run_id and j.status in {"queued", "running"} for j in self.manager.jobs.values())
        return {"config": config, "next_cutoff": self.next_cutoff, "browser_busy": busy,
                "next_base": (cutoff - timedelta(minutes=self.config.advance_minutes)).isoformat() if cutoff else None,
                "error": self.error, "runs": runs}

    # 保存失败时恢复旧配置和下次时间，避免实际未保存却继续按新配置执行。
    def configure(self, config: CutoffConfig):
        if self.error:
            raise ValueError(self.error)
        old = self.config, self.next_cutoff
        self.config = config
        self.next_cutoff = occurrence(config, now_utc()).isoformat() if config.enabled else None
        try:
            self.save()
        except OSError:
            self.config, self.next_cutoff = old
            raise
        return self.snapshot()

    def event(self, run, message):
        run["events"].append({"at": now_utc().isoformat(), "message": message})

    def retry(self, run_id: str):
        # 重试失败阶段，保留成功阶段文件；已提交但未识别任务身份时禁止重复提交。
        if self.error:
            raise ValueError(self.error)
        run = self.find(run_id)
        if run["status"] != "failed":
            raise ValueError("只有失败的截单任务可以重试")
        if any(r["status"] not in {"failed", "succeeded", "missed"} for r in self.runs if r is not run):
            raise ValueError("另一个截单任务尚未结束，请稍后重试")
        job = self.manager.get(run.get("job_id", ""))
        if job and job.export_checkpoint.get("submitted") and not job.export_checkpoint.get("task_key"):
            raise ValueError("导出已提交但身份未确认，需要人工核对，不能自动重复提交")
        run["resume"] = deepcopy(job.export_checkpoint) if job else {}
        run["job_id"] = None
        run["status"] = run.get("failed_stage", "base")
        run["error"] = None
        self.event(run, "已请求重试失败阶段，保留此前完成的文件。")
        self.save()
        return self.snapshot()

    def find(self, run_id):
        for run in self.runs:
            if run["id"] == run_id:
                return run
        raise ValueError("截单记录不存在")

    def file(self, run_id):
        run = self.find(run_id)
        if run["status"] != "succeeded":
            raise ValueError("截单文件尚未完成校验")
        path = self.root / run["id"] / run["filename"]
        if not path.is_file():
            raise ValueError("截单文件已不存在")
        return path

    # 先持久化本次运行身份和下次时间，再推进阶段；错过的计划不伪装成准点截单。
    async def tick(self, now: datetime | None = None):
        if self.error:
            return
        now = now or now_utc()
        if self.config.enabled and self.next_cutoff:
            cutoff = datetime.fromisoformat(self.next_cutoff)
            base_at = cutoff - timedelta(minutes=self.config.advance_minutes)
            if now >= base_at:
                run = {"id": uuid4().hex, "type": "cutoff", "cutoff": cutoff.isoformat(),
                       "base_at": base_at.isoformat(), "timezone": self.config.timezone,
                       "status": "missed" if now >= cutoff else "base", "job_id": None,
                       "events": [], "files": {}, "error": None}
                self.event(run, "已错过截单时间（服务停止或休眠），不自动补跑。" if run["status"] == "missed" else "截单任务已进入预导出阶段。")
                self.runs.append(run)
                self.next_cutoff = occurrence(self.config, now).isoformat()
                self.save()
        active = next((r for r in self.runs if r["status"] not in {"failed", "succeeded", "missed"}), None)
        if not active:
            return
        run = active
        try:
            await self.advance(run, now)
        except Exception as exc:
            run["failed_stage"] = run["status"]
            run["status"] = "failed"
            run["error"] = str(exc)
            self.event(run, f"截单失败：{exc}")
            self.save()

    async def advance(self, run, now):
        # 一次只推进一个阶段；固定本次创建时间边界，不用实际执行时间替代截单时间。
        # 预导出覆盖截单前一周，增量从预导出边界前 30 秒开始，交集交给订单号去重。
        # 这不是订单状态全量同步：预导出后取消且未出现在增量中的订单仍会保留。
        if run["status"] == "waiting":
            if now < datetime.fromisoformat(run["cutoff"]):
                return
            run["status"] = "delta"
            self.event(run, "到达截单时间，准备增量导出。")
            self.save()
        stage = run["status"]
        if stage == "merge":
            target = self.root / run["id"] / ("截单订单_" + datetime.fromisoformat(run["cutoff"]).astimezone(ZoneInfo(run["timezone"])).strftime("%Y-%m-%d_%H%M") + ".xlsx")
            stats = await asyncio.to_thread(merge_orders, Path(run["files"]["base"]), Path(run["files"]["delta"]), target)
            run.update(status="succeeded", filename=target.name, counts=stats, completed_at=now_utc().isoformat())
            self.event(run, f"合并校验完成：预导出 {stats['base']} 单，增量 {stats['delta']} 单，重叠 {stats['overlap']} 单，最终 {stats['total']} 单。点击文件加载分析。")
            self.save()
            return
        job = self.manager.get(run.get("job_id") or "")
        if not job and "resume" not in run:
            # Recover crash between manager persistence and run.job_id persistence.
            matches = [j for j in self.manager.jobs.values() if j.schedule_run_id == run["id"] and j.schedule_stage == stage]
            if matches:
                job = max(matches, key=lambda j: j.created_at)
                run["job_id"] = job.id
        if job:
            if job.status in {"queued", "running"}:
                return
            if job.status != "succeeded" or not job.result or not job.result.get("downloaded_file"):
                raise ValueError(job.error or "导出未完成")
            import shutil
            target = self.root / run["id"] / f"{stage}.xlsx"
            target.parent.mkdir(parents=True, exist_ok=True)
            await asyncio.to_thread(shutil.copyfile, job.result["downloaded_file"], target)
            run["events"].extend({"at": e.at, "message": e.message} for e in job.events if e.stage != "export_checkpoint")
            run["files"][stage] = str(target)
            run["status"] = "waiting" if stage == "base" else "merge"
            run["job_id"] = None
            run.pop("resume", None)
            self.event(run, "预导出文件已保存，等待截单。" if stage == "base" else "增量文件已保存，准备合并校验。")
            self.save()
            return
        zone = ZoneInfo(run["timezone"])
        base = datetime.fromisoformat(run["base_at"])
        end = base if stage == "base" else datetime.fromisoformat(run["cutoff"])
        # A calendar week in the configured WMS timezone (including DST weeks).
        start_at = (datetime.fromisoformat(run["cutoff"]).astimezone(zone) - timedelta(days=7)) if stage == "base" else (base - timedelta(seconds=30)).astimezone(zone)
        start = start_at.strftime("%Y-%m-%d %H:%M:%S")
        bounds = {"start": start, "end": end.astimezone(zone).strftime("%Y-%m-%d %H:%M:%S")}
        try:
            job = self.manager.create("export", "headless", schedule_run_id=run["id"], schedule_stage=stage,
                                      created_range=bounds, export_checkpoint=run.get("resume"))
        except ActiveJobConflictError:
            if not run.get("busy_notice"):
                self.event(run, "等待当前 WMS 任务或浏览器清理结束，不中断已有业务。")
                run["busy_notice"] = True
                self.save()
            return
        run["job_id"] = job.id
        run.pop("busy_notice", None)
        run.pop("resume", None)
        self.event(run, f"开始{'预导出' if stage == 'base' else '增量导出'}：创建时间 {bounds['start']} 至 {bounds['end']}（{run['timezone']}）。" + ("执行已延迟，筛选截止时间保持不变。" if now > end + timedelta(seconds=30) else ""))
        self.save()

    # 调度异常会暂停后续 tick 并暴露 error，避免持久化失效时继续生产导出。
    async def loop(self):
        while not self.stop_event.is_set():
            try:
                await self.tick()
            except Exception as exc:
                self.error = f"截单调度已暂停：{exc}"
                logging.getLogger(__name__).exception("cutoff scheduler paused")
            try:
                await asyncio.wait_for(self.stop_event.wait(), timeout=2)
            except TimeoutError:
                pass

    def start(self):
        self.worker = asyncio.create_task(self.loop())

    # 停止下一轮调度并等当前循环结束；任务取消由主服务生命周期统一处理。
    async def stop(self):
        self.stop_event.set()
        if self.worker:
            await self.worker
