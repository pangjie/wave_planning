import asyncio
from datetime import datetime
from unittest.mock import AsyncMock

import pytest

from app.automation import ExportResult, WavePickResult, WavePrintResult
from app.services.job_manager import ActiveJobConflictError, JobManager


class FakeAutomation:
    def __init__(self):
        self.last_headless = None

    async def run(self, progress, headless=None):
        self.last_headless = headless
        await progress("template_verified", "已确认导出模板：渠道拆分")
        return ExportResult(
            mode="export",
            template="渠道拆分",
            current_url="https://wms.xlwms.com/outbound/parcel",
            message="导出完成",
            completed_at=datetime.now().astimezone().isoformat(),
        )


class FakeWaveAutomation:
    def __init__(self):
        self.request = None

    async def run(self, progress, headless=None, *, wave_nos=None):
        self.request = (list(wave_nos or []), headless)
        await progress("waves_selected", "已锁定全部测试波次。")
        return WavePickResult(
            mode="pick_waves",
            wave_nos=["WTEST001", "WTEST002", "WTEST003"],
            failed_wave_nos=[],
            warnings=[],
            wave_count=3,
            sku_rows=9,
            current_url="https://wms.xlwms.com/outbound/wave",
            message="启动时快照中的 3 个待拣货波次已全部完成。",
            completed_at=datetime.now().astimezone().isoformat(),
        )


class BlockingAutomation:
    async def run(self, progress, headless=None):
        await progress("blocked", "测试任务保持运行。")
        await asyncio.Event().wait()


class FakeWavePrintAutomation:
    def __init__(self):
        self.request = None

    async def run(self, progress, *, wave_nos, headless=None):
        self.request = (wave_nos, headless)
        await progress("wave_pdf_saved", "测试波次 PDF 已保存。")
        return WavePrintResult(
            mode="print_waves",
            wave_nos=wave_nos,
            failed_wave_nos=[],
            warnings=[],
            printed_files=[f"outputs/{item}.pdf" for item in wave_nos],
            merged_file="outputs/Paper合并_2026-07-19.pdf",
            current_url="https://wms.xlwms.com/outbound/wave",
            message="选中波次打印完成",
            completed_at=datetime.now().astimezone().isoformat(),
        )


@pytest.mark.asyncio
async def test_job_reaches_success() -> None:
    fake = FakeAutomation()
    manager = JobManager(fake)
    job = manager.create("export", "headless")

    await asyncio.wait_for(manager.tasks[job.id], timeout=1)

    saved = manager.get(job.id)
    assert saved is not None
    assert saved.status == "succeeded"
    assert saved.browser_mode == "headless"
    assert saved.result["template"] == "渠道拆分"
    assert fake.last_headless is True


@pytest.mark.asyncio
async def test_all_wave_job_reaches_success() -> None:
    fake_export = FakeAutomation()
    fake_wave = FakeWaveAutomation()
    manager = JobManager(fake_export, fake_wave)
    job = manager.create("pick_waves", "headed")

    await asyncio.wait_for(manager.tasks[job.id], timeout=1)

    saved = manager.get(job.id)
    assert saved is not None
    assert saved.status == "succeeded"
    assert saved.result["wave_nos"] == ["WTEST001", "WTEST002", "WTEST003"]
    assert saved.result["wave_count"] == 3
    assert saved.result["sku_rows"] == 9
    assert fake_wave.request == ([], False)


@pytest.mark.asyncio
async def test_selected_wave_pick_job_forwards_wave_numbers() -> None:
    fake_wave = FakeWaveAutomation()
    manager = JobManager(FakeAutomation(), fake_wave)
    job = manager.create(
        "pick_waves",
        "headless",
        wave_nos=["W003", "W001"],
    )

    await asyncio.wait_for(manager.tasks[job.id], timeout=1)

    saved = manager.get(job.id)
    assert saved is not None
    assert saved.status == "succeeded"
    assert saved.wave_nos == ["W003", "W001"]
    assert fake_wave.request == (["W003", "W001"], True)


@pytest.mark.asyncio
async def test_wave_job_reports_partial_completion() -> None:
    fake_export = FakeAutomation()
    fake_wave = FakeWaveAutomation()
    fake_wave.run = AsyncMock(return_value=WavePickResult(
        mode="pick_waves",
        wave_nos=["WTEST001", "WTEST003"],
        failed_wave_nos=["WTEST002"],
        warnings=["最终统一检查发现 WTEST002 仍在待拣货列表"],
        wave_count=2,
        sku_rows=8,
        current_url="https://wms.xlwms.com/outbound/wave",
        message="最终统一检查确认完成 2 个；WTEST002 仍在待拣货列表",
        completed_at=datetime.now().astimezone().isoformat(),
    ))
    manager = JobManager(fake_export, fake_wave)
    job = manager.create("pick_waves", "headed")

    await asyncio.wait_for(manager.tasks[job.id], timeout=1)

    saved = manager.get(job.id)
    assert saved is not None
    assert saved.status == "partial"
    assert saved.result["failed_wave_nos"] == ["WTEST002"]
    assert saved.events[-1].stage == "completed_with_warnings"


