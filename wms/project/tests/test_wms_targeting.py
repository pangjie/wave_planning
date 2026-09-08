"""B5 fault-injected page targeting. No browser or WMS request is made."""
from unittest.mock import AsyncMock, MagicMock

import pytest
from playwright.async_api import TimeoutError as PlaywrightTimeoutError

from app.automation.common import AutomationError
from app.automation.wms_wave_generate import WmsWaveGenerateAutomation
from app.automation.wms_wave_pick import WmsWavePickAutomation


def locator(count=1, disabled=False):
    item = MagicMock()
    item.count = AsyncMock(return_value=count)
    item.is_disabled = AsyncMock(return_value=disabled)
    item.is_visible = AsyncMock(return_value=True)
    item.wait_for = AsyncMock(side_effect=PlaywrightTimeoutError("no visible candidate") if count == 0 else None)
    item.click = AsyncMock()
    item.filter.return_value = item
    item.and_.return_value = item
    item.or_.return_value = item
    item.locator.return_value = item
    # Model Playwright .first accurately: slicing destroys evidence of duplicates.
    item.first = item if count <= 1 else locator(1, disabled)
    return item


def generation_page(settings, *, confirms=1, checkboxes=1, dialogs=1, disabled=False):
    automation = WmsWaveGenerateAutomation(settings, settings.load_automation().wave_generation)
    sel = automation.config.selectors
    controls = {name: locator() for name in sel.model_dump()}
    controls["wave_confirm_button"] = locator(confirms, disabled)
    controls["select_all_checkbox"] = locator(checkboxes)
    controls["wave_dialog"] = locator(dialogs)
    lookup = {getattr(sel, name): control for name, control in controls.items()}
    lookup[sel.select_all_checkbox + ":visible"] = controls["select_all_checkbox"]
    page = MagicMock()
    page.locator.side_effect = lambda selector: lookup[selector]
    automation._search_chunk = AsyncMock(return_value=2)
    automation._set_page_size = AsyncMock()
    automation._read_search_total = AsyncMock(return_value=2)
    automation._verify_selected_total = AsyncMock()
    automation._ensure_sort_rules = AsyncMock()
    automation._extract_wave_no = AsyncMock(return_value="W0092609070001")
    return automation, page, controls


@pytest.mark.asyncio
@pytest.mark.parametrize("confirms,checkboxes,dialogs,disabled", [
    (0, 1, 1, False), (2, 1, 1, False), (1, 0, 1, False),
    (1, 2, 1, False), (1, 1, 0, False), (1, 1, 2, False), (1, 1, 1, True),
])
async def test_ambiguous_or_unavailable_generation_target_never_submits(
    isolated_runtime, confirms, checkboxes, dialogs, disabled,
):
    automation, page, controls = generation_page(isolated_runtime, confirms=confirms,
        checkboxes=checkboxes, dialogs=dialogs, disabled=disabled)
    with pytest.raises(AutomationError):
        await automation._generate_one(page, ["O1", "O2"], "CBT 单件1", AsyncMock())
    controls["wave_confirm_button"].click.assert_not_awaited()
    controls["wave_confirm_button"].first.click.assert_not_awaited()
    automation._extract_wave_no.assert_not_awaited()


@pytest.mark.asyncio
async def test_unique_generation_target_submits_once(isolated_runtime):
    automation, page, controls = generation_page(isolated_runtime)
    assert await automation._generate_one(page, ["O1", "O2"], "CBT 单件1", AsyncMock()) == "W0092609070001"
    controls["wave_confirm_button"].click.assert_awaited_once()
    controls["select_all_checkbox"].click.assert_awaited_once()
    automation._verify_selected_total.assert_awaited_once_with(page, "CBT 单件1", 2)
    controls["wave_dialog"].filter.assert_any_call(has=controls["sort_rule_rows"])
    automation._ensure_sort_rules.assert_awaited_once_with(page, "CBT 单件1", dialog=controls["wave_dialog"])
    controls["wave_confirm_button"].and_.assert_called_once_with(controls["wave_dialog"])


@pytest.mark.parametrize("error", [
    PlaywrightTimeoutError('Locator.click: Timeout 30000ms exceeded; another element intercepts pointer events'),
    PlaywrightTimeoutError('Locator.wait_for: Timeout 30000ms exceeded waiting for visible'),
    TimeoutError('operation timed out'),
    AutomationError('找不到确认按钮：timeout'),
    AutomationError('selector [data-dns] is missing'),
    AutomationError('resource temporarily unavailable'),
])
def test_ui_timeouts_and_generic_messages_are_not_network_failures(error):
    assert WmsWavePickAutomation._is_network_error(error) is False


@pytest.mark.parametrize("error", [
    AutomationError('Page.goto: net::ERR_CONNECTION_RESET'),
    AutomationError('Network Error: timed out'),
    ConnectionResetError('connection reset by peer'),
])
def test_explicit_transport_failure_remains_network_failure(error):
    assert WmsWavePickAutomation._is_network_error(error) is True


def test_wrapped_ui_timeout_does_not_inherit_network_permission():
    outer = AutomationError("Network error during confirmation")
    outer.__cause__ = PlaywrightTimeoutError("Locator.click: blocked")
    assert WmsWavePickAutomation._is_network_error(outer) is False
    action = AutomationError('Locator.click: blocked\nCall log:\nwaiting for button "Network Error"')
    assert WmsWavePickAutomation._is_network_error(action) is False
    suppressed = AutomationError("Missing button")
    suppressed.__context__ = ConnectionResetError("connection reset")
    suppressed.__suppress_context__ = True
    assert WmsWavePickAutomation._is_network_error(suppressed) is False


def test_wrapped_explicit_connection_failure_still_has_transport_evidence():
    outer = AutomationError("读取 WMS 响应失败")
    outer.__cause__ = ConnectionResetError("connection reset")
    assert WmsWavePickAutomation._is_network_error(outer) is True


@pytest.mark.asyncio
async def test_second_dialog_appearing_after_sorting_prevents_submit(isolated_runtime):
    automation, page, controls = generation_page(isolated_runtime)
    controls["wave_dialog"].count.side_effect = [1, 2]
    with pytest.raises(AutomationError, match="配置框不唯一"):
        await automation._generate_one(page, ["O1", "O2"], "CBT 单件1", AsyncMock())
    controls["wave_confirm_button"].click.assert_not_awaited()


@pytest.mark.asyncio
async def test_candidate_remains_unsliced_so_click_retains_strictness(isolated_runtime):
    automation, page, controls = generation_page(isolated_runtime)
    # If the DOM becomes ambiguous between count and click, Playwright's strict
    # unsliced locator fails; .first would silently target one of the buttons.
    confirm = controls["wave_confirm_button"]
    confirm.first = locator()
    confirm.click.side_effect = RuntimeError("strict mode violation: 2 elements")
    with pytest.raises(RuntimeError, match="strict mode violation"):
        await automation._generate_one(page, ["O1", "O2"], "CBT 单件1", AsyncMock())
    confirm.first.click.assert_not_awaited()
    automation._extract_wave_no.assert_not_awaited()
