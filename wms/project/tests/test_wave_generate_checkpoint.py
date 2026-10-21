"""Confirmed WMS results must not be reclassified by a local save failure."""

import json
from unittest.mock import AsyncMock, MagicMock
from types import SimpleNamespace

import pytest

from app.automation.common import AutomationError
from app.automation import wms_wave_generate as module


SEGMENTS = [
    {"channel": "CBT", "seg_name": "单件1", "order_nos": ["OBS1", "OBS2"]},
    {"channel": "USPS", "seg_name": "混件1", "order_nos": ["OBS3"]},
]


@pytest.fixture
def mocked_run(isolated_runtime, monkeypatch):
    automation = module.WmsWaveGenerateAutomation(
        isolated_runtime, isolated_runtime.load_automation().wave_generation,
    )
    page = MagicMock()
    page.url = automation.config.target_url
    page.goto = AsyncMock()
    context = MagicMock()
    manager = MagicMock()
    manager.__aenter__ = AsyncMock(return_value=context)
    manager.__aexit__ = AsyncMock(return_value=False)
    open_context = MagicMock(return_value=manager)
    monkeypatch.setattr(module, "open_browser_context", open_context)
    monkeypatch.setattr(module, "first_page", AsyncMock(return_value=page))
    for name in (
        "_wait_for_page_ready", "_ensure_no_blocking_dialog",
        "_select_pending_tab", "_set_page_size",
        "_close_visible_dialogs",
    ):
        monkeypatch.setattr(automation, name, AsyncMock())
    monkeypatch.setattr(
        automation, "_generate_one", AsyncMock(side_effect=["W001", "W002"]),
    )
    return automation, page, manager, open_context


@pytest.mark.asyncio
async def test_confirmed_segment_save_failure_stops_without_reclassifying_or_recovery(mocked_run):
    automation, page, manager, _ = mocked_run
    events = []
    failure = OSError("本地波次记录保存失败")

    async def progress(stage, message):
        events.append((stage, message))
        if stage == "segment_wave":
            raise failure

    with pytest.raises(OSError) as raised:
        await automation.run(progress, headless=True, segments=SEGMENTS)

    assert raised.value is failure
    automation._generate_one.assert_awaited_once()
    assert page.goto.await_count == 1  # Initial navigation only; no recovery / next segment.
    assert [stage for stage, _ in events] == ["launching", "searching", "segment_start", "segment_wave"]
    assert json.loads(events[-1][1]) == {
        "channel": "CBT", "seg_name": "单件1", "wave_no": "W001", "order_count": 2,
    }
    manager.__aexit__.assert_awaited_once()


@pytest.mark.asyncio
async def test_real_workflow_and_manager_keep_first_wave_when_index_save_fails(mocked_run, isolated_runtime, monkeypatch):
    from app.services import job_manager

    automation, page, _, _ = mocked_run
    monkeypatch.setattr(
        job_manager, "upsert_records",
        lambda *_: (_ for _ in ()).throw(OSError("index disk full")),
    )
    manager = job_manager.JobManager(
        SimpleNamespace(run=AsyncMock(side_effect=AssertionError("No export"))),
        wave_generate_automation=automation, settings=isolated_runtime,
    )
    job = manager.create("generate_waves", "headless", segments=SEGMENTS)
    await manager.tasks[job.id]

    automation._generate_one.assert_awaited_once()
    assert page.goto.await_count == 1
    assert job.status == "failed"
    assert job.result["segments"] == [
        {"channel": "CBT", "seg_name": "单件1", "wave_no": "W001", "order_count": 2},
    ]
    assert not any(event.stage == "segment_failed" for event in job.events)
    assert "后续分段已停止" in job.error
    persisted = json.loads(manager._jobs_file.read_text())[0]
    assert persisted["result"] == job.result
    assert "index disk full" in persisted["persistence_error"]


@pytest.mark.asyncio
async def test_normal_run_reports_each_success_once_with_order_count(mocked_run, isolated_runtime):
    automation, page, _, open_context = mocked_run
    events = []

    async def progress(stage, message):
        events.append((stage, message))

    result = await automation.run(progress, headless=True, segments=SEGMENTS)

    assert result.generated_count == 2
    assert result.failed_count == 0
    assert [(outcome.wave_no, outcome.order_count) for outcome in result.segments] == [
        ("W001", 2), ("W002", 1),
    ]
    assert [json.loads(message) for stage, message in events if stage == "segment_wave"] == [
        {"channel": "CBT", "seg_name": "单件1", "wave_no": "W001", "order_count": 2},
        {"channel": "USPS", "seg_name": "混件1", "wave_no": "W002", "order_count": 1},
    ]
    assert not any(stage == "segment_failed" for stage, _ in events)
    assert page.goto.await_count == 1
    assert automation._generate_one.await_args_list[1].kwargs["prev_expected"] == 2
    open_context.assert_called_once_with(isolated_runtime, headless=True, cleanup_warnings=result.warnings)


@pytest.mark.asyncio
async def test_search_progress_failure_stops_before_generation(mocked_run):
    automation, page, _, _ = mocked_run
    events = []

    async def progress(stage, message):
        events.append((stage, message))
        if stage == "searching":
            raise OSError("日志回调失败")

    with pytest.raises(OSError, match="日志回调失败"):
        await automation.run(progress, headless=True, segments=SEGMENTS)

    automation._generate_one.assert_not_awaited()
    assert page.goto.await_count == 1
    assert [stage for stage, _ in events] == ["launching", "searching"]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [AutomationError("生成校验失败"), RuntimeError("浏览器异常")])
async def test_generation_failure_still_records_once_and_recovers_for_next_segment(mocked_run, failure):
    automation, page, _, _ = mocked_run
    automation._generate_one.side_effect = [failure, "W002"]
    events = []

    async def progress(stage, message):
        events.append((stage, message))

    result = await automation.run(progress, headless=True, segments=SEGMENTS)

    assert result.generated_count == result.failed_count == 1
    assert len(result.segments) == 2
    assert result.segments[0].wave_no is None
    assert str(failure) in result.segments[0].note
    assert result.segments[1].wave_no == "W002"
    assert page.goto.await_count == 2  # Initial navigation plus existing failure recovery.
    assert sum(stage == "segment_failed" for stage, _ in events) == 1
    assert sum(stage == "segment_wave" for stage, _ in events) == 1
    assert automation._generate_one.await_args_list[1].kwargs["prev_expected"] == 2


@pytest.mark.asyncio
async def test_missing_wave_number_still_has_one_unsuccessful_outcome(mocked_run):
    automation, page, _, _ = mocked_run
    automation._generate_one.side_effect = [None]
    events = []

    async def progress(stage, message):
        events.append((stage, message))

    with pytest.raises(AutomationError, match="未取得确认波次号"):
        await automation.run(progress, headless=True, segments=SEGMENTS[:1])
    assert any(stage == "wave_submitting" for stage, _ in events)
    assert not any(stage == "segment_wave" for stage, _ in events)
    assert page.goto.await_count == 1
