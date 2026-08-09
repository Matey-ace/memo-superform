#!/usr/bin/env bash
# ============================================================
# Memo Superform - Linux 打包脚本（PyInstaller onefile）
# 产物：dist/MemoSuperform-Web 与 dist/MemoSuperform-Desktop
# 用法：bash build_linux.sh
# ============================================================
set -e
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
$PY -m pip install --quiet pyinstaller

# Linux 下 PyInstaller 的 --add-data 分隔符为冒号
COMMON=(
  --noconfirm --onefile
  --add-data "index.html:."
  --add-data "css:css"
  --add-data "js:js"
  --add-data "vendor:vendor"
  --add-data "index-anon.html:."
  --add-data "img:img"
  --add-data "fonts:fonts"
  --add-data "LICENSE:."
  --add-data "README.md:."
  --add-data "schema.sql:."
)

echo "== 打包 Web 版 =="
$PY -m PyInstaller "${COMMON[@]}" --name MemoSuperform-Web server.py

echo "== 打包 Desktop 版 =="
$PY -m PyInstaller "${COMMON[@]}" --name MemoSuperform-Desktop app.py

echo "完成：dist/MemoSuperform-Web   dist/MemoSuperform-Desktop"
