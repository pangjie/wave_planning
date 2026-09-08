from __future__ import annotations

import json
import os
import tempfile
import threading
from contextlib import suppress
from datetime import datetime
from pathlib import Path

# 波次号持久记录：新记录按批次+计划+渠道+分段去重；旧记录只供查看。
# 供规划页拉取回填波次表 / 分段变绿；无论任务从 API 还是规划页提交都会写入。
_lock = threading.Lock()


def _records_file(data_dir: Path) -> Path:
    return data_dir / "wave-records.json"


def _read_unlocked(data_dir: Path) -> list[dict[str, object]]:
    path = _records_file(data_dir)
    try:
        raw = json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return []
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise ValueError(f"波次历史文件无法读取，原文件已保留：{path}（{exc}）") from exc
    if not isinstance(raw, dict) or not isinstance(raw.get("records"), list):
        raise ValueError(f"波次历史文件格式错误，必须包含 records 列表，原文件已保留：{path}")
    for index, record in enumerate(raw["records"], 1):
        if not isinstance(record, dict) or any(
            not isinstance(record.get(field), str)
            for field in ("channel", "seg_name", "wave_no")
        ) or not record["wave_no"]:
            raise ValueError(
                f"波次历史文件第 {index} 条记录格式错误，"
                f"需要 channel、seg_name 和非空 wave_no 字符串，原文件已保留：{path}"
            )
        try:
            _validate_scope(record.get("batch_id"), record.get("plan_id"))
            if record.get("plan_id") is not None:
                _validate_orders(record.get("order_nos"))
        except ValueError as exc:
            raise ValueError(f"波次历史第 {index} 条身份/订单集合无效，原文件已保留：{path}（{exc}）") from exc
    return raw["records"]


def _write_unlocked(data_dir: Path, records: list[dict[str, object]]) -> None:
    """先写同目录临时文件，成功关闭后再替换；失败时保留旧历史。"""
    serialized = json.dumps({"records": records}, ensure_ascii=False, indent=2)
    path = _records_file(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent,
            prefix=".wave-records-", suffix=".tmp", delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(serialized)
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None:
            with suppress(FileNotFoundError):
                temporary_path.unlink()


def _scope_matches(record: dict, batch_id: str | None, plan_id: str | None) -> bool:
    return record.get("batch_id") == batch_id and record.get("plan_id") == plan_id


def _validate_scope(batch_id: str | None, plan_id: str | None) -> None:
    if (batch_id is not None or plan_id is not None) and (
        not isinstance(batch_id, str) or not batch_id.strip()
        or not isinstance(plan_id, str) or not plan_id.strip()
    ):
        raise ValueError("批次与计划身份必须同时提供且非空")


def _validate_orders(orders: object) -> None:
    if not isinstance(orders, list) or not orders or any(not isinstance(no, str) or not no for no in orders):
        raise ValueError("有身份的波次记录必须包含原提交订单集合")
    if len(set(orders)) != len(orders):
        raise ValueError("原提交订单集合不能重复")


def read_records(data_dir: Path, *, batch_id: str | None = None, plan_id: str | None = None) -> list[dict[str, object]]:
    _validate_scope(batch_id, plan_id)
    with _lock:
        records = _read_unlocked(data_dir)
        return records if batch_id is None else [r for r in records if _scope_matches(r, batch_id, plan_id)]


def clear_records(data_dir: Path, *, batch_id: str | None = None, plan_id: str | None = None) -> None:
    """仅清理指定计划；旧客户端无身份的请求只清理旧版无身份记录。"""
    _validate_scope(batch_id, plan_id)
    with _lock:
        records = _read_unlocked(data_dir)
        _write_unlocked(data_dir, [r for r in records if not _scope_matches(r, batch_id, plan_id)])


def upsert_records(data_dir: Path, new_records: list[dict[str, object]]) -> None:
    """按批次、计划、渠道与分段去重；wave_no 为空的记录忽略。"""
    valid: list[dict[str, object]] = []
    for index, r in enumerate(new_records, 1):
        if not isinstance(r, dict):
            raise ValueError(f"待保存波次记录第 {index} 条必须为对象")
        if not r.get("wave_no"):
            continue
        try:
            order_count = int(r.get("order_count") or 0)
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError(f"待保存波次记录第 {index} 条的 order_count 无法转换为整数") from exc
        valid.append(
            {
                "channel": str(r.get("channel", "")),
                "seg_name": str(r.get("seg_name", "")),
                "wave_no": str(r["wave_no"]),
                "order_count": order_count,
                "at": str(r.get("at") or datetime.now().astimezone().isoformat()),
            }
        )
        _validate_scope(r.get("batch_id"), r.get("plan_id"))
        if r.get("plan_id") is not None:
            orders = r.get("order_nos")
            _validate_orders(orders)
            valid[-1].update(batch_id=r["batch_id"], plan_id=r["plan_id"],
                             job_id=r.get("job_id"), order_nos=list(orders))
    if not valid:
        return
    with _lock:
        by_key: dict[tuple, dict[str, object]] = {}
        for r in _read_unlocked(data_dir):
            by_key[(r.get("batch_id"), r.get("plan_id"), str(r.get("channel")), str(r.get("seg_name")))] = r
        for r in valid:
            by_key[(r.get("batch_id"), r.get("plan_id"), str(r["channel"]), str(r["seg_name"]))] = r
        records = list(by_key.values())
        records.sort(key=lambda r: str(r.get("at", "")))
        _write_unlocked(data_dir, records)
