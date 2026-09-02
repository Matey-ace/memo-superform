# -*- mode: python ; coding: utf-8 -*-
# 统一 Windows 入口：launcher.py 负责网页模式与桌面模式的选择和切换。


a = Analysis(
    ['launcher.py'],
    pathex=[],
    binaries=[],
    datas=[('index.html', '.'), ('css', 'css'), ('js', 'js'), ('vendor', 'vendor'), ('index-anon.html', '.'), ('img', 'img'), ('fonts', 'fonts'), ('LICENSE', '.'), ('THIRD_PARTY_NOTICES.md', '.'), ('README.md', '.'), ('CHANGELOG.md', '.'), ('schema.sql', '.'), ('sqlite_schema.sql', '.')],
    # ``webview`` 会动态选择 Windows 后端。这里显式列出运行时模块，确保桌面
    # 可执行文件自包含，避免产出启动后只能使用浏览器模式的残缺包。
    hiddenimports=[
        'windows_tray',
        'webview',
        'webview.guilib',
        'webview.platforms.winforms',
        'webview.platforms.win32',
        'webview.platforms.edgechromium',
        # 大型语音包原生拖放使用 pywebview DOM 封装；冻结构建中显式保留，避免
        # 源码可用而 EXE 首次载入设置页时找不到该动态模块。
        'webview.dom',
        'webview.dom.element',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # 旧 SQL Server 迁移器在源码模式可按需导入 pyodbc，但发布 EXE 明确不携带
    # 这个可选 C 扩展，以控制包体；常规 SQLite 运行不受影响。
    excludes=['pyodbc'],
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
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['img\\icon.ico'],
)
