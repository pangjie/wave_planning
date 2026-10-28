"""Submitted planning workbooks, kept outside the frequently polled job record."""
from __future__ import annotations

import json
import os
import tempfile
from contextlib import suppress
from pathlib import Path


def validate_plan(snapshot: dict, segments: list[dict[str, object]]) -> None:
    if snapshot.get("version") != 1:
        raise ValueError("计划快照版本无效")
    workbook = snapshot.get("workbook")
    if not isinstance(workbook, dict) or not isinstance(workbook.get("filename"), str):
        raise ValueError("计划快照缺少工作簿")
    sheets = workbook.get("sheets")
    if not isinstance(sheets, list) or not sheets or any(
        not isinstance(s, dict) or not isinstance(s.get("name"), str)
        or not isinstance(s.get("aoa"), list) for s in sheets
    ):
        raise ValueError("计划快照工作表无效")
    tables = [s for s in sheets if s["name"] == "波次表"]
    if len(tables) != 1:
        raise ValueError("计划快照需要唯一的波次表")
    table = tables[0]
    refs = table.get("waveRefs")
    if not isinstance(refs, list) or len(refs) != len(segments):
        raise ValueError("计划快照与提交分段数量不一致")
    seen, rows = set(), set()
    expected = {(s["channel"], s["seg_name"]): len(s["order_nos"]) for s in segments}
    if len(expected) != len(segments):
        raise ValueError("提交计划包含重复分段")
    for ref in refs:
        if not isinstance(ref, dict):
            raise ValueError("计划快照行引用无效")
        key = (ref.get("channel"), ref.get("seg_name"))
        row = ref.get("row")
        if not all(isinstance(v, str) for v in key):
            raise ValueError("计划快照分段引用无效")
        if key not in expected or key in seen or type(row) is not int or row in rows or not 0 < row < len(table["aoa"]):
            raise ValueError("计划快照分段或行引用不匹配")
        cells = table["aoa"][row]
        if "kind" in ref and ref["kind"] not in {"hot", "paper", "multi", "mix"}:
            raise ValueError("计划快照分类无效")
        if not isinstance(cells, list) or len(cells) < 9 or cells[6] != expected[key]:
            raise ValueError("计划快照订单数量不匹配")
        seen.add(key)
        rows.add(row)


def save_plan(data_dir: Path, job_id: str, snapshot: dict) -> None:
    target = data_dir / "plans" / f"{job_id}.json"
    serialized = json.dumps(snapshot, ensure_ascii=False, allow_nan=False)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent,
                                         prefix=".plan-", suffix=".tmp", delete=False) as stream:
            tmp = Path(stream.name)
            stream.write(serialized)
        os.replace(tmp, target)
    finally:
        if tmp is not None:
            with suppress(FileNotFoundError):
                tmp.unlink()


def read_plan(data_dir: Path, job_id: str, segments: list[dict[str, object]]) -> dict:
    snapshot = json.loads((data_dir / "plans" / f"{job_id}.json").read_text("utf-8"))
    if not isinstance(snapshot, dict):
        raise ValueError("计划快照格式错误")
    validate_plan(snapshot, segments)
    return snapshot
