# 回归范围：审计发现问题的回归契约，使用临时文件和模拟依赖。
"""Audit regressions: preserve the required behavior of the implemented fixes.

All persistence lives in tmp_path. No test launches a browser, contacts WMS, or
replays a production operation.
"""

import errno
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from app.api.routes import CreateJobRequest
from app.core.config import Settings
from app.services import job_manager, wave_records
from app.services.job_manager import JobManager, JobRecord


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        automation_config_path=tmp_path / "unused-automation.json",
        browser_profile_dir=tmp_path / "profile",
        downloads_dir=tmp_path / "downloads",
        outputs_dir=tmp_path / "outputs",
    )


def _automation_that_must_not_run() -> SimpleNamespace:
    return SimpleNamespace(
        run=AsyncMock(side_effect=AssertionError("Audit tests must not execute jobs"))
    )


def _seed_job(tmp_path: Path, *, status: str = "running") -> JobRecord:
    record = JobRecord(
        id="audit-orphan-job",
        mode="generate_waves",
        status=status,
        result={
            "segments": [
                {
                    "channel": "CBT",
                    "seg_name": "single-1",
                    "wave_no": "W0092609050001",
                    "order_count": 2,
                }
            ]
        },
    )
    (tmp_path / "jobs.json").write_text(
        json.dumps([record.model_dump(mode="json")]), encoding="utf-8"
    )
    return record


def _saved_job(tmp_path: Path, job_id: str) -> dict:
    records = json.loads((tmp_path / "jobs.json").read_text(encoding="utf-8"))
    return next(record for record in records if record["id"] == job_id)


def test_a10_restart_does_not_restore_an_orphan_as_running(tmp_path: Path) -> None:
    original = _seed_job(tmp_path)
    automation = _automation_that_must_not_run()

    manager = JobManager(automation, settings=_settings(tmp_path))
    restored = manager.get(original.id)

    assert restored is not None
    assert manager.tasks == {}
    automation.run.assert_not_awaited()
    assert restored.status not in {"queued", "running"}, (
        "A restored job has no executor and must not remain active"
    )
    assert restored.result == original.result, "Confirmed wave numbers must survive"
    assert _saved_job(tmp_path, original.id)["status"] == restored.status


@pytest.mark.asyncio
async def test_a10_cancelling_an_orphan_persists_its_terminal_state(
    tmp_path: Path,
) -> None:
    original = _seed_job(tmp_path)
    automation = _automation_that_must_not_run()
    settings = _settings(tmp_path)
    manager = JobManager(automation, settings=settings)

    cancelled = await manager.cancel(original.id)

    assert cancelled is not None
    assert cancelled.status not in {"queued", "running"}
    assert _saved_job(tmp_path, original.id)["status"] == cancelled.status, (
        "Cancelling a job without an executor must persist its terminal state"
    )
    restarted = JobManager(automation, settings=settings)
    restored = restarted.get(original.id)
    assert restored is not None
    assert restored.status == cancelled.status
    assert restored.result == original.result
    automation.run.assert_not_awaited()


@pytest.mark.parametrize("order_nos", ["OBS123", 123], ids=["string", "integer"])
def test_a14_generate_request_rejects_non_list_order_numbers(order_nos: object) -> None:
    with pytest.raises(ValidationError):
        CreateJobRequest.model_validate(
            {
                "mode": "generate_waves",
                "confirm_production": True,
                "segments": [
                    {"channel": "CBT", "seg_name": "single-1", "order_nos": order_nos}
                ],
            }
        )


def test_a12_job_persistence_reports_replace_failure_and_preserves_old_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_job(tmp_path, status="succeeded")
    manager = JobManager(_automation_that_must_not_run(), settings=_settings(tmp_path))
    jobs_file = tmp_path / "jobs.json"
    original_bytes = jobs_file.read_bytes()
    replace = job_manager.os.replace

    def fail_job_replacement(source, destination):
        if Path(destination) == jobs_file:
            raise OSError(errno.ENOSPC, "simulated disk full")
        return replace(source, destination)

    monkeypatch.setattr(job_manager.os, "replace", fail_job_replacement)

    with pytest.raises(OSError, match="simulated disk full"):
        manager._persist(force=True)

    assert jobs_file.read_bytes() == original_bytes


def test_a12_upsert_rejects_corrupt_records_without_overwriting_them(
    tmp_path: Path,
) -> None:
    records_file = tmp_path / "wave-records.json"
    corrupt_bytes = b'{"records":[{"wave_no":"W_EXISTING"}'
    records_file.write_bytes(corrupt_bytes)

    try:
        with pytest.raises(ValueError):
            wave_records.upsert_records(
                tmp_path,
                [
                    {
                        "channel": "CBT",
                        "seg_name": "single-1",
                        "wave_no": "W_NEW",
                        "order_count": 1,
                    }
                ],
            )
    finally:
        assert records_file.read_bytes() == corrupt_bytes, (
            "Unreadable history must be preserved, not treated as an empty store"
        )
