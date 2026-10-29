# 回归范围：持久化失败和启动恢复的行为，所有文件位于临时目录。
"""Persistence faults use temporary files and mock workflows, never WMS."""

import asyncio
import json
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app.automation import ExportResult
from app.services import job_manager
from app.services.job_manager import JobManager, JobRecord
from app.services.wave_records import read_records


CONFIRMED = {"channel": "CBT", "seg_name": "单件1", "wave_no": "W001", "order_count": 2}


def unused_automation():
    return SimpleNamespace(run=AsyncMock(side_effect=AssertionError("Must not execute")))


def result():
    return ExportResult(
        mode="export", template="渠道拆分", current_url="https://example.invalid/",
        message="已完成", completed_at=datetime.now().astimezone().isoformat(),
        downloaded_file="confirmed.xlsx",
    )


def records_file(settings):
    return settings.browser_profile_dir.parent / "jobs.json"


def seed(settings, jobs):
    records_file(settings).write_text(json.dumps([j.model_dump(mode="json") for j in jobs]), "utf-8")


@pytest.mark.parametrize("invalid", [
    b"{broken", b"\xff", b"{}", b"null", b"[42]", b'[{}]',
    b'[{"id":"bad","mode":"export","created_at":"not-a-date"}]',
    b'[{"id":"bad","mode":"export","status":"unknown"}]',
])
def test_corrupt_jobs_are_not_silently_discarded(isolated_runtime, invalid):
    path = records_file(isolated_runtime)
    path.write_bytes(invalid)
    automation = unused_automation()
    with pytest.raises(ValueError, match="原文件已保留"):
        JobManager(automation, settings=isolated_runtime)
    assert path.read_bytes() == invalid
    automation.run.assert_not_awaited()


def test_one_bad_or_duplicate_record_cannot_partially_load(isolated_runtime):
    job = JobRecord(id="same", mode="export", status="succeeded")
    seed(isolated_runtime, [job, job])
    before = records_file(isolated_runtime).read_bytes()
    with pytest.raises(ValueError, match="任务 ID"):
        JobManager(unused_automation(), settings=isolated_runtime)
    assert records_file(isolated_runtime).read_bytes() == before


@pytest.mark.parametrize("state", ["queued", "running"])
@pytest.mark.parametrize("yesterday", [False, True])
def test_restart_marks_orphans_once_and_retains_confirmed_results(isolated_runtime, state, yesterday):
    job = JobRecord(id="orphan", mode="generate_waves", status=state, result={"segments": [CONFIRMED]})
    if yesterday:
        job.created_at = (datetime.now().astimezone() - timedelta(days=1)).isoformat()
    seed(isolated_runtime, [job])
    automation = unused_automation()
    first = JobManager(automation, settings=isolated_runtime)
    restored = first.get(job.id)
    assert restored.status == "failed"
    assert restored.result == job.result
    assert restored in first.list()
    assert "待核对" in restored.error
    assert first.tasks == {}
    second = JobManager(automation, settings=isolated_runtime)
    assert second.get(job.id).model_dump() == restored.model_dump()
    assert len([e for e in restored.events if e.stage == "interrupted"]) == 1
    automation.run.assert_not_awaited()


def test_failure_to_save_recovery_preserves_original(isolated_runtime, monkeypatch):
    seed(isolated_runtime, [JobRecord(id="orphan", mode="export", status="running")])
    path = records_file(isolated_runtime)
    before = path.read_bytes()
    monkeypatch.setattr(job_manager.os, "replace", lambda *_: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError, match="disk full"):
        JobManager(unused_automation(), settings=isolated_runtime)
    assert path.read_bytes() == before
    assert not list(path.parent.glob(".jobs-*.tmp"))


def test_partial_temporary_write_preserves_jobs_and_does_not_throttle_retry(isolated_runtime, monkeypatch):
    seed(isolated_runtime, [JobRecord(id="existing", mode="export", status="succeeded")])
    manager = JobManager(unused_automation(), settings=isolated_runtime)
    path = records_file(isolated_runtime)
    before = path.read_bytes()
    unrelated = path.parent / ".jobs-unrelated.tmp"
    unrelated.write_text("leave me alone", "utf-8")
    factory = job_manager.tempfile.NamedTemporaryFile

    @contextmanager
    def broken_writer(*args, **kwargs):
        with factory(*args, **kwargs) as temporary:
            def partial_write(text):
                temporary.write(text[:5])
                raise OSError("partial write: disk full")
            yield SimpleNamespace(name=temporary.name, write=partial_write)

    with monkeypatch.context() as fault:
        fault.setattr(job_manager.tempfile, "NamedTemporaryFile", broken_writer)
        with pytest.raises(OSError, match="partial write"):
            manager._persist(force=True)
    assert path.read_bytes() == before
    assert manager._last_persist == 0
    assert list(path.parent.glob(".jobs-*.tmp")) == [unrelated]
    manager.jobs["existing"].error = "retry saved"
    manager._persist()  # Failure did not start the 1-second throttle.
    assert json.loads(path.read_text())[0]["error"] == "retry saved"


