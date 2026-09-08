"""Installer contract tests: copied project, fake installer, no package downloads."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


PROJECT = Path(__file__).resolve().parents[1]


@pytest.fixture
def setup_project(tmp_path):
    root = tmp_path / "project with spaces"
    (root / "scripts").mkdir(parents=True)
    shutil.copyfile(PROJECT / "scripts/setup.sh", root / "scripts/setup.sh")
    fake = root / "fake-python"
    fake.write_text(f"#!{sys.executable}\n" + '''
import json, os, pathlib, shutil, sys
with open(os.environ["SETUP_TEST_LOG"], "a") as stream:
    stream.write(json.dumps(sys.argv[1:]) + "\\n")
if sys.argv[1] == "-c":
    sys.executable = str(pathlib.Path(__file__).resolve())
    sys.version_info = tuple(map(int, os.environ.get("SETUP_TEST_VERSION", "3.12").split(".")))
    exec(sys.argv[2])
elif sys.argv[1:3] == ["-m", "venv"]:
    target = pathlib.Path(sys.argv[3]) / "bin/python"
    target.parent.mkdir(parents=True)
    shutil.copyfile(__file__, target)
    target.chmod(0o755)
elif sys.argv[1:3] == ["-m", "pip"]:
    sys.exit(int(os.environ.get("SETUP_TEST_" + sys.argv[3].upper() + "_EXIT", "0")))
else:
    raise AssertionError(sys.argv)
''')
    fake.chmod(0o755)
    log = root / "invocations.jsonl"
    env = dict(os.environ, PYTHON_BIN=str(fake), SETUP_TEST_LOG=str(log))

    def run(*args, **overrides):
        return subprocess.run(["bash", str(root / "scripts/setup.sh"), *args],
                              env=dict(env, **overrides), capture_output=True, text=True, timeout=10)

    def calls():
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    return root, fake, run, calls


@pytest.mark.parametrize("args,manifest", [((), "backend/requirements.txt"), (("--dev",), "requirements-dev.txt")])
@pytest.mark.parametrize("version", ["3.11", "3.12"])
def test_fresh_setup_checks_version_installs_selected_dependencies_then_checks(setup_project, args, manifest, version):
    root, _, run, calls = setup_project
    result = run(*args, SETUP_TEST_VERSION=version)
    assert result.returncode == 0, result.stderr
    assert calls()[0][0] == "-c"
    assert calls()[1:] == [["-m", "venv", ".venv"], ["-m", "pip", "install", "-r", manifest], ["-m", "pip", "check"]]
    assert "依赖安装完成" in result.stdout
    assert (root / ".venv/bin/python").exists()


@pytest.mark.parametrize("version", ["3.9", "3.10"])
def test_old_python_fails_before_creating_or_installing(setup_project, version):
    root, _, run, calls = setup_project
    result = run(SETUP_TEST_VERSION=version)
    assert result.returncode != 0
    assert "需要 Python 3.11" in result.stderr
    assert len(calls()) == 1
    assert not (root / ".venv").exists()


def test_existing_environment_reused_without_running_requested_python(setup_project):
    root, fake, run, calls = setup_project
    target = root / ".venv/bin/python"
    target.parent.mkdir(parents=True)
    shutil.copy2(fake, target)
    before = target.stat().st_mtime_ns
    result = run(PYTHON_BIN="/missing/requested-python")
    assert result.returncode == 0, result.stderr
    assert not any(call[:2] == ["-m", "venv"] for call in calls())
    assert target.stat().st_mtime_ns == before
    assert str(target) in result.stdout


def test_broken_existing_environment_is_not_overwritten(setup_project):
    root, _, run, calls = setup_project
    (root / ".venv").mkdir()
    marker = root / ".venv/keep"
    marker.write_text("keep")
    result = run()
    assert result.returncode != 0
    assert "不会自动覆盖" in result.stderr
    assert not calls()
    assert marker.read_text() == "keep"


def test_old_existing_environment_does_not_install_or_rebuild(setup_project):
    root, fake, run, calls = setup_project
    target = root / ".venv/bin/python"
    target.parent.mkdir(parents=True)
    shutil.copy2(fake, target)
    before = target.read_bytes()
    result = run(SETUP_TEST_VERSION="3.10")
    assert result.returncode != 0
    assert len(calls()) == 1
    assert target.read_bytes() == before


@pytest.mark.parametrize("phase", ["INSTALL", "CHECK"])
def test_pip_failure_never_reports_success(setup_project, phase):
    _, _, run, calls = setup_project
    result = run(**{f"SETUP_TEST_{phase}_EXIT": "7"})
    assert result.returncode == 7
    assert "依赖安装完成" not in result.stdout
    assert calls()[-1][2] == phase.lower()


@pytest.mark.parametrize("arg,code", [("--help", 0), ("--typo", 2)])
def test_help_and_invalid_option_do_not_touch_environment(setup_project, arg, code):
    root, _, run, calls = setup_project
    assert run(arg).returncode == code
    assert not calls()
    assert not (root / ".venv").exists()


def test_requirements_share_runtime_pins_without_test_or_build_packages():
    runtime = (PROJECT / "backend/requirements.txt").read_text().splitlines()
    dev = (PROJECT / "requirements-dev.txt").read_text().splitlines()
    build = (PROJECT / "desktop/requirements-build.txt").read_text().splitlines()
    assert dev == ["-r backend/requirements.txt", "pytest==8.4.0", "pytest-asyncio==1.0.0", "httpx==0.28.1"]
    assert build == ["-r ../backend/requirements.txt", "pyinstaller==6.15.0"]
    assert not any(line.split("==")[0] in {"pytest", "pytest-asyncio", "httpx", "pyinstaller"} for line in runtime)
