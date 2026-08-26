from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.automation.common import AutomationError
from app.automation.export_task_center import ExportTaskCenter, TaskCenterItem
from app.automation.wms_export import WmsExportAutomation
from app.core.config import Settings


def make_automation() -> WmsExportAutomation:
    settings = Settings.from_environment()
    return WmsExportAutomation(settings, settings.load_automation())


@pytest.mark.asyncio
async def test_template_selection_uses_stable_keyboard_contract(monkeypatch) -> None:
    import app.automation.wms_export as mod

    automation = make_automation()
    monkeypatch.setattr(
        mod, "wait_for_input_value", AsyncMock(side_effect=["", "渠道拆分"])
    )

    template_input = MagicMock()
    template_input.count = AsyncMock(return_value=1)
    template_input.click = AsyncMock()
    template_input.press = AsyncMock()
    dialog = MagicMock()
    dialog.locator.return_value = template_input

    dropdown = MagicMock()
    dropdown.wait_for = AsyncMock()
    option = MagicMock()
    option.filter.return_value = option
    option.count = AsyncMock(return_value=1)
    option.inner_text = AsyncMock(return_value="渠道拆分")
    page = MagicMock()
    page.locator.side_effect = [dropdown, option]

    selected = await automation._ensure_template(dialog, page)

    assert selected == "渠道拆分"
    template_input.press.assert_any_await("ArrowDown", timeout=15000)
    template_input.press.assert_any_await("Enter", timeout=15000)
    option.click.assert_not_called()


@pytest.mark.asyncio
async def test_waits_until_required_template_fields_are_loaded_and_stable() -> None:
    automation = make_automation()
    partial = ["Outbound Order No/出库单号", "SKU 1", "SKU 2", "SKU 3", "SKU 4"]
    complete = partial + [
        "SKU 5",
        "SKU 6",
        "Type of order variety/订单品种类型",
        "Shipping Carrier/物流承运商",
        "Order No/订单号",
        "Tracking No/物流跟踪号",
    ]

    labels = MagicMock()
    labels.evaluate_all = AsyncMock(side_effect=[partial, complete, complete])
    dialog = MagicMock()
    dialog.locator.return_value = labels

    selected = await automation._wait_for_required_template_fields(dialog)

    assert selected == complete
    assert labels.evaluate_all.await_count == 3


def test_selects_only_new_parcel_export_task() -> None:
    settings = Settings.from_environment()
    task_center = ExportTaskCenter(settings, settings.load_automation())
    old = TaskCenterItem(
        filename="ParcelOutbound_20260620042741.xlsx",
        created_at="2026-06-19 16:27:33",
        status="导出",
        icon_class="xl_tip_success",
        downloadable=True,
    )
    unrelated = TaskCenterItem(
        filename="BlWaveList_20260620195229.xlsx",
        created_at="2026-06-20 07:52:29",
        status="导出",
        icon_class="xl_tip_success",
        downloadable=True,
    )
    new = TaskCenterItem(
        filename="ParcelOutbound_20260620201030.xlsx",
        created_at="2026-06-20 08:10:31",
        status="导出中",
        icon_class="xl_tip_info",
        downloadable=False,
    )

    selected = task_center._select_export_task([unrelated, new, old], {old.key})

    assert selected == new


def test_download_path_is_sanitized_and_does_not_overwrite(tmp_path) -> None:
    settings = Settings.from_environment().model_copy(update={"downloads_dir": tmp_path})
    task_center = ExportTaskCenter(settings, settings.load_automation())
    existing = tmp_path / "ParcelOutbound.xlsx"
    existing.write_text("existing", encoding="utf-8")

    target = task_center._unique_download_path("../ParcelOutbound.xlsx")

    assert target.parent == tmp_path
    assert target != existing
    assert target.suffix == ".xlsx"

@pytest.mark.asyncio
async def test_await_disk_download_picks_new_file(tmp_path) -> None:
    import asyncio
    import time

    from app.automation.export_task_center import ExportTaskCenter

    settings = Settings.from_environment().model_copy(update={"downloads_dir": tmp_path})
    center = ExportTaskCenter(settings, settings.load_automation())
    (tmp_path / "old.xlsx").write_bytes(b"old")
    before = center._snapshot_downloads_dir()

    async def writer():
        await asyncio.sleep(0.3)
        (tmp_path / "ParcelOutbound_20260821000000.xlsx").write_bytes(b"x" * 500)

    task = asyncio.create_task(writer())
    found = await center._await_disk_download(time.monotonic(), before)
    await task
    assert found.name == "ParcelOutbound_20260821000000.xlsx"


