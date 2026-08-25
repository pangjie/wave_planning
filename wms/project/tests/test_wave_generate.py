from unittest.mock import AsyncMock, MagicMock

import pytest

from app.automation.wms_wave_generate import (
    WmsWaveGenerateAutomation,
    chunk_list,
)
from app.core.config import Settings


def make_automation() -> WmsWaveGenerateAutomation:
    settings = Settings.from_environment()
    config = settings.load_automation().wave_generation
    return WmsWaveGenerateAutomation(settings, config)


def test_chunk_list_splits_at_max_lines() -> None:
    items = [f"OBS{i}" for i in range(250)]
    chunks = chunk_list(items, 100)
    assert [len(c) for c in chunks] == [100, 100, 50]
    assert sum(len(c) for c in chunks) == 250
    assert chunks[0][0] == "OBS0" and chunks[2][-1] == "OBS249"


def test_chunk_list_rejects_bad_size() -> None:
    with pytest.raises(ValueError):
        chunk_list(["a"], 0)


@pytest.mark.asyncio
async def test_extract_wave_no_matches_w13_pattern() -> None:
    automation = make_automation()
    container = MagicMock()
    container.inner_text = AsyncMock(return_value="波次建立成功：波次号 W2026081700123，共 12 单。")
    page = MagicMock()
    page.locator.return_value.first = container

    wave_no = await automation._extract_wave_no(page, "CBT 爆品1")

    assert wave_no == "W2026081700123"


@pytest.mark.asyncio
async def test_extract_wave_no_times_out_with_snippet() -> None:
    from app.automation.common import AutomationError

    automation = make_automation()
    automation.config.timeouts_ms.wave_generation = 1500  # 缩短测试超时
    container = MagicMock()
    container.inner_text = AsyncMock(return_value="波次建立成功：未发现波次号信息。")
    page = MagicMock()
    page.wait_for_timeout = AsyncMock()
    page.locator.return_value.first = container

    with pytest.raises(AutomationError, match="未在结果弹窗中找到波次号"):
        await automation._extract_wave_no(page, "CBT 爆品1")


@pytest.mark.asyncio
async def test_select_pending_tab_requires_unique_tab() -> None:
    from app.automation.common import AutomationError
    from playwright.async_api import TimeoutError as PlaywrightTimeoutError

    automation = make_automation()

    # 页签一直不可见 → 超时错误
    page = MagicMock()
    tab = MagicMock()
    tab.first.wait_for = AsyncMock(side_effect=PlaywrightTimeoutError("timeout"))
    page.locator.return_value = tab
    with pytest.raises(AutomationError, match="页签不可见"):
        await automation._select_pending_tab(page)

    # 可见但数量不唯一 → 停止
    page = MagicMock()
    tab = MagicMock()
    tab.first.wait_for = AsyncMock(return_value=None)
    tab.count = AsyncMock(return_value=2)
    page.locator.return_value = tab
    with pytest.raises(AutomationError, match="页签不唯一或不存在"):
        await automation._select_pending_tab(page)


@pytest.mark.asyncio
async def test_sort_rules_verified_when_already_correct() -> None:
    automation = make_automation()
    page = MagicMock()
    page.wait_for_timeout = AsyncMock()

    label1 = MagicMock()
    label1.inner_text = AsyncMock(return_value="库位")
    label2 = MagicMock()
    label2.inner_text = AsyncMock(return_value="SKU*数量")
    row1 = MagicMock()
    row1.locator.return_value.first.inner_text = label1.inner_text
    row2 = MagicMock()
    row2.locator.return_value.first.inner_text = label2.inner_text
    rows = MagicMock()
    row_list = [row1, row2]
    rows.count = AsyncMock(return_value=len(row_list))
    rows.nth = MagicMock(side_effect=lambda i: row_list[i])
    page.locator = MagicMock(return_value=rows)

    # 标签已正确：校验通过且不触发修正分支（无异常即通过）
    await automation._ensure_sort_rules(page, "CBT 爆品1")


