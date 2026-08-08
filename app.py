#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
app.py - Memo Superform 桌面应用入口（pywebview，源码模式）

等价于：python launcher.py --mode desktop
统一入口逻辑见 launcher.py。

使用方法：
  python app.py
"""

from launcher import run_desktop

if __name__ == "__main__":
    run_desktop()
