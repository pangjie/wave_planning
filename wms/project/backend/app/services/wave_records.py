from __future__ import annotations

import json
import threading
from datetime import datetime
from pathlib import Path

# 波次号持久记录（data/wave-records.json）：按 渠道+分段 去重、最新覆盖。
# 供规划页拉取回填波次表 / 分段变绿；无论任务从 API 还是规划页提交都会写入。
_lock = threading.Lock()


def _records_file(data_dir: Path) -> Path:
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / "wave-records.json"


def _read_unlocked(data_dir: Path) -> list[dict[str, object]]:
    path = _records_file(data_dir)
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text("utf-8"))
    except Exception:
        return []
    if isinstance(raw, dict) and isinstance(raw.get("records"), list):
        return [r for r in raw["records"] if isinstance(r, dict)]
    return []


def read_records(data_dir: Path) -> list[dict[str, object]]:
    with _lock:
        return _read_unlocked(data_dir)


def clear_records(data_dir: Path) -> None:
    """清空全部波次历史（导入新订单文件时调用：既往分段历史不应跨批次保留）。"""
    with _lock:
        _records_file(data_dir).write_text(
            json.dumps({"records": []}, ensure_ascii=False), "utf-8"
        )


def upsert_records(data_dir: Path, new_records: list[dict[str, object]]) -> None:
    """按 (channel, seg_name) 去重写入；wave_no 为空的记录忽略。"""
    valid: list[dict[str, object]] = []
    for r in new_records:
        if not r.get("wave_no"):
            continue
        valid.append(
            {
                "channel": str(r.get("channel", "")),
                "seg_name": str(r.get("seg_name", "")),
                "wave_no": str(r["wave_no"]),
                "order_count": int(r.get("order_count") or 0),
                "at": str(r.get("at") or datetime.now().astimezone().isoformat()),
            }
        )
    if not valid:
        return
    with _lock:
        by_key: dict[tuple[str, str], dict[str, object]] = {}
        for r in _read_unlocked(data_dir):
            by_key[(str(r.get("channel")), str(r.get("seg_name")))] = r
        for r in valid:
            by_key[(str(r["channel"]), str(r["seg_name"]))] = r
        records = list(by_key.values())
        records.sort(key=lambda r: str(r.get("at", "")))
        _records_file(data_dir).write_text(
            json.dumps({"records": records}, ensure_ascii=False, indent=2), "utf-8"
        )
