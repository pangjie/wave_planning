#!/bin/bash
# 安装/更新 LaunchAgent：登录自启、崩溃重启，不依赖终端或 AI 会话。
# 运行目录必须在 ~/Documents 之外（macOS TCC 禁止登录代理访问 Documents）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEPLOY_ROOT="${WAVE_DEPLOY_ROOT:-$HOME/Library/Application Support/WavePlanning}"
LABEL="com.jp.waveplanning"
DOMAIN="gui/$(id -u)"
TEMPLATE="$ROOT/deploy/$LABEL.plist.template"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
HOST="${WMS_HOST:-127.0.0.1}"
PORT="${WMS_PORT:-8000}"

fail() { echo "错误：$*" >&2; exit 1; }

"$ROOT/deploy/sync-to-runtime.sh"
[[ -x "$DEPLOY_ROOT/wms/project/.venv/bin/python" ]] || fail "运行环境缺失：$DEPLOY_ROOT/wms/project/.venv"
[[ -f "$DEPLOY_ROOT/wms/project/frontend/dist/index.html" ]] || fail "缺少控制台页面"
[[ -f "$TEMPLATE" ]] || fail "缺少 plist 模板：$TEMPLATE"

mkdir -p "$HOME/Library/LaunchAgents" "$DEPLOY_ROOT/wms/project/logs"
rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
sed "s|__ROOT__|$DEPLOY_ROOT|g" "$TEMPLATE" > "$rendered"
plutil -lint "$rendered" >/dev/null || fail "生成的 plist 格式无效"

# 先卸载旧任务；失败通常表示尚未加载，不应阻止首次安装。
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
sleep 0.5
install -m 0644 "$rendered" "$DEST"
launchctl enable "$DOMAIN/$LABEL"
launchctl bootstrap "$DOMAIN" "$DEST"
launchctl kickstart -k "$DOMAIN/$LABEL"

for _ in {1..40}; do
  if curl -fsS --max-time 1 "http://$HOST:$PORT/api/health" >/dev/null 2>&1; then
    echo "已安装并启动：$LABEL"
    echo "访问地址：http://$HOST:$PORT/"
    echo "运行目录：$DEPLOY_ROOT"
    echo "plist：$DEST"
    exit 0
  fi
  sleep 0.5
done

echo "错误：LaunchAgent 已加载但健康检查未通过。" >&2
echo "请查看：$DEPLOY_ROOT/wms/project/logs/launchd.err.log" >&2
launchctl print "$DOMAIN/$LABEL" 2>&1 | head -40 >&2 || true
exit 1
