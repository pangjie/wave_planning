"""Local runtime ownership uses only disposable paths and fake automation."""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI
import pytest

from app import main
from app.core.runtime_lock import RuntimeAlreadyRunningError, exclusive_runtime


def with_profile(settings, profile):
    return settings.model_copy(update={"browser_profile_dir": profile})


def test_same_process_cannot_acquire_twice_and_files_are_not_deleted(isolated_runtime):
    profile = isolated_runtime.browser_profile_dir
    with exclusive_runtime(isolated_runtime):
        inodes = {
            path: path.stat().st_ino
            for path in (profile.parent / ".wms-service.lock", profile / ".wms-profile.lock")
        }
        with pytest.raises(RuntimeAlreadyRunningError, match="更换端口不能解除占用"):
            with exclusive_runtime(isolated_runtime):
                pytest.fail("duplicate runtime entered")
    assert all(path.stat().st_ino == inode for path, inode in inodes.items())
    with exclusive_runtime(isolated_runtime):
        assert all(path.stat().st_ino == inode for path, inode in inodes.items())


def test_independent_data_and_profiles_can_run_together(isolated_runtime, tmp_path):
    other = with_profile(isolated_runtime, tmp_path / "other-data/profile")
    with exclusive_runtime(isolated_runtime), exclusive_runtime(other):
        pass


def test_different_profiles_in_same_data_directory_are_not_independent(isolated_runtime):
    other = with_profile(isolated_runtime, isolated_runtime.browser_profile_dir.parent / "other-profile")
    with exclusive_runtime(isolated_runtime):
        with pytest.raises(RuntimeAlreadyRunningError):
            with exclusive_runtime(other):
                pytest.fail("shared jobs.json must not have two owners")


def test_symlink_data_alias_does_not_bypass_lock(isolated_runtime, tmp_path):
    alias = tmp_path / "data-alias"
    alias.symlink_to(isolated_runtime.browser_profile_dir.parent, target_is_directory=True)
    other = with_profile(isolated_runtime, alias / isolated_runtime.browser_profile_dir.name)
    with exclusive_runtime(isolated_runtime):
        with pytest.raises(RuntimeAlreadyRunningError):
            with exclusive_runtime(other):
                pytest.fail("data directory alias bypassed ownership")


def test_shared_canonical_profile_and_partial_acquisition_cleanup(isolated_runtime, tmp_path):
    target = tmp_path / "zz-profile"
    target.mkdir()
    profiles = []
    for directory in ("00-first-data", "01-second-data"):
        profile = tmp_path / directory / "profile"
        profile.parent.mkdir()
        profile.symlink_to(target, target_is_directory=True)
        profiles.append(profile)
    first, second = [with_profile(isolated_runtime, profile) for profile in profiles]
    with exclusive_runtime(first):
        with pytest.raises(RuntimeAlreadyRunningError, match="wms-profile"):
            with exclusive_runtime(second):
                pytest.fail("canonical profile has two owners")
        # The second data lock was acquired first, then released when the
        # profile lock failed. It must not obstruct a truly separate profile.
        separate = with_profile(second, profiles[1].parent / "separate-profile")
        with exclusive_runtime(separate):
            pass


def test_body_exception_releases_both_locks(isolated_runtime):
    with pytest.raises(ValueError, match="original failure"):
        with exclusive_runtime(isolated_runtime):
            raise ValueError("original failure")
    with exclusive_runtime(isolated_runtime):
        pass


def test_non_contention_io_errors_are_not_reported_as_another_service(isolated_runtime, monkeypatch):
    import app.core.runtime_lock as locks

    monkeypatch.setattr(locks.fcntl, "flock", Mock(side_effect=OSError("disk problem")))
    with pytest.raises(OSError, match="disk problem"):
        with exclusive_runtime(isolated_runtime):
            pytest.fail("failed lock was accepted")


