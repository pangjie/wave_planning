from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from datetime import datetime

from playwright.async_api import Locator, Page, TimeoutError as PlaywrightTimeoutError

from app.automation.common import (
    AutomationError,
    ProgressCallback,
    SearchResultNotAppliedError,
    first_page,
    open_browser_context,
    resolve_headless,
    wait_for_loading,
)
from app.core.config import Settings, WaveGenerationConfig


@dataclass
class SegmentWaveOutcome:
    """One segment's wave-generation outcome inside a generate_waves job."""

    channel: str
    seg_name: str
    order_count: int
    wave_no: str | None = None
    note: str | None = None


@dataclass
class WaveGenerateResult:
    mode: str
    current_url: str
    message: str
    completed_at: str
    segments: list[SegmentWaveOutcome]
    generated_count: int
    failed_count: int


def chunk_list(items: list[str], size: int) -> list[list[str]]:
    """按固定大小切分出库单号（多项搜索单次上限 700 行；超过上限的分段已在 run() 中拦截）。"""
    if size < 1:
        raise ValueError("chunk size must be positive")
    return [items[start:start + size] for start in range(0, len(items), size)]


async def dialog_snippet(page: Page, selector: str) -> str:
    """取当前弹窗文本片段（最多 300 字符），用于失败诊断。"""
    try:
        text = await page.locator(selector).first.inner_text(timeout=1500)
        return " ".join(text.split())[:300]
    except Exception:
        return "(未捕获到弹窗内容)"


