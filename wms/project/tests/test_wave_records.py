# 回归范围：波次索引的读写、范围隔离与损坏文件保留。
import errno
import json
from pathlib import Path

import pytest

from app.services import wave_records
from app.services.wave_records import clear_records, read_records, upsert_records


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


def test_read_missing_file_has_no_filesystem_side_effects(tmp_path) -> None:
    data_dir = tmp_path / "not-created"
    assert read_records(data_dir) == []
    assert not data_dir.exists()


def test_read_legacy_record_without_optional_fields(tmp_path) -> None:
    record = {"channel": "A", "seg_name": "B", "wave_no": "W009", "legacy": "kept"}
    (tmp_path / "wave-records.json").write_text(
        json.dumps({"records": [record]}),
        encoding="utf-8",
    )
    assert read_records(tmp_path) == [record]
    upsert_records(tmp_path, [{"channel": "C", "seg_name": "D", "wave_no": "W010"}])
    assert read_records(tmp_path)[0] == record


@pytest.mark.parametrize(
    "original",
    [
        b"{not json",
        b"\xff",
        b"null",
        b"[]",
        b"{}",
        b'{"records":null}',
        b'{"records":{}}',
        b'{"records":[null]}',
        b'{"records":[[]]}',
        b'{"records":[{}]}',
        b'{"records":[{"channel":"A","wave_no":"W001"}]}',
        b'{"records":[{"channel":"A","seg_name":"B","wave_no":""}]}',
        b'{"records":[{"channel":"A","seg_name":"B","wave_no":123}]}',
        b'{"records":[{"channel":"A","seg_name":"B","wave_no":"W001"},false]}',
    ],
)
@pytest.mark.parametrize("operation", ["read", "upsert", "clear"])
def test_invalid_history_is_reported_and_never_overwritten(tmp_path, original, operation) -> None:
    path = tmp_path / "wave-records.json"
    path.write_bytes(original)

    with pytest.raises(ValueError, match="波次历史文件") as failure:
        if operation == "read":
            read_records(tmp_path)
        elif operation == "upsert":
            upsert_records(tmp_path, [{"channel": "A", "seg_name": "B", "wave_no": "W002"}])
        else:
            clear_records(tmp_path)

    assert str(path) in str(failure.value)
    assert path.read_bytes() == original
    assert list(tmp_path.glob(".wave-records-*.tmp")) == []


def test_upsert_preserves_normalization_and_timestamp_order(tmp_path) -> None:
    upsert_records(
        tmp_path,
        [
            {"channel": 42, "seg_name": 1, "wave_no": 123, "order_count": "7", "at": "2026-09-06T12:00:00Z"},
            {"channel": "A", "seg_name": "B", "wave_no": "W002", "order_count": None, "at": "2026-09-06T10:00:00Z"},
            {"wave_no": "", "order_count": "ignored invalid count"},
        ],
    )
    assert read_records(tmp_path) == [
        {"channel": "A", "seg_name": "B", "wave_no": "W002", "order_count": 0, "at": "2026-09-06T10:00:00Z"},
        {"channel": "42", "seg_name": "1", "wave_no": "123", "order_count": 7, "at": "2026-09-06T12:00:00Z"},
    ]


@pytest.mark.parametrize("new_records", [[None], [{"wave_no": "W002", "order_count": [1]}], [{"wave_no": "W002", "order_count": "bad"}]])
def test_invalid_new_records_do_not_replace_existing_history(tmp_path, new_records) -> None:
    upsert_records(tmp_path, [{"channel": "A", "seg_name": "B", "wave_no": "W001"}])
    path = tmp_path / "wave-records.json"
    original = path.read_bytes()
    with pytest.raises(ValueError, match="待保存波次记录"):
        upsert_records(tmp_path, new_records)
    assert path.read_bytes() == original


