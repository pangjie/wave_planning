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
async def test_template_selection_uses_stable_keyboard_contract() -> None:
    automation = make_automation()
    automation._wait_for_template_value = AsyncMock(side_effect=["", "渠道拆分"])

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
