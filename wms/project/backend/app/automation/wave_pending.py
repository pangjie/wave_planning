from __future__ import annotations

import asyncio
from dataclasses import dataclass

from playwright.async_api import Locator, Page, TimeoutError as PlaywrightTimeoutError

from app.automation.common import (
    AutomationError,
    ProgressCallback,
    WAVE_NO_PATTERN,
    wait_for_loading,
)
from app.core.config import AutomationConfig


class WaveNotFoundError(AutomationError):
    """The requested wave is absent from the configured list tab."""


@dataclass(frozen=True, slots=True)
class PendingWave:
    """The stable wave identifier captured before batch processing starts."""

    wave_no: str


class PendingWaveCatalog:
    """Navigate the paginated pending-wave list without submitting any pick action."""

    def __init__(self, config: AutomationConfig) -> None:
        self.config = config

    async def snapshot(
        self,
        page: Page,
        progress: ProgressCallback,
    ) -> list[PendingWave]:
        """Capture and deduplicate all pending waves across every current page."""
        rows = await self._open_page(page, progress, "候选波次")
        waves = await self._read_all_pages(page, rows)
        if not waves:
            raise AutomationError("待拣货列表为空，当前没有可处理的波次。")
        await progress(
            "waves_selected",
            f"已遍历全部分页并锁定 {len(waves)} 个不同待拣货波次。",
        )
        return waves

    async def prepare_page(
        self,
        page: Page,
        wave: PendingWave,
        progress: ProgressCallback,
        slot: int,
        concurrency: int,
    ) -> None:
        """Open a worker page and position it on the requested wave row."""
        await self.locate_wave(
            page,
            wave.wave_no,
            progress,
            label=f"并发页面 {slot}/{concurrency}",
        )

    async def locate_wave(
        self,
        page: Page,
        wave_no: str,
        progress: ProgressCallback,
        *,
        label: str,
        tab_text: str | None = None,
    ) -> Locator:
        """Open one wave-list tab and return every table clone for one exact wave."""
        rows = await self._open_page(page, progress, label, tab_text=tab_text)
        if not await self._find_across_pages(page, rows, wave_no):
            target_tab = tab_text or self.config.wave_picking.pending_tab_text
            raise WaveNotFoundError(
                f"波次 {wave_no} 不在“{target_tab}”列表中，未执行该页面。"
            )
        return page.locator(
            f'{self.config.wave_picking.selectors.wave_rows}[rowid="{wave_no}"]'
        )

    async def find_remaining(
        self,
        page: Page,
        initial_waves: list[PendingWave],
        progress: ProgressCallback,
    ) -> list[PendingWave]:
        """Compare the complete current list with the task's initial snapshot once."""
        rows = await self._open_page(
            page,
            progress,
            "任务结束统一检查",
            allow_empty=True,
        )
        current_waves = await self._read_all_pages(page, rows)
        current_wave_nos = {wave.wave_no for wave in current_waves}
        remaining = [
            wave for wave in initial_waves if wave.wave_no in current_wave_nos
        ]
        await progress(
            "final_pending_snapshot",
            f"统一检查已读取当前全部 {len(current_waves)} 个待拣货波次；"
            f"任务启动快照中仍有 {len(remaining)} 个波次在列表内。",
        )
        return remaining

    async def _open_page(
        self,
        page: Page,
        progress: ProgressCallback,
        label: str,
        *,
        allow_empty: bool = False,
        tab_text: str | None = None,
    ) -> Locator:
        cfg = self.config.wave_picking
        selectors = cfg.selectors
        timeouts = cfg.timeouts_ms

        await progress("navigating", f"{label}：正在打开 {cfg.target_url}")
        await page.goto(
            cfg.target_url,
            wait_until="domcontentloaded",
            timeout=timeouts.navigation,
        )

        target_tab_text = tab_text or cfg.pending_tab_text
        pending_tab = page.locator(selectors.pending_tabs).filter(has_text=target_tab_text)
        try:
            await pending_tab.wait_for(state="visible", timeout=12000)
        except PlaywrightTimeoutError:
            await progress(
                "waiting_login",
                "尚未检测到波次页面。请在自动打开的浏览器中登录，登录后保持窗口开启。",
            )
            try:
                await pending_tab.wait_for(state="visible", timeout=timeouts.login)
            except PlaywrightTimeoutError as exc:
                raise AutomationError(
                    f"等待登录超时，未找到“{target_tab_text}”子页签。"
                ) from exc

        if await pending_tab.count() != 1:
            raise AutomationError(
                f"无法唯一定位“{target_tab_text}”子页签，已停止操作。"
            )
        if await pending_tab.get_attribute("aria-selected") != "true":
            await pending_tab.click(timeout=timeouts.action)
            await self._wait_for_selected_tab(pending_tab, target_tab_text)
            # Element UI changes aria-selected before the table request starts.
            # Give the loading mask one event-loop turn to appear so the next
            # hidden-state wait cannot accidentally accept the previous tab's rows.
            await asyncio.sleep(0.25)

        await progress(
            "waiting_pending_waves",
            f"{label}：正在等待“{target_tab_text}”波次列表加载完成。",
        )
        await wait_for_loading(
            page,
            self.config.wave_picking.selectors.loading_mask,
            self.config.wave_picking.timeouts_ms.navigation,
            "波次页面加载超时，仍检测到处理遮罩。",
        )
        rows = page.locator(selectors.wave_rows)
        if allow_empty:
            return rows
        try:
            await rows.first.wait_for(state="visible", timeout=timeouts.navigation)
        except PlaywrightTimeoutError as exc:
            raise AutomationError("待拣货列表为空，当前没有可处理的波次。") from exc
        return rows

    async def _wait_for_selected_tab(self, tab: Locator, tab_text: str) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.config.wave_picking.timeouts_ms.action / 1000
        while loop.time() < deadline:
            if await tab.get_attribute("aria-selected") == "true":
                return
            await asyncio.sleep(0.05)
        raise AutomationError(f"切换到“{tab_text}”子页签超时，已停止操作。")

    async def _read_all_pages(
        self,
        page: Page,
        rows: Locator,
    ) -> list[PendingWave]:
        waves: list[PendingWave] = []
        seen: set[str] = set()
        visited_pages = 0

        while True:
            visited_pages += 1
            if visited_pages > 1000:
                raise AutomationError("待拣货分页超过安全上限 1000 页，已停止操作。")
            for wave in await self._read_waves(rows):
                if wave.wave_no in seen:
                    continue
                seen.add(wave.wave_no)
                waves.append(wave)
            if not await self._advance_page(page):
                return waves

    async def _find_across_pages(
        self,
        page: Page,
        rows: Locator,
        wave_no: str,
    ) -> bool:
        if not WAVE_NO_PATTERN.fullmatch(wave_no):
            raise AutomationError(f"波次号格式异常，已停止操作：{wave_no}")
        visited_pages = 0
        selected_row = page.locator(
            f'{self.config.wave_picking.selectors.wave_rows}[rowid="{wave_no}"]'
        )
        while True:
            visited_pages += 1
            if visited_pages > 1000:
                raise AutomationError("查找波次时分页超过安全上限 1000 页，已停止操作。")
            if await selected_row.count() > 0:
                return True
            if not await self._advance_page(page):
                return False
            await rows.first.wait_for(
                state="visible",
                timeout=self.config.wave_picking.timeouts_ms.navigation,
            )

    async def _advance_page(self, page: Page) -> bool:
        cfg = self.config.wave_picking
        selectors = cfg.selectors
        next_button = page.locator(selectors.pager_next_button)
        active_page = page.locator(selectors.pager_active_page)
        next_count = await next_button.count()
        active_count = await active_page.count()
        if next_count == 0 and active_count == 0:
            return False
        if next_count != 1 or active_count != 1:
            raise AutomationError("无法唯一定位待拣货分页控件，已停止操作。")
        if await next_button.is_disabled():
            return False

        previous_page = (await active_page.inner_text()).strip()
        await next_button.click(timeout=cfg.timeouts_ms.action)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + cfg.timeouts_ms.navigation / 1000
        while loop.time() < deadline:
            if (await active_page.inner_text()).strip() != previous_page:
                await wait_for_loading(
                    page,
                    self.config.wave_picking.selectors.loading_mask,
                    self.config.wave_picking.timeouts_ms.navigation,
                    "波次页面加载超时，仍检测到处理遮罩。",
                )
                await page.locator(selectors.wave_rows).first.wait_for(
                    state="visible",
                    timeout=cfg.timeouts_ms.navigation,
                )
                return True
            await asyncio.sleep(0.1)
        raise AutomationError("待拣货分页切换超时，已停止操作。")

    @staticmethod
    async def _read_waves(rows: Locator) -> list[PendingWave]:
        raw = await rows.evaluate_all(
            r"""
            rows => rows.map(row => {
              const cells = Array.from(row.querySelectorAll('td'));
              const text = index => (cells[index]?.textContent || '').replace(/\s+/g, ' ').trim();
              return row.getAttribute('rowid') || text(1);
            })
            """
        )
        waves: list[PendingWave] = []
        seen: set[str] = set()
        for item in raw:
            wave_no = str(item).strip()
            if not wave_no or wave_no in seen:
                continue
            seen.add(wave_no)
            waves.append(PendingWave(wave_no))
        return waves
