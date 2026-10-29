# 回归范围：执行协程结束后释放句柄，业务历史继续保留。
"""Completed execution handles are disposable; business records are not."""
import asyncio
import json
from datetime import datetime
from types import SimpleNamespace

import pytest

from app.automation import ExportResult
from app.services.job_manager import JobManager


def result():
    return ExportResult(mode="export", template="test", current_url="about:blank",
                        message="done", completed_at=datetime.now().astimezone().isoformat())


@pytest.mark.parametrize("fail", [False, True])
async def test_terminal_handle_released_but_result_and_history_retained(isolated_runtime, fail):
    async def run(progress, **_):
        await progress("testing", "isolated workflow")
        if fail:
            raise RuntimeError("workflow failed")
        return result()

    manager = JobManager(SimpleNamespace(run=run), settings=isolated_runtime)
    job = manager.create("export")
    task = manager.tasks[job.id]
    await task
    await asyncio.sleep(0)  # Run completion callbacks, not a timed business wait.
    assert manager.tasks == {}
    assert manager.get(job.id) is job
    assert manager.list() == [job]
    persisted = json.loads(manager._jobs_file.read_text())[0]
    assert persisted["status"] == job.status == ("failed" if fail else "succeeded")
    if fail:
        assert persisted["error"] == "workflow failed"
    else:
        assert persisted["result"]["message"] == "done"
    await manager.cancel(job.id)  # Cancelling a terminal job cannot erase its outcome.
    assert job.status == persisted["status"]


async def test_cancel_before_executor_first_turn_releases_handle(isolated_runtime):
    async def run(*_, **__):
        raise AssertionError("Cancelled before execution")

    manager = JobManager(SimpleNamespace(run=run), settings=isolated_runtime)
    job = manager.create("export")
    task = manager.tasks[job.id]
    await manager.cancel(job.id)
    await asyncio.sleep(0)
    assert task.cancelled()
    assert manager.tasks == {}
    assert manager.get(job.id).status == "cancelled"
    assert json.loads(manager._jobs_file.read_text())[0]["status"] == "cancelled"


async def test_handle_is_retained_until_cancelled_browser_cleanup_finishes(isolated_runtime):
    started, cleaning, release = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def run(progress, **_):
        await progress("running", "running")
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaning.set()
            await release.wait()

    manager = JobManager(SimpleNamespace(run=run), settings=isolated_runtime)
    job = manager.create("export")
    executor = manager.tasks[job.id]
    await asyncio.wait_for(started.wait(), 1)
    cancelling = asyncio.create_task(manager.cancel(job.id))
    try:
        await asyncio.wait_for(cleaning.wait(), 1)
        assert manager.tasks[job.id] is executor
        assert not executor.done()
    finally:
        release.set()
        await cancelling
    await asyncio.sleep(0)
    assert manager.tasks == {}
    assert job.status == "cancelled"


async def test_many_completed_jobs_release_handles_without_pruning_records_or_files(isolated_runtime):
    async def run(*_, **__):
        return result()

    markers = []
    for folder, name in [(isolated_runtime.downloads_dir, "orders.xlsx"),
                         (isolated_runtime.outputs_dir, "waves.pdf")]:
        marker = folder / name
        marker.write_bytes(b"existing artifact")
        markers.append(marker)
    manager = JobManager(SimpleNamespace(run=run), settings=isolated_runtime)
    for _ in range(120):
        job = manager.create("export")
        await manager.tasks[job.id]
        await asyncio.sleep(0)
        assert manager.tasks == {}
    assert len(manager.jobs) == 120
    assert len(manager.list()) == 50
    assert len(json.loads(manager._jobs_file.read_text())) == 120
    restored = JobManager(SimpleNamespace(run=run), settings=isolated_runtime)
    assert len(restored.jobs) == 120
    assert all(marker.read_bytes() == b"existing artifact" for marker in markers)


async def test_stale_completion_callback_cannot_remove_another_executor(isolated_runtime):
    manager = JobManager(SimpleNamespace(), settings=isolated_runtime)
    old = asyncio.create_task(asyncio.sleep(0))
    await old
    replacement = asyncio.create_task(asyncio.Event().wait())
    manager.tasks["test-job"] = replacement
    try:
        manager._release_task("test-job", old)
        assert manager.tasks["test-job"] is replacement
    finally:
        replacement.cancel()
        await asyncio.gather(replacement, return_exceptions=True)


async def test_unexpected_executor_exception_is_logged_before_handle_is_discarded(isolated_runtime, monkeypatch, caplog):
    manager = JobManager(SimpleNamespace(), settings=isolated_runtime)

    async def broken_executor(_):
        raise RuntimeError("unexpected executor fault")

    monkeypatch.setattr(manager, "_execute", broken_executor)
    job = manager.create("export")
    task = manager.tasks[job.id]
    with pytest.raises(RuntimeError, match="unexpected executor fault"):
        await task
    await asyncio.sleep(0)
    assert manager.tasks == {}
    assert job.id in caplog.text and "unexpected executor fault" in caplog.text
    assert manager.get(job.id) is job  # No result/history eviction in the callback.