@pytest.mark.asyncio
async def test_blocking_dialog_stops_before_work() -> None:
    from app.automation.common import AutomationError

    automation = make_automation()
    page = MagicMock()
    dialog = MagicMock()
    dialog.count = AsyncMock(return_value=1)
    dialog.first.inner_text = AsyncMock(return_value="欢迎使用领星WMS，请先创建库区库位 下一步")
    page.locator = MagicMock(return_value=dialog)

    with pytest.raises(AutomationError, match="未处理的系统弹窗"):
        await automation._ensure_no_blocking_dialog(page)


@pytest.mark.asyncio
async def test_observe_pause_waits_and_notifies() -> None:
    automation = make_automation()
    page = MagicMock()
    page.wait_for_timeout = AsyncMock()
    page.screenshot = AsyncMock()
    calls: list[tuple[str, str]] = []

    async def progress(kind: str, msg: str) -> None:
        calls.append((kind, msg))

    await automation._observe_pause(page, progress, 2000)

    assert [c.args[0] for c in page.wait_for_timeout.await_args_list] == [1000, 2000]
    assert calls and calls[0][0] == "observing" and "2 秒" in calls[0][1]

    # 0 → 完全不暂停
    page2 = MagicMock()
    page2.wait_for_timeout = AsyncMock()
    await automation._observe_pause(page2, progress, 0)
    assert page2.wait_for_timeout.await_count == 0


@pytest.mark.asyncio
async def test_manual_confirm_waits_for_control_file(tmp_path) -> None:
    import json as _json

    automation = make_automation()
    automation.config.manual_step_mode = True
    control = tmp_path / "step-control.json"
    automation.config.step_control_file = str(control)

    page = MagicMock()

    async def tick(ms: int) -> None:
        control.write_text(
            _json.dumps({"step": "seg1:before_confirm", "continue": True}),
            "utf-8",
        )

    page.wait_for_timeout = AsyncMock(side_effect=tick)
    calls: list[tuple[str, str]] = []

    async def progress(kind: str, msg: str) -> None:
        calls.append((kind, msg))

    await automation._await_manual_confirm(
        page, progress, "seg1:before_confirm", "配置框规则核对", "SwiftX 爆品1")

    assert calls[0][0] == "awaiting_confirm"
    assert calls[1][0] == "confirmed"
    assert _json.loads(control.read_text("utf-8"))["continue"] is False


@pytest.mark.asyncio
async def test_manual_confirm_disabled_is_noop() -> None:
    automation = make_automation()
    automation.config.manual_step_mode = False
    page = MagicMock()
    page.wait_for_timeout = AsyncMock()
    calls: list[tuple[str, str]] = []

    async def progress(kind: str, msg: str) -> None:
        calls.append((kind, msg))

    await automation._await_manual_confirm(page, progress, "seg1:x", "某步", "L")

    assert calls == []
    assert page.wait_for_timeout.await_count == 0


@pytest.mark.asyncio
async def test_set_page_size_skips_when_already_correct() -> None:
    automation = make_automation()
    page = MagicMock()
    page.keyboard = MagicMock()
    size_el = MagicMock()
    size_el.count = AsyncMock(return_value=1)
    size_el.click = AsyncMock()
    size_el.first = size_el
    cur = MagicMock()
    cur.first = cur
    cur.wait_for = AsyncMock(return_value=None)  # 已是 1000条/页

    def _locator(sel, **kw):
        if '.el-pagination__sizes .el-select' in sel:
            return size_el
        if '.el-pagination__sizes' in sel:
            return cur
        return MagicMock()
    page.locator = MagicMock(side_effect=_locator)

    await automation._set_page_size(page)

    assert size_el.click.await_count == 0  # 正确时不应重选


