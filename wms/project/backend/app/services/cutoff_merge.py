# 截单按订单号合并整行；输入双表时先关联库位明细，输出始终是一张出库单。
from __future__ import annotations

import re
from pathlib import Path

# 保留 read_orders 的原导入路径；文件格式及原子写入统一由 order_workbook 管理。
from app.services.order_workbook import normalized, read_orders, write_orders


def merge_orders(base: Path, delta: Path, target: Path) -> dict[str, int]:
    # 两次导出的动态 SKU 列数可能不同，先按归一化列名对齐，再按订单号取并集。
    # 同号以增量整行覆盖，不逐格补值；否则旧 SKU 可能残留在已经变化的订单中。
    # 结果先写临时文件，完整回读比对后再发布 target，失败不留下“成功”的半成品。
    headers, old = read_orders(base)
    extra_headers, new = read_orders(delta)
    keys, extra = list(map(normalized, headers)), list(map(normalized, extra_headers))
    base_keys = keys.copy()
    has_locations = lambda seq: any("recommendedpickinglocation/推荐拣货库位" in k for k in seq)
    if old and new and has_locations(keys) != has_locations(extra):
        raise ValueError("两次截单导出的库位字段不一致，请重新导出缺少库位的阶段，未发布合并文件")
    # WMS expands SKU n columns according to the largest order in each export.
    fixed = lambda seq: {k for k in seq if not re.match(r"^sku\d+", k)}
    if fixed(keys) != fixed(extra):
        raise ValueError("两次导出的模板字段不一致，未发布合并文件")
    for name, key in zip(extra_headers, extra):
        if key not in keys:
            headers.append(name)
            keys.append(key)
    def align(values, source):
        mapping = dict(zip(source, values))
        return tuple(mapping.get(k) for k in keys)
    merged = {key: align(row, base_keys) for key, row in old.items()}
    # Base column positions are retained; newly appended columns are blank.
    for key, row in new.items():
        merged[key] = align(row, extra)
    overlap = len(old.keys() & new.keys())
    if len(merged) != len(old) + len(new) - overlap:
        raise ValueError("合并订单数校验失败")
    write_orders(target, headers, merged)
    return {"base": len(old), "delta": len(new), "overlap": overlap, "total": len(merged)}