@pytest.mark.asyncio
async def test_await_disk_download_times_out_when_no_file(tmp_path) -> None:
    import time

    from app.automation.common import AutomationError
    from app.automation.export_task_center import ExportTaskCenter

    settings = Settings.from_environment().model_copy(
        update={
            "downloads_dir": tmp_path,
            "automation_config_path": Settings.from_environment().automation_config_path,
        }
    )
    cfg = settings.load_automation().model_copy(deep=True)
    cfg.timeouts_ms.task_completion = 800
    center = ExportTaskCenter(settings, cfg)

    before = center._snapshot_downloads_dir()
    with pytest.raises(AutomationError, match="既未收到下载事件"):
        await center._await_disk_download(time.monotonic(), before)


@pytest.mark.asyncio
async def test_await_disk_download_ignores_old_and_nonprefix_files(tmp_path) -> None:
    import asyncio
    import time

    from app.automation.export_task_center import ExportTaskCenter

    settings = Settings.from_environment().model_copy(update={"downloads_dir": tmp_path})
    center = ExportTaskCenter(settings, settings.load_automation())
    (tmp_path / "other_20260821000000.xlsx").write_bytes(b"x" * 100)  # 前缀不符
    before = center._snapshot_downloads_dir()

    async def writer():
        await asyncio.sleep(0.4)
        (tmp_path / "ParcelOutbound_20260821000001.xlsx").write_bytes(b"x" * 300)

    task = asyncio.create_task(writer())
    found = await center._await_disk_download(time.monotonic(), before)
    await task
    # 只应收到前缀匹配的新文件，旧文件与非前缀文件均被忽略
    assert found.name == "ParcelOutbound_20260821000001.xlsx"


def _fake_task_page(save_side_effect):
    """download() 流程所需页面替身：任务中心行 + 下载按钮 + expect_download。"""
    selectors = Settings.from_environment().load_automation().selectors
    page = MagicMock()
    page.context = MagicMock()

    button = MagicMock()
    button.count = AsyncMock(return_value=1)
    button.is_enabled = AsyncMock(return_value=True)
    button.click = AsyncMock()

    rows = MagicMock()
    rows.count = AsyncMock(return_value=1)
    btn_loc = MagicMock()
    btn_loc.filter.return_value = button
    rows.locator = MagicMock(return_value=btn_loc)

    download_obj = MagicMock()
    download_obj.suggested_filename = "ParcelOutbound_20260826000000.xlsx"
    download_obj.save_as = AsyncMock(side_effect=save_side_effect)

    class _Info:
        def __init__(self, download_obj):
            self._download_obj = download_obj

        @property
        def value(self):
            async def _get():
                return self._download_obj

            return _get()

    info = _Info(download_obj)

    class _ExpectCM:
        async def __aenter__(self):
            return info

        async def __aexit__(self, *exc):
            return False

    page.expect_download = MagicMock(return_value=_ExpectCM())

    def _locator(sel, **kw):
        m = MagicMock()
        if sel == selectors.task_center_item:
            m.filter.return_value = rows
        elif sel == selectors.task_center_download_button:
            m.filter.return_value = button
        return m

    page.locator = MagicMock(side_effect=_locator)
    page.goto = AsyncMock()
    return page


def _download_center(tmp_path):
    settings = Settings.from_environment().model_copy(update={"downloads_dir": tmp_path})
    center = ExportTaskCenter(settings, settings.load_automation())
    center._open = AsyncMock()
    center._close_safe = AsyncMock()
    center._snapshot_downloads_dir = MagicMock(return_value=set())
    center._unique_download_path = MagicMock(
        return_value=tmp_path / "ParcelOutbound_20260826000000.xlsx"
    )
    return center


