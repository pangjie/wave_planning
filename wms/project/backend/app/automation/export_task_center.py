from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from playwright.async_api import Page, TimeoutError as PlaywrightTimeoutError

from app.automation.common import (
    AutomationError,
    ProgressCallback,
    first_page,
    wait_for_loading,
)
from app.core.config import AutomationConfig, Settings


class _DownloadInterrupted(Exception):
    """下载传输被 WMS 关页中断；由 download() 捕获后恢复页面重试一次。"""


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

    async def download(
        self, page: Page, task: TaskCenterItem, progress: ProgressCallback
    ) -> Path:
        """Download exactly the task selected by the before/after comparison.

        全程分阶段计时并上报 download_timing 事件，便于定位下载慢的环节。

        已知场景：WMS 点击下载后会自行关闭页面/标签，使挂在页面上的下载传输
        中断（浏览器下载事件已触发但文件停在 .crdownload）。此时自动恢复页面
        并重试一次：重新打开订单页 → 任务中心 → 再次点击下载。
        安全边界：重试只重复“下载”这一幂等动作，绝不重复提交导出。
        """
        t_start = time.monotonic()
        last_error: Exception | None = None
        for attempt in range(2):
            if attempt > 0:
                await progress(
                    "download_retry",
                    "WMS 页面在下载时自行关闭导致下载中断，正在重新打开订单页并再次下载"
                    "（不重复提交导出）。",
                )
                try:
                    page = await first_page(page.context)
                    await page.goto(
                        self.config.target_url,
                        wait_until="domcontentloaded",
                        timeout=self.config.timeouts_ms.navigation,
                    )
                    await wait_for_loading(
                        page,
                        self.config.selectors.loading_mask,
                        self.config.timeouts_ms.navigation,
                        "重试前订单页加载超时。",
                    )
                except Exception as exc:
                    raise AutomationError(f"下载中断且页面恢复失败：{exc}") from exc
            try:
                return await self._try_download(page, task, progress, t_start)
            except _DownloadInterrupted as exc:
                last_error = exc.__cause__ or exc
                continue
        raise AutomationError(
            f"WMS 页面在下载时自行关闭，重试后仍未拿到完整文件 {task.filename}："
            f"{last_error}。请从任务中心手动下载。"
        )

    async def _try_download(
        self,
        page: Page,
        task: TaskCenterItem,
        progress: ProgressCallback,
        t_start: float,
    ) -> Path:
        selectors = self.config.selectors
        await self._open(page)
        rows = page.locator(selectors.task_center_item).filter(has_text=task.filename)
        if await rows.count() != 1:
            await self._close_safe(page)
            raise AutomationError(f"无法唯一定位刚完成的导出任务：{task.filename}")
        t_rows = time.monotonic()

        button = rows.locator(selectors.task_center_download_button).filter(has_text="下载")
        if await button.count() != 1 or not await button.is_enabled():
            await self._close_safe(page)
            raise AutomationError(f"导出任务已出现，但下载按钮不可用：{task.filename}")
        t_button = time.monotonic()

        # 先等下载事件（限时 30 秒）；事件迟迟不来时，直接轮询下载目录接收落盘文件，
        # 避免因浏览器下载事件缺失/延迟导致整段下载卡住数分钟。
        t_click = time.monotonic()
        dir_before = self._snapshot_downloads_dir()
        download_obj = None
        disk_file: Path | None = None
        try:
            async with page.expect_download(
                timeout=min(self.config.timeouts_ms.download, 30000)
            ) as info:
                await button.click(timeout=self.config.timeouts_ms.action)
            download_obj = await info.value
        except PlaywrightTimeoutError:
            disk_file = await self._await_disk_download(t_click, dir_before)
        except Exception as exc:
            # 点击/等待下载事件时页面被 WMS 关闭 → 可恢复，交由上层重试一次
            raise _DownloadInterrupted from exc
        t_event = time.monotonic()

        # 弹层清理是装饰性步骤：页面可能已被 WMS 关闭，失败不得掩盖保存阶段的真实错误
        await self._close_safe(page)

        target: Path
        try:
            if download_obj is not None:
                target = self._unique_download_path(
                    download_obj.suggested_filename or task.filename
                )
                await download_obj.save_as(target)
            else:
                assert disk_file is not None
                await progress(
                    "download_fallback",
                    "未收到浏览器下载事件，已直接从下载目录接收文件。",
                )
                target = self._unique_download_path(disk_file.name)
                if target != disk_file:
                    disk_file.replace(target)
        except OSError as exc:
            raise AutomationError(f"导出文件保存失败：{task.filename}") from exc
        except Exception as exc:
            # 下载传输被页面关闭中断（事件已触发但文件未完成）→ 可恢复，重试一次
            raise _DownloadInterrupted from exc
        t_saved = time.monotonic()
        await progress(
            "download_timing",
            "下载耗时分解：定位任务行 "
            f"{(t_rows - t_start) * 1000:.0f}ms，按钮检查 {(t_button - t_rows) * 1000:.0f}ms，"
            f"点击到收到文件 {(t_event - t_click) * 1000:.0f}ms，"
            f"保存/接收文件 {(t_saved - t_event) * 1000:.0f}ms。",
        )
        return target

    def _snapshot_downloads_dir(self) -> set[Path]:
        dl = self.settings.downloads_dir
        dl.mkdir(parents=True, exist_ok=True)
        return {p for p in dl.iterdir()}

    async def _await_disk_download(self, since: float, before: set[Path]) -> Path:
        """下载事件缺失时的兜底：轮询下载目录，等待点击后落盘的新文件。

        安全约束：
        - 只接受“点击时间之后、且不在点击前快照中”的文件，绝不误取旧文件；
        - 只接受文件名以导出前缀（ParcelOutbound）开头的文件；
        - 跳过 .crdownload 临时文件，并确认大小稳定 1 秒后再接收；
        - 最长等待 task_completion（10 分钟），覆盖 WMS 数分钟的长导出。
        """
        dl = self.settings.downloads_dir
        dl.mkdir(parents=True, exist_ok=True)
        prefix = self.config.task_filename_prefix
        deadline = time.monotonic() + self.config.timeouts_ms.task_completion / 1000
        while time.monotonic() < deadline:
            for p in sorted(
                dl.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True
            ):
                if not p.is_file() or p in before or p.name.endswith(".crdownload"):
                    continue
                if not p.name.startswith(prefix):
                    continue
                if p.stat().st_mtime < since - 1:
                    continue
                size1 = p.stat().st_size
                await asyncio.sleep(1)
                if p.stat().st_size == size1:
                    return p
            await asyncio.sleep(1)
        raise AutomationError("点击下载后既未收到下载事件，也未在下载目录发现新文件。")

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

    async def _close_safe(self, page: Page) -> None:
        """尽力关闭任务中心弹层；页面已被 WMS 自行关闭时静默跳过。"""
        try:
            await self._close(page)
        except Exception:
            pass

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
