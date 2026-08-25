from __future__ import annotations

import asyncio
import os
import re
import shutil
import tempfile
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from playwright.async_api import (
    BrowserContext,
    Dialog,
    Frame,
    Locator,
    Page,
    TimeoutError as PlaywrightTimeoutError,
)

from app.automation.common import (
    AutomationError,
    ProgressCallback,
    WAVE_NO_PATTERN,
    first_page,
    open_browser_context,
    resolve_headless,
)
from app.automation.pdf_centering import PdfCenteringError, center_pdf_visible_content
from app.automation.wave_pending import PendingWaveCatalog, WaveNotFoundError
from app.core.config import AutomationConfig, Settings


MERGED_FILENAME_PREFIX = "Paper合并"
PDF_CSS_DIMENSIONS = {
    "A4": (793.7, 1122.5),
    "Letter": (816.0, 1056.0),
}

_PRINT_INTERCEPT_SCRIPT = r"""
(() => {
  window.__wmsPrintRequested = false;
  const markPrintRequested = () => {
    window.__wmsPrintRequested = true;
  };
  try {
    Object.defineProperty(window, 'print', {
      configurable: true,
      writable: true,
      value: markPrintRequested,
    });
  } catch (_) {
    window.print = markPrintRequested;
  }
})();
"""


@dataclass(slots=True)
class WavePrintResult:
    mode: Literal["print_waves"]
    wave_nos: list[str]
    failed_wave_nos: list[str]
    warnings: list[str]
    printed_files: list[str]
    merged_file: str
    current_url: str
    message: str
    completed_at: str


