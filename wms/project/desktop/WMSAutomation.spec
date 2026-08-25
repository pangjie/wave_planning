# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_all, collect_submodules


playwright_datas, playwright_binaries, playwright_hiddenimports = collect_all("playwright")

a = Analysis(
    ["macos_launcher.py"],
    pathex=["../backend"],
    binaries=playwright_binaries,
    datas=[
        ("../config/automation.json", "config"),
        ("../frontend/dist", "frontend/dist"),
        *playwright_datas,
    ],
    hiddenimports=[
        *playwright_hiddenimports,
        *collect_submodules("uvicorn"),
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest", "pytest_asyncio", "httpx"],
    noarchive=False,
    optimize=1,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="WMSAutomation",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    target_arch="arm64",
    codesign_identity=None,
    entitlements_file=None,
)

collection = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="WMSAutomation",
)

app = BUNDLE(
    collection,
    name="WMS自动化控制台.app",
    icon=None,
    bundle_identifier="com.local.wmsautomation.console",
    version="0.1.0",
    info_plist={
        "CFBundleDisplayName": "WMS自动化控制台",
        "CFBundleName": "WMS自动化控制台",
        "LSUIElement": True,
        "NSHighResolutionCapable": True,
    },
)
