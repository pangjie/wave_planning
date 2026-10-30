# 回归范围：页面、上下文、驱动清理失败不覆盖已确认业务结果。
"""Completed operations survive page, context and driver cleanup faults."""

import json
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.automation import common, wms_wave_print
from app.automation import WmsExportAutomation, WmsWaveGenerateAutomation, WmsWavePickAutomation, WmsWavePrintAutomation
from app.automation import WavePickResult, WavePrintResult
from app.automation.export_task_center import TaskCenterItem
from app.services.job_manager import JobManager


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["export", "generate_waves", "pick_waves", "print_waves"])
async def test_confirmed_results_survive_context_and_driver_close(mode, isolated_runtime, monkeypatch):
    cfg = isolated_runtime.load_automation()
    page = MagicMock()
    page.url = "https://example.invalid/"
    page.goto = AsyncMock()
    context = SimpleNamespace(pages=[page], close=AsyncMock(side_effect=RuntimeError("context close failed")))
    chromium = SimpleNamespace(launch_persistent_context=AsyncMock(return_value=context))

    class Driver:
        async def __aenter__(self):
            return SimpleNamespace(chromium=chromium)

        async def __aexit__(self, *_):
            raise RuntimeError("driver stop failed")

    monkeypatch.setattr(common, "async_playwright", Driver)
    export = WmsExportAutomation(isolated_runtime, cfg)
    monkeypatch.setattr('app.automation.wms_export.normalize_order_file', lambda _: 1)
    generate = WmsWaveGenerateAutomation(isolated_runtime, cfg.wave_generation)
    pick = WmsWavePickAutomation(isolated_runtime, cfg)
    printer = WmsWavePrintAutomation(isolated_runtime, cfg)
    now = datetime.now().astimezone().isoformat()
    export._prepare_and_submit = AsyncMock(return_value=(
        "已导出", "渠道拆分", TaskCenterItem("orders.xlsx", now, "完成", "", True),
    ))
    download = isolated_runtime.downloads_dir / "orders.xlsx"
    download.write_bytes(b"confirmed download")
    export.task_center.download = AsyncMock(return_value=download)
    for name in ("_wait_for_page_ready", "_ensure_no_blocking_dialog", "_select_pending_tab", "_set_page_size", "_close_visible_dialogs"):
        monkeypatch.setattr(generate, name, AsyncMock())
    generate._generate_one = AsyncMock(return_value="W001")
    pick._run_all_pending = AsyncMock(return_value=WavePickResult(
        mode="pick_waves", wave_nos=["W001"], failed_wave_nos=[], warnings=[],
        wave_count=1, sku_rows=2, current_url=page.url, message="已拣货", completed_at=now,
    ))
    printer._run_selected = AsyncMock(return_value=WavePrintResult(
        mode="print_waves", wave_nos=["W001"], failed_wave_nos=[], warnings=[],
        printed_files=["W001.pdf"], merged_file="merged.pdf", current_url=page.url,
        message="已打印", completed_at=now,
    ))
    manager = JobManager(export, pick, printer, generate, settings=isolated_runtime)
    job = manager.create(mode, "headless", wave_nos=["W001"], segments=[
        {"channel": "CBT", "seg_name": "单件1", "order_nos": ["OBS1"]},
    ])
    await manager.tasks[job.id]

    assert job.status == "succeeded" and job.error is None
    assert len(job.result["warnings"]) == 2
    assert "context close failed" in job.result["warnings"][0]
    assert "driver stop failed" in job.result["warnings"][1]
    assert job.events[-1].stage == "completed_with_warnings"
    assert len([e for e in job.events if e.stage == "warning"]) == 2
    persisted = json.loads(manager._jobs_file.read_text())[0]
    assert persisted["result"] == job.result
    assert persisted["status"] == "succeeded"
    context.close.assert_awaited_once()
    chromium.launch_persistent_context.assert_awaited_once()
    assert chromium.launch_persistent_context.await_args.kwargs["headless"] is True
    if mode == "export":
        assert job.result["downloaded_file"] == str(download)
        export._prepare_and_submit.assert_awaited_once()
        export.task_center.download.assert_awaited_once()
    elif mode == "generate_waves":
        assert job.result["segments"][0]["wave_no"] == "W001"
        generate._generate_one.assert_awaited_once()
    else:
        assert job.result["wave_nos"] == ["W001"]


