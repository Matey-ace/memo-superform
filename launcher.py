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
import urllib.request
import webbrowser


_ACTIVE_GUARD = None
_ACTIVE_TRAY = None
# 每次打包发布都要更新此值。旧版本使用固定协调端口 8891，升级时会悄悄激活旧
# 可执行文件，并在新代码运行前退出。按构建版本划分端口后，v0.77 能打开自己的
# 窗口，并在升级期间准确报告共享 TTS 资料包锁。
BUILD_VERSION = "0.77"


class InstanceBroker:
    """带“激活已有实例”通道的本地单实例锁。

    socket 始终作为独占所有权锁，接收循环则让第二次启动恢复已有应用，而不是
    显示含糊的“已在运行”错误。仅接受固定格式的本地 JSON 消息。
    """

    _REQUEST = {"app": "memo-superform", "version": 1, "action": "activate"}

    def __init__(self, listener, port):
        self.listener = listener
        self.port = int(port)
        self._closed = threading.Event()
        self._lock = threading.RLock()
        self._activation_callback = None
        self._pending_activations = 0
        self._thread = threading.Thread(target=self._serve, name="MemoInstanceBroker", daemon=True)
        self._thread.start()

    def set_activation_callback(self, callback):
        with self._lock:
            self._activation_callback = callback
            count = self._pending_activations
            self._pending_activations = 0
        for _ in range(count):
            self._dispatch_activation(callback)

    def _dispatch_activation(self, callback):
        if callback is None:
            return
        threading.Thread(target=self._safe_activate, args=(callback,),
                         name="MemoInstanceActivate", daemon=True).start()

    @staticmethod
    def _safe_activate(callback):
        try:
            callback()
        except Exception as exc:
            _log("instance activation callback failed: %s" % exc)

    def _trigger_activation(self):
        with self._lock:
            callback = self._activation_callback
            if callback is None:
                self._pending_activations += 1
                return
        self._dispatch_activation(callback)

    def _serve(self):
        try:
            self.listener.settimeout(0.35)
            while not self._closed.is_set():
                try:
                    connection, _address = self.listener.accept()
                except socket.timeout:
                    continue
                except OSError:
                    break
                with connection:
                    try:
                        connection.settimeout(0.75)
                        payload = connection.recv(1024)
                        message = json.loads(payload.decode("utf-8", errors="strict").strip())
                        valid = message == self._REQUEST
                    except (OSError, ValueError, UnicodeError):
                        valid = False
                    try:
                        connection.sendall(json.dumps({"ok": valid}).encode("utf-8"))
                    except OSError:
                        pass
                    if valid:
                        self._trigger_activation()
        finally:
            try:
                self.listener.close()
            except OSError:
                pass

    def close(self):
        if self._closed.is_set():
            return
        self._closed.set()
        try:
            self.listener.close()
        except OSError:
            pass
        if self._thread is not threading.current_thread():
            self._thread.join(1.0)


def _instance_port():
    """返回按构建版本划分的通信端口，并允许环境变量显式覆盖。"""
    try:
        configured = os.environ.get("MEMO_INSTANCE_PORT")
        if configured:
            return int(configured)
    except (TypeError, ValueError):
        pass
    try:
        major, minor = (int(item) for item in BUILD_VERSION.split(".", 1))
        return 15100 + ((major * 100 + minor) % 800)
    except (TypeError, ValueError):
        return 15177


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


def _set_tray(tray):
    global _ACTIVE_TRAY
    _ACTIVE_TRAY = tray


def _release_tray():
    global _ACTIVE_TRAY
    if _ACTIVE_TRAY is not None:
        try:
            _ACTIVE_TRAY.stop()
        except Exception:
            pass
        _ACTIVE_TRAY = None