@pytest.mark.asyncio
async def test_set_page_size_reselects_when_wrong() -> None:
    from playwright.async_api import TimeoutError as PlaywrightTimeoutError

    automation = make_automation()
    page = MagicMock()
    page.keyboard = MagicMock()
    page.wait_for_timeout = AsyncMock()
    size_el = MagicMock()
    size_el.count = AsyncMock(return_value=1)
    size_el.click = AsyncMock()
    size_el.first = size_el
    option = MagicMock()
    option.first = option
    option.wait_for = AsyncMock(return_value=None)
    option.click = AsyncMock()
    cur = MagicMock()
    cur.first = cur
    checks = iter([PlaywrightTimeoutError("not yet"), None])

    def flaky(**kw):
        r = next(checks)
        if isinstance(r, Exception):
            raise r
        return r

    cur.wait_for = AsyncMock(side_effect=flaky)
    loading = MagicMock()
    loading.wait_for = AsyncMock(return_value=None)

    cfg_loading = automation.config.selectors.loading_mask

    def _locator(sel, **kw):
        if '.el-pagination__sizes .el-select' in sel:
            return size_el
        if '.el-pagination__sizes' in sel:
            return cur
        if '.el-select-dropdown__item' in sel:
            return option
        if sel == cfg_loading:
            return loading
        return MagicMock()
    page.locator = MagicMock(side_effect=_locator)

    await automation._set_page_size(page)

    assert size_el.click.await_count == 1
    assert option.click.await_count == 1


@pytest.mark.asyncio
async def test_run_continues_after_segment_failure(monkeypatch) -> None:
    import app.automation.wms_wave_generate as _mod
    from app.automation.common import AutomationError

    automation = make_automation()
    automation._wait_for_page_ready = AsyncMock()
    automation._ensure_no_blocking_dialog = AsyncMock()
    automation._select_pending_tab = AsyncMock()
    automation._set_page_size = AsyncMock()

    results = [AutomationError("模拟失败"), "W0092608180099"]

    async def fake_generate(page, order_nos, label, progress, **kw):
        r = results.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    automation._generate_one = fake_generate

    page = MagicMock()
    page.goto = AsyncMock()
    ctx = MagicMock()
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=ctx)
    cm.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(_mod, "open_browser_context", lambda *a, **kw: cm)
    monkeypatch.setattr(_mod, "first_page", AsyncMock(return_value=page))

    calls: list[tuple[str, str]] = []

    async def progress(stage: str, msg: str) -> None:
        calls.append((stage, msg))

    res = await automation.run(progress, headless=False, segments=[
        {"channel": "CBT", "seg_name": "爆品2", "order_nos": ["OBS1"]},
        {"channel": "CBT", "seg_name": "爆品3", "order_nos": ["OBS2"]},
    ])

    assert res.generated_count == 1 and res.failed_count == 1
    assert res.segments[0].wave_no is None and "模拟失败" in (res.segments[0].note or "")
    assert res.segments[1].wave_no == "W0092608180099"
    assert any(c[0] == "segment_failed" for c in calls)
    assert any(c[0] == "segment_wave" and "W0092608180099" in c[1] for c in calls), "成功分段应立即上报 segment_wave"
    assert page.goto.await_count == 2  # 初始导航 + 失败后恢复页面
    assert "部分完成" in res.message


@pytest.mark.asyncio
async def test_run_skips_oversized_segment(monkeypatch) -> None:
    import app.automation.wms_wave_generate as _mod

    automation = make_automation()
    automation._wait_for_page_ready = AsyncMock()
    automation._ensure_no_blocking_dialog = AsyncMock()
    automation._select_pending_tab = AsyncMock()
    automation._set_page_size = AsyncMock()
    automation._generate_one = AsyncMock(return_value="W0092608180088")

    page = MagicMock()
    page.goto = AsyncMock()
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=MagicMock())
    cm.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(_mod, "open_browser_context", lambda *a, **kw: cm)
    monkeypatch.setattr(_mod, "first_page", AsyncMock(return_value=page))

    async def progress(stage: str, msg: str) -> None:
        pass

    res = await automation.run(progress, headless=False, segments=[
        {"channel": "BIG", "seg_name": "超限段",
         "order_nos": ["OBS" + str(i) for i in range(701)]},
        {"channel": "CBT", "seg_name": "爆品2", "order_nos": ["OBS1"]},
    ])

    assert res.generated_count == 1 and res.failed_count == 1
    assert res.segments[0].wave_no is None and "单次上限" in (res.segments[0].note or "")
    assert res.segments[1].wave_no == "W0092608180088"
    assert automation._generate_one.await_count == 1  # 超限段不进入浏览器流程


