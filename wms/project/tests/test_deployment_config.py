"""Local deployment contracts; mocked browser and temporary bundle/runtime only."""
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi.testclient import TestClient

from app.automation import common
from app.core.config import Settings
from app.services.job_manager import JobRecord


PROJECT = Path(__file__).resolve().parents[1]


def load_entry(relative):
    spec = importlib.util.spec_from_file_location("isolated_" + Path(relative).stem, PROJECT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("override", [False, True])
def test_desktop_outputs_use_user_directory_not_bundle(isolated_runtime, tmp_path, monkeypatch, override):
    launcher = load_entry("desktop/macos_launcher.py")
    resources, support, logs = tmp_path / "bundle", tmp_path / "support", tmp_path / "logs"
    resources.mkdir()
    marker = resources / "old-output.xlsx"
    marker.write_bytes(b"leave existing files alone")
    monkeypatch.setattr(launcher, "bundled_root", lambda: resources)
    monkeypatch.setattr(launcher, "app_support_dir", lambda: support)
    monkeypatch.setattr(launcher, "log_dir", lambda: logs)
    monkeypatch.delenv("WMS_OUTPUTS_DIR")
    if override:
        monkeypatch.setenv("WMS_OUTPUTS_DIR", str(tmp_path / "custom-output"))
    launcher.configure_runtime()
    assert "WMS_SECONDARY_DOWNLOADS_DIR" not in os.environ
    settings = Settings.from_environment()
    assert settings.outputs_dir == (tmp_path / "custom-output" if override else support / "outputs")
    settings.outputs_dir.mkdir(parents=True)
    (settings.outputs_dir / "new.xlsx").write_bytes(b"new artifact")
    launcher.configure_runtime()  # Reopening/upgrading must not replace user artifacts.
    assert (settings.outputs_dir / "new.xlsx").read_bytes() == b"new artifact"
    assert list(resources.iterdir()) == [marker]
    assert marker.read_bytes() == b"leave existing files alone"


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["chrome", "", "msedge"])
@pytest.mark.parametrize("headless", [True, False])
async def test_smoke_uses_actual_channel_mode_and_temporary_profile(isolated_runtime, monkeypatch, channel, headless):
    monkeypatch.setenv("WMS_BROWSER_CHANNEL", channel)
    monkeypatch.setenv("WMS_HEADLESS", str(headless))
    smoke = load_entry("scripts/browser_smoke.py")
    page = SimpleNamespace(goto=AsyncMock(), title=AsyncMock(return_value="browser-ok"))
    context = SimpleNamespace(pages=[page], close=AsyncMock())
    launch = AsyncMock(return_value=context)

    class Driver:
        async def __aenter__(self):
            return SimpleNamespace(chromium=SimpleNamespace(launch_persistent_context=launch))
        async def __aexit__(self, *_):
            pass

    # Both the old direct implementation and the shared runtime path are mocked.
    monkeypatch.setattr(common, "async_playwright", Driver)
    monkeypatch.setattr(smoke, "async_playwright", Driver, raising=False)
    await smoke.main()
    options = launch.await_args.kwargs
    assert options.get("channel") == (channel or None)
    assert options["headless"] is headless
    assert options["viewport"] == {"width": 1440, "height": 900}
    assert options["accept_downloads"] is True
    profile = Path(options.get("user_data_dir") or launch.await_args.args[0])
    assert profile != isolated_runtime.browser_profile_dir
    assert not profile.exists(), "Smoke profile must be discarded"
    assert Path(options["downloads_path"]).parent == profile.parent
    assert page.goto.await_args.args[0].startswith("data:text/html,")
    context.close.assert_awaited_once()


