#!/usr/bin/env bash
# ============================================================
# Memo Superform - Linux 打包脚本（PyInstaller onefile）
# 产物：dist/MemoSuperform（单文件，启动时可选桌面/网页模式，与 Windows 版一致）
# 用法：bash build_linux.sh
# ============================================================
set -e
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
$PY -m pip install --quiet pyinstaller

# Linux 下 PyInstaller 的 --add-data 分隔符为冒号
$PY -m PyInstaller --noconfirm --onefile --name MemoSuperform \
  --add-data "index.html:." \
  --add-data "css:css" \
  --add-data "js:js" \
  --add-data "vendor:vendor" \
  --add-data "index-anon.html:." \
  --add-data "img:img" \
  --add-data "fonts:fonts" \
  --add-data "LICENSE:." \
  --add-data "README.md:." \
  --add-data "schema.sql:." \
  launcher.py

echo "完成：dist/MemoSuperform"
