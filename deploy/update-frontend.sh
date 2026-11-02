#!/bin/bash
# 只发布前端页面：同步 planner/ → 重建页面 → 更新运行目录的 dist。
# 不重启后端，因此可以在任务运行期间执行；用户在浏览器刷新后生效。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEPLOY_ROOT="${WAVE_DEPLOY_ROOT:-$HOME/Library/Application Support/WavePlanning}"
HOST="${WMS_HOST:-127.0.0.1}"
PORT="${WMS_PORT:-8000}"

[[ -x "$DEPLOY_ROOT/wms/project/.venv/bin/python" ]] || { echo "错误：运行环境缺失，请先执行 deploy/install-launchagent.sh" >&2; exit 1; }

WORKSPACE_PY="$ROOT/wms/project/.venv/bin/python"
[[ -x "$WORKSPACE_PY" ]] || WORKSPACE_PY="$(command -v python3)"

# 工作区产物：测试与离线 HTML 使用这一份。
"$WORKSPACE_PY" "$ROOT/planner/build.py" >/dev/null

# 只同步前端源码，不碰 backend/config；--delete 不会删除被排除的测试临时目录。
rsync -a --delete \
  --exclude 'tmp/' \
  --exclude 'shots/' \
  --exclude '__pycache__/' \
  --exclude '.DS_Store' \
  "$ROOT/planner/" "$DEPLOY_ROOT/planner/"
cp "$ROOT/波次规划工具.html" "$DEPLOY_ROOT/波次规划工具.html"

# 运行目录内重建：同时写运行目录顶层 HTML 与 wms/project/frontend/dist/index.html。
"$DEPLOY_ROOT/wms/project/.venv/bin/python" "$DEPLOY_ROOT/planner/build.py" >/dev/null

echo "前端已同步到运行目录；刷新 http://$HOST:$PORT/ 即可，无需重启后端。"
