"""Confirmed business results survive failing page cleanup; no real WMS is used."""

import asyncio
from contextlib import asynccontextmanager
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.automation.common import AutomationError
from app.automation.export_task_center import ExportTaskCenter, TaskCenterItem
from app.automation.wms_wave_generate import WmsWaveGenerateAutomation


def _wave_runner(monkeypatch, settings):
    import app.automation.wms_wave_generate as mod

    automation = WmsWaveGenerateAutomation(settings, settings.load_automation().wave_generation)
    for name in (
        "_wait_for_page_ready", "_ensure_no_blocking_dialog",
        "_select_pending_tab", "_set_page_size", "_close_visible_dialogs",
    ):
        setattr(automation, name, AsyncMock())
    automation._generate_one = AsyncMock(return_value="W0092608180099")
    page = MagicMock()
    page.url = automation.config.target_url
    page.goto = AsyncMock()

    @asynccontextmanager
    async def context(*args, **kwargs):
        yield MagicMock()

    monkeypatch.setattr(mod, "open_browser_context", context)
    monkeypatch.setattr(mod, "first_page", AsyncMock(return_value=page))
    return automation, page


def _segments(count):
    return [
        {"channel": "CBT", "seg_name": f"单件{index}",
         "order_nos": [f"OBS{index}-{order}" for order in range(index + 1)]}
        for index in range(count)
    ]


@pytest.mark.asyncio
async def test_final_dialog_cleanup_failure_preserves_confirmed_wave(monkeypatch, isolated_runtime):
    automation, _page = _wave_runner(monkeypatch, isolated_runtime)
    order = []
    confirmed = []

    async def progress(stage, message):
        if stage == "segment_wave":
            confirmed.append(json.loads(message))
            order.append("confirmed")

    async def fail_close(page):
        order.append("cleanup")
        raise RuntimeError("page already closed")

    automation._close_visible_dialogs = AsyncMock(side_effect=fail_close)
    result = await automation.run(progress, segments=_segments(1))

    assert order == ["confirmed", "cleanup"]
    assert confirmed == [{"channel": "CBT", "seg_name": "单件0",
                          "wave_no": "W0092608180099", "order_count": 1}]
    assert result.generated_count == 1
    assert result.failed_count == 0
    assert result.segments[0].wave_no == "W0092608180099"
    assert result.segments[0].note is None
    assert any("page already closed" in warning for warning in result.warnings)


@pytest.mark.asyncio
async def test_cleanup_failure_stops_only_unexecuted_segments(monkeypatch, isolated_runtime):
    automation, page = _wave_runner(monkeypatch, isolated_runtime)
    automation._close_visible_dialogs.side_effect = RuntimeError("still open")
    progress = AsyncMock()

    result = await automation.run(progress, segments=_segments(3))

    automation._generate_one.assert_awaited_once()
    assert page.goto.await_count == 1  # No reload/retry after a confirmed wave.
    assert result.generated_count == 1
    assert result.failed_count == 2
    assert [outcome.order_count for outcome in result.segments] == [1, 2, 3]
    assert result.segments[0].wave_no == "W0092608180099"
    assert all(outcome.wave_no is None for outcome in result.segments[1:])
    assert all("未执行" in outcome.note for outcome in result.segments[1:])
    assert "部分完成" in result.message
    assert any("停止剩余 2 个分段" in warning for warning in result.warnings)
    assert [call.args[0] for call in progress.await_args_list].count("segment_wave") == 1
    assert "segment_failed" not in [call.args[0] for call in progress.await_args_list]


@pytest.mark.asyncio
async def test_failed_confirmation_write_stops_before_cleanup(monkeypatch, isolated_runtime):
    automation, _page = _wave_runner(monkeypatch, isolated_runtime)

    async def progress(stage, message):
        if stage == "segment_wave":
            raise OSError("confirmed wave could not be saved")

    with pytest.raises(OSError, match="could not be saved"):
        await automation.run(progress, segments=_segments(2))

    automation._generate_one.assert_awaited_once()
    automation._close_visible_dialogs.assert_not_awaited()


@pytest.mark.asyncio
async def test_cancel_during_cleanup_is_not_turned_into_success(monkeypatch, isolated_runtime):
    automation, _page = _wave_runner(monkeypatch, isolated_runtime)
    automation._close_visible_dialogs.side_effect = asyncio.CancelledError()
    progress = AsyncMock()

    with pytest.raises(asyncio.CancelledError):
        await automation.run(progress, segments=_segments(2))

    assert [call.args[0] for call in progress.await_args_list].count("segment_wave") == 1
    automation._generate_one.assert_awaited_once()


@pytest.mark.asyncio
async def test_generate_one_returns_number_without_closing_dialog(isolated_runtime):
    automation = WmsWaveGenerateAutomation(
        isolated_runtime, isolated_runtime.load_automation().wave_generation,
    )
    element = MagicMock()
    element.first = element
    element.locator.return_value = element
    element.filter.return_value = element
    element.and_.return_value = element
    element.or_.return_value = element
    element.count = AsyncMock(return_value=1)
    element.wait_for = AsyncMock()
    element.is_disabled = AsyncMock(return_value=False)
    element.click = AsyncMock()
    page = MagicMock()
    page.locator.return_value = element
    automation._search_chunk = AsyncMock(return_value=1)
    automation._set_page_size = AsyncMock()
    automation._read_search_total = AsyncMock(return_value=1)
    automation._verify_selected_total = AsyncMock()
    automation._ensure_sort_rules = AsyncMock()
    automation._extract_wave_no = AsyncMock(return_value="W0092608180099")
    automation._close_visible_dialogs = AsyncMock(side_effect=RuntimeError("closed"))

    result = await automation._generate_one(page, ["OBS1"], "CBT 单件0", AsyncMock())

    assert result == "W0092608180099"
    automation._close_visible_dialogs.assert_not_awaited()


