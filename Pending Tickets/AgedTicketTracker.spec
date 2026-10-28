# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the Aged Ticket Tracker standalone exe.
# Build with:  pyinstaller AgedTicketTracker.spec

from PyInstaller.utils.hooks import collect_submodules

block_cipher = None

# Ship the Jinja templates inside the bundle under ticket_tracker/templates.
datas = [
    ("ticket_tracker/templates", "ticket_tracker/templates"),
]

# waitress loads some modules dynamically; make sure they're included.
hiddenimports = collect_submodules("waitress")

a = Analysis(
    ["launcher.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="AgedTicketTracker",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # keep the console so logs / the URL are visible
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