@pytest.mark.asyncio
async def test_cross_day_recovery_survives_later_storage_warning(isolated_runtime, monkeypatch):
    job = JobRecord(
        id="cross-midnight", mode="generate_waves", status="running",
        created_at=(datetime.now().astimezone() - timedelta(days=1)).isoformat(),
        result={"segments": [CONFIRMED]},
    )
    seed(isolated_runtime, [job])
    manager = JobManager(unused_automation(), settings=isolated_runtime)
    original = manager._persist
    with monkeypatch.context() as fault:
        fault.setattr(manager, "_persist", lambda **_: (_ for _ in ()).throw(OSError("disk full")))
        await manager.cancel(job.id)
    assert manager.get(job.id).events[-1].stage == "persistence_warning"
    assert [j.id for j in manager.list()] == [job.id]
    original(force=True)
    restored = JobManager(unused_automation(), settings=isolated_runtime).get(job.id)
    assert restored.result == job.result


@pytest.mark.asyncio
async def test_create_must_persist_before_scheduling_and_can_retry(isolated_runtime, monkeypatch):
    automation = SimpleNamespace(run=AsyncMock(return_value=result()))
    manager = JobManager(automation, settings=isolated_runtime)
    original = manager._persist
    monkeypatch.setattr(manager, "_persist", lambda **_: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError, match="disk full"):
        manager.create("export")
    await asyncio.sleep(0)
    assert manager.jobs == {} and manager.tasks == {}
    automation.run.assert_not_awaited()
    monkeypatch.setattr(manager, "_persist", original)
    job = manager.create("export")
    assert json.loads(records_file(isolated_runtime).read_text())[0]["id"] == job.id
    await manager.tasks[job.id]
    assert job.status == "succeeded"


@pytest.mark.asyncio
async def test_corrupt_wave_history_blocks_generation_before_scheduling(isolated_runtime):
    path = records_file(isolated_runtime).parent / "wave-records.json"
    path.write_text("broken", "utf-8")
    automation = unused_automation()
    manager = JobManager(automation, wave_generate_automation=automation, settings=isolated_runtime)
    with pytest.raises(ValueError):
        manager.create("generate_waves")
    assert manager.jobs == {} and manager.tasks == {}
    assert path.read_text() == "broken"
    automation.run.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["queued", "running"])
async def test_cancel_without_executor_is_saved(isolated_runtime, state):
    manager = JobManager(unused_automation(), settings=isolated_runtime)
    job = JobRecord(id="no-executor", mode="export", status=state)
    manager.jobs[job.id] = job
    manager._persist(force=True)
    await manager.cancel(job.id)
    persisted = json.loads(records_file(isolated_runtime).read_text())[0]
    assert persisted["status"] == "cancelled"
    assert persisted["updated_at"] == job.updated_at


@pytest.mark.asyncio
@pytest.mark.parametrize("finish", ["succeeded", "failed", "cancelled"])
async def test_save_failure_does_not_replace_business_outcome(isolated_runtime, monkeypatch, finish):
    entered = asyncio.Event()

    async def run(progress, **_):
        manager._last_persist = 0
        await progress("running", "ordinary log")
        entered.set()
        if finish == "failed":
            raise RuntimeError("original workflow failure")
        if finish == "cancelled":
            await asyncio.Event().wait()
        return result()

    manager = JobManager(SimpleNamespace(run=run), settings=isolated_runtime)
    original = manager._persist

    def fail_after_accept(**kwargs):
        if any(j.status != "queued" for j in manager.jobs.values()):
            raise OSError("disk full")
        return original(**kwargs)

    monkeypatch.setattr(manager, "_persist", fail_after_accept)
    job = manager.create("export")
    task = manager.tasks[job.id]
    await asyncio.wait_for(entered.wait(), 1)
    if finish == "cancelled":
        await manager.cancel(job.id)
        assert task.cancelled()
    else:
        await task  # no unhandled persistence exception
    await asyncio.sleep(0)
    assert manager.tasks == {}
    assert job.status == finish
    assert "disk full" in job.persistence_error
    assert any(e.stage == "persistence_warning" for e in job.events)
    if finish == "succeeded":
        assert job.result["downloaded_file"] == "confirmed.xlsx"
        assert job.error is None
    if finish == "failed":
        assert job.error == "original workflow failure"


