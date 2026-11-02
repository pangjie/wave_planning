#!/usr/bin/env python3
"""Generate the local location-priority JSON used by the planner.

The location table is internal warehouse data. The generated file and the source
xlsx are intentionally gitignored; only the local runtime serves them.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

from openpyxl import load_workbook

DEFAULT_OUT = Path(__file__).resolve().parent / "location-priority.local.json"


def norm(value: object) -> str:
    return re.sub(r"\s+", "", str(value or "")).lower()


def main() -> int:
    parser = argparse.ArgumentParser(description="Locationexport xlsx -> local JSON")
    parser.add_argument("xlsx", type=Path)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    wb = load_workbook(args.xlsx, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    rows = ws.iter_rows(values_only=True)
    headers = [str(c or "").strip() for c in next(rows)]
    keys = [norm(h) for h in headers]
    code_i = next((i for i, k in enumerate(keys) if "库位编码" in k or "locationcode" in k), None)
    pri_i = next((i for i, k in enumerate(keys) if "拣货推荐优先级" in k or "pickingrecommendationpriority" in k), None)
    area_i = next((i for i, k in enumerate(keys) if "所属库区" in k or "belongingarea" in k), None)
    if code_i is None or pri_i is None:
        raise SystemExit("缺少库位编码或拣货推荐优先级列")
    priority: dict[str, int] = {}
    non_picking: list[str] = []
    for number, row in enumerate(rows, 2):
        code = str(row[code_i] or "").strip()
        raw = row[pri_i]
        if not code:
            continue
        try:
            value = int(float(raw))
        except (TypeError, ValueError) as exc:
            raise SystemExit(f"第 {number} 行优先级无效：{raw!r}") from exc
        if code in priority:
            raise SystemExit(f"第 {number} 行库位编码重复：{code}")
        priority[code] = value
        if area_i is not None and str(row[area_i] or "").strip() == "XN":
            non_picking.append(code)
    wb.close()
    if not priority:
        raise SystemExit("库位表没有有效数据")

    canonical = json.dumps(
        {"priority": priority, "nonPicking": sorted(non_picking)},
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")
    digest = hashlib.sha256(canonical).hexdigest()[:16]
    payload = {
        "version": f"{args.xlsx.name}@sha256:{digest}",
        "source": args.xlsx.name,
        "count": len(priority),
        "nonPicking": sorted(non_picking),
        "priority": dict(sorted(priority.items())),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {args.out} ({len(priority)} locations, {len(non_picking)} non-picking, {digest})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