class QpdfMerger:
    """Merge already-rendered PDFs without loading their contents into Python."""

    def __init__(self, binary: str | None = None) -> None:
        common_locations = (Path("/opt/homebrew/bin/qpdf"), Path("/usr/local/bin/qpdf"))
        self.binary = binary or shutil.which("qpdf") or next(
            (str(path) for path in common_locations if path.is_file()),
            None,
        )

    def build_command(self, inputs: list[Path], output: Path) -> list[str]:
        if not self.binary:
            raise AutomationError(
                "未找到 qpdf，无法合并波次 PDF。请先安装 qpdf 后重试。"
            )
        return [
            self.binary,
            "--empty",
            "--pages",
            *(str(path) for path in inputs),
            "--",
            str(output),
        ]

    async def merge(self, inputs: list[Path], output: Path) -> None:
        if not inputs:
            raise AutomationError("没有可合并的波次 PDF。")
        for path in inputs:
            _validate_pdf(path, label=f"波次文件 {path.name}")

        output.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{output.stem}.",
            suffix=".pdf",
            dir=output.parent,
        )
        os.close(descriptor)
        temporary = Path(temporary_name)
        temporary.unlink(missing_ok=True)

        try:
            process = await asyncio.create_subprocess_exec(
                *self.build_command(inputs, temporary),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                _, stderr = await asyncio.wait_for(process.communicate(), timeout=120)
            except TimeoutError as exc:
                process.kill()
                await process.communicate()
                raise AutomationError("qpdf 合并超过 120 秒，已停止等待。") from exc
            if process.returncode != 0:
                detail = stderr.decode("utf-8", errors="replace").strip()
                raise AutomationError(f"qpdf 合并失败：{detail or '未知错误'}")
            _validate_pdf(temporary, label="合并文件")
            os.replace(temporary, output)
        finally:
            temporary.unlink(missing_ok=True)


class WmsWavePrintAutomation:
    """Print explicitly supplied pending waves and merge their PDFs in input order."""

    def __init__(
        self,
        settings: Settings,
        config: AutomationConfig,
        merger: QpdfMerger | None = None,
    ) -> None:
        self.settings = settings
        self.config = config
        self.pending_waves = PendingWaveCatalog(config)
        self.merger = merger or QpdfMerger()

    async def run(
        self,
        progress: ProgressCallback,
        *,
        wave_nos: list[str],
        headless: bool | None = None,
    ) -> WavePrintResult:
        selected = self._validate_request(wave_nos)
        effective_headless = resolve_headless(self.settings, headless)
        browser_label = "无头" if effective_headless else "有头"
        merged_output_name = _dated_merge_filename()
        await progress(
            "launching",
            f"正在以{browser_label}模式启动专用浏览器；将按输入顺序打印 "
            f"{len(selected)} 个波次，并合并为 {merged_output_name}。",
        )

        async with open_browser_context(
            self.settings,
            headless=effective_headless,
        ) as context:
            return await self._run_selected(
                context,
                progress,
                selected,
                merged_output_name,
            )

    def _validate_request(
        self,
        wave_nos: list[str],
    ) -> list[str]:
        printing = self.config.wave_printing
        selected: list[str] = []
        seen: set[str] = set()
        for raw in wave_nos:
            wave_no = raw.strip()
            if not wave_no or wave_no in seen:
                continue
            if not WAVE_NO_PATTERN.fullmatch(wave_no):
                raise AutomationError(f"波次号格式异常：{wave_no}")
            seen.add(wave_no)
            selected.append(wave_no)
        if not selected:
            raise AutomationError("请至少输入一个波次号。")
        if len(selected) > printing.max_selected_waves:
            raise AutomationError(
                f"一次最多打印 {printing.max_selected_waves} 个不同波次。"
            )
        return selected

    async def _run_selected(
        self,
        context: BrowserContext,
        progress: ProgressCallback,
        wave_nos: list[str],
        merged_output_name: str,
    ) -> WavePrintResult:
        # WMS may capture window.print while its own scripts initialize. Install
        # the interceptor before opening print-center pages, then verify it again
        # immediately before clicking Print in _trigger_print_request().
        await context.add_init_script(script=_PRINT_INTERCEPT_SCRIPT)
        control_page = await first_page(context)
        output_dir = self.settings.outputs_dir  # 打印 PDF 保存在项目内部 outputs/
        output_dir.mkdir(parents=True, exist_ok=True)
        printed_files: list[Path] = []
        printed_wave_nos: list[str] = []
        failed_wave_nos: list[str] = []
        warnings: list[str] = []

        for index, wave_no in enumerate(wave_nos, start=1):
            await progress(
                "locating_wave",
                f"第 {index}/{len(wave_nos)} 个：正在“{self.config.wave_printing.wave_tab_text}”"
                f"列表中查找波次 {wave_no}。",
            )
            try:
                printed_file = await self._print_wave(
                    context,
                    control_page,
                    progress,
                    wave_no,
                    index,
                    len(wave_nos),
                    output_dir,
                )
            except WaveNotFoundError as exc:
                failed_wave_nos.append(wave_no)
                warnings.append(str(exc))
                await progress(
                    "wave_not_found",
                    f"波次 {wave_no} 在当前“{self.config.wave_printing.wave_tab_text}”"
                    "列表中不可见，已跳过并继续下一个指定波次。",
                )
                continue
            printed_files.append(printed_file)
            printed_wave_nos.append(wave_no)
            await progress(
                "wave_pdf_saved",
                f"第 {index}/{len(wave_nos)} 个：波次 {wave_no} 已保存为 {printed_file.name}。",
            )

        if not printed_files:
            raise AutomationError(
                "输入的波次均未在当前列表中找到，没有生成或合并任何 PDF。"
            )

        merged_file = output_dir / merged_output_name
        await progress(
            "merging_pdfs",
            f"全部 {len(printed_files)} 个波次 PDF 已生成，正在按输入顺序合并。",
        )
        await self.merger.merge(printed_files, merged_file)
        await progress(
            "merged_pdf_saved",
            f"合并完成：{merged_file}",
        )
        return WavePrintResult(
            mode="print_waves",
            wave_nos=printed_wave_nos,
            failed_wave_nos=failed_wave_nos,
            warnings=warnings,
            printed_files=[str(path) for path in printed_files],
            merged_file=str(merged_file),
            current_url=control_page.url,
            message=(
                f"已保存 {len(printed_files)}/{len(wave_nos)} 个波次的"
                f"“一件代发汇总拣货单”，并合并为 {merged_file.name}。"
                + (
                    " 未找到：" + "、".join(failed_wave_nos)
                    if failed_wave_nos
                    else ""
                )
            ),
            completed_at=datetime.now().astimezone().isoformat(),
        )

    async def _print_wave(
        self,
        context: BrowserContext,
        control_page: Page,
        progress: ProgressCallback,
        wave_no: str,
        sequence: int,
        total: int,
        output_dir: Path,
    ) -> Path:
        selected_rows = await self.pending_waves.locate_wave(
            control_page,
            wave_no,
            progress,
            label=f"打印波次 {sequence}/{total}",
            tab_text=self.config.wave_printing.wave_tab_text,
        )
        selectors = self.config.wave_printing.selectors
        timeout = self.config.wave_printing.timeouts_ms.action

        more_button = _exact_text_locator(
            selected_rows.locator(selectors.more_button),
            "更多",
        )
        if await more_button.count() != 1 or not await more_button.is_enabled():
            raise AutomationError(f"波次 {wave_no} 的“更多”按钮无法唯一定位或不可用。")
        await more_button.click(timeout=timeout)

        menu_item = _exact_text_locator(
            control_page.locator(selectors.print_summary_item),
            "打印汇总拣货单",
        )
        try:
            await menu_item.wait_for(state="visible", timeout=timeout)
        except PlaywrightTimeoutError as exc:
            raise AutomationError(
                f"波次 {wave_no} 的“更多”菜单中未出现“打印汇总拣货单”。"
            ) from exc
        if await menu_item.count() != 1:
            raise AutomationError(
                f"波次 {wave_no} 出现多个“打印汇总拣货单”选项，已停止操作。"
            )

        await progress(
            "opening_print_center",
            f"第 {sequence}/{total} 个：正在打开波次 {wave_no} 的打印中心。",
        )
        baseline_pages = set(context.pages)
        observed_pages: list[Page] = []
        request_diagnostics: list[dict[str, object]] = []

        def remember_page(page: Page) -> None:
            observed_pages.append(page)

        def remember_response(response) -> None:
            parts = urlsplit(response.url)
            if parts.hostname == "wms.xlwms.com" and len(request_diagnostics) < 30:
                request_diagnostics.append(
                    {
                        "kind": "response",
                        "status": response.status,
                        "method": response.request.method,
                        "path": parts.path,
                        "resourceType": response.request.resource_type,
                    }
                )

        def remember_request_failure(request) -> None:
            parts = urlsplit(request.url)
            if parts.hostname == "wms.xlwms.com" and len(request_diagnostics) < 30:
                request_diagnostics.append(
                    {
                        "kind": "requestFailed",
                        "method": request.method,
                        "path": parts.path,
                        "resourceType": request.resource_type,
                        "failure": request.failure,
                    }
                )

        context.on("page", remember_page)
        control_page.on("response", remember_response)
        control_page.on("requestfailed", remember_request_failure)
        native_dialogs: list[tuple[str, bool]] = []

        async def handle_native_dialog(dialog: Dialog) -> None:
            accepted = _is_reprint_prompt(dialog.message, wave_no)
            native_dialogs.append((dialog.message, accepted))
            if accepted:
                await dialog.accept()
            else:
                await dialog.dismiss()

        control_page.on("dialog", handle_native_dialog)
        previous_url = control_page.url
        try:
            await menu_item.click(timeout=timeout)
            await asyncio.sleep(0.1)
            unexpected_dialogs = [
                message for message, accepted in native_dialogs if not accepted
            ]
            if unexpected_dialogs:
                raise AutomationError(
                    "打开打印中心时出现了非预期浏览器提示，已取消该提示并停止操作："
                    + "；".join(unexpected_dialogs)
                )
            reprint_confirmed = any(accepted for _, accepted in native_dialogs)
            if not reprint_confirmed:
                reprint_confirmed = await self._confirm_dom_reprint_prompt(
                    control_page,
                    wave_no,
                )
            if reprint_confirmed:
                await progress(
                    "reprint_confirmed",
                    f"波次 {wave_no} 已打印过拣货单；已按指引确认再次打印。",
                )
            print_page, print_surface = await self._wait_for_print_center(
                context,
                control_page,
                baseline_pages,
                observed_pages,
                previous_url,
                request_diagnostics,
            )
        finally:
            context.remove_listener("page", remember_page)
            control_page.remove_listener("response", remember_response)
            control_page.remove_listener("requestfailed", remember_request_failure)
            control_page.remove_listener("dialog", handle_native_dialog)

        try:
            template_input = await self._select_template(
                print_surface,
                progress,
                wave_no,
            )
            await self._trigger_print_request(
                print_page,
                print_surface,
                template_input,
                progress,
                wave_no,
            )
            output = output_dir / f"{wave_no}.pdf"
            await self._save_pdf(print_page, wave_no, output)
            return output
        finally:
            if print_page is not control_page and not print_page.is_closed():
                await print_page.close()

    async def _confirm_dom_reprint_prompt(self, page: Page, wave_no: str) -> bool:
        selectors = self.config.wave_printing.selectors
        dialogs = page.locator(selectors.reprint_dialog)
        try:
            await dialogs.first.wait_for(state="visible", timeout=1200)
        except PlaywrightTimeoutError:
            return False

        matching: list[Locator] = []
        unexpected_reprint_prompts: list[str] = []
        for index in range(await dialogs.count()):
            dialog = dialogs.nth(index)
            if not await dialog.is_visible():
                continue
            message = (await dialog.inner_text()).strip()
            if _is_reprint_prompt(message, wave_no):
                matching.append(dialog)
            elif "已打印过拣货单" in message:
                unexpected_reprint_prompts.append(message)

        if unexpected_reprint_prompts:
            raise AutomationError(
                "出现了与当前波次不匹配的重复打印提示，已停止操作。"
            )
        if not matching:
            return False
        if len(matching) != 1:
            raise AutomationError("重复打印确认框不唯一，已停止操作。")

        confirm_button = _exact_text_locator(
            matching[0].locator(selectors.reprint_confirm_buttons),
            "确定",
        )
        if await confirm_button.count() != 1 or not await confirm_button.is_enabled():
            raise AutomationError("重复打印确认框的“确定”按钮无法唯一定位或不可用。")
        await confirm_button.click(timeout=self.config.wave_printing.timeouts_ms.action)
        return True

    async def _wait_for_print_center(
        self,
        context: BrowserContext,
        control_page: Page,
        baseline_pages: set[Page],
        observed_pages: list[Page],
        previous_url: str,
        request_diagnostics: list[dict[str, object]],
    ) -> tuple[Page, Page | Frame]:
        cfg = self.config.wave_printing
        loop = asyncio.get_running_loop()
        deadline = loop.time() + cfg.timeouts_ms.print_center / 1000

        while loop.time() < deadline:
            candidates = _print_candidate_pages(
                context,
                control_page,
                baseline_pages,
                observed_pages,
            )
            for candidate in reversed(candidates):
                if candidate.is_closed():
                    continue
                for surface in [candidate, *candidate.frames]:
                    container = surface.locator(
                        cfg.selectors.print_template_container
                    )
                    if await container.count() == 1 and await container.is_visible():
                        await self._wait_for_loading(surface)
                        return candidate, surface
            await asyncio.sleep(0.15)

        current_url = control_page.url
        detail = (
            f"当前页面仍为 {current_url}"
            if current_url == previous_url
            else f"已跳转到 {current_url}，但未找到打印模板控件"
        )
        diagnostics = await self._describe_print_candidates(
            _print_candidate_pages(
                context,
                control_page,
                baseline_pages,
                observed_pages,
            )
        )
        raise AutomationError(
            f"打开打印中心超时：{detail}。受限结构诊断：{diagnostics}；"
            f"点击后请求诊断：{request_diagnostics}"
        )

    @staticmethod
    async def _describe_print_candidates(pages: list[Page]) -> list[dict[str, object]]:
        diagnostics: list[dict[str, object]] = []
        for page in pages:
            if page.is_closed():
                continue
            try:
                frame_details: list[dict[str, object]] = []
                for frame in page.frames:
                    details = await frame.evaluate(
                        r"""
                    () => {
                      const compact = value => (value || '').replace(/\s+/g, ' ').trim();
                      const nodes = Array.from(document.querySelectorAll('body *'));
                      return {
                        url: location.href,
                        title: document.title,
                        templateNodes: nodes
                          .filter(node => compact(node.textContent) === '打印模板')
                          .slice(0, 8)
                          .map(node => ({
                            tag: node.tagName,
                            className: String(node.className || ''),
                            parentClass: String(node.parentElement?.className || ''),
                          })),
                        readonlyInputs: Array.from(document.querySelectorAll('input[readonly]'))
                          .slice(0, 12)
                          .map(input => ({
                            value: input.value,
                            className: input.className,
                            parentText: compact(input.parentElement?.parentElement?.textContent).slice(0, 80),
                          })),
                        printButtons: Array.from(document.querySelectorAll('button'))
                          .filter(button => compact(button.textContent) === '打印')
                          .slice(0, 8)
                          .map(button => ({
                            className: button.className,
                            parentClass: String(button.parentElement?.className || ''),
                          })),
                        relevantMessages: nodes
                          .filter(node => node.children.length === 0)
                          .map(node => ({
                            text: compact(node.textContent),
                            className: String(node.className || ''),
                          }))
                          .filter(item => item.text && /(打印|失败|错误|异常|权限|请选择|error)/i.test(item.text))
                          .slice(0, 20),
                      };
                    }
                    """
                    )
                    frame_details.append(details)
                diagnostics.append(
                    {
                        "closed": False,
                        "pageUrl": page.url,
                        "frames": frame_details,
                    }
                )
            except Exception as exc:
                diagnostics.append({"error": str(exc)})
        return diagnostics

    async def _select_template(
        self,
        page: Page | Frame,
        progress: ProgressCallback,
        wave_no: str,
    ) -> Locator:
        cfg = self.config.wave_printing
        selectors = cfg.selectors
        container = page.locator(selectors.print_template_container)
        if await container.count() != 1:
            raise AutomationError("打印中心的“打印模板”区域不唯一，已停止操作。")
        template_input = container.locator(selectors.print_template_input)
        if await template_input.count() != 1:
            raise AutomationError("无法唯一定位打印模板下拉框，已停止操作。")

        expected = cfg.template_name
        current = (await template_input.input_value()).strip()
        if current != expected:
            await template_input.click(timeout=cfg.timeouts_ms.action)
            dropdown = page.locator(selectors.template_dropdown)
            try:
                await dropdown.wait_for(
                    state="visible",
                    timeout=cfg.timeouts_ms.action,
                )
            except PlaywrightTimeoutError as exc:
                raise AutomationError("点击打印模板后未出现下拉选项。") from exc
            option = _exact_text_locator(
                dropdown.locator(selectors.template_option),
                expected,
            )
            if await option.count() != 1:
                raise AutomationError(
                    f"无法唯一选择打印模板“{expected}”，已停止操作。"
                )
            await option.click(timeout=cfg.timeouts_ms.action)
            current = await self._wait_for_input_value(template_input, expected)
        if current != expected:
            raise AutomationError(
                f"打印模板校验失败：当前为“{current or '空'}”，要求“{expected}”。"
            )
        await progress(
            "print_template_verified",
            f"波次 {wave_no} 已确认打印模板：{expected}。",
        )
        return template_input

    async def _trigger_print_request(
        self,
        page: Page,
        surface: Page | Frame,
        template_input: Locator,
        progress: ProgressCallback,
        wave_no: str,
    ) -> None:
        cfg = self.config.wave_printing
        intercepted_frames = 0
        for frame in page.frames:
            try:
                await frame.evaluate(_PRINT_INTERCEPT_SCRIPT)
                intercepted_frames += 1
            except Exception:
                continue
        if not intercepted_frames:
            raise AutomationError("无法安全拦截浏览器打印请求，未点击“打印”。")

        print_candidates = _exact_text_locator(
            surface.locator(cfg.selectors.print_button),
            "打印",
        )
        print_button = await self._locate_template_print_button(
            template_input,
            print_candidates,
            cfg.timeouts_ms.render,
        )
        await progress(
            "triggering_print",
            f"波次 {wave_no}：模板已确认，正在触发打印。",
        )
        await print_button.click(timeout=cfg.timeouts_ms.action)
        await self._wait_for_loading(surface)

        loop = asyncio.get_running_loop()
        deadline = loop.time() + min(cfg.timeouts_ms.render / 1000, 2)
        while loop.time() < deadline:
            for frame in page.frames:
                try:
                    if await frame.evaluate("Boolean(window.__wmsPrintRequested)"):
                        return
                except Exception:
                    continue
            await asyncio.sleep(0.1)
        raise AutomationError(
            "点击“打印”后未捕获到页面的打印请求，未生成 PDF。"
        )

    @staticmethod
    async def _locate_template_print_button(
        template_input: Locator,
        candidates: Locator,
        timeout_ms: int,
    ) -> Locator:
        candidate_count = await candidates.count()
        if candidate_count == 1:
            candidate = candidates.first
            loop = asyncio.get_running_loop()
            deadline = loop.time() + timeout_ms / 1000
            while loop.time() < deadline:
                if await candidate.is_visible() and await candidate.is_enabled():
                    return candidate
                await asyncio.sleep(0.15)
            raise AutomationError(
                "打印中心唯一的“打印”按钮在等待数据渲染后仍不可用，已停止操作。"
            )

        input_box = await template_input.bounding_box()
        if input_box is None:
            raise AutomationError("无法读取打印模板下拉框的位置，已停止操作。")

        input_right = input_box["x"] + input_box["width"]
        input_center_y = input_box["y"] + input_box["height"] / 2
        vertical_tolerance = max(40, input_box["height"] * 2.5)
        matching_indexes: list[int] = []
        for index in range(candidate_count):
            candidate = candidates.nth(index)
            if not await candidate.is_visible() or not await candidate.is_enabled():
                continue
            box = await candidate.bounding_box()
            if box is None:
                continue
            center_y = box["y"] + box["height"] / 2
            if (
                box["x"] >= input_right
                and abs(center_y - input_center_y) <= vertical_tolerance
            ):
                matching_indexes.append(index)

        if len(matching_indexes) != 1:
            raise AutomationError(
                "无法唯一定位打印模板下拉框右侧的“打印”按钮，已停止操作。"
                f"（页面同名按钮 {candidate_count} 个，同区域候选 "
                f"{len(matching_indexes)} 个）。"
            )
        return candidates.nth(matching_indexes[0])

    async def _save_pdf(
        self,
        page: Page,
        wave_no: str,
        output: Path,
    ) -> None:
        output.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{output.stem}.",
            suffix=".pdf",
            dir=output.parent,
        )
        os.close(descriptor)
        temporary = Path(temporary_name)
        render_page: Page | None = None
        try:
            print_snapshot = await self._capture_print_preview(page)
            snapshot_html = str(print_snapshot.get("html") or "")
            snapshot_text = str(print_snapshot.get("text") or "")
            preview_verified = bool(print_snapshot.get("previewVerified"))
            if len(snapshot_html) < 200 or not preview_verified:
                raise AutomationError(
                    f"未能唯一提取波次 {wave_no} 的打印预览，未生成 PDF。"
                )
            if wave_no not in snapshot_text:
                raise AutomationError(
                    f"打印预览不包含当前波次号 {wave_no}，未生成 PDF。"
                )

            render_page = await page.context.new_page()
            await render_page.set_content(
                snapshot_html,
                wait_until="networkidle",
                timeout=self.config.wave_printing.timeouts_ms.render,
            )
            await render_page.emulate_media(media="print")
            try:
                content_width = float(print_snapshot["logicalPageWidth"])
                content_height = float(print_snapshot["logicalPageHeight"])
            except (KeyError, TypeError, ValueError) as exc:
                raise AutomationError("打印预览缺少有效的逻辑页面尺寸。") from exc
            if content_width <= 0 or content_height <= 0:
                raise AutomationError("打印预览的逻辑页面尺寸无效。")
            scale, pdf_margins = _fit_content_to_paper(
                content_width,
                content_height,
                self.config.wave_printing.pdf_format,
            )
            await render_page.pdf(
                path=str(temporary),
                format=self.config.wave_printing.pdf_format,
                scale=scale,
                print_background=True,
                prefer_css_page_size=False,
                margin=pdf_margins,
            )
            _validate_pdf(
                temporary,
                label=f"波次文件 {output.name}",
                minimum_size=5_000,
            )
            try:
                await asyncio.to_thread(center_pdf_visible_content, temporary)
            except PdfCenteringError as exc:
                raise AutomationError(
                    f"波次 {wave_no} 的 PDF 实际内容居中失败，未保存该文件。"
                ) from exc
            _validate_pdf(
                temporary,
                label=f"居中后的波次文件 {output.name}",
                minimum_size=5_000,
            )
            os.replace(temporary, output)
        except AutomationError:
            raise
        except Exception as exc:
            raise AutomationError(
                "浏览器未能直接生成 PDF。未操作系统打印弹窗；"
                "可改用无头模式重试，或检查打印中心页面结构。"
            ) from exc
        finally:
            if render_page is not None and not render_page.is_closed():
                await render_page.close()
            temporary.unlink(missing_ok=True)

    @staticmethod
    async def _capture_print_preview(page: Page) -> dict[str, object]:
        snapshot = await page.evaluate(
            r"""
            () => {
              const compact = value => (value || '').replace(/\s+/g, ' ').trim();
              const anchorNodes = Array.from(document.querySelectorAll('body *'))
                .filter(node => (
                  node.children.length === 0 &&
                  /Pick List/i.test(compact(node.textContent))
                ));
              const candidates = [];
              for (const anchorNode of anchorNodes) {
                let current = anchorNode;
                while (current && current !== document.body) {
                  const text = compact(current.innerText);
                  const rect = current.getBoundingClientRect();
                  if (
                    /(Pick List|汇总拣货单)/i.test(text) &&
                    /\bSKU\b/i.test(text) &&
                    rect.width >= 400 &&
                    Math.max(current.scrollHeight, rect.height) >= 300
                  ) {
                    candidates.push(current);
                    break;
                  }
                  current = current.parentElement;
                }
              }
              const uniqueCandidates = [...new Set(candidates)];
              if (uniqueCandidates.length !== 1) {
                return {
                  html: '', text: '',
                  logicalPageWidth: 0, logicalPageHeight: 0,
                  previewVerified: false,
                };
              }

              let target = uniqueCandidates[0];
              const logicalPageRect = target.getBoundingClientRect();
              const logicalPageWidth = Math.max(
                target.scrollWidth,
                logicalPageRect.width
              );
              const logicalPageHeight = Math.max(
                target.scrollHeight,
                logicalPageRect.height
              );
              const firstPageMarker = compact(target.innerText).match(/\b1\/(\d+)\b/);
              const totalPages = firstPageMarker ? Number(firstPageMarker[1]) : 1;
              if (totalPages > 1) {
                let current = target.parentElement;
                let multiPageRoot = null;
                while (current && current !== document.body) {
                  const pageMarkers = Array.from(current.querySelectorAll('*'))
                    .filter(node => node.children.length === 0)
                    .map(node => compact(node.textContent))
                    .filter(text => /^\d+\/\d+$/.test(text));
                  const distinctMarkers = new Set(pageMarkers);
                  if (
                    distinctMarkers.size >= totalPages &&
                    distinctMarkers.has(`${totalPages}/${totalPages}`)
                  ) {
                    multiPageRoot = current;
                    break;
                  }
                  current = current.parentElement;
                }
                if (!multiPageRoot) {
                  return {
                    html: '', text: '',
                    logicalPageWidth: 0, logicalPageHeight: 0,
                    previewVerified: false,
                  };
                }
                target = multiPageRoot;
              }
              const clone = target.cloneNode(true);
              const sourceCanvases = Array.from(target.querySelectorAll('canvas'));
              const clonedCanvases = Array.from(clone.querySelectorAll('canvas'));
              sourceCanvases.forEach((canvas, index) => {
                const clonedCanvas = clonedCanvases[index];
                if (!clonedCanvas) return;
                try {
                  const image = document.createElement('img');
                  for (const attribute of canvas.attributes) {
                    image.setAttribute(attribute.name, attribute.value);
                  }
                  image.src = canvas.toDataURL('image/png');
                  image.width = canvas.width;
                  image.height = canvas.height;
                  clonedCanvas.replaceWith(image);
                } catch (_) {}
              });
              clone.setAttribute('data-wms-print-root', 'true');

              const head = document.head.cloneNode(true);
              head.querySelectorAll('script').forEach(script => script.remove());
              const base = document.createElement('base');
              base.href = document.baseURI;
              head.prepend(base);
              const reset = document.createElement('style');
              reset.textContent = `
                html, body {
                  margin: 0 !important;
                  padding: 0 !important;
                  overflow: visible !important;
                  background: #fff !important;
                }
                [data-wms-print-root="true"] {
                  display: block !important;
                  position: static !important;
                  inset: auto !important;
                  margin: 0 !important;
                  width: ${logicalPageWidth}px !important;
                  transform: none !important;
                  max-width: none !important;
                  max-height: none !important;
                  overflow: visible !important;
                  background: #fff !important;
                  box-shadow: none !important;
                }
                [data-wms-print-root="true"] * {
                  box-shadow: none !important;
                }
              `;
              head.appendChild(reset);
              return {
                html: '<!doctype html><html>' + head.outerHTML +
                  '<body>' + clone.outerHTML + '</body></html>',
                text: compact(target.innerText),
                logicalPageWidth,
                logicalPageHeight,
                previewVerified: true,
              };
            }
            """
        )
        if not isinstance(snapshot, dict):
            return {
                "html": "",
                "text": "",
                "logicalPageWidth": 0,
                "logicalPageHeight": 0,
                "previewVerified": False,
            }
        return snapshot

    async def _wait_for_input_value(self, locator: Locator, expected: str) -> str:
        cfg = self.config.wave_printing
        loop = asyncio.get_running_loop()
        deadline = loop.time() + cfg.timeouts_ms.action / 1000
        current = ""
        while loop.time() < deadline:
            current = (await locator.input_value()).strip()
            if current == expected:
                return current
            await asyncio.sleep(0.1)
        return current

    async def _wait_for_loading(self, page: Page | Frame) -> None:
        try:
            await page.locator(
                self.config.wave_printing.selectors.loading_mask
            ).wait_for(
                state="hidden",
                timeout=self.config.wave_printing.timeouts_ms.render,
            )
        except PlaywrightTimeoutError as exc:
            raise AutomationError("打印中心加载超时，仍检测到处理遮罩。") from exc