@pytest.mark.asyncio
async def test_close_visible_dialogs_clicks_close_buttons() -> None:
    automation = make_automation()
    page = MagicMock()
    page.keyboard = MagicMock()
    page.keyboard.press = AsyncMock()
    page.wait_for_timeout = AsyncMock()
    state = {"n": 1}
    close = MagicMock()
    close.count = AsyncMock(return_value=1)
    close.first.click = AsyncMock(side_effect=lambda **kw: state.__setitem__("n", 0))
    dlg = MagicMock()
    dlg.count = AsyncMock(side_effect=lambda: state["n"])
    dlg.nth = MagicMock(return_value=dlg)
    dlg.locator = MagicMock(return_value=close)
    page.locator = MagicMock(return_value=dlg)

    await automation._close_visible_dialogs(page)

    assert close.first.click.await_count == 1  # 点击后弹窗消失即停
    assert page.keyboard.press.await_count == 0


@pytest.mark.asyncio
async def test_close_visible_dialogs_escape_fallback_and_none() -> None:
    automation = make_automation()
    page = MagicMock()
    page.keyboard = MagicMock()
    page.wait_for_timeout = AsyncMock()
    state = {"n": 1}
    close = MagicMock()
    close.count = AsyncMock(return_value=0)
    dlg = MagicMock()
    dlg.count = AsyncMock(side_effect=lambda: state["n"])
    dlg.nth = MagicMock(return_value=dlg)
    dlg.locator = MagicMock(return_value=close)
    page.locator = MagicMock(return_value=dlg)
    page.keyboard.press = AsyncMock(side_effect=lambda *a: state.__setitem__("n", 0))

    await automation._close_visible_dialogs(page)
    assert page.keyboard.press.await_count == 1  # 无关闭按钮 → Escape 后弹窗消失

    none = MagicMock()
    none.count = AsyncMock(return_value=0)
    page2 = MagicMock()
    page2.locator = MagicMock(return_value=none)
    page2.wait_for_timeout = AsyncMock()
    await automation._close_visible_dialogs(page2)  # 无弹窗 → 直接返回
    assert page2.wait_for_timeout.await_count == 0


def _fake_search_page(total_text: str | list[str] | None, tab_texts: list[str]) -> MagicMock:
    """搜索核对模型：分页总数（共 X 条）+ 页签文本序列。

    total_text 可为字符串（恒定值）、字符串序列（每次读取依次弹出，
    耗尽后重复最后一个值，用于模拟结果异步刷新），或 None（读取超时）。
    """
    automation_cfg = Settings.from_environment().load_automation().wave_generation.selectors
    page = MagicMock()
    page.wait_for_timeout = AsyncMock()
    total_el = MagicMock()
    if total_text is None:
        from playwright.async_api import TimeoutError as _T
        total_el.first.inner_text = AsyncMock(side_effect=_T("timeout"))
    else:
        total_seq = [total_text] if isinstance(total_text, str) else list(total_text)
        state = {"last": None}

        def _next_total() -> str:
            if total_seq:
                state["last"] = total_seq.pop(0)
            return state["last"]

        total_el.first.inner_text = AsyncMock(side_effect=lambda timeout=None: _next_total())
    tab_el = MagicMock()
    tab_el.count = AsyncMock(return_value=len(tab_texts))
    queue = list(tab_texts)
    tab_el.nth = MagicMock(return_value=tab_el)
    tab_el.inner_text = AsyncMock(side_effect=lambda timeout=None: queue.pop(0))

    def _locator(sel, **kw):
        if sel == automation_cfg.pagination_total:
            return total_el
        return tab_el

    page.locator = MagicMock(side_effect=_locator)
    return page


@pytest.mark.asyncio
async def test_verify_total_pass_when_all_pending() -> None:
    automation = make_automation()
    page = _fake_search_page("共 3 条", ["待处理 (3)", "已取消 (0)"])
    calls: list[tuple[str, str]] = []

    async def progress(stage: str, msg: str) -> None:
        calls.append((stage, msg))

    await automation._verify_search_total(page, progress, "CBT 爆品1", 3)  # 不抛异常
    assert not any(c[0] == "segment_warning" for c in calls)


