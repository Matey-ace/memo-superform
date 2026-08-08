#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
launcher.py - Memo Superform 统一启动入口（桌面 / 网页双模式）

用法：
  python launcher.py                  # 弹出模式选择窗口（可记住选择）
  python launcher.py --mode web       # 直接以网页模式启动
  python launcher.py --mode desktop   # 直接以桌面模式启动
  python launcher.py --reset          # 清除记住的模式选择
"""

import argparse
import json
import os
import socket
import subprocess
import sys
import threading
import time


_ACTIVE_GUARD = None


def _log(msg):
    """记录 launcher 生命周期事件（exe 同级 data/launcher.log）。"""
    try:
        path = os.path.join(get_data_dir(), "launcher.log")
        with open(path, "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def _set_guard(guard):
    """记录当前进程持有的单实例锁，供 request_relaunch 先释放。"""
    global _ACTIVE_GUARD
    _ACTIVE_GUARD = guard
    _log("guard set: %s" % id(guard))


def _release_guard():
    """释放单实例锁（幂等）。"""
    global _ACTIVE_GUARD
    if _ACTIVE_GUARD is not None:
        try:
            _ACTIVE_GUARD.close()
            _log("guard released: %s" % id(_ACTIVE_GUARD))
        except Exception:
            pass
        _ACTIVE_GUARD = None
    else:
        _log("guard release skipped (none)")


def get_runtime_root():
    """exe 模式下返回 exe 所在目录；源码模式返回项目根目录。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def get_data_dir():
    """可写数据目录：exe 同级 data/，源码模式为项目根 data/。"""
    path = os.path.join(get_runtime_root(), "data")
    try:
        os.makedirs(path, exist_ok=True)
    except OSError:
        pass
    return path


def get_launcher_config_path():
    return os.path.join(get_data_dir(), "launcher.json")


