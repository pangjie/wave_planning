from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from playwright.async_api import (
    BrowserContext,
    Dialog,
    Locator,
    Page,
    TimeoutError as PlaywrightTimeoutError,
)

from app.automation.common import (
    AutomationError,
    ProgressCallback,
    WAVE_NO_PATTERN,
    first_page,
    normalize_wave_nos,
    open_browser_context,
    resolve_headless,
)
from app.automation.wave_pending import PendingWave, PendingWaveCatalog
from app.core.config import AutomationConfig, Settings


@dataclass(slots=True)
class WavePickResult:
    mode: Literal["pick_waves"]
    wave_nos: list[str]
    failed_wave_nos: list[str]
    warnings: list[str]
    wave_count: int
    sku_rows: int
    current_url: str
    message: str
    completed_at: str


@dataclass(frozen=True, slots=True)
class CompletedWave:
    wave_no: str
    sku_rows: int


class WmsWavePickAutomation:
    """Pick the initial pending-wave snapshot in bounded concurrent batches."""

    def __init__(self, settings: Settings, config: AutomationConfig) -> None:
        self.settings = settings
        self.config = config
        self.pending_waves = PendingWaveCatalog(config)

    async def run(
        self,
        progress: ProgressCallback,
        headless: bool | None = None,
        *,
        wave_nos: list[str] | None = None,
    ) -> WavePickResult:
        wave_cfg = self.config.wave_picking
        if wave_cfg.max_concurrent_waves != 5:
            raise AutomationError("安全限制异常：波次拣货最大并发必须严格限制为 5。")

        requested_wave_nos = normalize_wave_nos(wave_nos or [])
        for wave_no in requested_wave_nos:
            if not WAVE_NO_PATTERN.fullmatch(wave_no):
                raise AutomationError(f"波次号格式异常，已停止操作：{wave_no}")

        effective_headless = resolve_headless(self.settings, headless)
        browser_label = "无头" if effective_headless else "有头"
        scope_message = (
            f"仅处理输入框指定的 {len(requested_wave_nos)} 个波次"
            if requested_wave_nos
            else "处理启动时的全部待拣货波次"
        )
        await progress(
            "launching",
            f"正在以{browser_label}模式启动专用浏览器；本任务将{scope_message}，"
            "最大并发为 5；可识别的网络错误会被忽略且不重试，任务结束后只做一次全量列表检查。",
        )

        async with open_browser_context(
            self.settings,
            headless=effective_headless,
        ) as context:
            return await self._run_all_pending(
                context,
                progress,
                requested_wave_nos=requested_wave_nos,
            )

    async def _run_all_pending(
        self,
        context: BrowserContext,
        progress: ProgressCallback,
        *,
        requested_wave_nos: list[str] | None = None,
    ) -> WavePickResult:
        cfg = self.config.wave_picking
        control_page = await first_page(context)
        snapshot_waves = await self.pending_waves.snapshot(control_page, progress)
        warnings: list[str] = []
        unavailable_wave_nos: list[str] = []

        if requested_wave_nos:
            pending_by_no = {wave.wave_no: wave for wave in snapshot_waves}
            waves = [
                pending_by_no[wave_no]
                for wave_no in requested_wave_nos
                if wave_no in pending_by_no
            ]
            unavailable_wave_nos = [
                wave_no for wave_no in requested_wave_nos if wave_no not in pending_by_no
            ]
            await progress(
                "selected_waves_filtered",
                f"已从当前全部 {len(snapshot_waves)} 个待拣货波次中匹配到"
                f" {len(waves)}/{len(requested_wave_nos)} 个指定波次。",
            )
            if unavailable_wave_nos:
                warning = (
                    f"输入的 {len(unavailable_wave_nos)} 个波次不在任务启动时的"
                    "待拣货列表中，已跳过：" + "、".join(unavailable_wave_nos)
                )
                warnings.append(warning)
                await progress("selected_waves_unavailable", warning)
            if not waves:
                message = (
                    f"输入的 {len(requested_wave_nos)} 个波次均不在任务启动时的"
                    "待拣货列表中，未执行拣货。"
                )
                return WavePickResult(
                    mode="pick_waves",
                    wave_nos=[],
                    failed_wave_nos=unavailable_wave_nos,
                    warnings=warnings,
                    wave_count=0,
                    sku_rows=0,
                    current_url=control_page.url,
                    message=message,
                    completed_at=datetime.now().astimezone().isoformat(),
                )
        else:
            waves = snapshot_waves

        total = len(waves)
        scope_total = len(requested_wave_nos) if requested_wave_nos else total
        concurrency = min(cfg.max_concurrent_waves, total)
        pages = [control_page]
        for _ in range(1, concurrency):
            pages.append(await context.new_page())

        await progress(
            "parallel_start",
            (
                f"已锁定输入框中匹配的 {total} 个待拣货波次，"
                if requested_wave_nos
                else f"已锁定当前列表全部 {total} 个待拣货波次，"
            )
            + f"将使用最多 {concurrency} 个独立页面分批并发处理。",
        )

        completed_by_no: dict[str, CompletedWave] = {}
        ignored_network_errors: dict[str, str] = {}
        for batch_start in range(0, total, concurrency):
            batch = waves[batch_start:batch_start + concurrency]
            batch_number = batch_start // concurrency + 1
            batch_count = (total + concurrency - 1) // concurrency
            await progress(
                "batch_start",
                f"正在处理第 {batch_number}/{batch_count} 批，共 {len(batch)} 个波次："
                + "、".join(wave.wave_no for wave in batch),
            )

            async def run_page(
                slot_index: int,
                page: Page,
                wave: PendingWave,
            ) -> CompletedWave:
                sequence = batch_start + slot_index + 1
                await self.pending_waves.prepare_page(
                    page,
                    wave,
                    progress,
                    slot_index + 1,
                    concurrency,
                )
                item = await self._pick_wave(
                    page,
                    wave,
                    progress,
                    sequence,
                    total,
                )
                await progress(
                    "wave_completed",
                    f"波次 {sequence}/{total} 已完成：{item.wave_no}。",
                )
                return item

            results = await asyncio.gather(
                *(
                    run_page(index, page, wave)
                    for index, (page, wave) in enumerate(
                        zip(pages[:len(batch)], batch, strict=True)
                    )
                ),
                return_exceptions=True,
            )
            fatal_failures: list[tuple[PendingWave, BaseException]] = []
            for wave, result in zip(batch, results, strict=True):
                if isinstance(result, CompletedWave):
                    completed_by_no[result.wave_no] = result
                    continue
                if not isinstance(result, BaseException):
                    fatal_failures.append(
                        (wave, RuntimeError(f"未知任务结果：{result!r}"))
                    )
                    continue
                if self._is_network_error(result):
                    ignored_network_errors[wave.wave_no] = str(result)
                    await progress(
                        "network_error_ignored",
                        f"波次 {wave.wave_no} 遇到网络错误，已忽略并继续后续任务；"
                        "不会针对该波次复查或重试。",
                    )
                    continue
                fatal_failures.append((wave, result))

            if fatal_failures:
                completed_text = "、".join(completed_by_no) or "无"
                failure_text = "；".join(
                    f"{wave.wave_no}：{error}" for wave, error in fatal_failures
                )
                raise AutomationError(
                    f"全部波次任务已完成 {len(completed_by_no)}/{total} 个"
                    f"（{completed_text}）；检测到非网络错误，为避免扩大影响，"
                    f"后续批次已停止。失败：{failure_text}"
                )

        await progress(
            "final_pending_check_start",
            f"常规拣货流程已结束，正在一次性检查本次锁定的全部 {total} 个波次"
            "是否仍在待拣货列表。",
        )
        try:
            remaining = await self.pending_waves.find_remaining(
                control_page,
                waves,
                progress,
            )
        except Exception as check_error:
            if not ignored_network_errors:
                raise AutomationError(
                    f"常规拣货流程已结束，但最终统一列表检查失败：{check_error}；"
                    "系统不会自动重跑波次。"
                ) from check_error
            pending_failed_wave_nos = [
                wave.wave_no
                for wave in waves
                if wave.wave_no in ignored_network_errors
            ]
            remaining_nos = set(pending_failed_wave_nos)
            failed_set = set(unavailable_wave_nos) | remaining_nos
            failed_wave_nos = [
                wave_no
                for wave_no in (requested_wave_nos or [wave.wave_no for wave in waves])
                if wave_no in failed_set
            ]
            warning = (
                f"最终统一列表检查失败：{check_error}；"
                f"{len(pending_failed_wave_nos)} 个网络异常波次无法确认，"
                "系统不会复查或重试。"
            )
            warnings.append(warning)
            await progress("final_pending_check_failed", warning)
        else:
            remaining_nos = {wave.wave_no for wave in remaining}
            failed_set = set(unavailable_wave_nos) | remaining_nos
            failed_wave_nos = [
                wave_no
                for wave_no in (requested_wave_nos or [wave.wave_no for wave in waves])
                if wave_no in failed_set
            ]
            pending_failed_wave_nos = [
                wave.wave_no for wave in waves if wave.wave_no in remaining_nos
            ]
            if pending_failed_wave_nos:
                warning = (
                    f"最终统一检查发现 {len(pending_failed_wave_nos)} 个本次锁定波次"
                    "仍在待拣货列表；系统不会复查或重试："
                    + "、".join(pending_failed_wave_nos)
                )
                warnings.append(warning)
                await progress("final_pending_check_remaining", warning)
            else:
                await progress(
                    "final_pending_check_clear",
                    f"最终统一检查完成：本次锁定的全部 {total} 个波次"
                    "均已不在待拣货列表。",
                )

        for wave_no in ignored_network_errors:
            if wave_no not in remaining_nos:
                completed_by_no[wave_no] = CompletedWave(wave_no=wave_no, sku_rows=0)

        completed = [
            completed_by_no[wave.wave_no]
            for wave in waves
            if wave.wave_no in completed_by_no and wave.wave_no not in remaining_nos
        ]
        wave_nos = [item.wave_no for item in completed]
        total_sku_rows = sum(item.sku_rows for item in completed)
        if failed_wave_nos:
            message = (
                f"常规流程已结束；确认完成 {len(completed)}/{scope_total} 个目标波次，"
                f"仍有 {len(failed_wave_nos)} 个目标波次未完成、不可用或无法确认："
                + "、".join(failed_wave_nos)
            )
        elif ignored_network_errors:
            message = (
                f"最终统一检查确认：本次锁定的全部 {total} 个波次均已不在待拣货列表；"
                f"期间忽略了 {len(ignored_network_errors)} 个网络错误，未进行定向复查或重试。"
            )
        else:
            message = (
                f"最终统一检查确认：本次锁定的全部 {total} 个波次"
                "均已不在待拣货列表。"
            )
        return WavePickResult(
            mode="pick_waves",
            wave_nos=wave_nos,
            failed_wave_nos=failed_wave_nos,
            warnings=warnings,
            wave_count=len(completed),
            sku_rows=total_sku_rows,
            current_url=control_page.url,
            message=message,
            completed_at=datetime.now().astimezone().isoformat(),
        )

    @staticmethod
    def _is_network_error(error: BaseException) -> bool:
        messages: list[str] = []
        current: BaseException | None = error
        visited: set[int] = set()
        while current is not None and id(current) not in visited:
            visited.add(id(current))
            if isinstance(current, (PlaywrightTimeoutError, TimeoutError)):
                return True
            messages.append(str(current).lower())
            current = current.__cause__ or current.__context__

        text = " ".join(messages)
        return any(
            token in text
            for token in (
                "net::err_",
                "network error",
                "networkerror",
                "网络错误",
                "网络异常",
                "connection reset",
                "connection refused",
                "connection closed",
                "连接超时",
                "连接失败",
                "socket hang up",
                "dns",
                "timed out",
                "timeout",
                "temporarily unavailable",
            )
        )

    async def _pick_wave(
        self,
        page: Page,
        wave: PendingWave,
        progress: ProgressCallback,
        sequence: int,
        total: int,
    ) -> CompletedWave:
        cfg = self.config.wave_picking
        selectors = cfg.selectors
        timeouts = cfg.timeouts_ms

        if not WAVE_NO_PATTERN.fullmatch(wave.wave_no):
            raise AutomationError(f"波次号格式异常，已停止操作：{wave.wave_no}")
        selected_row = page.locator(
            f'{selectors.wave_rows}[rowid="{wave.wave_no}"]'
        )
        selected_row_count = await selected_row.count()
        if selected_row_count < 1:
            raise AutomationError(
                f"无法定位待拣货波次 {wave.wave_no}。"
            )
        # VXETable may clone the same logical row into fixed-column tables. Only the
        # action copy has a visible pick button, so uniqueness is enforced there.
        pick_button = selected_row.locator(
            f"{selectors.wave_pick_button}:visible"
        ).filter(has_text="拣货")
        if await pick_button.count() != 1 or not await pick_button.is_enabled():
            raise AutomationError(f"波次 {wave.wave_no} 的“拣货”按钮不可用。")

        await progress(
            "opening_wave",
            f"第 {sequence}/{total} 个：正在打开波次 {wave.wave_no} 的拣货页签。",
        )
        await pick_button.click(timeout=timeouts.action)

        picking_header = page.locator(selectors.picking_headers).filter(has_text="SKU")
        try:
            await picking_header.wait_for(state="visible", timeout=timeouts.picking_page)
        except PlaywrightTimeoutError as exc:
            raise AutomationError(f"波次 {wave.wave_no} 已打开，但未找到包含 SKU 的拣货表格。") from exc
        if await picking_header.count() != 1:
            raise AutomationError("包含 SKU 的拣货表头不唯一，已停止操作。")

        sku_rows = await self._count_unique_picking_rows(
            page.locator(selectors.picking_rows)
        )
        if sku_rows < 1:
            raise AutomationError(f"波次 {wave.wave_no} 的拣货表格没有 SKU 数据。")

        # The visible fixed-column header can be a sibling clone of the header
        # containing the SKU label, so locate its uniquely titled checkbox globally.
        select_all = page.locator(selectors.select_all_checkbox)
        if await select_all.count() != 1:
            raise AutomationError("无法唯一定位 SKU 左侧的全选框，已停止操作。")
        await progress(
            "selecting_skus",
            f"第 {sequence}/{total} 个：正在全选波次 {wave.wave_no} 的 {sku_rows} 条 SKU 明细。",
        )
        await select_all.click(timeout=timeouts.action)

        confirm_button = await self._wait_for_enabled_confirm(page)
        await progress(
            "submitting_pick",
            f"第 {sequence}/{total} 个：SKU 已全选，正在确认波次 {wave.wave_no}；"
            "之后仅处理截单提醒。",
        )

        native_messages: list[str] = []
        unexpected_native_messages: list[str] = []
        dialog_tasks: set[asyncio.Task[None]] = set()

        async def handle_native_dialog(dialog: Dialog) -> None:
            message = dialog.message.strip()
            if self._is_cutoff_prompt(message):
                native_messages.append(message or "截单提醒")
                await dialog.accept()
            else:
                unexpected_native_messages.append(message or "未知浏览器弹窗")
                await dialog.dismiss()

        def schedule_dialog(dialog: Dialog) -> None:
            task = asyncio.create_task(handle_native_dialog(dialog))
            dialog_tasks.add(task)
            task.add_done_callback(dialog_tasks.discard)

        page.on("dialog", schedule_dialog)
        try:
            await confirm_button.click(timeout=timeouts.action)
            await self._wait_for_completion(
                page,
                wave.wave_no,
                progress,
                native_messages,
                unexpected_native_messages,
            )
            if dialog_tasks:
                await asyncio.gather(*dialog_tasks, return_exceptions=True)
        finally:
            page.remove_listener("dialog", schedule_dialog)

        return CompletedWave(
            wave_no=wave.wave_no,
            sku_rows=sku_rows,
        )

    @staticmethod
    async def _count_unique_picking_rows(rows: Locator) -> int:
        return await rows.evaluate_all(
            r"""
            rows => new Set(rows.map(row =>
              row.getAttribute('rowid') || (row.textContent || '').replace(/\s+/g, ' ').trim()
            )).size
            """
        )

    async def _wait_for_enabled_confirm(self, page: Page) -> Locator:
        cfg = self.config.wave_picking
        candidates = page.locator(cfg.selectors.confirm_buttons).filter(
            has_text=re.compile(r"^\s*(确认|Confirm)\s*$", re.IGNORECASE)
        )
        loop = asyncio.get_running_loop()
        deadline = loop.time() + cfg.timeouts_ms.action / 1000
        while loop.time() < deadline:
            enabled: list[Locator] = []
            for index in range(await candidates.count()):
                candidate = candidates.nth(index)
                if await candidate.is_visible() and await candidate.is_enabled():
                    enabled.append(candidate)
            if len(enabled) == 1:
                return enabled[0]
            if len(enabled) > 1:
                raise AutomationError("全选后出现多个可点击的“确认”按钮，已停止操作。")
            await asyncio.sleep(0.1)
        raise AutomationError("SKU 全选后，“确认”按钮仍不可点击，已停止操作。")

    async def _wait_for_completion(
        self,
        page: Page,
        wave_no: str,
        progress: ProgressCallback,
        native_messages: list[str],
        unexpected_native_messages: list[str],
    ) -> None:
        cfg = self.config.wave_picking
        loop = asyncio.get_running_loop()
        deadline = loop.time() + cfg.timeouts_ms.completion / 1000
        reported_processing = False
        handled_dialog_texts: set[str] = set()

        while loop.time() < deadline:
            if unexpected_native_messages:
                raise AutomationError(
                    "确认拣货后出现未识别的浏览器弹窗，已安全取消："
                    + "；".join(unexpected_native_messages)
                )
            if native_messages:
                for message in native_messages:
                    if message not in handled_dialog_texts:
                        handled_dialog_texts.add(message)
                        await progress("cutoff_confirmed", f"已确认截单提醒：{message}")

            await self._handle_cutoff_dialog(page, progress, handled_dialog_texts)

            messages = page.locator(cfg.selectors.result_messages)
            for text in await messages.all_inner_texts():
                normalized = " ".join(text.split())
                lowered = normalized.lower()
                if any(token in lowered for token in ("失败", "error", "fail")):
                    raise AutomationError(f"波次 {wave_no} 拣货失败：{normalized}")
                if any(token in lowered for token in ("成功", "完成", "success", "completed")):
                    return

            if await page.locator(cfg.selectors.loading_mask).count() > 0:
                if not reported_processing:
                    reported_processing = True
                    await progress("processing", f"波次 {wave_no} 正在 processing，请稍候。")
            await asyncio.sleep(0.2)

        raise AutomationError(
            f"已提交波次 {wave_no} 的拣货确认，但在限定时间内未收到明确的完成信息。"
        )

    async def _handle_cutoff_dialog(
        self,
        page: Page,
        progress: ProgressCallback,
        handled_dialog_texts: set[str],
    ) -> None:
        cfg = self.config.wave_picking
        dialogs = page.locator(cfg.selectors.cutoff_dialog)
        visible_dialogs: list[Locator] = []
        for index in range(await dialogs.count()):
            dialog = dialogs.nth(index)
            if await dialog.is_visible():
                visible_dialogs.append(dialog)
        if not visible_dialogs:
            return
        if len(visible_dialogs) > 1:
            raise AutomationError("确认拣货后同时出现多个弹窗，已停止自动确认。")

        dialog = visible_dialogs[0]
        text = " ".join((await dialog.inner_text()).split())
        if not self._is_cutoff_prompt(text):
            raise AutomationError(f"确认拣货后出现未识别的弹窗，未点击：{text}")

        buttons = dialog.locator(cfg.selectors.cutoff_confirm_buttons).filter(
            has_text=re.compile(r"^\s*(确定|确认|Confirm)\s*$", re.IGNORECASE)
        )
        enabled: list[Locator] = []
        for index in range(await buttons.count()):
            button = buttons.nth(index)
            if await button.is_visible() and await button.is_enabled():
                enabled.append(button)
        if len(enabled) != 1:
            raise AutomationError("检测到截单提醒，但无法唯一定位其确认按钮。")
        await enabled[0].click(timeout=cfg.timeouts_ms.action)
        if text not in handled_dialog_texts:
            handled_dialog_texts.add(text)
            await progress("cutoff_confirmed", f"已确认截单提醒：{text}")

    @staticmethod
    def _is_cutoff_prompt(text: str) -> bool:
        lowered = text.lower()
        return any(
            token in lowered
            for token in ("截单", "截取", "提醒", "confirm", "cut off", "cutoff")
        )
