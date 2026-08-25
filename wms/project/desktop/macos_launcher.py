"""macOS 应用入口：准备本机数据目录，启动服务并打开控制台。"""

from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
from urllib.error import URLError
from urllib.request import urlopen
import webbrowser


APP_NAME = "WMS自动化控制台"
HOST = "127.0.0.1"
PORT = int(os.getenv("WMS_APP_PORT", "8000"))
BASE_URL = f"http://{HOST}:{PORT}"


def bundled_root() -> Path:
    """返回 PyInstaller 解包资源目录；源码运行时返回项目根目录。"""
    frozen_root = getattr(sys, "_MEIPASS", None)
    if frozen_root:
        return Path(frozen_root).resolve()
    return Path(__file__).resolve().parents[1]


def app_support_dir() -> Path:
    return Path.home() / "Library" / "Application Support" / APP_NAME


def log_dir() -> Path:
    return Path.home() / "Library" / "Logs" / APP_NAME


def configure_runtime() -> Path:
    """把可变数据放到用户目录，把只读配置指向应用资源。"""
    resources = bundled_root()
    support = app_support_dir()
    logs = log_dir()
    support.mkdir(parents=True, exist_ok=True)
    logs.mkdir(parents=True, exist_ok=True)

    runtime_paths = {
        "WMS_PROJECT_ROOT": resources,
        "WMS_FRONTEND_DIST": resources / "frontend" / "dist",
        "WMS_AUTOMATION_CONFIG": resources / "config" / "automation.json",
        "WMS_BROWSER_PROFILE": support / "browser-profile",
        "WMS_DOWNLOADS_DIR": support / "downloads",
        "WMS_SECONDARY_DOWNLOADS_DIR": Path.home() / "Downloads",
    }
    for name, value in runtime_paths.items():
        os.environ.setdefault(name, str(value))

    return logs / "service.log"


def redirect_output(log_path: Path) -> None:
    """窗口应用没有终端，将 Python 与 Uvicorn 输出统一写入日志。"""
    stream = log_path.open("a", encoding="utf-8", buffering=1)
    sys.stdout = stream
    sys.stderr = stream
    print(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] 启动 {APP_NAME}")


def service_is_ready(timeout: float = 0.8) -> bool:
    try:
        with urlopen(f"{BASE_URL}/api/health", timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return response.status == 200 and payload.get("status") == "ok"
    except (OSError, URLError, ValueError, json.JSONDecodeError):
        return False


def port_is_occupied() -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((HOST, PORT)) == 0


def show_error(message: str) -> None:
    """尽量通过原生对话框提示；失败时仍会保留日志。"""
    escaped = message.replace("\\", "\\\\").replace('"', '\\"')
    script = f'display alert "{APP_NAME}" message "{escaped}" as critical'
    try:
        subprocess.run(
            ["/usr/bin/osascript", "-e", script],
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        print(message)


def open_console_when_ready() -> None:
    for _ in range(120):
        if service_is_ready():
            if os.getenv("WMS_APP_NO_BROWSER") != "1":
                webbrowser.open(BASE_URL)
            return
        time.sleep(0.25)
    show_error(f"服务未能在 30 秒内启动。请查看日志：{log_dir() / 'service.log'}")


def main() -> int:
    log_path = configure_runtime()
    redirect_output(log_path)

    # 再次打开应用时只复用现有服务，不创建第二个后端进程。
    if service_is_ready():
        if os.getenv("WMS_APP_NO_BROWSER") != "1":
            webbrowser.open(BASE_URL)
        print("检测到现有服务，已复用。")
        return 0

    if port_is_occupied():
        message = f"端口 {PORT} 已被其它程序占用，无法启动服务。"
        print(message)
        show_error(message)
        return 1

    threading.Thread(target=open_console_when_ready, daemon=True).start()

    # 延迟导入，确保配置环境变量在 FastAPI 模块初始化前生效。
    import uvicorn
    from app.main import app

    uvicorn.run(
        app,
        host=HOST,
        port=PORT,
        log_level="info",
        access_log=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
