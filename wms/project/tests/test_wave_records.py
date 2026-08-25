import json

from app.services.wave_records import read_records, upsert_records


def test_upsert_read_roundtrip(tmp_path) -> None:
    upsert_records(
        tmp_path,
        [
            {"channel": "SwiftX", "seg_name": "爆品1", "wave_no": "W001", "order_count": 10},
            {"channel": "CBT", "seg_name": "爆品2", "wave_no": "W002", "order_count": 5},
        ],
    )
    records = read_records(tmp_path)
    assert len(records) == 2
    assert {r["wave_no"] for r in records} == {"W001", "W002"}

    # 同分段重复写入 → 最新覆盖，且无 wave_no 的忽略
    upsert_records(
        tmp_path,
        [
            {"channel": "SwiftX", "seg_name": "爆品1", "wave_no": "W001B", "order_count": 10},
            {"channel": "CBT", "seg_name": "失败段", "wave_no": None, "order_count": 3},
        ],
    )
    records = read_records(tmp_path)
    assert len(records) == 2
    by_key = {(r["channel"], r["seg_name"]): r["wave_no"] for r in records}
    assert by_key[("SwiftX", "爆品1")] == "W001B"
    assert ("CBT", "失败段") not in by_key


def test_read_missing_or_corrupt_file(tmp_path) -> None:
    assert read_records(tmp_path) == []
    (tmp_path / "wave-records.json").write_text("{not json", encoding="utf-8")
    assert read_records(tmp_path) == []
    (tmp_path / "wave-records.json").write_text(
        json.dumps({"records": [{"channel": "A", "seg_name": "B", "wave_no": "W009"}]}),
        encoding="utf-8",
    )
    assert read_records(tmp_path)[0]["wave_no"] == "W009"


def test_clear_records(tmp_path) -> None:
    from app.services.wave_records import clear_records

    upsert_records(
        tmp_path,
        [{"channel": "A", "seg_name": "s1", "wave_no": "W001", "order_count": 1}],
    )
    assert len(read_records(tmp_path)) == 1
    clear_records(tmp_path)
    assert read_records(tmp_path) == []


def test_clear_wave_records_endpoint(tmp_path) -> None:
    from fastapi.testclient import TestClient

    from app.main import app
    from app.services.wave_records import upsert_records

    with TestClient(app) as client:
        settings = app.state.settings.model_copy(
            update={"browser_profile_dir": tmp_path / "profile"}
        )
        app.state.settings = settings
        upsert_records(
            tmp_path,
            [{"channel": "A", "seg_name": "s1", "wave_no": "W001", "order_count": 1}],
        )
        assert len(client.get("/api/wave-records").json()) == 1
        resp = client.post("/api/wave-records/clear")
        assert resp.status_code == 200
        assert client.get("/api/wave-records").json() == []
