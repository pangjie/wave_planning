# 提交计划的独立存储：避免轮询任务记录时反复传送整个工作簿。
# 快照用于中断后的规划导出和重试；不得用当前页面的分段替换原提交内容。
"""Submitted planning workbooks, kept outside the frequently polled job record."""
from __future__ import annotations

import json
import os
import tempfile
from contextlib import suppress
from pathlib import Path


def validate_generation_segments(segments: list[dict], limit: int) -> None:
    # API 和执行器共用整批校验，重试也不能绕过。先发现超限/重单再开浏览器，
    # 避免前几段已成功，走到后面才发现本可提前阻止的输入问题。
    """Check the entire batch before any WMS side effect, including retry batches."""
    oversized = [f"{s['channel']} {s['seg_name']}（{len(s['order_nos'])} 单）"
                 for s in segments if len(s['order_nos']) > limit]
    if oversized:
        raise ValueError(f"未启动任何分段：以下分段超过单次 {limit} 单上限，请增加分段数或调整分段：" + "、".join(oversized))
    seen: set[str] = set()
    for segment in segments:
        for order in segment['order_nos']:
            if order in seen:
                raise ValueError(f"未启动任何分段：出库单号重复分配：{order}")
            seen.add(order)


def validate_plan(snapshot: dict, segments: list[dict[str, object]]) -> None:
    # waveRefs 将内部渠道/分段映射到工作簿行，必须与提交分段一一对应且不共用行。
    # 这里只校验快照契约；订单分配计算仍在前端 core.js，不在后台再算一套。
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


# 独立 JSON 保存提交快照，同目录替换防止读到部分写入内容。
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


# 读取后重新校验与原提交分段的对应关系，不能仅凭文件存在就信任快照。
def read_plan(data_dir: Path, job_id: str, segments: list[dict[str, object]]) -> dict:
    snapshot = json.loads((data_dir / "plans" / f"{job_id}.json").read_text("utf-8"))
    if not isinstance(snapshot, dict):
        raise ValueError("计划快照格式错误")
    validate_plan(snapshot, segments)
    return snapshot
