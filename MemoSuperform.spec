# -*- mode: python ; coding: utf-8 -*-
# 统一 Windows 入口：launcher.py 负责网页模式与桌面模式的选择和切换。


a = Analysis(
    ['launcher.py'],
    pathex=[],
    binaries=[],
    datas=[('index.html', '.'), ('css', 'css'), ('js', 'js'), ('vendor', 'vendor'), ('index-anon.html', '.'), ('img', 'img'), ('fonts', 'fonts'), ('LICENSE', '.'), ('README.md', '.'), ('schema.sql', '.'), ('sqlite_schema.sql', '.')],
    hiddenimports=['pyodbc'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='MemoSuperform',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['img\\icon.ico'],
)
