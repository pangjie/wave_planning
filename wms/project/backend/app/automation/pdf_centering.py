from __future__ import annotations

import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import pdfplumber
from pypdf import PdfReader, PdfWriter, Transformation


logging.getLogger("pdfminer").setLevel(logging.ERROR)


class PdfCenteringError(RuntimeError):
    """Raised when a generated PDF cannot be safely centered."""


@dataclass(frozen=True, slots=True)
class PageCentering:
    page_number: int
    shift_x: float
    shift_y: float


def center_pdf_visible_content(
    path: Path,
    *,
    maximum_ratio: float = 0.2,
    tolerance: float = 0.1,
) -> list[PageCentering]:
    """Center each page using the bounds of its actual painted PDF objects."""
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.stem}.centered.",
        suffix=".pdf",
        dir=path.parent,
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        reader = PdfReader(path)
        writer = PdfWriter()
        adjustments: list[PageCentering] = []
        with pdfplumber.open(path) as layout_pdf:
            if len(reader.pages) != len(layout_pdf.pages):
                raise PdfCenteringError("PDF 页面数量分析结果不一致。")

            for page_number, (page, layout_page) in enumerate(
                zip(reader.pages, layout_pdf.pages, strict=True),
                start=1,
            ):
                page_width = float(page.mediabox.width)
                page_height = float(page.mediabox.height)
                bounds = _visible_page_bounds(
                    layout_page,
                    page_width,
                    page_height,
                )
                if bounds is None:
                    raise PdfCenteringError(
                        f"第 {page_number} 页没有可识别的可见内容。"
                    )

                shift_x, shift_y = _translation_from_bounds(
                    page_width,
                    page_height,
                    bounds,
                    maximum_ratio=maximum_ratio,
                )
                if abs(shift_x) < tolerance:
                    shift_x = 0.0
                if abs(shift_y) < tolerance:
                    shift_y = 0.0
                writer.add_page(page)
                if shift_x or shift_y:
                    writer.pages[-1].add_transformation(
                        Transformation().translate(tx=shift_x, ty=shift_y),
                        expand=False,
                    )
                adjustments.append(
                    PageCentering(
                        page_number=page_number,
                        shift_x=shift_x,
                        shift_y=shift_y,
                    )
                )

        with temporary.open("wb") as handle:
            writer.write(handle)
        os.replace(temporary, path)
        return adjustments
    except PdfCenteringError:
        raise
    except Exception as exc:
        raise PdfCenteringError("无法分析或改写 PDF 页面内容。") from exc
    finally:
        temporary.unlink(missing_ok=True)


def _visible_page_bounds(
    page: Any,
    page_width: float,
    page_height: float,
) -> tuple[float, float, float, float] | None:
    visible_bounds: list[tuple[float, float, float, float]] = []
    object_groups: Iterable[tuple[str, list[dict[str, Any]]]] = (
        ("chars", page.chars),
        ("lines", page.lines),
        ("rects", page.rects),
        ("curves", page.curves),
        ("images", page.images),
    )
    for kind, objects in object_groups:
        for item in objects:
            if not _is_visible_object(kind, item, page_width, page_height):
                continue
            left = max(0.0, float(item["x0"]))
            right = min(page_width, float(item["x1"]))
            top = max(0.0, float(item["top"]))
            bottom = min(page_height, float(item["bottom"]))
            if right > left and bottom > top:
                visible_bounds.append((left, top, right, bottom))

    if not visible_bounds:
        return None
    return (
        min(bounds[0] for bounds in visible_bounds),
        min(bounds[1] for bounds in visible_bounds),
        max(bounds[2] for bounds in visible_bounds),
        max(bounds[3] for bounds in visible_bounds),
    )


def _is_visible_object(
    kind: str,
    item: dict[str, Any],
    page_width: float,
    page_height: float,
) -> bool:
    width = float(item.get("width") or 0)
    height = float(item.get("height") or 0)
    if width <= 0 or height <= 0:
        return False
    if kind == "images":
        return not (width >= page_width * 0.95 and height >= page_height * 0.95)
    if kind == "chars":
        return not _is_white_or_transparent(item.get("non_stroking_color"))

    colors: list[Any] = []
    if item.get("fill"):
        colors.append(item.get("non_stroking_color"))
    if item.get("stroke"):
        colors.append(item.get("stroking_color"))
    if not colors:
        colors.extend(
            [item.get("non_stroking_color"), item.get("stroking_color")]
        )
    return any(not _is_white_or_transparent(color) for color in colors)


def _is_white_or_transparent(color: Any) -> bool:
    if color is None:
        return True
    if isinstance(color, (tuple, list)) and len(color) >= 3:
        try:
            return min(float(component) for component in color[:3]) >= 0.96
        except (TypeError, ValueError):
            return False
    return False


def _translation_from_bounds(
    page_width: float,
    page_height: float,
    bounds: tuple[float, float, float, float],
    *,
    maximum_ratio: float = 0.2,
) -> tuple[float, float]:
    left, top, right, bottom = bounds
    shift_x = page_width / 2 - (left + right) / 2
    # pdfplumber measures from the top; PDF translation uses positive Y upward.
    shift_y = (top + bottom) / 2 - page_height / 2
    maximum_x = page_width * maximum_ratio
    maximum_y = page_height * maximum_ratio
    return (
        max(-maximum_x, min(maximum_x, shift_x)),
        max(-maximum_y, min(maximum_y, shift_y)),
    )
