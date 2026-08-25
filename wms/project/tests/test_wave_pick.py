import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.automation.common import AutomationError
from app.automation.wave_pending import PendingWave
from app.automation.wms_wave_pick import CompletedWave, WmsWavePickAutomation
from app.core.config import Settings


def make_automation() -> WmsWavePickAutomation:
    settings = Settings.from_environment()
    return WmsWavePickAutomation(settings, settings.load_automation())


def make_context() -> tuple[MagicMock, list[MagicMock]]:
    pages = [MagicMock() for _ in range(5)]
    pages[0].url = "https://wms.xlwms.com/outbound/wave"
    context = MagicMock()
    context.pages = [pages[0]]
    context.new_page = AsyncMock(side_effect=pages[1:])
    return context, pages


@pytest.mark.asyncio
async def test_all_pending_waves_run_in_batches_of_five() -> None:
    automation = make_automation()
    waves = [PendingWave(f"W{index:03d}") for index in range(1, 13)]
    automation.pending_waves.snapshot = AsyncMock(return_value=waves)
    automation.pending_waves.prepare_page = AsyncMock()
    automation.pending_waves.find_remaining = AsyncMock(return_value=[])
    active = 0
    max_active = 0

    async def fake_pick(page, wave, progress, sequence, total):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.01)
        active -= 1
        return CompletedWave(wave.wave_no, sequence)

    automation._pick_wave = AsyncMock(side_effect=fake_pick)
    progress = AsyncMock()
    context, _ = make_context()

    result = await automation._run_all_pending(context, progress)

    assert result.wave_nos == [wave.wave_no for wave in waves]
    assert result.wave_count == 12
    assert result.sku_rows == sum(range(1, 13))
    assert max_active == 5
    assert context.new_page.await_count == 4
    assert automation.pending_waves.prepare_page.await_count == 12
    assert automation.pending_waves.find_remaining.await_count == 1
    assert automation._pick_wave.await_count == 12
    assert sum(call.args[0] == "batch_start" for call in progress.await_args_list) == 3


@pytest.mark.asyncio
async def test_selected_wave_pick_filters_snapshot_and_preserves_input_order() -> None:
    automation = make_automation()
    snapshot = [PendingWave("W001"), PendingWave("W002"), PendingWave("W003")]
    automation.pending_waves.snapshot = AsyncMock(return_value=snapshot)
    automation.pending_waves.prepare_page = AsyncMock()
    automation.pending_waves.find_remaining = AsyncMock(return_value=[])
    attempted: list[str] = []

    async def fake_pick(page, wave, progress, sequence, total):
        attempted.append(wave.wave_no)
        return CompletedWave(wave.wave_no, 1)

    automation._pick_wave = AsyncMock(side_effect=fake_pick)
    progress = AsyncMock()
    context, _ = make_context()

    result = await automation._run_all_pending(
        context,
        progress,
        requested_wave_nos=["W003", "W001", "W404"],
    )

    assert attempted == ["W003", "W001"]
    assert result.wave_nos == ["W003", "W001"]
    assert result.failed_wave_nos == ["W404"]
    assert result.wave_count == 2
    assert any("W404" in warning for warning in result.warnings)
    checked_waves = automation.pending_waves.find_remaining.await_args.args[1]
    assert [wave.wave_no for wave in checked_waves] == ["W003", "W001"]


@pytest.mark.asyncio
async def test_selected_wave_pick_skips_task_when_none_are_pending() -> None:
    automation = make_automation()
    automation.pending_waves.snapshot = AsyncMock(
        return_value=[PendingWave("W001"), PendingWave("W002")]
    )
    automation.pending_waves.prepare_page = AsyncMock()
    automation.pending_waves.find_remaining = AsyncMock()
    automation._pick_wave = AsyncMock()
    progress = AsyncMock()
    context, _ = make_context()

    result = await automation._run_all_pending(
        context,
        progress,
        requested_wave_nos=["W404", "W405"],
    )

    assert result.wave_nos == []
    assert result.failed_wave_nos == ["W404", "W405"]
    assert result.wave_count == 0
    automation.pending_waves.prepare_page.assert_not_awaited()
    automation.pending_waves.find_remaining.assert_not_awaited()
    automation._pick_wave.assert_not_awaited()


@pytest.mark.asyncio
async def test_pending_snapshot_combines_and_deduplicates_pages() -> None:
    catalog = make_automation().pending_waves
    wave1 = PendingWave("W001")
    wave2 = PendingWave("W002")
    wave3 = PendingWave("W003")
    catalog._read_waves = AsyncMock(side_effect=[[wave1, wave2], [wave2, wave3]])
    catalog._advance_page = AsyncMock(side_effect=[True, False])

    waves = await catalog._read_all_pages(MagicMock(), MagicMock())

    assert waves == [wave1, wave2, wave3]
    assert catalog._advance_page.await_count == 2


@pytest.mark.asyncio
async def test_read_waves_callable_via_instance() -> None:
    """回归：_read_waves 为 @staticmethod，必须支持 self._read_waves(rows) 的实例调用。"""
    catalog = make_automation().pending_waves
    rows = MagicMock()
    rows.evaluate_all = AsyncMock(return_value=["R1", "R2", "", "R2", "R3"])

    waves = await catalog._read_waves(rows)  # 实例调用；丢失 @staticmethod 会抛 TypeError

    assert [w.wave_no for w in waves] == ["R1", "R2", "R3"]


