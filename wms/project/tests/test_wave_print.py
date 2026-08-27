import asyncio
from datetime import date
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.automation.common import AutomationError
from app.automation.wave_pending import WaveNotFoundError
from app.automation.wms_wave_print import (
    QpdfMerger,
    WmsWavePrintAutomation,
    _dated_merge_filename,
    _fit_content_to_paper,
    _is_reprint_prompt,
)
from app.core.config import Settings


def make_automation(tmp_path: Path | None = None) -> WmsWavePrintAutomation:
    settings = Settings.from_environment()
    if tmp_path is not None:
        settings = settings.model_copy(update={"outputs_dir": tmp_path})
    return WmsWavePrintAutomation(settings, settings.load_automation())


def fake_pdf(path: Path) -> None:
    path.write_bytes(b"%PDF-1.7\n" + b"0" * 6_000)


def test_print_request_validation_deduplicates_and_rejects_unsafe_values() -> None:
    automation = make_automation()

    assert automation._validate_request([" W001 ", "W002", "W001"]) == [
        "W001",
        "W002",
    ]

    with pytest.raises(AutomationError, match="格式异常"):
        automation._validate_request(["../unsafe"])


def test_qpdf_command_preserves_input_order() -> None:
    merger = QpdfMerger(binary="/opt/homebrew/bin/qpdf")
    inputs = [Path("W002.pdf"), Path("W001.pdf")]

    command = merger.build_command(inputs, Path("合并.pdf"))

    assert command == [
        "/opt/homebrew/bin/qpdf",
        "--empty",
        "--pages",
        "W002.pdf",
        "W001.pdf",
        "--",
        "合并.pdf",
    ]


def test_reprint_prompt_must_match_current_wave() -> None:
    assert _is_reprint_prompt(
        "提示\n波次号W001已打印过拣货单，是否确认打印？",
        "W001",
    )
    assert _is_reprint_prompt(
        "提示 波次号W001已打印过拣货单，是否确认打印？ 取消 确定",
        "W001",
    )
    assert not _is_reprint_prompt(
        "波次号W002已打印过拣货单，是否确认打印？",
        "W001",
    )
    assert not _is_reprint_prompt("是否删除波次W001？", "W001")


def test_dated_merge_filename_and_letter_centering() -> None:
    assert _dated_merge_filename(date(2026, 7, 18)) == "Paper合并_2026-07-18.pdf"

    scale, margins = _fit_content_to_paper(816, 1056, "Letter")

    assert scale == pytest.approx(0.95)
    assert margins == {
        "top": "26.40px",
        "right": "20.40px",
        "bottom": "26.40px",
        "left": "20.40px",
    }

    enlarged_scale, enlarged_margins = _fit_content_to_paper(
        600,
        800,
        "Letter",
    )
    assert enlarged_scale == pytest.approx(1.254)
    assert enlarged_margins == {
        "top": "26.40px",
        "right": "31.80px",
        "bottom": "26.40px",
        "left": "31.80px",
    }


@pytest.mark.asyncio
async def test_selected_waves_print_five_at_a_time_then_merge_in_input_order(
    tmp_path: Path,
) -> None:
    merger = MagicMock()
    merger.merge = AsyncMock()
    automation = make_automation(tmp_path)
    automation.merger = merger
    active = 0
    max_active = 0
    completed_order: list[str] = []

    async def print_wave(page, progress, wave_no, sequence, total, output_dir):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(
            {1: 0.05, 2: 0.01, 3: 0.04, 4: 0.02, 5: 0.03}.get(
                sequence,
                0.01,
            )
        )
        active -= 1
        completed_order.append(wave_no)
        output = output_dir / f"{wave_no}.pdf"
        fake_pdf(output)
        return output

    automation._print_wave = AsyncMock(side_effect=print_wave)
    pages = [MagicMock() for _ in range(5)]
    for page in pages:
        page.url = "https://wms.xlwms.com/outbound/wave"
    context = MagicMock()
    context.pages = [pages[0]]
    context.add_init_script = AsyncMock()
    context.new_page = AsyncMock(side_effect=pages[1:])
    progress = AsyncMock()
    wave_nos = ["W003", "W001", "W007", "W005", "W002", "W006", "W004"]

    result = await automation._run_selected(
        context,
        progress,
        wave_nos,
        "Paper合并_2026-07-18.pdf",
    )

    assert max_active == 5
    assert completed_order[:5] != wave_nos[:5]
    assert result.wave_nos == wave_nos
    assert result.failed_wave_nos == []
    assert result.merged_file == str(tmp_path / "Paper合并_2026-07-18.pdf")
    context.add_init_script.assert_awaited_once()
    assert context.new_page.await_count == 4
    worker_pages = [call.args[0] for call in automation._print_wave.await_args_list]
    assert all(worker_pages[index] is pages[index] for index in range(5))
    assert worker_pages[5] is pages[0]
    assert worker_pages[6] is pages[1]
    merger.merge.assert_awaited_once_with(
        [tmp_path / f"{wave_no}.pdf" for wave_no in wave_nos],
        tmp_path / "Paper合并_2026-07-18.pdf",
    )
    assert any(
        call.args[0] == "parallel_start" for call in progress.await_args_list
    )


