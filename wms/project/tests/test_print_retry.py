# 回归范围：模拟 WMS、使用真实临时 PDF 验证检查点复用与有序合并。
"""Real PDF artifacts, mocked WMS pages; no production browser is started."""
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from pypdf import PdfWriter, PdfReader

from app.automation.wms_wave_print import WmsWavePrintAutomation
from app.services.job_manager import JobManager
from test_job_retry import finish


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["page", "merge", "corrupt"])
async def test_print_retry_reuses_files_and_merges_original_order(monkeypatch, isolated_runtime, failure):
    import app.automation.wms_wave_print as module
    opens, calls, merges = [], [], []
    state = {"fail": True}
    @asynccontextmanager
    async def browser(*args, **kwargs):
        opens.append(1)
        page = MagicMock()
        page.url = "mock://wave"
        context = MagicMock()
        context.pages = [page]
        context.add_init_script = AsyncMock()
        context.new_page = AsyncMock(return_value=page)
        yield context
    monkeypatch.setattr(module, "open_browser_context", browser)
    async def print_wave(page, progress, wave, sequence, total, output_dir):
        calls.append(wave)
        if failure == "page" and state["fail"] and wave == "W2":
            raise RuntimeError("page failed")
        path = output_dir / f"{wave}.pdf"
        writer = PdfWriter()
        writer.add_blank_page(width=100+int(wave[1:]),height=200)
        writer.write(path)
        return path
    async def merge(files, output):
        merges.append(list(files))
        if failure != "page" and state["fail"]:
            raise RuntimeError("merge failed")
        writer = PdfWriter()
        for file in files:
            for page in PdfReader(file).pages:
                writer.add_page(page)
        writer.write(output)
    automation = WmsWavePrintAutomation(isolated_runtime,isolated_runtime.load_automation(),merger=SimpleNamespace(merge=merge))
    automation._print_wave = print_wave
    manager = JobManager(SimpleNamespace(),wave_print_automation=automation,settings=isolated_runtime)
    waves = ["W3","W1","W2","W5","W4","W7","W6"]
    job = manager.create("print_waves", "headless", wave_nos=waves)
    await finish(manager,job)
    assert job.status == "failed"
    assert len(job.print_files) == (4 if failure == "page" else 7)
    if failure == "corrupt":
        from pathlib import Path
        Path(job.print_files["W3"]["path"]).write_bytes(b"corrupt")
    state["fail"] = False
    calls.clear()
    # Restoring the manager verifies checkpoints survive a restart.
    restored = JobManager(SimpleNamespace(),wave_print_automation=automation,settings=isolated_runtime)
    child = restored.retry(job.id)
    await finish(restored,child)
    assert child.status == "succeeded", child.error
    assert calls == ({"page":["W2","W7","W6"], "merge":[], "corrupt":["W3"]}[failure])
    if failure == "merge": assert len(opens) == 1
    assert child.result["wave_nos"] == waves
    assert [int(p.mediabox.width)-100 for p in PdfReader(child.result["merged_file"]).pages] == [3,1,2,5,4,7,6]
    assert restored.retry(job.id).id == child.id


@pytest.mark.asyncio
@pytest.mark.parametrize("output_pages", [1, 2])
async def test_merge_checks_total_pages_before_replacing(monkeypatch, tmp_path, output_pages):
    import app.automation.wms_wave_print as module
    from app.automation.common import AutomationError
    inputs = []
    for i in range(2):
        path = tmp_path / f"source-{i}.pdf"
        writer = PdfWriter(); writer.add_blank_page(width=100,height=200); writer.write(path)
        inputs.append(path)
    target = tmp_path / "merged.pdf"
    target.write_bytes(b"previous file")
    async def process(*command, **kwargs):
        writer = PdfWriter()
        for _ in range(output_pages): writer.add_blank_page(width=100,height=200)
        writer.write(command[-1])
        return SimpleNamespace(returncode=0,communicate=AsyncMock(return_value=(b"",b"")))
    monkeypatch.setattr(module.asyncio, "create_subprocess_exec", process)
    merger = module.QpdfMerger(binary="mock-qpdf")
    if output_pages == 1:
        with pytest.raises(AutomationError,match="页数"):
            await merger.merge(inputs,target)
        assert target.read_bytes() == b"previous file"
    else:
        await merger.merge(inputs,target)
        assert len(PdfReader(target).pages) == 2