@pytest.mark.asyncio
async def test_download_raises_interrupted_when_page_closes(tmp_path) -> None:
    """回归：WMS 关页中断下载时，download() 抛可恢复信号（换新浏览器重试由导出流程负责）。"""
    from app.automation.export_task_center import DownloadInterruptedError

    center = _download_center(tmp_path)
    page = _fake_task_page([RuntimeError("Download interrupted by page close")])
    task = TaskCenterItem(
        filename="ParcelOutbound_20260826000000.xlsx",
        created_at="t", status="", icon_class="", downloadable=True,
    )

    async def progress(stage: str, msg: str) -> None:
        pass

    with pytest.raises(DownloadInterruptedError):
        await center.download(page, task, progress)


@pytest.mark.asyncio
async def test_run_retries_download_in_new_browser(tmp_path, monkeypatch) -> None:
    """回归：浏览器被 WMS 关页杀死后，导出流程换新浏览器只补下载，不重复提交导出。"""
    import app.automation.wms_export as mod
    from app.automation.export_task_center import DownloadInterruptedError

    automation = make_automation()
    task = TaskCenterItem(
        filename="ParcelOutbound_20260826000000.xlsx",
        created_at="t", status="", icon_class="", downloadable=True,
    )
    monkeypatch.setattr(
        automation, "_prepare_and_submit",
        AsyncMock(return_value=("已提交。", "渠道拆分", task)),
    )
    monkeypatch.setattr(
        automation, "_resume_download",
        AsyncMock(return_value=tmp_path / "ParcelOutbound_20260826000000.xlsx"),
    )
    monkeypatch.setattr(
        automation.task_center, "download",
        AsyncMock(side_effect=[
            DownloadInterruptedError(RuntimeError("Target closed")),
            tmp_path / "ParcelOutbound_20260826000000.xlsx",
        ]),
    )

    opens = 0

    class _FakeBrowserCM:
        async def __aenter__(self):
            nonlocal opens
            opens += 1
            return MagicMock()

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(
        mod, "open_browser_context",
        lambda *a, **kw: _FakeBrowserCM(),
    )
    monkeypatch.setattr(mod, "first_page", AsyncMock(return_value=MagicMock()))
    calls: list[tuple[str, str]] = []

    async def progress(stage: str, msg: str) -> None:
        calls.append((stage, msg))

    result = await automation.run(progress, headless=True)

    assert result.downloaded_file.endswith("ParcelOutbound_20260826000000.xlsx")
    assert opens == 2  # 第二次进入新浏览器
    assert automation._prepare_and_submit.await_count == 1  # 导出只提交一次
    assert any(stage == "download_retry" for stage, _ in calls), calls


@pytest.mark.asyncio
async def test_run_stops_with_manual_download_hint_when_retry_also_interrupted(
    tmp_path, monkeypatch
) -> None:
    """回归：换新浏览器重试后仍被关页中断 → 停止并明确提示手动下载。"""
    import app.automation.wms_export as mod
    from app.automation.export_task_center import DownloadInterruptedError

    automation = make_automation()
    task = TaskCenterItem(
        filename="ParcelOutbound_20260826000000.xlsx",
        created_at="t", status="", icon_class="", downloadable=True,
    )
    monkeypatch.setattr(
        automation, "_prepare_and_submit",
        AsyncMock(return_value=("已提交。", "渠道拆分", task)),
    )
    monkeypatch.setattr(
        automation, "_resume_download",
        AsyncMock(side_effect=DownloadInterruptedError(RuntimeError("Target closed again"))),
    )
    monkeypatch.setattr(
        automation.task_center, "download",
        AsyncMock(side_effect=DownloadInterruptedError(RuntimeError("Target closed"))),
    )

    class _FakeBrowserCM:
        async def __aenter__(self):
            return MagicMock()

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(mod, "open_browser_context", lambda *a, **kw: _FakeBrowserCM())
    monkeypatch.setattr(mod, "first_page", AsyncMock(return_value=MagicMock()))

    async def progress(stage: str, msg: str) -> None:
        pass

    with pytest.raises(AutomationError, match="请从任务中心手动下载"):
        await automation.run(progress, headless=True)


@pytest.mark.asyncio
async def test_close_safe_swallows_closed_page() -> None:
    """回归：弹层清理遇到页面已关闭时静默跳过，不掩盖保存阶段的真实错误。"""
    settings = Settings.from_environment()
    center = ExportTaskCenter(settings, settings.load_automation())
    center._close = AsyncMock(
        side_effect=RuntimeError("Target page, context or browser has been closed")
    )

    await center._close_safe(MagicMock())  # 不抛异常
