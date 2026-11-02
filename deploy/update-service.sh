#!/bin/bash
# 代码更新后的一键发布：同步工作区代码 → 重建页面 → 重启 launchd 服务。
# 默认拒绝在存在排队/运行中任务时重启；确认可以中断时使用 --force。
# 更新前请先在 wms/project 运行后端测试，并在 planner 运行前端测试。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEPLOY_ROOT="${WAVE_DEPLOY_ROOT:-$HOME/Library/Application Support/WavePlanning}"
HOST="${WMS_HOST:-127.0.0.1}"
PORT="${WMS_PORT:-8000}"
URL="http://$HOST:$PORT"
PYTHON="$DEPLOY_ROOT/wms/project/.venv/bin/python"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

check_idle() {
  # 重启会中断任务并让记录进入“已中断、待核对”。运行时先做一次可达性检查。
  if ! curl -fsS --max-time 3 "$URL/api/health" >/dev/null 2>&1; then
    echo "服务当前未响应，按无活动任务继续。"
    return 0
  fi
  local active
  active="$(curl -fsS --max-time 3 "$URL/api/jobs" | "$PYTHON" -c '
import json, sys
jobs = json.load(sys.stdin)
print(sum(1 for j in jobs if j.get("status") in ("queued", "running")))
')" || { echo "错误：无法读取任务列表，未重启。" >&2; exit 3; }
  if [[ "$active" != "0" ]]; then
    if [[ "$FORCE" -eq 1 ]]; then
      echo "警告：仍有 $active 个活动任务，按 --force 继续；任务会被中断并标记待核对。"
    else
      echo "错误：仍有 $active 个排队/运行中的任务，已拒绝重启。" >&2
      echo "请等待任务结束；确需中断时使用：$0 --force" >&2
      exit 3
    fi
  fi
}

# 先确认空闲再动运行目录；同步/构建后再确认一次，缩小检查与重启之间的窗口。
check_idle
"$ROOT/deploy/sync-to-runtime.sh"
check_idle
"$ROOT/deploy/waveplanning-service" restart
