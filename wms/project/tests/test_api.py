import pytest

from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.routes import CreateJobRequest
from app.main import app


def test_health() -> None:
    with TestClient(app) as client:
        assert client.get("/api/health").json() == {"status": "ok"}


def test_production_export_requires_confirmation() -> None:
    with TestClient(app) as client:
        response = client.post(
            "/api/jobs",
            json={"mode": "export", "confirm_production": False},
        )
        assert response.status_code == 422


def test_wave_batch_requires_confirmation() -> None:
    with TestClient(app) as client:
        response = client.post(
            "/api/jobs",
            json={"mode": "pick_waves", "confirm_production": False},
        )
        assert response.status_code == 422


def test_selected_wave_print_request_is_normalized() -> None:
    payload = CreateJobRequest.model_validate({
        "mode": "print_waves",
        "browser_mode": "headless",
        "confirm_production": True,
        "wave_nos": [" W001 ", "W002", "W001", ""],
    })

    assert payload.wave_nos == ["W001", "W002"]


def test_selected_wave_print_request_requires_safe_values() -> None:
    with pytest.raises(ValidationError, match="至少提供一个波次号"):
        CreateJobRequest.model_validate({
            "mode": "print_waves",
            "confirm_production": True,
            "wave_nos": [],
        })

    with pytest.raises(ValidationError, match="波次号格式异常"):
        CreateJobRequest.model_validate({
            "mode": "print_waves",
            "confirm_production": True,
            "wave_nos": ["../../unsafe"],
        })


def test_wave_pick_request_allows_empty_or_normalizes_selected_waves() -> None:
    all_waves = CreateJobRequest.model_validate({
        "mode": "pick_waves",
        "confirm_production": True,
        "wave_nos": [],
    })
    selected_waves = CreateJobRequest.model_validate({
        "mode": "pick_waves",
        "confirm_production": True,
        "wave_nos": [" W003 ", "W001", "W003", ""],
    })

    assert all_waves.wave_nos == []
    assert selected_waves.wave_nos == ["W003", "W001"]


def test_wave_pick_request_rejects_unsafe_or_too_many_values() -> None:
    with pytest.raises(ValidationError, match="波次号格式异常"):
        CreateJobRequest.model_validate({
            "mode": "pick_waves",
            "confirm_production": True,
            "wave_nos": ["../../unsafe"],
        })

    with pytest.raises(ValidationError, match="一次最多拣货 500 个不同波次"):
        CreateJobRequest.model_validate({
            "mode": "pick_waves",
            "confirm_production": True,
            "wave_nos": [f"W{index:04d}" for index in range(501)],
        })


def test_export_file_download_serves_only_download_dir(tmp_path) -> None:
    from app.services.job_manager import JobRecord

    with TestClient(app) as client:
        manager = app.state.job_manager
        settings = app.state.settings
        downloads_dir = tmp_path / "downloads"
        downloads_dir.mkdir()
        original = settings.downloads_dir
        settings.downloads_dir = downloads_dir

        good = downloads_dir / "ParcelOutbound_ok.xlsx"
        good.write_bytes(b"PK-fake-xlsx-content")

        # 无结果 → 404
        job_none = JobRecord(id="j-none", mode="export", status="succeeded")
        manager.jobs[job_none.id] = job_none
        assert client.get("/api/jobs/j-none/file").status_code == 404

        # 正常下载
        job_ok = JobRecord(id="j-ok", mode="export", status="succeeded")
        job_ok.result = {"downloaded_file": str(good), "task_filename": good.name}
        manager.jobs[job_ok.id] = job_ok
        resp = client.get("/api/jobs/j-ok/file")
        assert resp.status_code == 200
        assert resp.content == b"PK-fake-xlsx-content"
        assert resp.headers["content-type"].startswith(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )

        # 目录外路径 → 403
        outside = tmp_path / "outside.xlsx"
        outside.write_bytes(b"x")
        job_out = JobRecord(id="j-out", mode="export", status="succeeded")
        job_out.result = {"downloaded_file": str(outside)}
        manager.jobs[job_out.id] = job_out
        assert client.get("/api/jobs/j-out/file").status_code == 403

        # 文件不存在 → 404
        missing = downloads_dir / "missing.xlsx"
        job_miss = JobRecord(id="j-miss", mode="export", status="succeeded")
        job_miss.result = {"downloaded_file": str(missing)}
        manager.jobs[job_miss.id] = job_miss
        assert client.get("/api/jobs/j-miss/file").status_code == 404

        settings.downloads_dir = original


