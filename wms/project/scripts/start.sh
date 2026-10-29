#!/usr/bin/env bash
# 服务管理入口；命令行参数覆盖环境默认值，相对路径按项目根目录解析。
# 停止/重启前核对进程身份，启动后等待健康检查；不把占用端口的任意进程当作本服务。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
IDENTITY_TOOL="$ROOT_DIR/scripts/service_identity.py"
DEFAULT_IP="${HOST:-127.0.0.1}"
DEFAULT_PORT="${PORT:-8000}"

COMMAND=""
BIND_IP="$DEFAULT_IP"
SERVICE_PORT="$DEFAULT_PORT"
LOG_FILE=""
PID_FILE=""

usage() {
  cat <<'EOF'
波次规划服务管理器

用法：
  ./scripts/start.sh [start|stop|restart|status] [选项]
  ./scripts/start.sh PORT                 # 兼容旧式调用，等同于 start --port PORT

命令：
  start       后台启动服务（默认命令）
  stop        平滑停止服务
  restart     停止后重新启动
  status      显示进程与健康状态

选项：
  --ip IP             监听地址，默认读取 HOST，未设置时为 127.0.0.1
  --port PORT         监听端口，默认读取 PORT，未设置时为 8000
  --log PATH          日志文件，默认 logs/service-PORT.log
  --pid-file PATH     PID 文件，默认 data/service-PORT.pid
  -h, --help          显示帮助

相对路径均以项目根目录为基准。命令行参数优先于环境变量。
EOF
}

fail() {
  echo "错误：$*" >&2
  exit 2
}

need_value() {
  [[ $# -ge 2 && -n "$2" ]] || fail "$1 缺少参数值"
}

resolve_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$ROOT_DIR" "$1" ;;
  esac
}

if [[ $# -eq 0 ]]; then
  COMMAND="start"
else
  case "$1" in
    start|stop|restart|status)
      COMMAND="$1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    ''|*[!0-9]*)
      if [[ "$1" == --* ]]; then
        COMMAND="start"
      else
        fail "未知命令：$1"
      fi
      ;;
    *)
      COMMAND="start"
      SERVICE_PORT="$1"
      shift
      ;;
  esac
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ip|--host)
      need_value "$1" "${2:-}"
      BIND_IP="$2"
      shift 2
      ;;
    --port)
      need_value "$1" "${2:-}"
      SERVICE_PORT="$2"
      shift 2
      ;;
    --log)
      need_value "$1" "${2:-}"
      LOG_FILE="$2"
      shift 2
      ;;
    --pid-file)
      need_value "$1" "${2:-}"
      PID_FILE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "未知参数：$1"
      ;;
  esac
done

