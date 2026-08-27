from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from playwright.async_api import Page

from app.automation.common import AutomationError, ProgressCallback
from app.core.config import AutomationConfig, Settings


@dataclass(frozen=True, slots=True)
class TaskCenterItem:
    """One export-history entry shown in the WMS task-center popover."""

    filename: str
    created_at: str
    status: str
    icon_class: str
    downloadable: bool

    @property
    def key(self) -> str:
        return f"{self.filename}\x00{self.created_at}"


class ExportTaskCenter:
    """Read, identify and download files from the WMS export task center."""

    def __init__(self, settings: Settings, config: AutomationConfig) -> None:
        self.settings = settings
        self.config = config

    async def snapshot(self, page: Page) -> list[TaskCenterItem]:
        """Capture the pre-export history used to distinguish the new task."""
        await self._open(page)
        try:
            return await self._read_items(page)
        finally:
            await self._close(page)

    async def wait_until_downloadable(
        self,
        page: Page,
        before_keys: set[str],
        progress: ProgressCallback,
    ) -> TaskCenterItem:
        """Poll until the newly-created parcel export is ready to download."""
        timeouts = self.config.timeouts_ms
        started = time.monotonic()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeouts.task_completion / 1000
        detected_key: str | None = None
        reported_status: str | None = None

        while loop.time() < deadline:
            await self._open(page)
            tasks = await self._read_items(page)
            candidate = self._select_export_task(tasks, before_keys, detected_key)

            if candidate:
                if detected_key is None:
                    await progress(
                        "task_detected",
                        f"已识别本次导出任务：{candidate.filename}",
                    )
                detected_key = candidate.key
                failure_signal = f"{candidate.status} {candidate.icon_class}".lower()
                if any(token in failure_signal for token in ("失败", "error", "fail")):
                    await self._close(page)
                    raise AutomationError(
                        f"导出任务失败：{candidate.filename}（{candidate.status}）"
                    )
                if candidate.downloadable:
                    await progress(
                        "task_ready",
                        f"本次导出任务已可下载（在任务中心等待了 {time.monotonic() - started:.1f} 秒）。",
                    )
                    return candidate
                if candidate.status != reported_status:
                    reported_status = candidate.status
                    await progress(
                        "waiting_export_file",
                        f"任务仍在导出：{candidate.filename}（{candidate.status or '处理中'}）",
                    )

            await self._close(page)
            await asyncio.sleep(timeouts.task_poll_interval / 1000)

        if await page.locator(self.config.selectors.task_center_popover).is_visible():
            await self._close(page)
        raise AutomationError("等待导出文件完成超时，未下载任何历史文件。")

    async def download(self, page: Page, task: TaskCenterItem) -> Path:
        """Download exactly the task selected by the before/after comparison."""
        selectors = self.config.selectors
        await self._open(page)
        rows = page.locator(selectors.task_center_item).filter(has_text=task.filename)
        if await rows.count() != 1:
            await self._close(page)
            raise AutomationError(f"无法唯一定位刚完成的导出任务：{task.filename}")

        button = rows.locator(selectors.task_center_download_button).filter(has_text="下载")
        if await button.count() != 1 or not await button.is_enabled():
            await self._close(page)
            raise AutomationError(f"导出任务已出现，但下载按钮不可用：{task.filename}")

        try:
            async with page.expect_download(
                timeout=self.config.timeouts_ms.download
            ) as info:
                await button.click(timeout=self.config.timeouts_ms.action)
            download_obj = await info.value
            target = self._unique_download_path(
                download_obj.suggested_filename or task.filename
            )
            await download_obj.save_as(target)
        except OSError as exc:
            raise AutomationError(
                f"导出文件保存失败：{task.filename}（{exc}）"
            ) from exc
        except Exception as exc:
            raise AutomationError(
                f"下载文件失败：{task.filename}（{exc}）"
            ) from exc
        await self._close(page)
        return target

    async def _open(self, page: Page) -> None:
        selectors = self.config.selectors
        timeout = self.config.timeouts_ms.action
        popover = page.locator(selectors.task_center_popover)
        if await popover.is_visible():
            return

        trigger = page.locator(selectors.task_center_trigger)
        if await trigger.count() != 1:
            raise AutomationError("无法唯一定位网页右上角的“任务中心”按钮。")
        await trigger.click(timeout=timeout)
        await popover.wait_for(state="visible", timeout=timeout)

    async def _close(self, page: Page) -> None:
        selectors = self.config.selectors
        timeout = self.config.timeouts_ms.action
        popover = page.locator(selectors.task_center_popover)
        if not await popover.is_visible():
            return

        trigger = page.locator(selectors.task_center_trigger)
        if await trigger.count() != 1:
            raise AutomationError("任务中心已打开，但无法定位其关闭按钮。")
        await trigger.click(timeout=timeout)
        await popover.wait_for(state="hidden", timeout=timeout)

    async def _read_items(self, page: Page) -> list[TaskCenterItem]:
        selectors = self.config.selectors
        popover = page.locator(selectors.task_center_popover)
        await popover.locator(".el-loading-mask:visible").wait_for(
            state="hidden",
            timeout=self.config.timeouts_ms.action,
        )

        rows = page.locator(selectors.task_center_item)
        # Require repeated identical reads so an in-flight render is not treated as empty.
        previous: list[dict[str, object]] | None = None
        raw: list[dict[str, object]] = []
        for attempt in range(5):
            raw = await rows.evaluate_all(
                """
                rows => rows.map(row => {
                  const button = row.querySelector('.status-btn .right button');
                  return {
                    filename: (row.querySelector('.desc')?.textContent || '').trim(),
                    created_at: (row.querySelector('.time')?.textContent || '').trim(),
                    status: (row.querySelector('.status-btn .left')?.textContent || '').trim(),
                    icon_class: row.querySelector('.status-btn .left i')?.className || '',
                    downloadable: Boolean(button && !button.disabled)
                  };
                })
                """
            )
            if previous == raw and attempt >= 2:
                break
            previous = raw
            await asyncio.sleep(0.25)

        return [
            TaskCenterItem(
                filename=str(item.get("filename", "")),
                created_at=str(item.get("created_at", "")),
                status=str(item.get("status", "")),
                icon_class=str(item.get("icon_class", "")),
                downloadable=bool(item.get("downloadable", False)),
            )
            for item in raw
            if item.get("filename")
        ]

    def _select_export_task(
        self,
        tasks: list[TaskCenterItem],
        before_keys: set[str],
        detected_key: str | None = None,
    ) -> TaskCenterItem | None:
        if detected_key:
            return next((item for item in tasks if item.key == detected_key), None)
        return next(
            (
                item
                for item in tasks
                if item.key not in before_keys
                and item.filename.startswith(self.config.task_filename_prefix)
            ),
            None,
        )

    def _unique_download_path(self, filename: str) -> Path:
        return self._unique_path(self.settings.downloads_dir, filename)

    @staticmethod
    def _unique_path(directory: Path, filename: str) -> Path:
        directory.mkdir(parents=True, exist_ok=True)
        basename = Path(filename).name
        basename = re.sub(r"[^\w.()\-\u4e00-\u9fff]", "_", basename)
        if not basename:
            basename = f"wms-export-{datetime.now().strftime('%Y%m%d-%H%M%S')}.xlsx"

        target = directory / basename
        if not target.exists():
            return target
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        target = target.with_name(f"{target.stem}-{stamp}{target.suffix}")
        counter = 1
        while target.exists():
            target = target.with_name(f"{target.stem}-{stamp}-{counter}{target.suffix}")
            counter += 1
        return target