class WmsWaveGenerateAutomation:
    """“生成波次”工作流：按分段逐段搜索出库单号 → 全选 → 生成波次 → 提取波次号。

    生产安全约束：
    - 只处理请求中显式给出的分段与出库单号；
    - 每一步目标必须唯一且可见，歧义立即停止；
    - 网络错误不重试生产提交；
    - 每个分段只允许点击一次“确定”提交生成波次。
    """

    def __init__(self, settings: Settings, config: WaveGenerationConfig) -> None:
        self.settings = settings
        self.config = config

    async def run(
        self,
        progress: ProgressCallback,
        *,
        headless: bool | None = None,
        segments: list[dict[str, object]],
    ) -> WaveGenerateResult:
        cfg = self.config
        effective_headless = resolve_headless(self.settings, headless)
        browser_label = "无头" if effective_headless else "有头"
        await progress(
            "launching",
            f"正在以{browser_label}模式启动专用浏览器；将按顺序为 {len(segments)} 个分段生成波次，"
            "每个分段只提交一次生成操作。",
        )
        async with open_browser_context(
            self.settings, headless=effective_headless
        ) as context:
            page = await first_page(context)
            await page.goto(cfg.target_url, timeout=cfg.timeouts_ms.navigation)
            await self._wait_for_page_ready(page, progress)
            await self._ensure_no_blocking_dialog(page)
            await self._select_pending_tab(page)
            await self._set_page_size(page)

            outcomes: list[SegmentWaveOutcome] = []
            total = len(segments)
            prev_count: int | None = None  # 上一次实际执行搜索的分段数量（用于识别残留结果）
            for index, seg in enumerate(segments, start=1):
                channel = str(seg.get("channel", ""))
                seg_name = str(seg.get("seg_name", ""))
                order_nos = [
                    no for no in (str(x).strip() for x in (seg.get("order_nos") or [])) if no
                ]
                label = f"{channel} {seg_name}"
                note: str | None = None
                if len(order_nos) > cfg.multi_search_max_lines:
                    outcomes.append(SegmentWaveOutcome(
                        channel=channel, seg_name=seg_name,
                        order_count=len(order_nos), wave_no=None,
                        note=(
                            f"分段出库单号 {len(order_nos)} 个超过多项搜索单次上限 "
                            f"{cfg.multi_search_max_lines} 行，已跳过（请把该分段拆小后重试）。"
                        ),
                    ))
                    await progress(
                        "segment_failed",
                        f"分段 {label} 出库单号超过多项搜索单次上限，已跳过。",
                    )
                    continue
                try:
                    await progress(
                        "searching",
                        f"第 {index}/{total} 个分段：{label}，准备粘贴 {len(order_nos)} 个出库单号。",
                    )
                    wave_no = await self._generate_one(
                        page, order_nos, label, progress,
                        prev_expected=prev_count,
                    )
                    outcomes.append(SegmentWaveOutcome(
                        channel=channel, seg_name=seg_name,
                        order_count=len(order_nos), wave_no=wave_no,
                        note=None if wave_no else "未能提取波次号",
                    ))
                    if wave_no:
                        # 生成一个立即上报一个：前端轮询到该事件即变绿，后端立即持久化
                        await progress(
                            "segment_wave",
                            json.dumps(
                                {
                                    "channel": channel,
                                    "seg_name": seg_name,
                                    "wave_no": wave_no,
                                },
                                ensure_ascii=False,
                            ),
                        )
                except AutomationError as exc:
                    note = str(exc)
                except Exception as exc:
                    note = f"未预期错误：{exc}"
                if note:
                    outcomes.append(SegmentWaveOutcome(
                        channel=channel, seg_name=seg_name,
                        order_count=len(order_nos), wave_no=None, note=note,
                    ))
                    await progress(
                        "segment_failed",
                        f"分段 {label} 失败：{note}。不重试该分段，恢复页面后继续下一分段。",
                    )
                    try:
                        await page.goto(cfg.target_url, timeout=cfg.timeouts_ms.navigation)
                        await self._wait_for_page_ready(page, progress)
                        await self._select_pending_tab(page)
                        await self._set_page_size(page)
                    except Exception as recover_exc:
                        raise AutomationError(
                            f"分段 {label} 失败，且页面恢复失败：{recover_exc}"
                        )
                # 已实际执行过搜索的分段才更新对照值（跳过分段未动页面，结果仍是更早的查询）
                prev_count = len(order_nos)

            generated = sum(1 for o in outcomes if o.wave_no)
            failed = len(outcomes) - generated
            message = (
                f"生成波次完成：{generated}/{len(outcomes)} 个分段成功。"
                if not failed
                else f"生成波次部分完成：{generated}/{len(outcomes)} 个分段成功，{failed} 个分段失败（详见结果明细）。"
            )
            return WaveGenerateResult(
                mode="generate_waves",
                current_url=page.url,
                message=message,
                completed_at=datetime.now().astimezone().isoformat(),
                segments=outcomes,
                generated_count=generated,
                failed_count=failed,
            )

    async def _wait_for_page_ready(self, page: Page, progress: ProgressCallback) -> None:
        """等待业务页面可用（页签/搜索栏出现）；超时提示可能需要在弹出浏览器中登录。"""
        cfg = self.config
        await progress(
            "waiting_login",
            "正在等待订单页面就绪。若自动打开的浏览器停在登录页，请登录后保持窗口开启。",
        )
        anchor = page.locator('[role="tab"], .ak-advanced-input__multi')
        try:
            await anchor.first.wait_for(state="visible", timeout=cfg.timeouts_ms.login)
        except PlaywrightTimeoutError as exc:
            raise AutomationError("等待登录/页面就绪超时，未找到业务页面元素。") from exc
        await wait_for_loading(
            page, cfg.selectors.loading_mask, cfg.timeouts_ms.navigation,
            "订单页面加载超时，仍检测到加载遮罩。",
        )

    async def _ensure_no_blocking_dialog(self, page: Page) -> None:
        """开工前检查是否存在非流程内的系统弹窗（如初始化引导），有则快速停止。"""
        dialog = page.locator('.el-dialog:visible, .vxe-modal--wrapper:visible, .el-message-box:visible')
        try:
            if await dialog.count() == 0:
                return
            text = " ".join((await dialog.first.inner_text(timeout=2000)).split())[:200]
        except Exception:
            return
        if text:
            raise AutomationError(
                f"页面存在未处理的系统弹窗，已停止（请先在 WMS 中处理）：{text}"
            )

    async def _select_pending_tab(self, page: Page) -> None:
        cfg = self.config
        tab = page.locator('[role="tab"]', has_text=cfg.pending_tab_text)
        try:
            await tab.first.wait_for(state="visible", timeout=cfg.timeouts_ms.action)
        except PlaywrightTimeoutError as exc:
            raise AutomationError(f"“{cfg.pending_tab_text}”页签不可见，已停止。") from exc
        if await tab.count() != 1:
            raise AutomationError(f"“{cfg.pending_tab_text}”页签不唯一或不存在，已停止。")
        await tab.click(timeout=cfg.timeouts_ms.action)
        await wait_for_loading(
            page, cfg.selectors.loading_mask, cfg.timeouts_ms.navigation,
            "切换页签后页面加载超时。",
        )

    async def _set_page_size(self, page: Page) -> None:
        cfg = self.config
        size_select = page.locator('.el-pagination__sizes .el-select').first
        if await size_select.count() == 0:
            return  # 分页器不存在时跳过（保持现状）
        # 系统会记住上次设置：先确认当前每页条数，正确则无需重选
        try:
            await page.locator(
                '.el-pagination__sizes', has_text=cfg.page_size_option
            ).first.wait_for(state="visible", timeout=3000)
            return
        except PlaywrightTimeoutError:
            pass
        option = page.locator('.el-select-dropdown__item', has_text=cfg.page_size_option).first
        applied = False
        for _attempt in range(3):
            await size_select.click(timeout=cfg.timeouts_ms.action)
            try:
                await option.wait_for(state="visible", timeout=3000)
                await option.click(timeout=cfg.timeouts_ms.action)
                applied = True
                break
            except PlaywrightTimeoutError:
                await page.keyboard.press("Escape")
                await page.wait_for_timeout(600)
        if not applied:
            raise AutomationError(f"无法设置每页显示“{cfg.page_size_option}”。")
        # 校验生效
        try:
            await page.locator(
                '.el-pagination__sizes', has_text=cfg.page_size_option
            ).first.wait_for(state="visible", timeout=cfg.timeouts_ms.search_result)
        except PlaywrightTimeoutError as exc:
            raise AutomationError(f"每页显示“{cfg.page_size_option}”未生效。") from exc
        await wait_for_loading(
            page, cfg.selectors.loading_mask, cfg.timeouts_ms.search_result,
            "调整每页条数后页面加载超时。",
        )

    async def _generate_one(
        self,
        page: Page,
        order_nos: list[str],
        label: str,
        progress: ProgressCallback,
        *,
        prev_expected: int | None = None,
    ) -> str | None:
        cfg = self.config
        sel = cfg.selectors
        timeouts = cfg.timeouts_ms

        # 1) 定位出库单号搜索栏（页面存在多个高级搜索栏，需按标签精确定位）
        component = page.locator(sel.outbound_search_component)
        if await component.count() != 1:
            raise AutomationError("出库单号搜索栏不唯一或不存在（可能存在多个高级搜索栏）。")
        search_input = component.locator(sel.search_input).first
        if await search_input.count() == 0:
            raise AutomationError("出库单号搜索输入框未找到。")
        try:
            await search_input.wait_for(state="visible", timeout=timeouts.action)
        except PlaywrightTimeoutError as exc:
            raise AutomationError("出库单号搜索输入框不可见，已停止。") from exc
        if await search_input.is_disabled():
            raise AutomationError("出库单号搜索输入框处于禁用状态（可能有弹窗遮挡或页面未就绪）。")
        await search_input.click(timeout=timeouts.action)

        # 2) 打开“多项精确搜索”弹层并粘贴（一行一项，单次上限 700 行 → 分块累计）
        filter_icon = component.locator(sel.advanced_filter_icon).first
        if await filter_icon.count() != 1:
            raise AutomationError("多项搜索按钮不唯一或不存在。")
        textarea = page.locator(sel.multi_search_textarea).first

        for chunk in chunk_list(order_nos, cfg.multi_search_max_lines):
            await self._search_chunk(
                page, textarea, filter_icon, chunk, label,
                prev_expected=prev_expected, progress=progress,
            )

        # 3) 全选当前列表
        select_all = page.locator(sel.select_all_checkbox + ":visible").first
        if await select_all.count() != 1:
            raise AutomationError("表头全选框不唯一或不可见。")
        await select_all.click(timeout=timeouts.action)

        # 4) 生成波次 → 按勾选数据
        gen_btn = page.locator(sel.generate_wave_button)
        if await gen_btn.count() != 1:
            raise AutomationError("“生成波次”按钮不唯一或不存在。")
        await gen_btn.click(timeout=timeouts.action)
        by_selection = page.locator(sel.generate_by_selection_item)
        if await by_selection.count() != 1:
            raise AutomationError("“按勾选数据”选项不唯一或不存在。")
        await by_selection.click(timeout=timeouts.action)

        # 5) 排序规则：确保两条规则（库位 → SKU*数量）
        await self._ensure_sort_rules(page, label)

        # 6) 确定生成（生产提交点，唯一一次）
        confirm = page.locator(sel.wave_confirm_button).first
        try:
            await confirm.wait_for(state="visible", timeout=timeouts.dialog)
        except PlaywrightTimeoutError as exc:
            snippet = await dialog_snippet(page, sel.wave_dialog)
            raise AutomationError(
                f"分段 {label}：未找到生成波次配置框的“确定”按钮。弹窗内容片段：{snippet}"
            ) from exc
        if await confirm.is_disabled():
            raise AutomationError("生成波次“确定”按钮不可用。")
        await confirm.click(timeout=timeouts.action)

        # 7) 提取波次号
        wave_no = await self._extract_wave_no(page, label)

        # 8) 关闭结果弹窗，避免遮挡下一分段的操作
        await self._close_visible_dialogs(page)
        return wave_no

    async def _close_visible_dialogs(self, page: Page) -> None:
        """关闭当前可见的系统弹窗（点关闭按钮，失败则按 Escape），最多尝试 3 轮。"""
        dialogs = page.locator(
            '.el-dialog:visible, .vxe-modal--wrapper:visible, '
            '.el-message-box:visible, .el-message:visible'
        )
        for _round in range(3):
            try:
                count = await dialogs.count()
            except Exception:
                return
            if count == 0:
                return
            closed = False
            for index in range(count):
                dlg = dialogs.nth(index)
                close_btn = dlg.locator(
                    '.el-dialog__headerbtn, .el-message-box__headerbtn, '
                    'button.el-message__closeBtn, .vxe-modal--header-right'
                )
                if await close_btn.count() == 0:
                    continue
                try:
                    await close_btn.first.click(timeout=2000)
                    closed = True
                except Exception:
                    continue
            if not closed:
                try:
                    await page.keyboard.press("Escape")
                except Exception:
                    pass
            await page.wait_for_timeout(600)

    async def _search_chunk(
        self,
        page: Page,
        textarea: Locator,
        filter_icon: Locator,
        chunk: list[str],
        label: str,
        *,
        prev_expected: int | None,
        progress: ProgressCallback,
    ) -> None:
        """粘贴一批出库单号并查询，核对结果数量；疑似读到上一次查询的残留时重查一次。

        安全边界：重查只重新粘贴同一批单号并再次点击“搜索”，绝不重复提交生成波次；
        单块最多执行 2 次查询，仍未生效则停止。
        """
        cfg = self.config
        sel = cfg.selectors
        timeouts = cfg.timeouts_ms
        for attempt in range(2):
            # 弹层已打开则不再点击（按钮是开合切换，重复点击会关闭弹层）
            try:
                await textarea.wait_for(state="visible", timeout=1500)
            except PlaywrightTimeoutError:
                await filter_icon.click(timeout=timeouts.action)
                await textarea.wait_for(state="visible", timeout=timeouts.dialog)
            if await textarea.is_disabled():
                raise AutomationError("多项搜索输入框处于禁用状态，请检查页面状态。")
            await textarea.fill("\n".join(chunk))
            search_btn = page.locator(sel.multi_search_button).first
            if await search_btn.count() != 1 or await search_btn.is_disabled():
                raise AutomationError("多项搜索的“搜索”按钮不可用。")
            await search_btn.click(timeout=timeouts.action)
            await wait_for_loading(
                page, sel.loading_mask, timeouts.search_result,
                f"分段 {label} 搜索后页面加载超时。",
            )
            try:
                await self._verify_search_total(
                    page, progress, label, len(chunk), prev_expected=prev_expected
                )
                return
            except SearchResultNotAppliedError as exc:
                if attempt == 1:
                    raise AutomationError(
                        f"{exc} 已自动重查一次仍未生效，已停止。"
                    ) from exc
                await progress(
                    "searching",
                    f"分段 {label}：搜索结果疑似残留上一次查询（总数 {prev_expected}），"
                    "重新粘贴查询并复核（不重复生成波次）。",
                )

    async def _verify_search_total(
        self,
        page: Page,
        progress: ProgressCallback,
        label: str,
        expected: int,
        *,
        prev_expected: int | None = None,
    ) -> None:
        """搜索后核对结果数量。

        以右下角“共 X 条”为准（它与结果表同步刷新）：
        - X == 目标数 → 直接继续；
        - X != 目标数 → 短暂轮询等待结果加载完成（总数稳定或达到目标为止）：
          · 若仍不符，按页签（待处理/已取消）判定“部分订单已取消”情形。
            页签数字是异步刷新的，可能残留全局旧值，因此必须等到
            “待处理数 == 共 X 条”（说明页签已随本次搜索刷新）才可信，
            再按 待处理 + 已取消 == 目标数 判定取消情形；
          · 若总数恰等于上一分段数量，疑似读到上一次搜索的残留结果
            （查询未触发或未生效），抛 SearchResultNotAppliedError，
            由上层重新粘贴查询复核；
          · 其余情况立即停止。
        """
        sel = self.config.selectors
        timeouts = self.config.timeouts_ms

        total = await self._read_search_total(page, sel, timeouts)
        if total is None:
            raise AutomationError(
                f"分段 {label}：无法读取搜索结果总数（共 X 条），已停止。"
            )
        if total == expected:
            return

        # 结果可能在加载中：轮询至总数稳定或达到目标（时长有上限）
        deadline = time.monotonic() + self.config.search_verify_wait_ms / 1000.0
        while time.monotonic() < deadline:
            await page.wait_for_timeout(500)
            cur = await self._read_search_total(page, sel, timeouts)
            if cur is None:
                continue
            if cur == expected:
                return
            if cur == total:
                break  # 连续两次读数相同 → 已稳定
            total = cur

        # 数量不符：等待页签数字与搜索结果一致（防读到全局残留值）
        pending: int | None = None
        cancelled: int | None = None
        for _ in range(30):
            pending = await self._tab_badge_count(page, self.config.pending_tab_text)
            cancelled = await self._tab_badge_count(page, "已取消")
            if pending == total:
                break
            await page.wait_for_timeout(300)

        if pending == total and cancelled is not None and pending + cancelled == expected:
            if cancelled > 0:
                await progress(
                    "segment_warning",
                    f"分段 {label}：有 {cancelled} 个订单已取消"
                    f"（共 {expected} 单，待处理 {pending} 单），继续生成波次。",
                )
            return

        if prev_expected is not None and total == prev_expected:
            raise SearchResultNotAppliedError(
                f"分段 {label}：搜索结果总数 {total} 与目标 {expected} 不一致"
                f"（待处理 {pending}、已取消 {cancelled}，"
                f"与上一分段数量 {prev_expected} 相同，疑似残留上一次搜索结果）。"
            )
        raise AutomationError(
            f"分段 {label}：搜索结果总数 {total} 与目标 {expected} 不一致"
            f"（待处理 {pending}、已取消 {cancelled}），"
            "搜索结果可能未正确生效或被清空，已停止。"
        )

    async def _read_search_total(self, page: Page, sel, timeouts) -> int | None:
        """读取右下角“共 X 条”；解析失败短重试后返回 None。"""
        for _ in range(30):
            try:
                text = await page.locator(sel.pagination_total).first.inner_text(
                    timeout=timeouts.action
                )
                m = re.search(r"共\s*(\d+)\s*条", text or "")
                if m:
                    return int(m.group(1))
            except PlaywrightTimeoutError:
                pass
            await page.wait_for_timeout(300)
        return None

    async def _tab_badge_count(self, page: Page, tab_text: str) -> int | None:
        """读取页签文字旁括号内的数量（如“待处理 (123)”→123）；读不到返回 None。"""
        tabs = page.locator('[role="tab"]')
        try:
            count = await tabs.count()
        except Exception:
            return None
        for index in range(count):
            try:
                text = await tabs.nth(index).inner_text(timeout=1000)
            except Exception:
                continue
            if tab_text in text:
                m = re.search(r"\((\d+)\)", text)
                return int(m.group(1)) if m else None
        return None

    async def _ensure_sort_rules(self, page: Page, label: str) -> None:
        """确保配置框内两条排序规则生效：第一条库位、第二条 SKU*数量。

        实测该配置框默认已含两条规则；本方法读取现有标签并仅在缺失/不一致时修正。
        """
        cfg = self.config
        sel = cfg.selectors
        timeouts = cfg.timeouts_ms
        targets = ["库位", "SKU*数量"]

        async def _current_labels() -> list[str]:
            rows = page.locator(sel.sort_rule_rows)
            labels: list[str] = []
            for i in range(await rows.count()):
                lb = rows.nth(i).locator(sel.sort_rule_label).first
                try:
                    labels.append((await lb.inner_text(timeout=timeouts.action)).strip())
                except PlaywrightTimeoutError:
                    labels.append("")
            return labels

        for idx, target in enumerate(targets):
            labels = await _current_labels()
            current = labels[idx] if idx < len(labels) else ""
            if current == target:
                continue
            if idx >= len(labels):
                add_btn = page.locator(sel.sort_rule_add_btn).first
                if await add_btn.count() == 0:
                    raise AutomationError(f"分段 {label}：缺少排序规则且无“添加规则”入口。")
                await add_btn.click(timeout=timeouts.action)
                await page.wait_for_timeout(500)
            rows = page.locator(sel.sort_rule_rows)
            if await rows.count() <= idx:
                raise AutomationError(f"分段 {label}：无法添加第 {idx + 1} 条排序规则。")
            await rows.nth(idx).locator(sel.sort_rule_select).first.click(timeout=timeouts.action)
            # has_text 模糊匹配可能命中多个，取第一个可见
            visible = page.locator(
                '.el-select-dropdown .el-select-dropdown__item:visible'
            ).filter(has_text=target).first
            if await visible.count() == 0:
                raise AutomationError(f"分段 {label}：排序规则选项“{target}”不存在。")
            await visible.click(timeout=timeouts.action)
            await page.wait_for_timeout(400)

    async def _extract_wave_no(self, page: Page, label: str) -> str | None:
        """等待波次生成结果弹窗并提取 W+13 位波次号。"""
        cfg = self.config
        sel = cfg.selectors
        timeouts = cfg.timeouts_ms
        pattern = re.compile(cfg.wave_no_pattern)
        deadline = time.monotonic() + timeouts.wave_generation / 1000
        last_text = ""
        while time.monotonic() < deadline:
            container = page.locator(sel.result_text).first
            try:
                text = await container.inner_text(timeout=timeouts.action)
            except PlaywrightTimeoutError:
                text = ""
            if text:
                last_text = text
                match = pattern.search(text)
                if match:
                    return match.group(0)
            await page.wait_for_timeout(1000)
        # 结果弹窗文本里没有波次号：保留现场信息，安全停止
        snippet = last_text.replace("\n", " ")[:200]
        raise AutomationError(
            f"分段 {label}：生成波次后未在结果弹窗中找到波次号（W+13位数字）。"
            f"弹窗内容片段：{snippet}"
        )
