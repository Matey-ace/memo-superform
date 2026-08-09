#!/usr/bin/env bash
# ============================================================
# Memo Superform - Linux 启动脚本
# 用法：
#   ./launcher-linux.sh              # 弹出模式选择（或使用记住的模式）
#   ./launcher-linux.sh web          # 网页模式（自动打开浏览器）
#   ./launcher-linux.sh desktop      # 桌面模式（pywebview 原生窗口）
#   ./launcher-linux.sh --reset      # 清除记住的模式
# ============================================================
set -e
cd "$(dirname "$0")"

case "$1" in
  web|desktop)
    exec python3 launcher.py --mode "$1"
    ;;
  --reset)
    exec python3 launcher.py --reset
    ;;
  *)
    exec python3 launcher.py
    ;;
esac