@pytest.mark.asyncio
async def test_parallel_print_skips_missing_wave_and_preserves_remaining_order(
    tmp_path: Path,
) -> None:
    merger = MagicMock()
    merger.merge = AsyncMock()
    automation = make_automation(tmp_path)
    automation.merger = merger

    async def print_wave(page, progress, wave_no, sequence, total, output_dir):
        if wave_no == "W002":
            raise WaveNotFoundError("波次 W002 不在“全部”列表中。")
        output = output_dir / f"{wave_no}.pdf"
        fake_pdf(output)
        return output

    automation._print_wave = AsyncMock(side_effect=print_wave)
    pages = [MagicMock() for _ in range(4)]
    pages[0].url = "https://wms.xlwms.com/outbound/wave"
    context = MagicMock()
    context.pages = [pages[0]]
    context.add_init_script = AsyncMock()
    context.new_page = AsyncMock(side_effect=pages[1:])
    progress = AsyncMock()

    result = await automation._run_selected(
        context,
        progress,
        ["W003", "W002", "W001", "W004"],
        "Paper合并_2026-07-18.pdf",
    )

    assert result.wave_nos == ["W003", "W001", "W004"]
    assert result.failed_wave_nos == ["W002"]
    merger.merge.assert_awaited_once_with(
        [tmp_path / "W003.pdf", tmp_path / "W001.pdf", tmp_path / "W004.pdf"],
        tmp_path / "Paper合并_2026-07-18.pdf",
    )


@pytest.mark.asyncio
async def test_parallel_print_fatal_error_stops_later_batches(tmp_path: Path) -> None:
    merger = MagicMock()
    merger.merge = AsyncMock()
    automation = make_automation(tmp_path)
    automation.merger = merger
    attempted: list[str] = []

    async def print_wave(page, progress, wave_no, sequence, total, output_dir):
        attempted.append(wave_no)
        if wave_no == "W002":
            raise AutomationError("打印中心结构异常")
        output = output_dir / f"{wave_no}.pdf"
        fake_pdf(output)
        return output

    automation._print_wave = AsyncMock(side_effect=print_wave)
    pages = [MagicMock() for _ in range(5)]
    pages[0].url = "https://wms.xlwms.com/outbound/wave"
    context = MagicMock()
    context.pages = [pages[0]]
    context.add_init_script = AsyncMock()
    context.new_page = AsyncMock(side_effect=pages[1:])

    with pytest.raises(AutomationError, match="后续批次已停止"):
        await automation._run_selected(
            context,
            AsyncMock(),
            ["W001", "W002", "W003", "W004", "W005", "W006"],
            "Paper合并_2026-07-18.pdf",
        )

    assert attempted == ["W001", "W002", "W003", "W004", "W005"]
    merger.merge.assert_not_awaited()


@pytest.mark.asyncio
async def test_pdf_is_written_atomically(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    automation = make_automation(tmp_path)
    center_pdf = MagicMock(return_value=[])
    monkeypatch.setattr(
        "app.automation.wms_wave_print.center_pdf_visible_content",
        center_pdf,
    )
    verified_html = "<html><body>" + "x" * 220 + "</body></html>"
    automation._capture_print_preview = AsyncMock(
        return_value={
            "html": verified_html,
            "text": "W001",
            "logicalPageWidth": 816,
            "logicalPageHeight": 1056,
            "previewVerified": True,
        }
    )
    page = MagicMock()
    page.emulate_media = AsyncMock()

    async def render_pdf(**options):
        fake_pdf(Path(options["path"]))

    page.pdf = AsyncMock(side_effect=render_pdf)
    output = tmp_path / "W001.pdf"

    page.context.new_page = AsyncMock(return_value=page)
    page.set_content = AsyncMock()
    page.is_closed = MagicMock(return_value=False)
    page.close = AsyncMock()
    await automation._save_pdf(
        page,
        "W001",
        output,
    )

    assert output.read_bytes().startswith(b"%PDF-")
    automation._capture_print_preview.assert_awaited_once_with(page)
    page.set_content.assert_awaited_once()
    center_pdf.assert_called_once()
    assert page.pdf.await_args.kwargs["format"] == "Letter"
    assert page.pdf.await_args.kwargs["prefer_css_page_size"] is False