@pytest.mark.asyncio
async def test_verify_total_allows_cancelled_with_warning() -> None:
    automation = make_automation()
    page = _fake_search_page("共 2 条", ["待处理 (2)", "已取消 (1)"])
    calls: list[tuple[str, str]] = []

    async def progress(stage: str, msg: str) -> None:
        calls.append((stage, msg))

    await automation._verify_search_total(page, progress, "SwiftX 爆品1", 3)  # 不抛异常
    assert any(c[0] == "segment_warning" and "1 个订单已取消" in c[1] for c in calls), calls


@pytest.mark.asyncio
async def test_verify_total_stops_on_mismatch() -> None:
    from app.automation.common import AutomationError

    automation = make_automation()
    page = _fake_search_page("共 2 条", ["待处理 (2)", "已取消 (0)"])

    async def progress(stage: str, msg: str) -> None:
        pass

    with pytest.raises(AutomationError, match="与目标 3 不一致"):
        await automation._verify_search_total(page, progress, "SwiftX 爆品1", 3)


@pytest.mark.asyncio
async def test_verify_total_stops_when_unreadable() -> None:
    from app.automation.common import AutomationError

    automation = make_automation()
    page = _fake_search_page(None, ["待处理 (2)", "已取消 (0)"])

    async def progress(stage: str, msg: str) -> None:
        pass

    with pytest.raises(AutomationError, match="无法读取搜索结果总数"):
        await automation._verify_search_total(page, progress, "CBT 爆品1", 3)


@pytest.mark.asyncio
async def test_verify_total_ignores_stale_badges_when_total_matches() -> None:
    """关键回归：共 X 条已与目标一致时，页签残留全局旧值（如 已取消 7255）不得误判。"""
    automation = make_automation()
    page = _fake_search_page("共 316 条", ["待处理 (316)", "已取消 (7255)"])
    calls: list[tuple[str, str]] = []

    async def progress(stage: str, msg: str) -> None:
        calls.append((stage, msg))

    await automation._verify_search_total(page, progress, "CBT 爆品1", 316)  # 不抛异常
    assert not any(c[0] == "segment_warning" for c in calls)


@pytest.mark.asyncio
async def test_verify_total_stops_when_badges_never_consistent() -> None:
    """关键回归：总数不足且页签始终不一致（残留全局旧值）时，必须安全停止。"""
    from app.automation.common import AutomationError

    automation = make_automation()
    # 共 310 条（缺 6 单），页签一直残留旧值：待处理(316) ≠ 310 → 判定搜索未正确生效 → 停止
    page = _fake_search_page("共 310 条", ["待处理 (316)", "已取消 (7255)"])

    async def progress(stage: str, msg: str) -> None:
        pass

    with pytest.raises(AutomationError, match="与目标 316 不一致"):
        await automation._verify_search_total(page, progress, "CBT 爆品1", 316)


@pytest.mark.asyncio
async def test_verify_total_waits_for_slow_loading_results() -> None:
    """加固：结果仍在加载时（总数先是旧值、随后刷新为目标数）应等待并继续。"""
    automation = make_automation()
    page = _fake_search_page(["共 75 条", "共 76 条"], ["待处理 (76)", "已取消 (0)"])
    calls: list[tuple[str, str]] = []

    async def progress(stage: str, msg: str) -> None:
        calls.append((stage, msg))

    await automation._verify_search_total(
        page, progress, "USPS 多件2", 76, prev_expected=75
    )  # 不抛异常
    assert not any(c[0] == "segment_warning" for c in calls)


@pytest.mark.asyncio
async def test_verify_total_raises_stale_when_unchanged_prev_count() -> None:
    """加固：总数稳定在“上一分段数量”（疑似旧结果残留）→ 抛重查信号，而非直接判死。"""
    from app.automation.common import SearchResultNotAppliedError

    automation = make_automation()
    page = _fake_search_page("共 75 条", ["待处理 (75)", "已取消 (0)"])

    async def progress(stage: str, msg: str) -> None:
        pass

    with pytest.raises(SearchResultNotAppliedError, match="疑似残留上一次搜索结果"):
        await automation._verify_search_total(
            page, progress, "USPS 多件2", 76, prev_expected=75
        )