@pytest.mark.parametrize("mode,section", [("pick_waves", "wave_picking"), ("print_waves", "wave_printing")])
@pytest.mark.parametrize("updated", [1, 5, "broken"])
def test_request_limits_use_same_startup_snapshot_as_executor(app, isolated_runtime, monkeypatch, mode, section, updated):
    path = isolated_runtime.automation_config_path
    raw = json.loads(path.read_text())
    raw[section]["max_selected_waves"] = 2
    path.write_text(json.dumps(raw))
    with TestClient(app) as client:
        manager = app.state.job_manager
        executor = manager.wave_pick_automation if mode == "pick_waves" else manager.wave_print_automation
        assert executor.config is app.state.automation_config
        create = Mock(return_value=JobRecord(id="isolated", mode=mode))
        monkeypatch.setattr(manager, "create", create)
        if updated == "broken":
            path.write_text("{invalid")
        else:
            raw[section]["max_selected_waves"] = updated
            path.write_text(json.dumps(raw))
        rejected = client.post("/api/jobs", json={"mode": mode, "confirm_production": True, "wave_nos": ["W1", "W2", "W3"]})
        assert rejected.status_code == 422
        assert "2" in str(rejected.json())
        create.assert_not_called()
        accepted = client.post("/api/jobs", json={"mode": mode, "confirm_production": True, "wave_nos": [" W1 ", "W1", "W2"]})
        assert accepted.status_code == 202
        assert create.call_args.kwargs["wave_nos"] == ["W1", "W2"]


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["launch", "page", "close"])
async def test_smoke_failure_does_not_fallback_or_print_success(isolated_runtime, monkeypatch, capsys, fault):
    monkeypatch.setenv("WMS_BROWSER_CHANNEL", "missing-custom-channel")
    smoke = load_entry("scripts/browser_smoke.py")
    sentinel = isolated_runtime.browser_profile_dir / "Cookies"
    sentinel.write_bytes(b"existing session must not be touched")
    page = SimpleNamespace(goto=AsyncMock(side_effect=RuntimeError("page failed") if fault == "page" else None),
                           title=AsyncMock(return_value="browser-ok"))
    context = SimpleNamespace(pages=[page], close=AsyncMock(side_effect=RuntimeError("close failed") if fault == "close" else None))
    launch = AsyncMock(side_effect=RuntimeError("launch failed") if fault == "launch" else None, return_value=context)
    stopped = AsyncMock()

    class Driver:
        async def __aenter__(self):
            return SimpleNamespace(chromium=SimpleNamespace(launch_persistent_context=launch))
        async def __aexit__(self, *_):
            await stopped()

    monkeypatch.setattr(common, "async_playwright", Driver)
    with pytest.raises(RuntimeError, match=f"{fault} failed"):
        await smoke.main()
    launch.assert_awaited_once()
    assert launch.await_args.kwargs["channel"] == "missing-custom-channel"
    assert not Path(launch.await_args.kwargs["user_data_dir"]).exists()
    stopped.assert_awaited_once()
    assert sentinel.read_bytes() == b"existing session must not be touched"
    assert "browser-ok" not in capsys.readouterr().out


def test_new_service_start_adopts_changed_limits(app, isolated_runtime, monkeypatch):
    path = isolated_runtime.automation_config_path
    raw = json.loads(path.read_text())
    raw["wave_printing"]["max_selected_waves"] = 2
    path.write_text(json.dumps(raw))
    with TestClient(app):
        assert app.state.automation_config.wave_printing.max_selected_waves == 2
        raw["wave_printing"]["max_selected_waves"] = 5
        path.write_text(json.dumps(raw))
    with TestClient(app) as client:
        create = Mock(return_value=JobRecord(id="restarted", mode="print_waves"))
        monkeypatch.setattr(app.state.job_manager, "create", create)
        response = client.post("/api/jobs", json={"mode": "print_waves", "confirm_production": True,
            "wave_nos": ["W1", "W2", "W3", "W4"]})
        assert response.status_code == 202
        assert app.state.job_manager.wave_print_automation.config.wave_printing.max_selected_waves == 5
        create.assert_called_once()
