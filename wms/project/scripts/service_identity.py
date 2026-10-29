# 服务进程身份辅助工具：记录并核对 PID、启动时间、项目与完整启动命令。
# PID 会复用，不能仅凭 PID 存活就停止进程；此模块本身不发送停止信号。
"""Single-machine service identity checks. This helper never sends signals."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def process_snapshot(pid: int) -> dict[str, str]:
    values = {}
    for key, field in (("command", "command="), ("started", "lstart=")):
        # macOS ps escapes non-ASCII command paths in the C locale. Keep UTF-8
        # for command identity, but stable English timestamps for lstart.
        locale = ("en_US.UTF-8" if sys.platform == "darwin" else "C.UTF-8") if key == "command" else "C"
        result = subprocess.run(["/bin/ps", "-ww", "-p", str(pid), "-o", field],
                                capture_output=True, text=True, encoding="utf-8", check=False,
                                env={**os.environ, "LC_ALL": locale}, timeout=3)
        value = result.stdout.strip()
        if result.returncode or not value:
            raise ValueError("无法读取进程身份")
        values[key] = value
    return values


def matches_command(command: str, project: Path, host: str, port: int) -> bool:
    # ps does not quote paths containing spaces. Match the complete known suffix,
    # then resolve the remaining executable path, rather than splitting on spaces.
    suffix = f" -m uvicorn app.main:app --app-dir {project / 'backend'} --host {host} --port {port}"
    if not command.endswith(suffix):
        return False
    executable = command[:-len(suffix)]
    return Path(executable).resolve() == Path(sys.executable).resolve()


def identity_path(pid_file: Path) -> Path:
    return pid_file.with_name(pid_file.name + ".identity.json")


def record(pid_file: Path, pid: int, project: Path, host: str, port: int) -> None:
    project = project.resolve()
    snapshot = process_snapshot(pid)
    if not matches_command(snapshot["command"], project, host, port):
        raise ValueError("尚未确认本项目的完整启动命令")
    data = {"version": 1, "pid": pid, "project": str(project), "port": port,
            "host": host, "python": str(Path(sys.executable).resolve()), **snapshot}
    target = identity_path(pid_file)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent,
                                         prefix=".service-identity-", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(data, stream, ensure_ascii=False)
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def verify(pid_file: Path, pid: int, project: Path, port: int) -> bool:
    data = json.loads(identity_path(pid_file).read_text("utf-8"))
    if not isinstance(data, dict) or data.get("version") != 1:
        return False
    project = project.resolve()
    if (data.get("pid") != pid or data.get("project") != str(project) or data.get("port") != port
            or data.get("python") != str(Path(sys.executable).resolve())
            or not isinstance(data.get("host"), str)):
        return False
    current = process_snapshot(pid)
    return (current["command"] == data.get("command") and current["started"] == data.get("started")
            and matches_command(current["command"], project, data["host"], port))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["record", "verify"])
    parser.add_argument("--pid-file", type=Path, required=True)
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--ip", default="127.0.0.1")
    args = parser.parse_args()
    if not 1 < args.pid <= 2147483647 or not 1 <= args.port <= 65535:
        return 2
    try:
        if args.operation == "record":
            record(args.pid_file, args.pid, args.project, args.ip, args.port)
            return 0
        return 0 if verify(args.pid_file, args.pid, args.project, args.port) else 2
    except (OSError, ValueError, subprocess.SubprocessError):
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
