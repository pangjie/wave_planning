#!/bin/bash
# 把当前工作区同步到 launchd 可访问的运行目录（~/Library/Application Support）。
# macOS 隐私保护（TCC）禁止登录代理读取 ~/Documents，因此运行目录必须在其外。
# 只同步代码/配置/页面；data、downloads、outputs、logs、.venv 永远保留在运行目录。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEPLOY_ROOT="${WAVE_DEPLOY_ROOT:-$HOME/Library/Application Support/WavePlanning}"
PYTHON_BIN="${PYTHON_BIN:-/opt/miniconda3/bin/python3.12}"

if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="$(command -v python3.12 || command -v python3 || true)"
fi
[[ -n "$PYTHON_BIN" && -x "$PYTHON_BIN" ]] || { echo "错误：找不到 Python 3.11+ 解释器" >&2; exit 1; }

# 先在源码目录构建一次，保证工作区 HTML（测试打开的文件）也反映最新源码。
WORKSPACE_PY="$ROOT/wms/project/.venv/bin/python"
[[ -x "$WORKSPACE_PY" ]] || WORKSPACE_PY="$(command -v python3)"
"$WORKSPACE_PY" "$ROOT/planner/build.py" >/dev/null

mkdir -p "$DEPLOY_ROOT"
# --delete 只删除未排除的旧代码；运行数据目录被 --exclude 保护，不会被删。
rsync -a --delete \
  --exclude '.git/' \
  --exclude '.venv/' \
  --exclude '__pycache__/' \
  --exclude '.pytest_cache/' \
  --exclude '.DS_Store' \
  --exclude 'wms/project/data/' \
  --exclude 'wms/project/downloads/' \
  --exclude 'wms/project/outputs/' \
  --exclude 'wms/project/logs/' \
  --exclude 'wms/project/build/' \
  --exclude 'wms/project/dist/' \
  --exclude 'planner/tmp/' \
  --exclude 'planner/shots/' \
  "$ROOT/" "$DEPLOY_ROOT/"
chmod +x "$DEPLOY_ROOT/deploy/run-service.sh" "$DEPLOY_ROOT/deploy/waveplanning-service" \
  "$DEPLOY_ROOT/wms/project/scripts/"*.sh

if [[ ! -x "$DEPLOY_ROOT/wms/project/.venv/bin/python" ]]; then
  echo "首次部署：创建运行环境 $DEPLOY_ROOT/wms/project/.venv"
  ( cd "$DEPLOY_ROOT/wms/project" && PYTHON_BIN="$PYTHON_BIN" ./scripts/setup.sh )
fi

# 页面始终由唯一构建脚本生成，避免运行目录与源码不一致。
"$DEPLOY_ROOT/wms/project/.venv/bin/python" "$DEPLOY_ROOT/planner/build.py" >/dev/null

echo "已同步代码到：$DEPLOY_ROOT"
echo "运行数据保留在：$DEPLOY_ROOT/wms/project/{data,downloads,outputs,logs}"
