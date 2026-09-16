"""B4 plan identity/snapshot contracts; only mock tasks and temporary artifacts."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app.services import job_plans
from app.services.job_manager import JobManager, JobRecord
from app.services.wave_records import clear_records, read_records, upsert_records


def segments():
    return [{"channel": "CBT", "seg_name": "单件1", "order_nos": ["O1", "O2"]}]


def snapshot():
    return {"version": 1, "workbook": {"filename": "波次规划20260907.xlsx", "sheets": [
        {"name": "波次表", "aoa": [["header"], ["CBT", "", "", "", "", 1, 2, 2, ""]],
         "waveRefs": [{"channel": "CBT", "seg_name": "单件1", "row": 1}]},
        {"name": "客户统计", "aoa": [["客户", "订单数"], ["原客户", 2]]},
    ]}}


def scoped_record(batch="B1", plan="P1", wave="W1"):
    return {**segments()[0], "batch_id": batch, "plan_id": plan, "job_id": "job",
            "wave_no": wave, "order_count": 2}


def seed_job(manager):
    job = JobRecord(id="snapshot-job", mode="generate_waves", status="succeeded",
                    batch_id="B1", plan_id="P1", has_plan_snapshot=True, segments=segments(),
                    result={"segments": [scoped_record()]})
    manager.jobs[job.id] = job
    job_plans.save_plan(manager.wave_records_dir, job.id, snapshot())
    return job


def test_scoped_history_read_upsert_clear_preserves_other_plans(tmp_path):
    upsert_records(tmp_path, [scoped_record(), scoped_record(plan="P2", wave="W2"),
                              scoped_record(batch="B2", wave="W3"), {"channel": "CBT", "seg_name": "单件1", "wave_no": "OLD"}])
    assert len(read_records(tmp_path)) == 4
    upsert_records(tmp_path, [scoped_record(wave="W4")])
    assert read_records(tmp_path, batch_id="B1", plan_id="P1")[0]["wave_no"] == "W4"
    clear_records(tmp_path, batch_id="B1", plan_id="P1")
    assert {r["wave_no"] for r in read_records(tmp_path)} == {"W2", "W3", "OLD"}
    clear_records(tmp_path)  # old clients cannot erase new scoped records
    assert {r["wave_no"] for r in read_records(tmp_path)} == {"W2", "W3"}


@pytest.mark.parametrize("change", ["version", "count", "row", "reference", "missing", "duplicate"])
def test_invalid_snapshot_rejected_before_execution(app, monkeypatch, change):
    plan = snapshot()
    table = plan["workbook"]["sheets"][0]
    if change == "version": plan["version"] = 9
    if change == "count": table["aoa"][1][6] = 20
    if change == "row": table["waveRefs"][0]["row"] = -1
    if change == "reference": table["waveRefs"][0]["channel"] = "USPS"
    if change == "missing": table.pop("waveRefs")
    if change == "duplicate": table["waveRefs"] *= 2
    with TestClient(app) as client:
        create = AsyncMock(side_effect=AssertionError("must not start"))
        monkeypatch.setattr(app.state.job_manager, "create", create)
        response = client.post("/api/jobs", json={"mode": "generate_waves", "confirm_production": True,
            "segments": segments(), "batch_id": "B1", "plan_id": "P1", "plan_snapshot": plan})
        assert response.status_code == 422
        create.assert_not_called()


@pytest.mark.asyncio
async def test_snapshot_saved_before_scheduling_and_survives_reload(isolated_runtime, monkeypatch):
    automation = SimpleNamespace(run=AsyncMock(side_effect=AssertionError("no WMS")))
    manager = JobManager(automation, settings=isolated_runtime)
    execution = AsyncMock()
    monkeypatch.setattr(manager, "_execute", execution)
    plan, submitted = snapshot(), segments()
    job = manager.create("generate_waves", segments=submitted, batch_id="B1", plan_id="P1", plan_snapshot=plan)
    assert execution.await_count == 0
    assert job_plans.read_plan(manager.wave_records_dir, job.id, job.segments) == plan
    plan["workbook"]["sheets"][1]["aoa"][1][0] = "新客户"
    submitted[0]["order_nos"].append("O3")
    assert job.segments == segments()
    assert job_plans.read_plan(manager.wave_records_dir, job.id, job.segments) == snapshot()
    await manager.tasks[job.id]
    restored = JobManager(automation, settings=isolated_runtime)
    assert restored.get(job.id).plan_id == "P1"
    assert "workbook" not in restored.get(job.id).model_dump_json()
    assert job_plans.read_plan(manager.wave_records_dir, job.id, job.segments) == snapshot()
    automation.run.assert_not_awaited()


@pytest.mark.asyncio
async def test_snapshot_write_failure_never_accepts_or_starts_job(isolated_runtime, monkeypatch):
    manager = JobManager(SimpleNamespace(run=AsyncMock()), settings=isolated_runtime)
    def fail(*_): raise OSError("disk full")
    monkeypatch.setattr(job_plans.os, "replace", fail)
    with pytest.raises(OSError, match="disk full"):
        manager.create("generate_waves", segments=segments(), batch_id="B1", plan_id="P1", plan_snapshot=snapshot())
    assert not manager.jobs and not manager.tasks
    assert not list(manager.wave_records_dir.glob("plans/.plan-*.tmp"))


def test_confirmed_history_gets_submitted_identity_and_order_set(app):
    with TestClient(app):
        manager = app.state.job_manager
        job = seed_job(manager)
        job.result = {"segments": [{"channel": "CBT", "seg_name": "单件1", "wave_no": "W1", "order_count": 1}]}
        assert manager._save_wave_records(job)
        record = read_records(manager.wave_records_dir, batch_id="B1", plan_id="P1")[0]
        assert record["order_nos"] == ["O1", "O2"]  # cancelled orders may reduce selected count, not submitted identity
        assert record["order_count"] == 1
        assert record["job_id"] == job.id


def test_snapshot_api_and_idempotent_export_across_retry_and_reload(app):
    with TestClient(app) as client:
        manager = app.state.job_manager
        job = seed_job(manager)
        response = client.get(f"/api/jobs/{job.id}/plan")
        assert response.json() == {"batch_id": "B1", "plan_id": "P1", "snapshot": snapshot()}
        payload = b"PK\x03\x04" + b"original" * 200
        first = client.post(f"/api/jobs/{job.id}/planning-export", content=payload)
        assert first.status_code == 200
        manager._load_persisted()
        second = client.post(f"/api/jobs/{job.id}/planning-export", content=b"PK\x03\x04" + b"different" * 200)
        assert second.json() == first.json()
        assert client.get(first.json()["url"]).content == payload
        assert len(list(app.state.settings.outputs_dir.glob("*.xlsx"))) == 1
        assert manager.get(job.id).planning_export_file == first.json()["file"]


def test_snapshot_missing_or_corrupt_never_falls_back(app):
    with TestClient(app) as client:
        manager = app.state.job_manager
        legacy = JobRecord(id="legacy", mode="generate_waves")
        manager.jobs[legacy.id] = legacy
        assert client.get("/api/jobs/legacy/plan").status_code == 404
        job = seed_job(manager)
        path = manager.wave_records_dir / "plans" / f"{job.id}.json"
        path.write_text("{broken", "utf-8")
        assert client.get(f"/api/jobs/{job.id}/plan").status_code == 503
        assert path.read_text() == "{broken"
        path.unlink()
        assert client.get(f"/api/jobs/{job.id}/plan").status_code == 503


def test_export_persistence_failure_reuses_file_on_retry(app, monkeypatch):
    with TestClient(app) as client:
        manager = app.state.job_manager
        job = seed_job(manager)
        save = manager._save_job
        monkeypatch.setattr(manager, "_save_job", lambda *_args, **_kwargs: False)
        content = b"PK\x03\x04" + b"original" * 200
        assert client.post(f"/api/jobs/{job.id}/planning-export", content=content).status_code == 503
        files = list(app.state.settings.outputs_dir.glob("*.xlsx"))
        assert len(files) == 1 and files[0].read_bytes() == content
        monkeypatch.setattr(manager, "_save_job", save)
        assert client.post(f"/api/jobs/{job.id}/planning-export", content=content).status_code == 200
        assert list(app.state.settings.outputs_dir.glob("*.xlsx")) == files


@pytest.mark.parametrize("state", ["queued", "running", "succeeded", "partial", "cancelled", "failed"])
@pytest.mark.parametrize("confirmed", [False, True])
def test_export_accepts_every_terminal_plan_including_zero_completed(app, state, confirmed):
    with TestClient(app) as client:
        manager = app.state.job_manager
        job = seed_job(manager)
        job.status = state
        if not confirmed:
            job.result = None
        content = b"PK\x03\x04" + b"original-plan" * 200
        response = client.post(f"/api/jobs/{job.id}/planning-export", content=content)
        if state in {"queued", "running"}:
            assert response.status_code == 409
            assert not list(app.state.settings.outputs_dir.glob("*.xlsx"))
        else:
            assert response.status_code == 200
            manager._load_persisted()
            retry = client.post(f"/api/jobs/{job.id}/planning-export", content=content)
            assert retry.json() == response.json()
            assert len(list(app.state.settings.outputs_dir.glob("*.xlsx"))) == 1


@pytest.mark.parametrize("confirmed", [False, True])
def test_restart_interrupted_generation_can_export_saved_plan(app, confirmed):
    with TestClient(app) as client:
        manager = app.state.job_manager
        job = seed_job(manager)
        job.status = "running"
        if not confirmed:
            job.result = None
        manager._persist(force=True)
        manager._load_persisted()
        assert manager.get(job.id).status == "failed"
        assert client.get(f"/api/jobs/{job.id}/plan").status_code == 200
        response = client.post(f"/api/jobs/{job.id}/planning-export", content=b"PK\x03\x04" + b"plan" * 400)
        assert response.status_code == 200


def test_scoped_history_api_and_incomplete_identity(app):
    with TestClient(app) as client:
        data = app.state.job_manager.wave_records_dir
        upsert_records(data, [scoped_record(), scoped_record(batch="B2")])
        assert len(client.get("/api/wave-records?batch_id=B1&plan_id=P1").json()) == 1
        assert client.post("/api/wave-records/clear?batch_id=B1&plan_id=P1").status_code == 200
        assert [r["batch_id"] for r in read_records(data)] == ["B2"]
        assert client.post("/api/wave-records/clear?batch_id=B2").status_code == 503
        assert len(read_records(data)) == 1
