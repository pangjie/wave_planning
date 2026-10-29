# 全量/截单导出共用流程：准备筛选 → 校验模板 → 提交 → 识别任务 → 下载。
# 截单检查点用于恢复原导出；手工全量导出先重置筛选，避免继承上次增量范围。
from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

from playwright.async_api import Locator, Page, TimeoutError as PlaywrightTimeoutError

from app.automation.common import (
    AutomationError,
    ProgressCallback,
    first_page,
    open_browser_context,
    reset_browser_download_state,
    resolve_headless,
    wait_for_input_value,
    wait_for_loading,
)
from app.automation.export_task_center import ExportTaskCenter, TaskCenterItem
from app.core.config import AutomationConfig, Settings


@dataclass(slots=True)
class ExportResult:
    mode: Literal["export"]
    template: str
    current_url: str
    message: str
    completed_at: str
    task_filename: str | None = None
    downloaded_file: str | None = None
    downloaded_copy: str | None = None
    warnings: list[str] = field(default_factory=list)


class WmsExportAutomation:
    """Orchestrate template validation, submission and result download."""

    def __init__(self, settings: Settings, config: AutomationConfig) -> None:
        self.settings = settings
        self.config = config
        self.task_center = ExportTaskCenter(settings, config)

    # 保持指定的有头/无头模式；恢复已有 task_key 时仅等候和下载原任务。
    async def run(
        self,
        progress: ProgressCallback,
        headless: bool | None = None,
        created_range: dict[str, str] | None = None,
        checkpoint: dict | None = None,
    ) -> ExportResult:
        effective_headless = resolve_headless(self.settings, headless)
        browser_label = "无头" if effective_headless else "有头"
        await progress(
            "launching",
            f"正在以{browser_label}模式启动专用浏览器。",
        )
        warnings: list[str] = []
        reset_browser_download_state(self.settings.browser_profile_dir)
        async with open_browser_context(
            self.settings,
            headless=effective_headless,
            downloads_dir=self.settings.downloads_dir,
            cleanup_warnings=warnings,
        ) as context:
            page = await first_page(context)
            if checkpoint and checkpoint.get("submitted"):
                if not checkpoint.get("task_key"):
                    raise AutomationError("导出已提交但任务身份未确认，请人工核对，不能自动重复提交。")
                await page.goto(self.config.target_url, wait_until="domcontentloaded", timeout=self.config.timeouts_ms.navigation)
                await progress("resuming_export", "继续等待并下载原导出任务，不重复提交。")
                task = await self.task_center.wait_until_downloadable(page, set(), progress,
                    detected_key=checkpoint["task_key"], checkpoint=True)
                message, selected_template = "已恢复原导出任务。", self.config.template_name
            else:
                message, selected_template, task = await self._prepare_and_submit(
                    page, progress, **({"created_range": created_range} if created_range else {})
                )
            await progress("downloading", f"导出已完成，正在下载 {task.filename}")
            downloaded_file = await self.task_center.download(page, task, warnings=warnings)
            return ExportResult(
                mode="export",
                template=selected_template,
                current_url=page.url,
                message=f"{message} 文件已保存到 {downloaded_file}",
                completed_at=datetime.now().astimezone().isoformat(),
                task_filename=task.filename,
                downloaded_file=str(downloaded_file),
                warnings=warnings,
            )

    async def _prepare_and_submit(
        self,
        page: Page,
        progress: ProgressCallback,
        created_range: dict[str, str] | None = None,
    ) -> tuple[str, str, TaskCenterItem]:
        """打开订单页 → 校验模板 → 提交正式导出 → 等待任务可下载；返回提交信息、模板与任务。"""
        cfg = self.config
        selectors = cfg.selectors
        timeouts = cfg.timeouts_ms

        await progress("navigating", f"正在打开 {cfg.target_url}")
        await page.goto(cfg.target_url, wait_until="domcontentloaded", timeout=timeouts.navigation)

        page_export = page.locator(selectors.page_export_button).filter(has_text="导出")
        try:
            await page_export.wait_for(state="visible", timeout=12000)
        except PlaywrightTimeoutError:
            await progress(
                "waiting_login",
                "尚未检测到业务页面。请在自动打开的浏览器中登录，登录后保持窗口开启。",
            )
            try:
                await page_export.wait_for(state="visible", timeout=timeouts.login)
            except PlaywrightTimeoutError as exc:
                raise AutomationError("等待登录超时，未找到页面上的“导出”按钮。") from exc

        if await page_export.count() != 1:
            raise AutomationError("页面上的“导出”按钮不唯一，选择器需要更新。")

        await progress("waiting_data", "页面已打开，正在等待数据和操作区加载完成。")
        await wait_for_loading(
            page, selectors.loading_mask, timeouts.navigation,
            "页面数据加载超时，仍检测到加载遮罩。",
        )
        if not await page_export.is_enabled():
            raise AutomationError("页面数据已显示，但“导出”按钮当前不可用。")

        if created_range:
            await self._apply_created_range(page, created_range, progress)
        else:
            # Never let a scheduled delta range leak into a manual full export.
            await self._reset_order_filters(page)
        before_tasks = await self.task_center.snapshot(page)
        await progress(
            "task_snapshot",
            f"已记录导出前任务中心列表（{len(before_tasks)} 条），用于识别本次新任务。",
        )

        await progress("opening_dialog", "正在打开导出窗口。")
        await page_export.click(timeout=timeouts.action)
        dialog = page.locator(selectors.export_dialog)
        await dialog.wait_for(state="visible", timeout=timeouts.dialog)

        selected_template = await self._ensure_template(dialog, page)
        selected_fields = await self._wait_for_required_template_fields(dialog)
        await progress(
            "template_verified",
            f"已确认导出模板：{selected_template}（{len(selected_fields)} 个字段，关键字段齐全）",
        )

        final_export = dialog.locator(selectors.final_export_button).filter(has_text="导出")
        if await final_export.count() != 1:
            raise AutomationError("弹窗中的最终“导出”按钮不唯一，已停止操作。")
        if not await final_export.is_enabled():
            raise AutomationError("弹窗中的最终“导出”按钮不可用，已停止操作。")

        # This is the only irreversible/production-impacting click in the workflow.
        await progress("submitting", "模板校验完成，正在提交正式导出。")
        if created_range:
            await progress("export_checkpoint", json.dumps({"submitted": True}))
        await final_export.click(timeout=timeouts.action)
        submission_message = await self._read_result_message(page)
        await progress("waiting_export_task", "正在任务中心等待本次导出任务出现。")
        task = await self.task_center.wait_until_downloadable(
            page,
            {item.key for item in before_tasks},
            progress,
            **({"checkpoint": True} if created_range else {}),
        )
        return submission_message, selected_template, task

    async def _reset_order_filters(self, page: Page) -> None:
        # Fresh navigation normally opens 待处理. Reset removes persisted ad-hoc
        # customer/SKU searches, never inherits a previous production search.
        await page.get_by_role("button", name="重置", exact=True).click(timeout=self.config.timeouts_ms.action)
        await wait_for_loading(page, self.config.selectors.loading_mask, self.config.timeouts_ms.navigation, "重置筛选超时。")
        pending = page.get_by_role("tab", name=re.compile(r"^待处理(?:\s|\(|$)"))
        await pending.click(timeout=self.config.timeouts_ms.action)
        await wait_for_loading(page, self.config.selectors.loading_mask, self.config.timeouts_ms.navigation, "待处理列表加载超时。")

    async def _apply_created_range(self, page: Page, bounds: dict[str, str], progress: ProgressCallback) -> None:
        """Observed WMS date-range UI: Enter commits; blur alone can revert edits."""
        start, end = bounds["start"], bounds["end"]
        if datetime.fromisoformat(start) > datetime.fromisoformat(end):
            raise AutomationError("创建时间范围无效。")
        await self._reset_order_filters(page)
        field = page.locator('.date-picker .search-time-field input.el-input__inner:visible')
        if await field.count() != 1:
            raise AutomationError("创建时间筛选控件不唯一，未提交导出。")
        if await field.input_value() != "创建时间":
            await field.click()
            await page.locator('.el-select-dropdown:visible .el-select-dropdown__item').filter(has_text=re.compile(r'^\s*创建时间\s*$')).click()
        first = page.locator('.date-picker input.el-range-input[placeholder="开始日期"]:visible')
        last = page.locator('.date-picker input.el-range-input[placeholder="结束日期"]:visible')
        await first.fill(start)
        await last.fill(end)
        await last.press("Enter")
        await wait_for_loading(page, self.config.selectors.loading_mask, self.config.timeouts_ms.navigation, "时间筛选加载超时。")
        await page.wait_for_function("""([start,end]) => {
            const a=document.querySelector('.date-picker input.el-range-input[placeholder="开始日期"]');
            const b=document.querySelector('.date-picker input.el-range-input[placeholder="结束日期"]');
            return a && b && !a.disabled && !b.disabled && a.value===start && b.value===end;
        }""", arg=[start, end], timeout=self.config.timeouts_ms.action)
        if await field.input_value() != "创建时间" or await first.input_value() != start or await last.input_value() != end:
            raise AutomationError("WMS 改写了创建时间筛选范围，已停止导出。")
        await progress("created_range_verified", f"已确认待处理订单创建时间：{start} 至 {end}（WMS 页面时区）。")

    # 核对模板选中状态，不能看到导出弹窗就提交默认模板。
    async def _ensure_template(self, dialog: Locator, page: Page) -> str:
        cfg = self.config
        selectors = cfg.selectors
        timeouts = cfg.timeouts_ms
        template_input = dialog.locator(selectors.template_input)
        if await template_input.count() != 1:
            raise AutomationError("无法唯一定位导出模板选择框。")

        # Element UI fills the saved template asynchronously after the dialog is visible.
        # Give that model value a short grace period so we do not open a dropdown while
        # the component is still re-rendering (the cause of the original flaky click).
        current = await wait_for_input_value(
            template_input,
            cfg.template_name,
            min(5000, timeouts.action),
        )
        if current != cfg.template_name:
            try:
                await template_input.click(timeout=timeouts.action)
                dropdown = page.locator(selectors.template_dropdown)
                await dropdown.wait_for(state="visible", timeout=timeouts.dialog)
                option = page.locator(selectors.template_option).filter(
                    has_text=cfg.template_name
                )
                if await option.count() != 1:
                    raise AutomationError(f"找不到唯一的“{cfg.template_name}”模板选项。")
                option_text = (await option.inner_text()).strip()
                if option_text != cfg.template_name:
                    raise AutomationError(
                        f"模板选项文本不匹配：期望“{cfg.template_name}”，实际为“{option_text}”。"
                    )

                # Clicking the animated <li> is flaky because Element UI replaces it
                # during transition. The focused select's keyboard contract is stable.
                await template_input.press("ArrowDown", timeout=timeouts.action)
                await template_input.press("Enter", timeout=timeouts.action)
            except PlaywrightTimeoutError as exc:
                current = (await template_input.input_value()).strip()
                if current != cfg.template_name:
                    raise AutomationError(f"模板选择控件响应超时，未能确认“{cfg.template_name}”。") from exc

            current = await wait_for_input_value(
                template_input,
                cfg.template_name,
                timeouts.action,
            )

        if current != cfg.template_name:
            raise AutomationError(
                f"模板校验失败：期望“{cfg.template_name}”，实际为“{current or '空'}”。"
            )
        return current

    async def _wait_for_required_template_fields(self, dialog: Locator) -> list[str]:
        """Wait until the selected template's asynchronously loaded fields are stable."""
        cfg = self.config
        loop = asyncio.get_running_loop()
        deadline = loop.time() + cfg.timeouts_ms.action / 1000
        previous: tuple[str, ...] | None = None
        stable_reads = 0
        fields: list[str] = []

        while loop.time() < deadline:
            fields = await self._read_selected_template_fields(dialog)
            current = tuple(fields)
            has_required = all(
                any(required in field for field in fields)
                for required in cfg.required_template_fields
            )
            has_minimum = len(fields) >= cfg.minimum_template_fields

            if has_required and has_minimum:
                stable_reads = stable_reads + 1 if current == previous else 1
                if stable_reads >= 2:
                    return fields
            else:
                stable_reads = 0

            previous = current
            await asyncio.sleep(0.1)

        missing = [
            required
            for required in cfg.required_template_fields
            if not any(required in field for field in fields)
        ]
        missing_text = "、".join(missing) or "无"
        raise AutomationError(
            f"{cfg.template_name}模板字段未加载完整，已停止导出："
            f"当前 {len(fields)} 个字段（至少需要 {cfg.minimum_template_fields} 个），"
            f"缺少关键字段：{missing_text}。"
        )

    @staticmethod
    # 读取已选字段而非所有可选字段，供模板完整性校验使用。
    async def _read_selected_template_fields(dialog: Locator) -> list[str]:
        labels = dialog.locator("label.el-checkbox")
        return await labels.evaluate_all(
            """
            labels => labels
              .filter(label => label.querySelector('input[type="checkbox"]')?.checked)
              .map(label => (label.textContent || '').replace(/\\s+/g, ' ').trim())
              .filter(Boolean)
            """
        )

    async def _read_result_message(self, page: Page) -> str:
        toast = page.locator(self.config.selectors.toast)
        try:
            await toast.wait_for(state="visible", timeout=self.config.timeouts_ms.result)
            text = (await toast.inner_text()).strip()
            return text or "已点击最终“导出”按钮。"
        except PlaywrightTimeoutError:
            return "已点击最终“导出”按钮；页面未返回可读取的提示信息。"