@pytest.mark.asyncio
@pytest.mark.parametrize("render_fails", [False, True])
async def test_pdf_render_page_close_cannot_replace_output_or_original_failure(isolated_runtime, monkeypatch, caplog, render_fails):
    automation = WmsWavePrintAutomation(isolated_runtime, isolated_runtime.load_automation())
    automation._capture_print_preview = AsyncMock(return_value={
        "html": "<html>" + "x" * 220 + "</html>", "text": "W001",
        "logicalPageWidth": 816, "logicalPageHeight": 1056, "previewVerified": True,
    })
    monkeypatch.setattr(wms_wave_print, "center_pdf_visible_content", lambda *_: [])
    page = MagicMock()
    render = MagicMock()
    page.context.new_page = AsyncMock(return_value=render)
    render.set_content = AsyncMock()
    render.emulate_media = AsyncMock()
    render.close = AsyncMock(side_effect=RuntimeError("render page close"))

    async def pdf(**kwargs):
        if render_fails:
            raise common.AutomationError("original PDF error")
        Path(kwargs["path"]).write_bytes(b"%PDF-1.7\n" + b"0" * 6000)

    render.pdf = AsyncMock(side_effect=pdf)
    output = isolated_runtime.outputs_dir / "W001.pdf"
    output.write_bytes(b"old file")
    if render_fails:
        with pytest.raises(common.AutomationError, match="original PDF error"):
            await automation._save_pdf(page, "W001", output)
        assert output.read_bytes() == b"old file"
    else:
        await automation._save_pdf(page, "W001", output)
        assert output.read_bytes().startswith(b"%PDF-")
    assert "render page close" in caplog.text
    assert not list(output.parent.glob(".W001.*.pdf"))
    render.close.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("save_fails", [False, True])
async def test_print_popup_close_preserves_pdf_result_or_error(isolated_runtime, monkeypatch, caplog, save_fails):
    automation = WmsWavePrintAutomation(isolated_runtime, isolated_runtime.load_automation())
    control = MagicMock()
    control.url = "https://example.invalid/"
    popup = SimpleNamespace(close=AsyncMock(side_effect=RuntimeError("popup close failed")))
    button = MagicMock()
    button.count = AsyncMock(return_value=1)
    button.is_enabled = AsyncMock(return_value=True)
    button.click = AsyncMock()
    button.wait_for = AsyncMock()
    monkeypatch.setattr(wms_wave_print, "_exact_text_locator", lambda *_: button)
    automation.pending_waves.locate_wave = AsyncMock(return_value=MagicMock())
    automation._confirm_dom_reprint_prompt = AsyncMock(return_value=False)
    automation._wait_for_print_center = AsyncMock(return_value=(popup, MagicMock()))
    automation._select_template = AsyncMock()
    automation._trigger_print_request = AsyncMock()
    automation._save_pdf = AsyncMock(side_effect=common.AutomationError("original save error") if save_fails else None)
    if save_fails:
        with pytest.raises(common.AutomationError, match="original save error"):
            await automation._print_wave(control, AsyncMock(), "W001", 1, 1, isolated_runtime.outputs_dir)
    else:
        assert await automation._print_wave(control, AsyncMock(), "W001", 1, 1, isolated_runtime.outputs_dir) == isolated_runtime.outputs_dir / "W001.pdf"
    assert "popup close failed" in caplog.text
    popup.close.assert_awaited_once()
    automation._trigger_print_request.assert_awaited_once()