@pytest.mark.parametrize("operation", ["upsert", "clear"])
def test_atomic_replace_failure_preserves_existing_history(tmp_path, monkeypatch, operation) -> None:
    upsert_records(tmp_path, [{"channel": "A", "seg_name": "B", "wave_no": "W001"}])
    path = tmp_path / "wave-records.json"
    original = path.read_bytes()
    unrelated_temporary = tmp_path / ".wave-records-unrelated.tmp"
    unrelated_temporary.write_text("not owned by this write", "utf-8")
    calls = []

    def fail_replace(source, destination):
        assert Path(source).parent == path.parent
        assert Path(source) != path
        assert Path(destination) == path
        assert path.read_bytes() == original
        payload = json.loads(Path(source).read_text("utf-8"))
        assert isinstance(payload["records"], list)
        calls.append(payload)
        raise OSError(errno.ENOSPC, "simulated disk full")

    monkeypatch.setattr(wave_records.os, "replace", fail_replace)
    with pytest.raises(OSError, match="simulated disk full"):
        if operation == "upsert":
            upsert_records(tmp_path, [{"channel": "A", "seg_name": "B", "wave_no": "W002"}])
        else:
            clear_records(tmp_path)
    assert len(calls) == 1
    assert path.read_bytes() == original
    assert list(tmp_path.glob(".wave-records-*.tmp")) == [unrelated_temporary]
    assert unrelated_temporary.read_text("utf-8") == "not owned by this write"


@pytest.mark.parametrize("operation", ["read", "upsert", "clear"])
def test_read_permission_error_is_not_treated_as_empty_history(tmp_path, monkeypatch, operation) -> None:
    path = tmp_path / "wave-records.json"
    original = b'{"records": []}'
    path.write_bytes(original)
    read_text = Path.read_text

    def denied(self, *args, **kwargs):
        if self == path:
            raise PermissionError("simulated unreadable history")
        return read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", denied)
    with pytest.raises(PermissionError, match="simulated unreadable history"):
        if operation == "read":
            read_records(tmp_path)
        elif operation == "upsert":
            upsert_records(tmp_path, [{"channel": "A", "seg_name": "B", "wave_no": "W001"}])
        else:
            clear_records(tmp_path)
    assert path.read_bytes() == original


@pytest.mark.parametrize("operation", ["upsert", "clear"])
def test_temporary_file_creation_error_propagates(tmp_path, monkeypatch, operation) -> None:
    path = tmp_path / "wave-records.json"
    original = b'{"records": []}'
    path.write_bytes(original)

    def denied(*args, **kwargs):
        raise PermissionError("simulated unwritable directory")

    monkeypatch.setattr(wave_records.tempfile, "NamedTemporaryFile", denied)
    with pytest.raises(PermissionError, match="simulated unwritable directory"):
        if operation == "upsert":
            upsert_records(tmp_path, [{"channel": "A", "seg_name": "B", "wave_no": "W001"}])
        else:
            clear_records(tmp_path)
    assert path.read_bytes() == original


@pytest.mark.parametrize("operation", ["upsert", "clear"])
def test_partial_temporary_write_failure_preserves_history(tmp_path, monkeypatch, operation) -> None:
    path = tmp_path / "wave-records.json"
    original = b'{"records": []}'
    path.write_bytes(original)
    named_temporary_file = wave_records.tempfile.NamedTemporaryFile
    created = []

    class PartialWriteFailure:
        def __init__(self, *args, **kwargs):
            self.file = named_temporary_file(*args, **kwargs)
            self.name = self.file.name
            created.append(Path(self.name))

        def __enter__(self):
            self.file.__enter__()
            return self

        def __exit__(self, *args):
            return self.file.__exit__(*args)

        def write(self, value):
            self.file.write(value[:5])
            raise OSError(errno.ENOSPC, "simulated partial write")

    monkeypatch.setattr(wave_records.tempfile, "NamedTemporaryFile", PartialWriteFailure)
    with pytest.raises(OSError, match="simulated partial write"):
        if operation == "upsert":
            upsert_records(tmp_path, [{"channel": "A", "seg_name": "B", "wave_no": "W001"}])
        else:
            clear_records(tmp_path)
    assert path.read_bytes() == original
    assert len(created) == 1
    assert not created[0].exists()


def test_clear_records(tmp_path) -> None:
    upsert_records(
        tmp_path,
        [{"channel": "A", "seg_name": "s1", "wave_no": "W001", "order_count": 1}],
    )
    assert len(read_records(tmp_path)) == 1
    clear_records(tmp_path)
    assert read_records(tmp_path) == []


def test_clear_missing_history_creates_empty_records(tmp_path) -> None:
    data_dir = tmp_path / "not-created"
    clear_records(data_dir)
    assert read_records(data_dir) == []
    assert json.loads((data_dir / "wave-records.json").read_text("utf-8")) == {"records": []}
    assert list(data_dir.iterdir()) == [data_dir / "wave-records.json"]


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
