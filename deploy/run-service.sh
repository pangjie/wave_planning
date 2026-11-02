#!/bin/bash
# launchd 前台入口：只负责启动后端，由 launchd 守护、限流重启并接收 SIGTERM。
# 不在本脚本内 nohup/后台化，否则 launchd 无法跟踪真实服务进程。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PROJECT="$ROOT/wms/project"
PYTHON="$PROJECT/.venv/bin/python"
HOST="${WMS_HOST:-127.0.0.1}"
PORT="${WMS_PORT:-8000}"

if [[ ! -x "$PYTHON" ]]; then
  echo "错误：未找到 ${PYTHON}；请先运行 $PROJECT/scripts/setup.sh" >&2
  exit 1
fi
if [[ ! -f "$PROJECT/frontend/dist/index.html" ]]; then
  echo "错误：缺少控制台页面 $PROJECT/frontend/dist/index.html；请运行 planner/build.py" >&2
  exit 1
fi

cd "$PROJECT"
export PYTHONPATH="$PROJECT/backend"
export PYTHONUNBUFFERED=1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 启动 WMS 波次控制台 ${HOST}:${PORT}（PID $$）"
exec "$PYTHON" -m uvicorn app.main:app \
  --app-dir "$PROJECT/backend" --host "$HOST" --port "$PORT"
