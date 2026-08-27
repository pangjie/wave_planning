from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

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
    return page, download_obj


def _download_center(tmp_path):
    settings = Settings.from_environment().model_copy(update={"downloads_dir": tmp_path})
    center = ExportTaskCenter(settings, settings.load_automation())
    center._open = AsyncMock()
    center._close = AsyncMock()
    center._unique_download_path = MagicMock(
        return_value=tmp_path / "ParcelOutbound_20260826000000.xlsx"
    )
    return center


@pytest.mark.asyncio
async def test_download_uses_standard_playwright_save(tmp_path) -> None:
    """下载流程只使用 Playwright 的标准事件与 save_as。"""
    order: list[str] = []

    async def save(target: Path) -> None:
        target.write_bytes(b"downloaded")
        order.append("saved")

    async def close(_page) -> None:
        order.append("closed")

    center = _download_center(tmp_path)
    center._close = AsyncMock(side_effect=close)
    page, download_obj = _fake_task_page(save)
    task = TaskCenterItem(
        filename="ParcelOutbound_20260826000000.xlsx",
        created_at="t", status="", icon_class="", downloadable=True,
    )

    target = await center.download(page, task)

    assert target.is_file()
    assert order == ["saved", "closed"]
    download_obj.save_as.assert_awaited_once_with(target)


@pytest.mark.asyncio
async def test_run_uses_one_headless_context_until_download_completes(
    tmp_path, monkeypatch
) -> None:
    """提交和下载始终处于同一个无头会话，完成后才退出上下文。"""
    import app.automation.wms_export as mod

    automation = make_automation()
    target = tmp_path / "ParcelOutbound_20260826000000.xlsx"
    task = TaskCenterItem(
        filename="ParcelOutbound_20260826000000.xlsx",
        created_at="t", status="", icon_class="", downloadable=True,
    )
    monkeypatch.setattr(
        automation, "_prepare_and_submit",
        AsyncMock(return_value=("已提交。", "渠道拆分", task)),
    )
    opens = 0
    context_order: list[str] = []
    page = MagicMock()
    page.url = "https://wms.xlwms.com/outbound/parcel"

    async def download_once(*args, **kwargs):
        context_order.append("download")
        return target

    monkeypatch.setattr(
        automation.task_center,
        "download",
        AsyncMock(side_effect=download_once),
    )

    class _FakeBrowserCM:
        async def __aenter__(self):
            context_order.append("enter")
            return self

        async def __aexit__(self, *exc):
            context_order.append("exit")
            return False

    def open_context(*args, **kwargs):
        nonlocal opens
        opens += 1
        return _FakeBrowserCM()

    monkeypatch.setattr(mod, "open_browser_context", open_context)
    reset_download_state = MagicMock()
    monkeypatch.setattr(mod, "reset_browser_download_state", reset_download_state)
    monkeypatch.setattr(
        mod,
        "first_page",
        AsyncMock(return_value=page),
    )
    async def progress(stage: str, msg: str) -> None:
        pass

    result = await automation.run(progress, headless=True)

    assert opens == 1
    assert context_order == ["enter", "download", "exit"]
    assert result.downloaded_file == str(target)
    reset_download_state.assert_called_once_with(
        automation.settings.browser_profile_dir
    )
    assert automation._prepare_and_submit.await_count == 1
    assert automation.task_center.download.await_count == 1
