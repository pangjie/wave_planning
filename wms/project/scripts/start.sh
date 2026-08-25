#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-${PORT:-8000}}"

if [[ ! -x "$ROOT_DIR/.venv/bin/python" ]]; then
  echo "依赖尚未安装，请先运行 ./scripts/setup.sh。" >&2
  exit 1
fi
if [[ ! -f "$ROOT_DIR/frontend/dist/index.html" ]]; then
  echo "未找到控制台页面 frontend/dist/index.html。" >&2
  echo "请在 planner/ 中运行 python3 build.py（会自动部署到本目录）。" >&2
  exit 1
fi

cd "$ROOT_DIR"
PYTHONPATH=backend exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT"