[[ -n "$BIND_IP" && "$BIND_IP" != *[[:space:]]* ]] || fail "IP 地址不能为空或包含空格"
[[ "$SERVICE_PORT" =~ ^[0-9]+$ ]] || fail "端口必须为整数：$SERVICE_PORT"
[[ ${#SERVICE_PORT} -le 5 ]] || fail "端口必须位于 1 到 65535 之间：$SERVICE_PORT"
SERVICE_PORT=$((10#$SERVICE_PORT))
(( SERVICE_PORT >= 1 && SERVICE_PORT <= 65535 )) || fail "端口必须位于 1 到 65535 之间：$SERVICE_PORT"

LOG_FILE="$(resolve_path "${LOG_FILE:-logs/service-$SERVICE_PORT.log}")"
PID_FILE="$(resolve_path "${PID_FILE:-data/service-$SERVICE_PORT.pid}")"

read_pid() {
  local pid=""
  [[ -f "$PID_FILE" ]] || return 1
  IFS= read -r pid < "$PID_FILE" || true
  [[ "$pid" =~ ^[1-9][0-9]{0,9}$ ]] || return 1
  (( pid > 1 && pid <= 2147483647 )) || return 1
  printf '%s\n' "$pid"
}

process_alive() {
  kill -0 "$1" 2>/dev/null
}

pid_matches_service() {
  [[ -x "$PYTHON_BIN" && -f "$IDENTITY_TOOL" ]] || return 1
  "$PYTHON_BIN" "$IDENTITY_TOOL" verify --pid "$1" --pid-file "$PID_FILE" \
    --project "$ROOT_DIR" --port "$SERVICE_PORT"
}

record_identity() {
  [[ "$(read_pid || true)" == "$1" ]] || return 1
  "$PYTHON_BIN" "$IDENTITY_TOOL" record --pid "$1" --pid-file "$PID_FILE" \
    --project "$ROOT_DIR" --ip "$BIND_IP" --port "$SERVICE_PORT"
}

remove_owned_pid() {
  # Do not remove a newer invocation's PID/identity while cleaning up an old one.
  [[ "$(read_pid || true)" == "$1" ]] || return 0
  rm -f "$PID_FILE" "$PID_FILE.identity.json"
}

port_pids() {
  local lsof_bin=""
  lsof_bin="$(command -v lsof || true)"
  [[ -n "$lsof_bin" ]] || return 0
  "$lsof_bin" -nP -iTCP:"$SERVICE_PORT" -sTCP:LISTEN -t 2>/dev/null || true
}

health_url() {
  local connect_ip="$BIND_IP"
  case "$connect_ip" in
    0.0.0.0) connect_ip="127.0.0.1" ;;
    ::) connect_ip="::1" ;;
  esac
  if [[ "$connect_ip" == *:* ]]; then
    printf 'http://[%s]:%s/api/health\n' "$connect_ip" "$SERVICE_PORT"
  else
    printf 'http://%s:%s/api/health\n' "$connect_ip" "$SERVICE_PORT"
  fi
}

service_healthy() {
  curl -fsS --max-time 1 "$(health_url)" >/dev/null 2>&1
}

check_runtime() {
  [[ -x "$PYTHON_BIN" ]] || fail "依赖尚未安装，请先运行 ./scripts/setup.sh。"
  [[ -f "$IDENTITY_TOOL" ]] || fail "缺少 scripts/service_identity.py，请使用完整项目。"
  if [[ ! -f "$ROOT_DIR/frontend/dist/index.html" ]]; then
    echo "错误：未找到控制台页面 frontend/dist/index.html。" >&2
    echo "请在 planner/ 中运行 python3 build.py（会自动部署到本目录）。" >&2
    exit 2
  fi
}

start_service() {
  # 后台启动后同时确认进程身份与健康接口；仅端口可连接不足以证明启动了正确实例。
  local pid="" owners="" i="" identified="false"
  check_runtime

  pid="$(read_pid || true)"
  if [[ -n "$pid" ]] && process_alive "$pid"; then
    if pid_matches_service "$pid"; then
      echo "服务已经运行：PID ${pid}，http://${BIND_IP}:${SERVICE_PORT}/"
      return 0
    fi
    echo "错误：PID 文件指向存活进程（PID ${pid}），但无法可靠确认归属，已拒绝启动。" >&2
    echo "请核对后手动移除：$PID_FILE" >&2
    return 2
  fi
  [[ -z "$pid" ]] || remove_owned_pid "$pid"

  owners="$(port_pids)"
  if [[ -n "$owners" ]]; then
    echo "错误：端口 $SERVICE_PORT 已被进程占用：$(echo "$owners" | tr '\n' ' ')" >&2
    echo "该进程不是由当前 PID 文件管理，未执行任何终止操作。" >&2
    return 2
  fi

  mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$PID_FILE")"
  {
    echo
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 启动服务：$BIND_IP:$SERVICE_PORT"
  } >> "$LOG_FILE"

  cd "$ROOT_DIR"
  PYTHONPATH=backend nohup "$PYTHON_BIN" -m uvicorn app.main:app \
    --app-dir "$ROOT_DIR/backend" --host "$BIND_IP" --port "$SERVICE_PORT" >> "$LOG_FILE" 2>&1 < /dev/null &
  pid=$!
  printf '%s\n' "$pid" > "$PID_FILE.tmp"
  mv "$PID_FILE.tmp" "$PID_FILE"

  for i in {1..40}; do
    if ! process_alive "$pid"; then
      remove_owned_pid "$pid"
      echo "错误：服务启动后立即退出，请检查日志：$LOG_FILE" >&2
      tail -n 20 "$LOG_FILE" >&2 || true
      return 1
    fi
    if [[ "$identified" == "false" ]] && record_identity "$pid"; then
      identified="true"
    fi
    if [[ "$identified" == "true" ]] && pid_matches_service "$pid" && service_healthy; then
      echo "服务启动成功：PID $pid"
      echo "访问地址：http://$BIND_IP:$SERVICE_PORT/"
      echo "日志文件：$LOG_FILE"
      echo "PID 文件：$PID_FILE"
      return 0
    fi
    sleep 0.25
  done

  echo "错误：服务进程已启动，但健康检查在 10 秒内未通过。" >&2
  if [[ "$identified" == "true" ]] && pid_matches_service "$pid"; then
    kill "$pid" 2>/dev/null || true
    # Retain identity until termination is confirmed, so a slow exit stays manageable.
    if ! process_alive "$pid"; then remove_owned_pid "$pid"; fi
  else
    echo "无法确认 PID $pid 的完整身份，未终止进程；请核对 PID 文件和日志。" >&2
  fi
  tail -n 20 "$LOG_FILE" >&2 || true
  return 1
}

stop_service() {
  # 先发 TERM 留给后端保存/清理，等待 10 秒后重新核对身份才允许 KILL。
  # 这里的超时是进程退出期限，不是任务完成期限；停止会中断正在运行的任务。
  local pid="" i=""
  pid="$(read_pid || true)"
  if [[ -z "$pid" ]]; then
    echo "服务未运行（没有有效 PID 文件）：$PID_FILE"
    return 0
  fi
  if ! process_alive "$pid"; then
    remove_owned_pid "$pid"
    echo "已清理失效 PID 文件；服务当前未运行。"
    return 0
  fi
  if ! pid_matches_service "$pid"; then
    echo "错误：无法确认 PID $pid 属于本项目、本端口及原启动实例，已拒绝停止。" >&2
    echo "旧版或缺失身份记录的 PID 文件不会自动接管，请核对原启动进程。" >&2
    return 2
  fi

  echo "正在停止服务：PID $pid"
  kill "$pid"
  for i in {1..40}; do
    if ! process_alive "$pid"; then
      remove_owned_pid "$pid"
      echo "服务已停止。"
      return 0
    fi
    sleep 0.25
  done

  if ! pid_matches_service "$pid"; then
    echo "等待期间进程身份已变化或无法确认，未强制终止 PID ${pid}，保留记录供核对。" >&2
    return 2
  fi
  echo "服务未在 10 秒内退出，已重新确认身份，正在强制终止 PID ${pid}。" >&2
  kill -9 "$pid" 2>/dev/null || true
  for i in {1..20}; do
    if ! process_alive "$pid"; then
      remove_owned_pid "$pid"
      echo "服务已强制停止。"
      return 0
    fi
    sleep 0.1
  done
  echo "无法确认进程已退出，保留 PID 与身份记录，请核对。" >&2
  return 2
}

status_service() {
  local pid="" owners=""
  pid="$(read_pid || true)"
  if [[ -n "$pid" ]] && process_alive "$pid"; then
    if ! pid_matches_service "$pid"; then
      echo "状态异常：无法确认 PID ${pid} 的项目、端口或原启动身份（旧版 PID 文件也不会自动接管）。" >&2
      return 2
    fi
    if service_healthy; then
      echo "运行中且健康：PID ${pid}，http://${BIND_IP}:${SERVICE_PORT}/"
      echo "日志文件：$LOG_FILE"
      return 0
    fi
    echo "进程存在但健康检查失败：PID $pid" >&2
    return 2
  fi

  if [[ -n "$pid" ]]; then
    echo "服务未运行，PID 文件已经失效：$PID_FILE" >&2
    return 1
  fi
  owners="$(port_pids)"
  if [[ -n "$owners" ]]; then
    echo "端口 $SERVICE_PORT 被未受当前 PID 文件管理的进程占用：$(echo "$owners" | tr '\n' ' ')" >&2
    return 2
  fi
  echo "服务未运行。"
  return 1
}

case "$COMMAND" in
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    stop_service
    start_service
    ;;
  status)
    status_service
    ;;
esac
