#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"

cd "$ROOT_DIR"
"$PYTHON_BIN" -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt

if ! command -v qpdf >/dev/null 2>&1; then
  echo "提示：未找到 qpdf；使用“打印选中波次”前请先安装 qpdf（macOS 可运行 brew install qpdf）。" >&2
fi

if [[ ! -f "$ROOT_DIR/frontend/dist/index.html" ]]; then
  echo "提示：未找到控制台页面 frontend/dist/index.html。" >&2
  echo "请在规划工具工程 planner/ 中运行 python3 build.py（会自动部署到本目录）。" >&2
fi

echo "依赖安装完成。运行 ./scripts/start.sh 启动服务，浏览器访问 http://127.0.0.1:8000/。"
