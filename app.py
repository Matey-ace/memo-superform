#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
app.py - Memo Superform 桌面应用入口（pywebview）
以原生窗口方式运行仪表盘，替代浏览器。

使用方法：
  python app.py
"""

import os
import sys
import socket
import time

# 静态资源目录（打包为 exe 时为 PyInstaller 的 _MEIPASS 临时目录）
BASE_DIR = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)
os.chdir(BASE_DIR)


def acquire_single_instance(port=8891):
    """通过占用专用端口实现单实例锁。返回 socket 或 None（已存在实例）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        s.listen(1)
        return s
    except OSError:
        return None


def main():
    guard = acquire_single_instance()
    if guard is None:
        msg = "Memo Superform 已经在运行中。"
        print(msg)
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, msg, "Memo Superform", 0x40)
        except Exception:
            pass
        sys.exit(0)

    # 启动本地代理服务器（后台守护线程，不自动打开浏览器）
    import server
    result = server.start_server(open_browser=False, block=False)
    if not result:
        print("无法启动本地服务器，请检查端口是否被占用。")
        sys.exit(1)
    httpd, url = result
    time.sleep(0.5)  # 等待服务器就绪

    # 启动 pywebview 原生窗口
    import webview
    webview.create_window(
        "Memo Superform - 墨墨数据仪表盘",
        url,
        width=1280,
        height=820,
        min_size=(960, 640),
        text_select=False,
    )
    webview.start()

    # 窗口关闭后清理
    try:
        httpd.shutdown()
    except Exception:
        pass
    try:
        guard.close()
    except Exception:
        pass


if __name__ == "__main__":
    main()