def read_launcher_config():
    """返回记住的模式；未记住或配置无效返回 None。"""
    try:
        with open(get_launcher_config_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if data.get("remember") and data.get("mode") in ("desktop", "web"):
            return data["mode"]
    except (OSError, ValueError):
        pass
    return None


def write_launcher_config(mode, remember=True):
    with open(get_launcher_config_path(), "w", encoding="utf-8") as f:
        json.dump({"mode": mode, "remember": bool(remember)}, f, ensure_ascii=False, indent=2)


def clear_launcher_config():
    try:
        os.remove(get_launcher_config_path())
    except OSError:
        pass


def acquire_single_instance(port=8891):
    """占用专用端口实现单实例锁。返回 socket 或 None（已存在实例）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        s.listen(1)
        _log("single instance lock acquired (port %d)" % port)
        return s
    except OSError:
        _log("single instance lock DENIED (port %d)" % port)
        return None


def show_message(title, msg):
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, msg, title, 0x40)
    except Exception:
        print(msg)


def choose_mode_interactive():
    """弹出模式选择窗口；tkinter 不可用时回退控制台选择；再回退网页模式。"""
    try:
        import tkinter as tk

        root = tk.Tk()
        root.title("Memo Superform")
        root.resizable(False, False)

        var = tk.BooleanVar(value=True)
        result = {"mode": None}

        def pick(mode):
            result["mode"] = mode
            if var.get():
                write_launcher_config(mode, remember=True)
            else:
                clear_launcher_config()
            root.destroy()

        tk.Label(root, text="选择启动模式", font=("Microsoft YaHei UI", 13, "bold")).grid(
            row=0, column=0, columnspan=2, padx=24, pady=(18, 10)
        )
        tk.Button(
            root, text="桌面模式", width=16, font=("Microsoft YaHei UI", 11),
            command=lambda: pick("desktop"),
        ).grid(row=1, column=0, padx=(24, 6), pady=8)
        tk.Button(
            root, text="网页模式", width=16, font=("Microsoft YaHei UI", 11),
            command=lambda: pick("web"),
        ).grid(row=1, column=1, padx=(6, 24), pady=8)
        tk.Checkbutton(
            root, text="记住选择，下次直接启动", variable=var, font=("Microsoft YaHei UI", 9)
        ).grid(row=2, column=0, columnspan=2, pady=(6, 4))
        tk.Button(root, text="取消", font=("Microsoft YaHei UI", 9), command=root.destroy).grid(
            row=3, column=0, columnspan=2, pady=(0, 12)
        )

        root.update_idletasks()
        w = root.winfo_width()
        h = root.winfo_height()
        x = (root.winfo_screenwidth() - w) // 2
        y = (root.winfo_screenheight() - h) // 3
        root.geometry("+%d+%d" % (x, y))
        root.mainloop()
        return result["mode"]
    except Exception:
        pass

    # 回退：控制台选择
    try:
        choice = input("请选择启动模式 [1=桌面, 2=网页, 回车=网页]: ").strip()
        if choice == "1":
            return "desktop"
    except Exception:
        pass
    return "web"


def run_web():
    """网页模式：启动本地服务器并自动打开浏览器。"""
    os.environ["MEMO_MODE"] = "web"
    import server
    server.set_relaunch_handler(request_relaunch)
    try:
        server.start_server(open_browser=True, block=True)
    except KeyboardInterrupt:
        pass
    except RuntimeError as exc:
        print(exc)
        show_message("Memo Superform", str(exc))


def run_desktop(guard=None):
    """桌面模式：启动本地服务器（后台线程）并用 pywebview 打开原生窗口。"""
    os.environ["MEMO_MODE"] = "desktop"
    if guard is None:
        guard = acquire_single_instance()
        if guard is None:
            show_message("Memo Superform", "Memo Superform 已经在运行中。")
            sys.exit(0)
    _set_guard(guard)

    import server
    server.set_relaunch_handler(request_relaunch)
    result = server.start_server(open_browser=False, block=False)
    if not result:
        show_message("Memo Superform", "无法启动本地服务器，请检查端口是否被占用。")
        sys.exit(1)
    _log("server started: %s" % result[1])
    httpd, url = result
    time.sleep(0.5)

    import webview
    try:
        webview.create_window(
            "Memo Superform - 墨墨数据仪表盘",
            url,
            width=1280,
            height=820,
            min_size=(960, 640),
            text_select=False,
        )
        webview.start()
    finally:
        try:
            httpd.shutdown()
        except Exception:
            pass
        _release_guard()


def request_relaunch(mode):
    """先释放单实例锁，再拉起新进程并延迟退出当前进程。

    时序：释放锁 -> 写记住配置 -> 拉起 --mode <target> -> 1.5s 后退出。
    先释放锁是为了避免新进程抢不到 8891 锁而弹出“已在运行中”后退出。
    """
    _log("request_relaunch begin: mode=%s" % mode)
    _release_guard()
    write_launcher_config(mode, remember=True)
    # 源码模式需要补 launcher.py 路径；frozen(exe) 模式下 sys.executable 就是程序本体。
    # 注意不能无条件追加 __file__：打包后 __file__ 指向临时解压目录，会被 exe 当成多余参数。
    cmd = [sys.executable]
    if not getattr(sys, "frozen", False):
        cmd.append(os.path.abspath(__file__))
    cmd += ["--mode", mode]
    try:
        if os.name == "nt":
            flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
            proc = subprocess.Popen(
                cmd,
                creationflags=flags,
                close_fds=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            proc = subprocess.Popen(
                cmd,
                start_new_session=True,
                close_fds=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        _log("relaunch spawned pid=%s" % proc.pid)
    except Exception as exc:
        raise RuntimeError("重启失败：" + str(exc))
    threading.Timer(1.5, lambda: os._exit(0)).start()
    _log("relaunch exit scheduled")
    return True

def main(argv=None):
    parser = argparse.ArgumentParser(description="Memo Superform 统一启动入口")
    parser.add_argument("--mode", choices=["desktop", "web"], help="直接指定启动模式")
    parser.add_argument("--reset", action="store_true", help="清除记住的模式选择")
    args = parser.parse_args(argv)

    if args.reset:
        clear_launcher_config()
        print("已清除启动模式记忆。")
        return 0

    mode = args.mode or read_launcher_config()
    if mode is None:
        mode = choose_mode_interactive()
        if mode is None:
            return 0

    guard = acquire_single_instance()
    if guard is None:
        show_message("Memo Superform", "Memo Superform 已经在运行中。")
        return 0
    _set_guard(guard)
    _log("launcher main: mode=%s" % mode)

    if mode == "desktop":
        run_desktop(guard=guard)
    else:
        run_web()
        _release_guard()
    _log("launcher main: exit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
