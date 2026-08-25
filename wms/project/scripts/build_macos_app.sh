#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export PYINSTALLER_CONFIG_DIR="$ROOT_DIR/build/pyinstaller-cache"

if [[ ! -x "$ROOT_DIR/.venv/bin/python" ]]; then
  echo "未找到项目虚拟环境，请先运行 ./scripts/setup.sh。" >&2
  exit 1
fi

if ! "$ROOT_DIR/.venv/bin/python" -m PyInstaller --version >/dev/null 2>&1; then
  echo "未安装构建依赖，请运行：.venv/bin/python -m pip install -r desktop/requirements-build.txt" >&2
  exit 1
fi

# 控制台页面由 planner/build.py 生成并部署到 frontend/dist/index.html；.app 直接打包该产物
if [[ ! -f "$ROOT_DIR/frontend/dist/index.html" ]]; then
  echo "未找到控制台页面 frontend/dist/index.html。" >&2
  echo "请先在 planner/ 中运行 python3 build.py（会自动部署到本目录）。" >&2
  exit 1
fi

cd "$ROOT_DIR/desktop"
"$ROOT_DIR/.venv/bin/python" -m PyInstaller \
  --noconfirm \
  --clean \
  --distpath "$ROOT_DIR/dist" \
  --workpath "$ROOT_DIR/build/macos-app" \
  WMSAutomation.spec

codesign --force --deep --sign - "$ROOT_DIR/dist/WMS自动化控制台.app"

echo "构建完成：$ROOT_DIR/dist/WMS自动化控制台.app"
