#!/usr/bin/env bash
# 依赖安装入口：默认运行依赖，--dev 包括测试依赖；复用现有虚拟环境。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
REQUIREMENTS="backend/requirements.txt"

for arg in "$@"; do
  case "$arg" in
    --dev) REQUIREMENTS="requirements-dev.txt" ;;
    --help|-h)
      echo "用法：./scripts/setup.sh [--dev]"
      echo "默认安装运行依赖；--dev 同时安装测试依赖。首次创建环境可用 PYTHON_BIN 指定 Python 3.11+（推荐 3.12）。"
      exit 0 ;;
    *) echo "未知参数：${arg}；请使用 --help 查看用法。" >&2; exit 2 ;;
  esac
done

cd "$ROOT_DIR"
# Reuse an existing environment; do not rewrite its interpreter in place.
if [[ -e .venv || -L .venv ]]; then
  if [[ ! -x .venv/bin/python ]]; then
    echo "现有 .venv 不可用；请先停止服务并核对环境，再另行重建。安装脚本不会自动覆盖它。" >&2
    exit 1
  fi
  PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
fi

"$PYTHON_BIN" -c 'import sys; print("安装解释器：", sys.executable, sys.version.split()[0]); sys.exit(0 if sys.version_info >= (3, 11) else "需要 Python 3.11 或更高版本，推荐 3.12；现有环境不会自动重建。")'
if [[ ! -x .venv/bin/python ]]; then
  "$PYTHON_BIN" -m venv .venv
fi
.venv/bin/python -m pip install -r "$REQUIREMENTS"
.venv/bin/python -m pip check

if ! command -v qpdf >/dev/null 2>&1; then
  echo "提示：未找到 qpdf；使用“打印选中波次”前请先安装 qpdf（macOS 可运行 brew install qpdf）。" >&2
fi

if [[ ! -f "$ROOT_DIR/frontend/dist/index.html" ]]; then
  echo "提示：未找到控制台页面 frontend/dist/index.html。" >&2
  echo "请在规划工具工程 planner/ 中运行 python3 build.py（会自动部署到本目录）。" >&2
fi

echo "依赖安装完成。运行 ./scripts/start.sh 启动服务，浏览器访问 http://127.0.0.1:8000/。"
