"""Compatibility entry point for the isolated, mock-only browser workflow test.

Never attach to an existing service. The Node test owns its random-port mock
server and temporary browser; it is the single implementation of this workflow.
"""

import argparse
import os
from pathlib import Path
import shutil
import subprocess


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="运行隔离的模拟 WMS 全流程测试；不连接现有服务或真实 WMS。"
    )
    parser.parse_args(argv)  # Deliberately no arbitrary target URL or production switch.
    root = Path(__file__).resolve().parents[3]
    entry = root / "planner/test-wms-ui.js"
    node = shutil.which("node")
    if not entry.is_file():
        parser.error("需要完整项目中的 planner/test-wms-ui.js；没有启动浏览器。")
    if not node:
        parser.error("需要 Node.js 才能运行模拟测试；没有启动浏览器。")
    env = {
        name: os.environ[name]
        for name in ("PATH", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "CHROME_PATH")
        if name in os.environ
    }
    print("仅运行本地模拟全流程；不会提交真实 WMS 操作。", flush=True)
    result = subprocess.run([node, str(entry)], cwd=root, env=env, check=False)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