@pytest.mark.asyncio
async def test_still_visible_dialog_is_reported_after_bounded_attempts(isolated_runtime):
    automation = WmsWaveGenerateAutomation(
        isolated_runtime, isolated_runtime.load_automation().wave_generation,
    )
    dialogs = MagicMock()
    dialogs.count = AsyncMock(return_value=1)
    dialogs.nth.return_value = dialogs
    dialogs.locator.return_value.count = AsyncMock(return_value=0)
    page = MagicMock()
    page.locator.return_value = dialogs
    page.keyboard.press = AsyncMock()
    page.wait_for_timeout = AsyncMock()

    with pytest.raises(AutomationError, match="3 次关闭尝试后仍可见"):
        await automation._close_visible_dialogs(page)

    assert page.keyboard.press.await_count == 3


def _download_fixture(settings):
    center = ExportTaskCenter(settings, settings.load_automation())
    center._open = AsyncMock()
    center._close = AsyncMock(side_effect=RuntimeError("task center already closed"))
    task = TaskCenterItem("ParcelOutbound_test.xlsx", "t", "ready", "", True)
    download = MagicMock()
    download.suggested_filename = task.filename

    async def save(target: Path):
        target.write_bytes(b"complete downloaded workbook")

    download.save_as = AsyncMock(side_effect=save)

    class DownloadInfo:
        @property
        def value(self):
            async def get():
                return download
            return get()

    @asynccontextmanager
    async def expect_download(**kwargs):
        yield DownloadInfo()

    button = MagicMock()
    button.count = AsyncMock(return_value=1)
    button.is_enabled = AsyncMock(return_value=True)
    button.click = AsyncMock()
    rows = MagicMock()
    rows.count = AsyncMock(return_value=1)
    rows.locator.return_value.filter.return_value = button
    page = MagicMock()
    page.locator.return_value.filter.return_value = rows
    page.expect_download = expect_download
    return center, task, page, download, rows, button


@pytest.mark.asyncio
async def test_downloaded_path_survives_task_center_close_error(isolated_runtime):
    center, task, page, download, _rows, button = _download_fixture(isolated_runtime)
    warnings = []

    result = await center.download(page, task, warnings=warnings)

    assert result.read_bytes() == b"complete downloaded workbook"
    download.save_as.assert_awaited_once_with(result)
    button.click.assert_awaited_once()
    assert any("task center already closed" in warning for warning in warnings)


@pytest.mark.asyncio
async def test_download_save_failure_is_not_hidden_by_cleanup(isolated_runtime):
    center, task, page, download, _rows, button = _download_fixture(isolated_runtime)
    download.save_as.side_effect = OSError("disk full")
    warnings = []

    with pytest.raises(AutomationError, match="导出文件保存失败.*disk full"):
        await center.download(page, task, warnings=warnings)

    button.click.assert_awaited_once()
    center._close.assert_not_awaited()
    assert warnings == []


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid_target", ["rows", "button"])
async def test_task_target_error_is_not_masked_by_close_error(isolated_runtime, invalid_target):
    center, task, page, _download, rows, button = _download_fixture(isolated_runtime)
    if invalid_target == "rows":
        rows.count.return_value = 2
        expected = "无法唯一定位刚完成的导出任务"
    else:
        button.is_enabled.return_value = False
        expected = "下载按钮不可用"
    warnings = []

    with pytest.raises(AutomationError, match=expected):
        await center.download(page, task, warnings=warnings)

    button.click.assert_not_awaited()
    assert any("task center already closed" in warning for warning in warnings)


@pytest.mark.asyncio
@pytest.mark.parametrize("read_error", [ValueError("unreadable task data"), asyncio.CancelledError()])
async def test_snapshot_failure_or_cancellation_survives_close_failure(isolated_runtime, read_error):
    center, _task, page, _download, _rows, _button = _download_fixture(isolated_runtime)
    center._read_items = AsyncMock(side_effect=read_error)

    with pytest.raises(type(read_error)) as caught:
        await center.snapshot(page)

    assert caught.value is read_error
    center._close.assert_awaited_once_with(page)


@pytest.mark.asyncio
async def test_snapshot_close_failure_still_stops_before_export(isolated_runtime):
    center, task, page, _download, _rows, _button = _download_fixture(isolated_runtime)
    center._read_items = AsyncMock(return_value=[task])

    with pytest.raises(RuntimeError, match="task center already closed"):
        await center.snapshot(page)


@pytest.mark.asyncio
async def test_export_task_failure_is_not_masked_by_task_center_close_failure(isolated_runtime):
    center, _task, page, _download, _rows, _button = _download_fixture(isolated_runtime)
    center._read_items = AsyncMock(return_value=[
        TaskCenterItem("ParcelOutbound_failed.xlsx", "t", "导出失败", "error", False),
    ])

    with pytest.raises(AutomationError, match="导出任务失败.*ParcelOutbound_failed"):
        await center.wait_until_downloadable(page, set(), AsyncMock())

    center._close.assert_awaited_once_with(page)


@pytest.mark.asyncio
async def test_export_wait_timeout_is_not_masked_by_task_center_close_failure(isolated_runtime):
    center, _task, page, _download, _rows, _button = _download_fixture(isolated_runtime)
    center.config.timeouts_ms.task_completion = 0

    with pytest.raises(AutomationError, match="等待导出文件完成超时"):
        await center.wait_until_downloadable(page, set(), AsyncMock())

    center._close.assert_awaited_once_with(page)
