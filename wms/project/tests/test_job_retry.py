"""Offline retry contracts: immutable inputs, checkpoints and no duplicate writes."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock
from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient

from app.services.job_manager import JobManager, ActiveJobConflictError
from app.services.job_plans import read_plan


def inputs():
    segments = [{"channel": "USPS-H" if i == 0 else "USPS-G", "seg_name": "单件1", "order_nos": [f"O{i}"]} for i in range(3)]
    segments[2]["seg_name"] = "单件2"
    plan = {"version": 1, "workbook": {"filename": "original.xlsx", "sheets": [{"name": "波次表",
        "aoa": [["header"]] + [[s["channel"], "", "", "", "", 1, 1, 1, ""] for s in segments],
        "waveRefs": [{"channel": s["channel"], "seg_name": s["seg_name"], "row": i+1} for i,s in enumerate(segments)]}]}}
    return segments, plan


@dataclass
class Result:
    segments: list
    generated_count: int = 0
    failed_count: int = 0
    message: str = "done"


async def finish(manager, job):
    task = manager.tasks.get(job.id)
    if task:
        await task
    await asyncio.sleep(0)


def create(manager):
    segments, plan = inputs()
    return manager.create("generate_waves", "headless", segments=segments, batch_id="B", plan_id="P", plan_snapshot=plan)


@pytest.mark.asyncio
async def test_cleanup_failure_retry_skips_confirmed_and_accumulates(isolated_runtime):
    calls = []
    async def run(progress, *, segments, **kwargs):
        calls.append(segments)
        results = []
        for i,s in enumerate(segments):
            await progress("segment_start", json.dumps(s))
            await progress("wave_submitting", "submitting")
            result = {"channel":s["channel"], "seg_name":s["seg_name"], "wave_no":"W"+s["order_nos"][0][1:], "order_count":1}
            await progress("segment_wave", json.dumps(result))
            results.append(result)
            if len(calls) == 1:
                raise RuntimeError("result dialog would not close")
        return Result(results)
    manager = JobManager(SimpleNamespace(), wave_generate_automation=SimpleNamespace(run=run), settings=isolated_runtime)
    original = create(manager)
    await finish(manager, original)
    assert original.status == "failed"
    original.planning_export_file = "old.xlsx"
    child = manager.retry(original.id)
    assert manager.retry(original.id) is child
    assert child.planning_export_file is None
    assert child.attempt == 2
    assert child.segments == original.segments
    assert read_plan(manager.wave_records_dir, child.id, child.segments) == inputs()[1]
    await finish(manager, child)
    assert calls[1] == inputs()[0][1:]
    assert child.status == "succeeded"
    assert [s["wave_no"] for s in child.result["segments"]] == ["W0","W1","W2"]
    assert child.result["generated_count"] == 3
    assert original.result["segments"][0]["wave_no"] == "W0"


@pytest.mark.asyncio
@pytest.mark.parametrize("submitted", [False, True])
async def test_restart_retries_pre_submit_but_blocks_unknown(isolated_runtime, submitted):
    gate = asyncio.Event()
    async def run(progress, *, segments, **kwargs):
        await progress("segment_start", json.dumps(segments[0]))
        if submitted:
            await progress("wave_submitting", "clicked")
        gate.set()
        await asyncio.Event().wait()
    manager = JobManager(SimpleNamespace(), wave_generate_automation=SimpleNamespace(run=run), settings=isolated_runtime)
    job = create(manager)
    await gate.wait()
    # Separate manager restores persisted running state, without using the old executor.
    restored = JobManager(SimpleNamespace(), wave_generate_automation=SimpleNamespace(run=AsyncMock(side_effect=RuntimeError("offline"))), settings=isolated_runtime)
    assert restored.get(job.id).status == "failed"
    if submitted:
        with pytest.raises(ValueError, match="未确认"):
            restored.retry(job.id)
    else:
        child = restored.retry(job.id)
        await finish(restored, child)
        assert child.attempt == 2
    await manager.cancel(job.id)


@pytest.mark.asyncio
async def test_legacy_cancel_storage_and_active_guard(isolated_runtime):
    manager = JobManager(SimpleNamespace(), wave_generate_automation=SimpleNamespace(run=AsyncMock(side_effect=RuntimeError("before browser"))), settings=isolated_runtime)
    job = create(manager)
    await finish(manager, job)
    for field, value in [("checkpoint_version",0), ("persistence_error","disk full"), ("status","cancelled")]:
        old = getattr(job,field)
        setattr(job,field,value)
        with pytest.raises(ValueError): manager.retry(job.id)
        setattr(job,field,old)
    waiting = asyncio.create_task(asyncio.sleep(60))
    manager.tasks["cleanup"] = waiting
    with pytest.raises(ActiveJobConflictError): manager.retry(job.id)
    waiting.cancel()
    with pytest.raises(asyncio.CancelledError): await waiting


def test_retry_api_confirmation_and_old_job_rejection(app):
    from app.services.job_manager import JobRecord
    with TestClient(app) as client:
        job = JobRecord(id="old", mode="print_waves", status="failed", wave_nos=["W1"])
        app.state.job_manager.jobs[job.id] = job
        assert client.post("/api/jobs/old/retry",json={}).status_code == 422
        assert client.post("/api/jobs/old/retry",json={"confirm_production":True}).status_code == 409


@pytest.mark.asyncio
async def test_actual_dialog_cleanup_failure_returns_partial_then_resumes(monkeypatch, isolated_runtime):
    from test_confirmed_cleanup import _wave_runner
    automation, page = _wave_runner(monkeypatch, isolated_runtime)
    automation._generate_one.side_effect = ["W1", "W2", "W3"]
    automation._close_visible_dialogs.side_effect = RuntimeError("3 次关闭后仍可见")
    manager = JobManager(SimpleNamespace(), wave_generate_automation=automation,settings=isolated_runtime)
    original = create(manager)
    await finish(manager,original)
    assert original.status == "partial"
    assert list(original.node_states.values()) == ["done","pending","pending"]
    automation._close_visible_dialogs.side_effect = None
    child = manager.retry(original.id)
    await finish(manager,child)
    assert child.status == "succeeded", child.error
    assert automation._generate_one.await_count == 3
    assert [s["wave_no"] for s in child.result["segments"]] == ["W1","W2","W3"]


@pytest.mark.asyncio
async def test_submission_checkpoint_failure_prevents_click_and_next_node(monkeypatch, isolated_runtime):
    from app.automation.common import CheckpointError
    entered = []
    async def run(progress, *, segments, **kwargs):
        await progress("segment_start", json.dumps(segments[0]))
        monkeypatch.setattr(manager, "_save_job", lambda *a, **k: False)
        await progress("wave_submitting", "production boundary")
        entered.append("clicked")
        return Result([])
    manager = JobManager(SimpleNamespace(),wave_generate_automation=SimpleNamespace(run=run),settings=isolated_runtime)
    job=create(manager)
    await finish(manager,job)
    assert entered == []
    assert job.status == "failed"
    assert "uncertain" in job.node_states.values()
    with pytest.raises(ValueError,match="未确认"): manager.retry(job.id)