@pytest.mark.asyncio
async def test_selected_wave_print_job_reaches_success() -> None:
    fake_print = FakeWavePrintAutomation()
    manager = JobManager(FakeAutomation(), FakeWaveAutomation(), fake_print)
    job = manager.create(
        "print_waves",
        "headless",
        wave_nos=["W001", "W002"],
    )

    await asyncio.wait_for(manager.tasks[job.id], timeout=1)

    saved = manager.get(job.id)
    assert saved is not None
    assert saved.status == "succeeded"
    assert saved.result["merged_file"].endswith("Paper合并_2026-07-19.pdf")
    assert fake_print.request == (["W001", "W002"], True)


@pytest.mark.asyncio
async def test_second_active_job_is_rejected() -> None:
    manager = JobManager(BlockingAutomation())
    first = manager.create("export", "headed")
    await asyncio.sleep(0)

    with pytest.raises(ActiveJobConflictError, match="已有任务正在排队或执行"):
        manager.create("export", "headless")

    await manager.cancel(first.id)


@pytest.mark.asyncio
async def test_immediate_cancel_releases_active_job() -> None:
    manager = JobManager(BlockingAutomation())
    first = manager.create("export", "headed")

    cancelled = await manager.cancel(first.id)
    replacement = manager.create("export", "headless")

    assert cancelled is not None
    assert cancelled.status == "cancelled"
    assert cancelled.events[-1].stage == "cancelled"
    await manager.cancel(replacement.id)


class FakeGenerateAutomation:
    async def run(self, progress, headless=None, *, segments=None):
        await progress(
            "segment_wave",
            '{"channel": "SwiftX", "seg_name": "爆品1", "wave_no": "W0092608180055"}',
        )
        from app.automation import WaveGenerateResult

        return WaveGenerateResult(
            mode="generate_waves",
            current_url="https://wms.xlwms.com/outbound/parcel",
            message="生成波次完成：1/1 个分段成功。",
            completed_at=datetime.now().astimezone().isoformat(),
            segments=[{
                "channel": "SwiftX", "seg_name": "爆品1",
                "order_count": 10, "wave_no": "W0092608180055", "note": None,
            }],
            generated_count=1,
            failed_count=0,
        )


@pytest.mark.asyncio
async def test_generate_waves_persists_each_segment_immediately(tmp_path) -> None:
    from app.core.config import Settings
    from app.services.wave_records import read_records

    settings = Settings.from_environment().model_copy(
        update={"browser_profile_dir": tmp_path / "profile"}
    )
    fake = FakeGenerateAutomation()
    manager = JobManager(
        FakeAutomation(), wave_generate_automation=fake, settings=settings
    )
    job = manager.create(
        "generate_waves",
        "headed",
        segments=[{"channel": "SwiftX", "seg_name": "爆品1", "order_nos": ["OBS1"]}],
    )
    await asyncio.wait_for(manager.tasks[job.id], timeout=1)

    records = read_records(tmp_path)
    assert records and records[0]["wave_no"] == "W0092608180055"
    assert records[0]["channel"] == "SwiftX" and records[0]["seg_name"] == "爆品1"


@pytest.mark.asyncio
async def test_jobs_persist_across_manager_instances(tmp_path) -> None:
    from app.core.config import Settings

    settings = Settings.from_environment().model_copy(
        update={"browser_profile_dir": tmp_path / "profile"}
    )
    fake = FakeAutomation()
    m1 = JobManager(fake, settings=settings)
    job = m1.create("export", "headless")
    await asyncio.wait_for(m1.tasks[job.id], timeout=1)

    m2 = JobManager(FakeAutomation(), settings=settings)  # 模拟重启
    restored = m2.get(job.id)
    assert restored is not None
    assert restored.status == "succeeded"
    assert restored.events and restored.events[-1].stage == "completed"


@pytest.mark.asyncio
async def test_persisted_jobs_are_pruned_outside_today(tmp_path) -> None:
    from app.core.config import Settings

    settings = Settings.from_environment().model_copy(
        update={"browser_profile_dir": tmp_path / "profile"}
    )
    m = JobManager(FakeAutomation(), settings=settings)
    old_job = m.create("export", "headless")
    old_job.created_at = "2020-01-01T00:00:00"
    await asyncio.wait_for(m.tasks[old_job.id], timeout=1)
    m._persist()

    m2 = JobManager(FakeAutomation(), settings=settings)
    assert m2.get(old_job.id) is None  # 非当天的任务加载时被丢弃
