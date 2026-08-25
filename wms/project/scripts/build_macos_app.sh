#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PNPM_BIN="${PNPM_BIN:-$(command -v pnpm || true)}"
export PYINSTALLER_CONFIG_DIR="$ROOT_DIR/build/pyinstaller-cache"

if [[ ! -x "$ROOT_DIR/.venv/bin/python" ]]; then
  echo "未找到项目虚拟环境，请先运行 ./scripts/setup.sh。" >&2
  exit 1
fi

if [[ -z "$PNPM_BIN" ]]; then
  echo "未找到 pnpm，无法构建前端。" >&2
  exit 1
fi

if ! "$ROOT_DIR/.venv/bin/python" -m PyInstaller --version >/dev/null 2>&1; then
  echo "未安装构建依赖，请运行：.venv/bin/python -m pip install -r desktop/requirements-build.txt" >&2
  exit 1
fi

cd "$ROOT_DIR/frontend"
node node_modules/vite/bin/vite.js build

cd "$ROOT_DIR/desktop"
"$ROOT_DIR/.venv/bin/python" -m PyInstaller \
  --noconfirm \
  --clean \
  --distpath "$ROOT_DIR/dist" \
  --workpath "$ROOT_DIR/build/macos-app" \
  WMSAutomation.spec

codesign --force --deep --sign - "$ROOT_DIR/dist/WMS自动化控制台.app"

echo "构建完成：$ROOT_DIR/dist/WMS自动化控制台.app"