def get_runtime_root():
    """exe 模式下返回 exe 所在目录；源码模式返回项目根目录。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def get_data_dir():
    """可写数据目录：exe 同级 data/，源码模式为项目根 data/。"""
    path = os.environ.get("MEMO_DATA_DIR") or os.path.join(get_runtime_root(), "data")
    path = os.path.abspath(path)
    try:
        os.makedirs(path, exist_ok=True)
    except OSError:
        pass
    return path


def _res_path(name):
    """打包为 exe 时资源在 _MEIPASS 解压目录，源码模式在项目根目录。"""
    base = getattr(sys, "_MEIPASS", None) or get_runtime_root()
    return os.path.join(base, name)


def create_windows_tray(mode, on_open, on_exit):
    """创建可选的 Windows 通知区域生命周期指示器。"""
    try:
        from windows_tray import WindowsTray
        label = "桌面模式 · 正在运行" if mode == "desktop" else "网页模式 · 正在运行"
        tray = WindowsTray(
            app_name="Memo Superform",
            icon_path=_res_path(os.path.join("img", "icon.ico")),
            on_open=on_open,
            on_exit=on_exit,
            status=label,
        )
        if tray.start():
            _log("Windows tray started: %s" % label)
        elif tray.supported:
            _log("Windows tray unavailable: %s" % tray.last_error)
        return tray
    except Exception as exc:
        _log("Windows tray creation failed: %s" % exc)
        return None


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


def acquire_single_instance(port=None):
    """占用专用端口实现单实例锁。返回 socket 或 None（已存在实例）。"""
    if port is None:
        port = _instance_port()
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        s.bind(("127.0.0.1", port))
        s.listen(8)
        actual_port = int(s.getsockname()[1])
        _log("single instance lock acquired (port %d)" % actual_port)
        return InstanceBroker(s, actual_port)
    except OSError:
        s.close()
        _log("single instance lock DENIED (port %d)" % port)
        return None


def activate_existing_instance(port=None, timeout=0.9):
    """请求已有实例恢复/打开自身；无关锁会返回 False。"""
    if port is None:
        port = _instance_port()
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=timeout) as connection:
            connection.settimeout(timeout)
            connection.sendall(json.dumps(InstanceBroker._REQUEST).encode("utf-8"))
            response = json.loads(connection.recv(256).decode("utf-8"))
        return bool(response.get("ok"))
    except (OSError, ValueError, UnicodeError):
        return False


def find_running_app_url(timeout=0.35):
    """寻找已启动的 Memo 服务；用于重复启动网页模式时重新打开页面。"""
    for port in (8888, 8889, 8890, 3000, 5000):
        api_url = "http://127.0.0.1:%d/api/app/current-mode" % port
        try:
            with urllib.request.urlopen(api_url, timeout=timeout) as response:
                if response.status != 200:
                    continue
                payload = json.loads(response.read().decode("utf-8"))
            if payload.get("mode") in ("web", "desktop") and "data_dir" in payload:
                return "http://localhost:%d/index.html" % port
        except (OSError, ValueError):
            continue
    return None


def reopen_running_web_app():
    """若已有实例正在提供网页，则把浏览器重新带回该实例。"""
    url = find_running_app_url()
    if not url:
        return False
    opened = bool(webbrowser.open(url))
    _log("existing instance reopened: %s opened=%s" % (url, opened))
    return opened


def show_message(title, msg):
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, msg, title, 0x40)
    except Exception:
        print(msg)


def choose_mode_interactive():
    """弹出模式选择窗口；tkinter 不可用时回退控制台选择；再回退网页模式并给出提示。"""
    try:
        import tkinter as tk

        root = tk.Tk()
        root.title("Memo Superform")
        root.resizable(False, False)
        # 窗口图标（可用则设置，不可用不影响）
        try:
            _ico = _res_path(os.path.join("img", "icon.ico"))
            if os.path.exists(_ico):
                root.iconbitmap(_ico)
        except Exception:
            pass

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
        return "web"
    except Exception:
        pass

    # 既无窗口也无终端：明确提示后默认网页模式，避免静默降级
    print("未检测到模式选择窗口/终端，默认以网页模式启动。")
    print("如需桌面模式请运行: python launcher.py --mode desktop")
    print("（安装 python3-tk 可恢复启动时的模式选择窗口）")
    return "web"


def run_web(guard=None):
    """网页模式：后台服务器 + Windows 托盘运行状态 + 浏览器入口。"""
    os.environ["MEMO_MODE"] = "web"
    import server
    server.set_relaunch_handler(request_relaunch)
    shutdown_requested = threading.Event()
    stop_lock = threading.Lock()
    tray_holder = {"tray": None}
    httpd = None
    try:
        result = server.start_server(open_browser=False, block=False)
        if not result:
            raise RuntimeError("无法启动本地服务器，请检查端口是否被占用。")
        httpd, url = result
        _log("server started: %s" % url)

        def open_running_app():
            if os.environ.get("MEMO_NO_BROWSER") == "1":
                return
            webbrowser.open(url)

        def exit_application():
            with stop_lock:
                if shutdown_requested.is_set():
                    return
                shutdown_requested.set()
                tray = tray_holder["tray"]
                if tray:
                    tray.set_status("网页模式 · 正在退出")
            try:
                httpd.shutdown()
            except Exception:
                pass

        if guard is not None and hasattr(guard, "set_activation_callback"):
            guard.set_activation_callback(open_running_app)
        tray = create_windows_tray("web", open_running_app, exit_application)
        tray_holder["tray"] = tray
        _set_tray(tray)
        threading.Timer(0.8, open_running_app).start()
        # 服务端在独立线程运行；保持此生命周期循环存活，托盘图标才准确表示后台
        # 应用仍在运行。
        shutdown_requested.wait()
    except KeyboardInterrupt:
        shutdown_requested.set()
    except RuntimeError as exc:
        print(exc)
        show_message("Memo Superform", str(exc))
    finally:
        if httpd is not None:
            try:
                httpd.shutdown()
            except Exception:
                pass
            try:
                httpd.server_close()
            except Exception:
                pass
        _release_tray()


def run_desktop(guard=None):
    """桌面模式：窗口关闭后隐藏到托盘，托盘菜单负责恢复或完整退出。"""
    os.environ["MEMO_MODE"] = "desktop"
    if guard is None:
        guard = acquire_single_instance()
        if guard is None:
            if activate_existing_instance():
                return
            show_message("Memo Superform", "Memo Superform 已经在运行中。")
            return
    _set_guard(guard)

    import server
    server.set_relaunch_handler(request_relaunch)
    result = server.start_server(open_browser=False, block=False)
    if not result:
        show_message("Memo Superform", "无法启动本地服务器，请检查端口是否被占用。")
        sys.exit(1)
    _log("server started: %s" % result[1])
    httpd, url = result
    # 给桌面窗口 URL 加版本参数，强制 WebView 拉取最新页面，避免陈旧缓存
    # 与当前静态入口版本同步，避免 WebView 继续命中旧版 index.html。
    url = url + "?v=77"
    time.sleep(0.5)

    import webview
    exit_requested = threading.Event()
    gui_ready = threading.Event()
    pending_activation = threading.Event()
    tray_holder = {"tray": None}

    window = webview.create_window(
        "Memo Superform - 墨墨数据仪表盘",
        url,
        width=1280,
        height=820,
        min_size=(960, 640),
        text_select=False,
    )

    def show_main_window():
        if not gui_ready.is_set():
            pending_activation.set()
            return
        try:
            window.restore()
        except Exception:
            pass
        try:
            window.show()
        except Exception:
            pass
        tray = tray_holder["tray"]
        if tray:
            tray.set_status("桌面模式 · 正在运行")

    def close_to_tray():
        # pywebview 把返回 False 视为取消原生关闭。托盘宿主不可用时保留传统的
        # 关闭即退出行为，避免留下无法访问的后台进程。
        tray = tray_holder["tray"]
        if exit_requested.is_set() or not tray or not tray.is_running:
            return None
        try:
            window.hide()
            tray.set_status("桌面模式 · 后台运行")
            _log("desktop window hidden to tray")
            return False
        except Exception:
            return None

    def exit_application():
        if exit_requested.is_set():
            return
        exit_requested.set()
        tray = tray_holder["tray"]
        if tray:
            tray.set_status("桌面模式 · 正在退出")
        try:
            window.destroy()
        except Exception:
            pass
        try:
            httpd.shutdown()
        except Exception:
            pass

    window.events.closing += close_to_tray
    if guard is not None and hasattr(guard, "set_activation_callback"):
        guard.set_activation_callback(show_main_window)

    def on_gui_ready():
        gui_ready.set()
        tray = create_windows_tray("desktop", show_main_window, exit_application)
        tray_holder["tray"] = tray
        _set_tray(tray)
        if pending_activation.is_set():
            show_main_window()

    try:
        webview.start(on_gui_ready)
    finally:
        exit_requested.set()
        try:
            httpd.shutdown()
        except Exception:
            pass
        try:
            httpd.server_close()
        except Exception:
            pass
        _release_tray()
        _release_guard()


def request_relaunch(mode):
    """先释放单实例锁，再拉起新进程并延迟退出当前进程。

    时序：释放锁 -> 写记住配置 -> 拉起 --mode <target> -> 1.5s 后退出。
    先释放锁是为了避免新进程抢不到当前构建的实例锁而弹出“已在运行中”后退出。
    """
    _log("request_relaunch begin: mode=%s" % mode)
    _release_tray()
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
        if activate_existing_instance():
            _log("existing instance activation requested")
            return 0
        if mode == "web" and reopen_running_web_app():
            return 0
        show_message("Memo Superform", "Memo Superform 已经在运行中。")
        return 0
    _set_guard(guard)
    _log("launcher main: mode=%s" % mode)

    if mode == "desktop":
        run_desktop(guard=guard)
    else:
        run_web(guard=guard)
        _release_guard()
    _log("launcher main: exit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