@pytest.mark.asyncio
async def test_verify_total_mismatch_unrelated_to_prev_stops_normally() -> None:
    """加固：总数与上一分段数量不同且页签无法解释差异 → 按普通不一致停止（不触发重查）。"""
    from app.automation.common import AutomationError, SearchResultNotAppliedError

    automation = make_automation()
    page = _fake_search_page("共 75 条", ["待处理 (75)", "已取消 (0)"])

    async def progress(stage: str, msg: str) -> None:
        pass

    with pytest.raises(AutomationError, match="与目标 76 不一致") as exc_info:
        await automation._verify_search_total(
            page, progress, "USPS 多件2", 76, prev_expected=100
        )
    assert not isinstance(exc_info.value, SearchResultNotAppliedError)


def _fake_chunk_page() -> MagicMock:
    """_search_chunk 依赖的页面模型：多项搜索按钮 + 已就绪的输入框。"""
    page = MagicMock()
    search_btn = MagicMock()
    search_btn.count = AsyncMock(return_value=1)
    search_btn.is_disabled = AsyncMock(return_value=False)
    search_btn.click = AsyncMock()
    page.locator = MagicMock()
    page.locator.return_value.first = search_btn
    return page


@pytest.mark.asyncio
async def test_search_chunk_retries_once_when_stale(monkeypatch) -> None:
    """加固：疑似旧结果残留 → 自动重新粘贴同一批单号再查询一次（绝不重复提交波次）。"""
    import app.automation.wms_wave_generate as mod
    from app.automation.common import SearchResultNotAppliedError

    automation = make_automation()
    page = _fake_chunk_page()
    textarea = MagicMock()
    textarea.wait_for = AsyncMock()
    textarea.is_disabled = AsyncMock(return_value=False)
    textarea.fill = AsyncMock()
    filter_icon = MagicMock()
    filter_icon.click = AsyncMock()
    monkeypatch.setattr(mod, "wait_for_loading", AsyncMock())
    monkeypatch.setattr(
        automation, "_verify_search_total",
        AsyncMock(side_effect=[SearchResultNotAppliedError("疑似残留"), None]),
    )
    calls: list[tuple[str, str]] = []

    async def progress(stage: str, msg: str) -> None:
        calls.append((stage, msg))

    await automation._search_chunk(
        page, textarea, filter_icon, ["A", "B"], "USPS 多件2",
        prev_expected=75, progress=progress,
    )  # 不抛异常
    assert textarea.fill.await_count == 2
    assert any("重新粘贴查询并复核" in msg for _, msg in calls), calls


@pytest.mark.asyncio
async def test_search_chunk_stops_after_two_stale_attempts(monkeypatch) -> None:
    """加固：重查一次后结果仍疑似残留 → 停止并给出明确提示（最多 2 次查询）。"""
    import app.automation.wms_wave_generate as mod
    from app.automation.common import AutomationError, SearchResultNotAppliedError

    automation = make_automation()
    page = _fake_chunk_page()
    textarea = MagicMock()
    textarea.wait_for = AsyncMock()
    textarea.is_disabled = AsyncMock(return_value=False)
    textarea.fill = AsyncMock()
    filter_icon = MagicMock()
    filter_icon.click = AsyncMock()
    monkeypatch.setattr(mod, "wait_for_loading", AsyncMock())
    monkeypatch.setattr(
        automation, "_verify_search_total",
        AsyncMock(side_effect=[
            SearchResultNotAppliedError("疑似残留"),
            SearchResultNotAppliedError("疑似残留"),
        ]),
    )

    async def progress(stage: str, msg: str) -> None:
        pass

    with pytest.raises(AutomationError, match="已自动重查一次仍未生效"):
        await automation._search_chunk(
            page, textarea, filter_icon, ["A", "B"], "USPS 多件2",
            prev_expected=75, progress=progress,
        )
    assert textarea.fill.await_count == 2