def _print_candidate_pages(
    context: BrowserContext,
    control_page: Page,
    baseline_pages: set[Page],
    observed_pages: list[Page],
) -> list[Page]:
    """Keep short-lived popup pages in the diagnostic candidate set."""
    candidates: list[Page] = []
    for page in [*context.pages, *observed_pages]:
        if page is not control_page and page in baseline_pages:
            continue
        if page not in candidates:
            candidates.append(page)
    return candidates


def _exact_text_locator(locator: Locator, text: str) -> Locator:
    return locator.filter(has_text=re.compile(rf"^\s*{re.escape(text)}\s*$"))


def _dated_merge_filename(run_date: date | None = None) -> str:
    effective_date = run_date or datetime.now().astimezone().date()
    return f"{MERGED_FILENAME_PREFIX}_{effective_date.isoformat()}.pdf"


def _fit_content_to_paper(
    content_width: float,
    content_height: float,
    paper_format: Literal["A4", "Letter"],
    *,
    safety_ratio: float = 0.95,
) -> tuple[float, dict[str, str]]:
    """Scale one logical page to fit and center it within the selected paper."""
    paper_width, paper_height = PDF_CSS_DIMENSIONS[paper_format]
    fitted_scale = min(
        2.0,
        paper_width / max(content_width, 1),
        paper_height / max(content_height, 1),
    )
    scale = max(0.1, fitted_scale * safety_ratio)
    horizontal_margin = max(0.0, (paper_width - content_width * scale) / 2)
    vertical_margin = max(0.0, (paper_height - content_height * scale) / 2)
    return scale, {
        "top": f"{vertical_margin:.2f}px",
        "right": f"{horizontal_margin:.2f}px",
        "bottom": f"{vertical_margin:.2f}px",
        "left": f"{horizontal_margin:.2f}px",
    }


def _is_reprint_prompt(message: str, wave_no: str) -> bool:
    compact = re.sub(r"\s+", "", message)
    return bool(
        re.search(
            rf"波次号{re.escape(wave_no)}已打印过拣货单[，,]?是否确认打印[？?]?",
            compact,
        )
    )


def _validate_pdf(path: Path, *, label: str, minimum_size: int = 100) -> None:
    if not path.is_file() or path.stat().st_size < minimum_size:
        raise AutomationError(f"{label}不存在或内容为空。")
    with path.open("rb") as handle:
        if handle.read(5) != b"%PDF-":
            raise AutomationError(f"{label}不是有效的 PDF 文件。")
