#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
app.py - Memo Superform 桌面应用入口（pywebview，源码模式）

等价于：python launcher.py --mode desktop
统一入口逻辑见 launcher.py。

使用方法：
  python app.py
"""

from launcher import main

if __name__ == "__main__":
    # 走统一入口，确保 Windows OAuth 回调协议、单实例锁和托盘生命周期与 EXE
    # 完全一致，而不是绕过 launcher 的协议注册步骤。
    raise SystemExit(main(["--mode", "desktop"]))