@pytest.mark.asyncio
@pytest.mark.parametrize("failing_file", ["jobs.json", "wave-records.json", "both"])
async def test_failed_checkpoint_keeps_confirmed_wave_and_stops_next_segment(isolated_runtime, monkeypatch, failing_file):
    reached_next = False
    original = job_manager.os.replace

    def fail_selected(source, destination):
        if failing_file == "both" or Path(destination).name == failing_file:
            raise OSError("checkpoint disk full")
        return original(source, destination)

    async def generate(progress, **_):
        nonlocal reached_next
        monkeypatch.setattr(job_manager.os, "replace", fail_selected)
        await progress("segment_wave", json.dumps(CONFIRMED))
        reached_next = True
        raise AssertionError("Should stop before the next segment")

    manager = JobManager(unused_automation(), wave_generate_automation=SimpleNamespace(run=generate), settings=isolated_runtime)
    job = manager.create("generate_waves", segments=[{"channel":"CBT", "seg_name":"单件1", "order_nos":["O1","O2"]}])
    await manager.tasks[job.id]
    assert not reached_next
    assert job.status == "failed"
    assert job.result["segments"] == [CONFIRMED]
    assert job.result["generated_count"] == 1
    assert "后续分段已停止" in job.error
    assert "checkpoint disk full" in job.persistence_error
    if failing_file == "wave-records.json":
        persisted = json.loads(records_file(isolated_runtime).read_text())[0]
        assert persisted["result"]["segments"] == [CONFIRMED]
        assert persisted["status"] == "failed"
    if failing_file == "jobs.json":
        assert read_records(records_file(isolated_runtime).parent)[0]["wave_no"] == "W001"
    assert not list(records_file(isolated_runtime).parent.glob(".*.tmp"))


@pytest.mark.asyncio
async def test_confirmed_checkpoint_is_not_throttled_and_survives_cancellation(isolated_runtime):
    entered = asyncio.Event()

    async def generate(progress, **_):
        await progress("segment_wave", json.dumps(CONFIRMED))
        await progress("segment_wave", json.dumps(CONFIRMED))  # duplicate notification
        entered.set()
        await asyncio.Event().wait()

    manager = JobManager(unused_automation(), wave_generate_automation=SimpleNamespace(run=generate), settings=isolated_runtime)
    job = manager.create("generate_waves", segments=[{"channel":"CBT", "seg_name":"单件1", "order_nos":["O1","O2"]}])
    await asyncio.wait_for(entered.wait(), 1)
    persisted = json.loads(records_file(isolated_runtime).read_text())[0]
    assert persisted["result"]["segments"] == [CONFIRMED]
    assert read_records(records_file(isolated_runtime).parent)[0]["order_count"] == 2
    await manager.cancel(job.id)
    restarted = JobManager(unused_automation(), settings=isolated_runtime)
    assert restarted.get(job.id).status == "cancelled"
    assert restarted.get(job.id).result["segments"] == [CONFIRMED]


def test_history_api_reports_corruption_and_preserves_file(app):
    with TestClient(app) as client:
        path = app.state.settings.browser_profile_dir.parent / "wave-records.json"
        path.write_text("broken", "utf-8")
        for method, url in [("get", "/api/wave-records"), ("post", "/api/wave-records/clear")]:
            response = getattr(client, method)(url)
            assert response.status_code == 503
            assert "原" in response.json()["detail"]
            assert path.read_text() == "broken"


def test_create_api_reports_storage_failure_without_scheduling(app, monkeypatch):
    with TestClient(app) as client:
        manager = app.state.job_manager
        monkeypatch.setattr(manager, "_persist", lambda **_: (_ for _ in ()).throw(OSError("disk full")))
        response = client.post("/api/jobs", json={"mode": "export", "confirm_production": True})
        assert response.status_code == 503
        assert "未启动 WMS" in response.json()["detail"]
        assert manager.jobs == {} and manager.tasks == {}
