from pathlib import Path

import pdfplumber
import pytest
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, NameObject

from app.automation.pdf_centering import (
    _translation_from_bounds,
    center_pdf_visible_content,
)


def _offset_rectangle_pdf(path: Path) -> None:
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    stream = DecodedStreamObject()
    stream.set_data(b"0 0 0 rg\n10 100 500 600 re f\n")
    page[NameObject("/Contents")] = writer._add_object(stream)
    with path.open("wb") as handle:
        writer.write(handle)


def test_translation_uses_visible_object_center() -> None:
    assert _translation_from_bounds(
        612,
        792,
        (10, 92, 510, 692),
    ) == pytest.approx((46, -4))


def test_pdf_content_is_centered_after_postprocessing(tmp_path: Path) -> None:
    pdf_path = tmp_path / "offset.pdf"
    _offset_rectangle_pdf(pdf_path)

    adjustments = center_pdf_visible_content(pdf_path)

    assert len(PdfReader(pdf_path).pages) == 1
    assert adjustments[0].shift_x == pytest.approx(46)
    with pdfplumber.open(pdf_path) as document:
        rectangle = document.pages[0].rects[0]
        assert (rectangle["x0"] + rectangle["x1"]) / 2 == pytest.approx(306)

    second_pass = center_pdf_visible_content(pdf_path)
    assert second_pass[0].shift_x == pytest.approx(0, abs=0.1)
    assert second_pass[0].shift_y == pytest.approx(0, abs=0.1)
