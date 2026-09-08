"""Single-machine ownership for this application's data and browser profile.

The open descriptors, not the presence of the files, own the locks. Keep the
files after release so another process cannot lock a replacement inode. This
only coordinates cooperating application entry points, not manually launched
Chrome instances. An older service without these locks must be stopped before
starting the updated service. macOS and Linux are the supported runtimes.
"""

from __future__ import annotations

from contextlib import ExitStack, contextmanager
import fcntl
from collections.abc import Iterator

from app.core.config import Settings


class RuntimeAlreadyRunningError(RuntimeError):
    """Another local service already owns shared runtime files."""


@contextmanager
def exclusive_runtime(settings: Settings) -> Iterator[None]:
    # Resolve each separately: a profile symlink can point outside its data
    # directory, while sibling profiles still share their parent's jobs.json.
    data_dir = settings.browser_profile_dir.parent.resolve()
    profile_dir = settings.browser_profile_dir.resolve()
    lock_paths = sorted({
        data_dir / ".wms-service.lock",
        profile_dir / ".wms-profile.lock",
    })
    with ExitStack() as stack:
        for path in lock_paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            stream = stack.enter_context(path.open("a+b"))
            try:
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeAlreadyRunningError(
                    "当前数据目录或浏览器会话已被另一个本机服务占用，不能重复启动。"
                    f"请先正常停止原服务，再启动本服务；更换端口不能解除占用。锁位置：{path}"
                ) from exc
        yield