CHILD = """
import sys
from app.core.config import Settings
from app.core.runtime_lock import RuntimeAlreadyRunningError, exclusive_runtime
settings = Settings.model_validate_json(sys.argv[1])
try:
    with exclusive_runtime(settings):
        print('LOCKED', flush=True)
        sys.stdin.readline()
except RuntimeAlreadyRunningError:
    print('BUSY', flush=True)
    sys.exit(23)
"""


def child_options(settings):
    backend = Path(__file__).resolve().parents[1] / "backend"
    env = {name: os.environ[name] for name in ("PATH", "LANG", "LC_ALL", "TMPDIR") if name in os.environ}
    env.update({"PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": str(backend)})
    return {
        "args": [sys.executable, "-c", CHILD, settings.model_dump_json()],
        "env": env,
        "cwd": str(settings.browser_profile_dir.parent),
        "text": True,
    }


@contextmanager
def child_owner(settings):
    child = subprocess.Popen(
        **child_options(settings),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            assert selector.select(10), "temporary lock-holder did not start"
        assert child.stdout.readline().strip() == "LOCKED"
        yield child
    finally:
        if child.poll() is None:
            try:
                child.communicate("\n", timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.communicate(timeout=5)
        else:
            child.communicate(timeout=5)


def test_competing_child_process_is_rejected_before_entry(isolated_runtime):
    with exclusive_runtime(isolated_runtime):
        result = subprocess.run(
            **child_options(isolated_runtime), input="\n", capture_output=True, timeout=10,
        )
        assert result.returncode == 23, result.stderr
        assert result.stdout.strip() == "BUSY"


@pytest.mark.parametrize("abrupt", [False, True])
def test_child_owner_release_on_exit_including_abrupt_exit(isolated_runtime, abrupt):
    with child_owner(isolated_runtime) as child:
        with pytest.raises(RuntimeAlreadyRunningError):
            with exclusive_runtime(isolated_runtime):
                pytest.fail("second process acquired active lock")
        if abrupt:
            child.kill()
            child.wait(timeout=5)
        else:
            child.communicate("\n", timeout=5)
        with exclusive_runtime(isolated_runtime):
            pass


async def test_second_lifespan_does_not_construct_manager_or_recover_jobs(isolated_runtime, monkeypatch):
    first = FastAPI()
    async with main.lifespan(first):
        jobs_file = isolated_runtime.browser_profile_dir.parent / "jobs.json"
        original = b'[{"id":"active-first-service","status":"running"}]'
        jobs_file.write_bytes(original)
        manager = Mock(side_effect=AssertionError("second manager must not be constructed"))
        monkeypatch.setattr(main, "JobManager", manager)
        with pytest.raises(RuntimeAlreadyRunningError):
            async with main.lifespan(FastAPI()):
                pytest.fail("duplicate lifespan entered")
        manager.assert_not_called()
        assert jobs_file.read_bytes() == original


async def test_lifespan_initialization_failure_releases_ownership(isolated_runtime, monkeypatch):
    monkeypatch.setattr(main, "JobManager", Mock(side_effect=ValueError("invalid saved history")))
    with pytest.raises(ValueError, match="invalid saved history"):
        async with main.lifespan(FastAPI()):
            pytest.fail("initialization should fail")
    with exclusive_runtime(isolated_runtime):
        pass


@pytest.mark.parametrize("body_error", [False, True])
async def test_lifespan_releases_after_normal_or_exceptional_body(isolated_runtime, body_error):
    async def run_service():
        async with main.lifespan(FastAPI()):
            with pytest.raises(RuntimeAlreadyRunningError):
                with exclusive_runtime(isolated_runtime):
                    pytest.fail("running lifespan lost ownership")
            if body_error:
                raise ValueError("body failure")
    if body_error:
        with pytest.raises(ValueError, match="body failure"):
            await run_service()
    else:
        await run_service()
    with exclusive_runtime(isolated_runtime):
        pass


@pytest.mark.parametrize("cancel_shutdown", [False, True])
@pytest.mark.parametrize("cancel_job_first", [False, True])
async def test_shutdown_waits_for_job_cleanup_and_save_before_unlock(
    isolated_runtime, monkeypatch, cancel_shutdown, cancel_job_first,
):
    started = asyncio.Event()
    stop_service = asyncio.Event()
    cleaning = asyncio.Event()
    release_cleanup = asyncio.Event()
    shutdown_cancel_started = asyncio.Event()
    cleanup_interrupted = asyncio.Event()
    app = FastAPI()

    async def run(progress, headless):
        await progress("fake_running", "Temporary fake task")
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaning.set()
            try:
                await release_cleanup.wait()
            except asyncio.CancelledError:
                cleanup_interrupted.set()
                raise

    monkeypatch.setattr(main, "WmsExportAutomation", lambda *args: SimpleNamespace(run=run))

    async def service():
        async with main.lifespan(app):
            app.state.job = app.state.job_manager.create("export", "headless")
            await stop_service.wait()

    owner = asyncio.create_task(service())
    cancelling = None
    try:
        await asyncio.wait_for(started.wait(), 3)
        original_cancel = app.state.job_manager.cancel

        async def tracked_cancel(job_id):
            if stop_service.is_set():
                shutdown_cancel_started.set()
            return await original_cancel(job_id)

        monkeypatch.setattr(app.state.job_manager, "cancel", tracked_cancel)
        if cancel_job_first:
            cancelling = asyncio.create_task(app.state.job_manager.cancel(app.state.job.id))
            await asyncio.wait_for(cleaning.wait(), 3)
        stop_service.set()
        await asyncio.wait_for(shutdown_cancel_started.wait(), 3)
        await asyncio.wait_for(cleaning.wait(), 3)
        await asyncio.sleep(0)
        assert not cleanup_interrupted.is_set(), "Shutdown cancelled browser cleanup a second time"
        if cancel_shutdown:
            owner.cancel()
            await asyncio.sleep(0)
            owner.cancel()
            await asyncio.sleep(0)
        assert not owner.done()
        with pytest.raises(RuntimeAlreadyRunningError):
            with exclusive_runtime(isolated_runtime):
                pytest.fail("lock released while browser cleanup was pending")
        release_cleanup.set()
        if cancel_shutdown:
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(owner, 3)
        else:
            await asyncio.wait_for(owner, 3)
        assert app.state.job.status == "cancelled"
        saved = json.loads((isolated_runtime.browser_profile_dir.parent / "jobs.json").read_text())
        assert saved[0]["status"] == "cancelled"
        with exclusive_runtime(isolated_runtime):
            pass
    finally:
        stop_service.set()
        release_cleanup.set()
        if not owner.done():
            owner.cancel()
        await asyncio.gather(owner, return_exceptions=True)
        if cancelling is not None:
            await asyncio.gather(cancelling, return_exceptions=True)


async def test_cancel_request_disconnection_does_not_interrupt_executor_cleanup(isolated_runtime):
    from app.services.job_manager import JobManager

    started = asyncio.Event()
    cleaning = asyncio.Event()
    released = asyncio.Event()
    interrupted = asyncio.Event()

    async def run(progress, headless):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaning.set()
            try:
                await released.wait()
            except asyncio.CancelledError:
                interrupted.set()
                raise

    manager = JobManager(SimpleNamespace(run=run), settings=isolated_runtime)
    job = manager.create("export")
    await asyncio.wait_for(started.wait(), 3)
    request = asyncio.create_task(manager.cancel(job.id))
    try:
        await asyncio.wait_for(cleaning.wait(), 3)
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        assert not interrupted.is_set()
        assert not manager.tasks[job.id].done()
    finally:
        released.set()
        await asyncio.gather(request, manager.tasks[job.id], return_exceptions=True)
    assert job.status == "cancelled"