@pytest.mark.asyncio
async def test_final_check_compares_the_complete_initial_snapshot() -> None:
    catalog = make_automation().pending_waves
    initial = [PendingWave("W001"), PendingWave("W002"), PendingWave("W003")]
    rows = MagicMock()
    catalog._open_page = AsyncMock(return_value=rows)
    catalog._read_all_pages = AsyncMock(
        return_value=[PendingWave("W002"), PendingWave("W999")]
    )
    progress = AsyncMock()

    remaining = await catalog.find_remaining(MagicMock(), initial, progress)

    assert remaining == [PendingWave("W002")]
    assert catalog._open_page.await_args.kwargs["allow_empty"] is True
    assert progress.await_args.args[0] == "final_pending_snapshot"


@pytest.mark.asyncio
async def test_failed_batch_stops_before_later_waves() -> None:
    automation = make_automation()
    waves = [PendingWave(f"W{index:03d}") for index in range(1, 8)]
    automation.pending_waves.snapshot = AsyncMock(return_value=waves)
    automation.pending_waves.prepare_page = AsyncMock()
    automation.pending_waves.find_remaining = AsyncMock(return_value=[])

    async def fake_pick(page, wave, progress, sequence, total):
        if wave.wave_no == "W003":
            raise AutomationError("测试失败")
        return CompletedWave(wave.wave_no, 1)

    automation._pick_wave = AsyncMock(side_effect=fake_pick)
    progress = AsyncMock()
    context, _ = make_context()

    with pytest.raises(AutomationError, match="后续批次已停止"):
        await automation._run_all_pending(context, progress)

    attempted = [call.args[1].wave_no for call in automation._pick_wave.await_args_list]
    assert attempted == ["W001", "W002", "W003", "W004", "W005"]
    automation.pending_waves.find_remaining.assert_not_awaited()


@pytest.mark.asyncio
async def test_network_error_does_not_stop_later_batches() -> None:
    automation = make_automation()
    waves = [PendingWave(f"W{index:03d}") for index in range(1, 9)]
    automation.pending_waves.snapshot = AsyncMock(return_value=waves)
    automation.pending_waves.prepare_page = AsyncMock()
    automation.pending_waves.find_remaining = AsyncMock(return_value=[])
    attempts: list[str] = []

    async def fake_pick(page, wave, progress, sequence, total):
        attempts.append(wave.wave_no)
        if wave.wave_no == "W002":
            raise AutomationError("Network Error: connection reset")
        return CompletedWave(wave.wave_no, 1)

    automation._pick_wave = AsyncMock(side_effect=fake_pick)
    progress = AsyncMock()
    context, _ = make_context()

    result = await automation._run_all_pending(context, progress)

    assert attempts == [wave.wave_no for wave in waves]
    assert result.wave_nos == [wave.wave_no for wave in waves]
    assert result.failed_wave_nos == []
    assert automation.pending_waves.find_remaining.await_count == 1
    assert any(
        call.args[0] == "network_error_ignored" for call in progress.await_args_list
    )


@pytest.mark.asyncio
async def test_pending_network_error_is_reported_without_retry() -> None:
    automation = make_automation()
    waves = [PendingWave(f"W{index:03d}") for index in range(1, 5)]
    automation.pending_waves.snapshot = AsyncMock(return_value=waves)
    automation.pending_waves.prepare_page = AsyncMock()
    automation.pending_waves.find_remaining = AsyncMock(return_value=[waves[1]])
    attempts: list[str] = []

    async def fake_pick(page, wave, progress, sequence, total):
        attempts.append(wave.wave_no)
        if wave.wave_no == "W002":
            raise AutomationError("Network Error: timed out")
        return CompletedWave(wave.wave_no, 1)

    automation._pick_wave = AsyncMock(side_effect=fake_pick)
    progress = AsyncMock()
    context, _ = make_context()

    result = await automation._run_all_pending(context, progress)

    assert attempts.count("W002") == 1
    assert result.failed_wave_nos == ["W002"]
    assert result.wave_nos == ["W001", "W003", "W004"]
    assert result.wave_count == 3
    assert len(result.warnings) == 1
    assert "仍在待拣货列表" in result.warnings[0]
    assert "不会复查或重试" in result.warnings[0]
    assert any(
        call.args[0] == "final_pending_check_remaining"
        for call in progress.await_args_list
    )


@pytest.mark.asyncio
async def test_final_check_reports_any_initial_wave_still_pending() -> None:
    automation = make_automation()
    waves = [PendingWave("W001"), PendingWave("W002"), PendingWave("W003")]
    automation.pending_waves.snapshot = AsyncMock(return_value=waves)
    automation.pending_waves.prepare_page = AsyncMock()
    automation.pending_waves.find_remaining = AsyncMock(return_value=[waves[2]])
    automation._pick_wave = AsyncMock(
        side_effect=[CompletedWave(wave.wave_no, 1) for wave in waves]
    )
    progress = AsyncMock()
    context, _ = make_context()

    result = await automation._run_all_pending(context, progress)

    assert result.failed_wave_nos == ["W003"]
    assert result.wave_nos == ["W001", "W002"]
    assert result.wave_count == 2