def test_merged_pdf_download_serves_only_outputs_dir(tmp_path) -> None:
    from app.services.job_manager import JobRecord

    with TestClient(app) as client:
        manager = app.state.job_manager
        settings = app.state.settings
        outputs_dir = tmp_path / "outputs"
        outputs_dir.mkdir()
        original = settings.outputs_dir
        settings.outputs_dir = outputs_dir

        merged = outputs_dir / "Paper合并_2026-08-17.pdf"
        merged.write_bytes(b"%PDF-fake")

        job_ok = JobRecord(id="j-mg", mode="print_waves", status="succeeded")
        job_ok.result = {"merged_file": str(merged)}
        manager.jobs[job_ok.id] = job_ok
        resp = client.get("/api/jobs/j-mg/merged")
        assert resp.status_code == 200
        assert resp.content == b"%PDF-fake"
        assert resp.headers["content-type"] == "application/pdf"

        # 无合并结果 → 404
        job_none = JobRecord(id="j-mn", mode="print_waves", status="succeeded")
        manager.jobs[job_none.id] = job_none
        assert client.get("/api/jobs/j-mn/merged").status_code == 404

        # 目录外 → 403
        outside = tmp_path / "outside.pdf"
        outside.write_bytes(b"x")
        job_out = JobRecord(id="j-mo", mode="print_waves", status="succeeded")
        job_out.result = {"merged_file": str(outside)}
        manager.jobs[job_out.id] = job_out
        assert client.get("/api/jobs/j-mo/merged").status_code == 403

        settings.outputs_dir = original


def test_generate_waves_requires_segments_and_safe_order_nos() -> None:
    with pytest.raises(ValidationError, match="至少提供一个分段"):
        CreateJobRequest.model_validate({
            "mode": "generate_waves", "confirm_production": True, "segments": [],
        })
    with pytest.raises(ValidationError, match="出库单号格式异常"):
        CreateJobRequest.model_validate({
            "mode": "generate_waves", "confirm_production": True,
            "segments": [{"channel": "CBT", "seg_name": "爆品1", "order_nos": ["../bad"]}],
        })
    ok = CreateJobRequest.model_validate({
        "mode": "generate_waves", "confirm_production": True,
        "segments": [
            {"channel": "CBT", "seg_name": "爆品1",
             "order_nos": ["OBS1", "OBS2", "OBS1", "  OBS3  "]},
        ],
    })
    assert ok.segments[0]["order_nos"] == ["OBS1", "OBS2", "OBS3"]


def test_exports_save_and_download(tmp_path) -> None:
    with TestClient(app) as client:
        settings = app.state.settings
        original = settings.outputs_dir
        settings.outputs_dir = tmp_path / "outputs"

        payload = b"PK\x03\x04" + b"x" * 2000
        resp = client.post(
            "/api/exports", params={"filename": "波次规划20260817.xlsx"},
            content=payload,
            headers={"Content-Type": "application/octet-stream"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["file"] == "波次规划20260817.xlsx"
        d = client.get(data["url"])
        assert d.status_code == 200 and d.content == payload

        # 非法内容 → 400；不存在 → 404
        assert client.post("/api/exports", params={"filename": "x.xlsx"}, content=b"xx").status_code == 400
        assert client.get("/api/exports/missing.xlsx").status_code == 404

        settings.outputs_dir = original


def test_wave_records_endpoint(tmp_path) -> None:
    from app.services.wave_records import upsert_records

    with TestClient(app) as client:
        settings = app.state.settings.model_copy(
            update={"browser_profile_dir": tmp_path / "profile"}
        )
        app.state.settings = settings
        upsert_records(
            tmp_path,
            [{"channel": "SwiftX", "seg_name": "爆品1", "wave_no": "W0092608180011", "order_count": 10}],
        )
        records = client.get("/api/wave-records").json()
        assert records and records[0]["wave_no"] == "W0092608180011"


def test_exports_list_returns_todays_files_only(tmp_path) -> None:
    import os
    import time
    from datetime import datetime

    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        settings = app.state.settings.model_copy(
            update={
                "outputs_dir": tmp_path,
                "browser_profile_dir": tmp_path / "profile",
            }
        )
        app.state.settings = settings
        today = tmp_path / "波次规划_new.xlsx"
        today.write_bytes(b"PK\x03\x04" + b"x" * 100)
        old = tmp_path / "波次规划_old.xlsx"
        old.write_bytes(b"PK\x03\x04" + b"x" * 100)
        yesterday = datetime.now().timestamp() - 86400
        os.utime(old, (yesterday, yesterday))
        items = client.get("/api/exports").json()
        assert [i["file"] for i in items] == ["波次规划_new.xlsx"]
