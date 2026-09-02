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
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
import webbrowser
from urllib.parse import urlparse

from build_info import BUILD_VERSION


_ACTIVE_GUARD = None
_ACTIVE_TRAY = None


def _is_maimemo_oauth_callback_url(value):
    """接受浏览器/Windows 对自定义协议路径的等价序列化。"""
    callback_url = str(value or "")
    if not 0 < len(callback_url) <= 8192:
        return False
    parsed = urlparse(callback_url)
    return (
        parsed.scheme.lower() == "memo-superform"
        and parsed.netloc.lower() == "maimemo-oauth"
        and parsed.path in ("", "/")
        and bool(parsed.query)
    )
# 每次打包发布都要更新 build_info.py 中的此值。旧版本使用固定协调端口 8891，
# 升级时会悄悄激活旧可执行文件，并在新代码运行前退出。按构建版本划分端口后，
# 新版本能打开自己的窗口，并在升级期间准确报告共享 TTS 资料包锁。


class _DesktopTtsPackBridge:
    """桌面语音包导入桥接：只允许本地设置页发起原生文件选择。

    JavaScript 永远不会收到文件绝对路径；它只得到后台任务的安全快照。EdgeChromium
    原生 DnD 会在 Python DOM 回调中提供 ``pywebviewFullPath``，由这里直接交给
    本机服务，绕过 WebView 的大文件 HTTP 上传路径。
    """

    _PENDING_DROP_TTL_SECONDS = 30.0

    def __init__(self, server_module, local_url, webview_module):
        self._server = server_module
        self._local_url = str(local_url or "")
        self._webview = webview_module
        self._window = None
        self._drop_bound_for_page = None
        self._pending_drop_lock = threading.RLock()
        self._pending_drop = None

    def bind_window(self, window):
        self._window = window

    def reset_native_drop_page(self):
        """让页面重载后的新 DOM 重新绑定原生拖放监听。"""
        self._drop_bound_for_page = None
        with self._pending_drop_lock:
            self._pending_drop = None

    @staticmethod
    def _public_error(error, local_path=""):
        """把本机异常转换为可显示但不泄露路径的提示。"""
        message = str(error or "").strip() or "桌面导入器未能读取该语音包"
        if local_path:
            try:
                raw = os.fspath(local_path)
                message = message.replace(raw, os.path.basename(raw))
                message = message.replace(os.path.abspath(raw), os.path.basename(raw))
            except (TypeError, ValueError, OSError):
                pass
        # Windows/UNC 路径可能来自底层 OSError，而不是用户选择的 ZIP 本身。
        return re.sub(r"(?i)(?:[a-z]:[\\/]|\\\\)[^\r\n'\"]+", "<本机路径>", message)

    @classmethod
    def _public_job_snapshot(cls, job):
        """限制 pywebview API 可返回给网页的任务字段。"""
        if not isinstance(job, dict):
            raise RuntimeError("桌面导入器未返回有效任务")
        allowed = (
            "job_id", "source_size", "state", "stage", "completed_bytes", "total_bytes",
            "completed_files", "total_files", "percent", "message", "error",
        )
        snapshot = {key: job[key] for key in allowed if key in job}
        snapshot["source_name"] = os.path.basename(str(job.get("source_name") or "语音包.zip"))
        if "error" in snapshot:
            snapshot["error"] = cls._public_error(snapshot["error"])
        if "message" in snapshot:
            snapshot["message"] = cls._public_error(snapshot["message"])
        return snapshot

    def _is_local_index(self):
        if self._window is None:
            return False
        try:
            current = str(self._window.get_current_url() or "")
            expected = urlparse(self._local_url)
            actual = urlparse(current)
            return (
                expected.scheme == actual.scheme == "http"
                and expected.hostname in ("localhost", "127.0.0.1")
                and actual.hostname in ("localhost", "127.0.0.1")
                and expected.port == actual.port
                and actual.path.rstrip("/") == "/index.html"
            )
        except Exception:
            return False

    def _dispatch(self, event_name, detail):
        if self._window is None:
            return
        # detail 来自任务快照，绝不含本机路径。json.dumps 也避免文件名影响脚本语法。
        try:
            payload = json.dumps(detail or {}, ensure_ascii=False)
            self._window.evaluate_js(
                "window.dispatchEvent(new CustomEvent(%s,{detail:%s}));"
                % (json.dumps(str(event_name)), payload)
            )
        except Exception as exc:
            _log("desktop tts pack bridge dispatch failed: %s" % exc)

    def _announce_ready(self, drop_ready):
        if self._window is None:
            return
        detail = {"drop": bool(drop_ready), "picker": True}
        try:
            payload = json.dumps(detail, ensure_ascii=False)
            self._window.evaluate_js(
                "window.__memoNativeTtsPackImport=%s;"
                "window.dispatchEvent(new CustomEvent('memoNativeTtsPackReady',{detail:%s}));"
                % (payload, payload)
            )
        except Exception as exc:
            _log("desktop tts pack bridge ready announcement failed: %s" % exc)

    def choose_tts_pack(self):
        """供 ``window.pywebview.api`` 调用的无参数原生文件选择器。"""
        if not self._is_local_index():
            raise RuntimeError("语音包原生导入只能从本地设置页发起")
        if self._window is None:
            raise RuntimeError("桌面窗口尚未就绪")
        selected = self._window.create_file_dialog(
            self._webview.FileDialog.OPEN,
            allow_multiple=False,
            file_types=("语音包 ZIP (*.zip)",),
        )
        if not selected:
            return {"cancelled": True}
        selected_path = selected[0]
        try:
            return self._public_job_snapshot(self._server.start_tts_pack_mount_path(selected_path))
        except Exception as exc:
            return {"error": self._public_error(exc, selected_path)}

    def _queue_pending_drop(self, local_path):
        """暂存原生拖放路径，等待网页确认丢弃未保存的角色编辑。"""
        if not str(local_path).lower().endswith(".zip"):
            raise RuntimeError("请拖入完整的语音包 ZIP 文件")
        try:
            size = os.path.getsize(local_path)
        except OSError as exc:
            raise RuntimeError(self._public_error(exc, local_path))
        if size <= 0:
            raise RuntimeError("这个语音包 ZIP 是空的")
        now = time.monotonic()
        drop_id = uuid.uuid4().hex
        with self._pending_drop_lock:
            previous = self._pending_drop
            if previous and now - previous["created_at"] < self._PENDING_DROP_TTL_SECONDS:
                raise RuntimeError("已有拖入的语音包等待确认，请先完成当前操作")
            self._pending_drop = {
                "drop_id": drop_id,
                "path": os.path.abspath(local_path),
                "source_name": os.path.basename(local_path),
                "source_size": int(size),
                "created_at": now,
            }
        return {
            "drop_id": drop_id,
            "source_name": os.path.basename(local_path),
            "source_size": int(size),
        }

    def _take_pending_drop(self, drop_id):
        now = time.monotonic()
        with self._pending_drop_lock:
            pending = self._pending_drop
            if not pending or str(pending.get("drop_id") or "") != str(drop_id or ""):
                raise RuntimeError("未找到等待确认的拖入语音包")
            self._pending_drop = None
        if now - float(pending.get("created_at") or 0) > self._PENDING_DROP_TTL_SECONDS:
            raise RuntimeError("拖入语音包的确认已过期，请重新拖入 ZIP")
        return pending

    def start_tts_pack_drop(self, drop_id):
        """仅在本地页面确认后，把先前暂存的拖放路径交给后台任务。"""
        if not self._is_local_index():
            raise RuntimeError("语音包原生导入只能从本地设置页发起")
        local_path = ""
        try:
            pending = self._take_pending_drop(drop_id)
            local_path = pending["path"]
            return self._public_job_snapshot(self._server.start_tts_pack_mount_path(local_path))
        except Exception as exc:
            return {"error": self._public_error(exc, local_path)}

    def discard_tts_pack_drop(self, drop_id):
        """用户取消确认时丢弃仅保存在桥接内存中的拖放路径。"""
        if not self._is_local_index():
            raise RuntimeError("语音包原生导入只能从本地设置页发起")
        with self._pending_drop_lock:
            pending = self._pending_drop
            if pending and str(pending.get("drop_id") or "") == str(drop_id or ""):
                self._pending_drop = None
        return {"ok": True}

    @staticmethod
    def _dropped_path(event):
        payload = event if isinstance(event, dict) else {}
        files = payload.get("dataTransfer", {}).get("files", []) if isinstance(payload.get("dataTransfer", {}), dict) else []
        if not isinstance(files, list) or len(files) != 1 or not isinstance(files[0], dict):
            raise RuntimeError("请一次只拖入一个语音包 ZIP 文件")
        path = str(files[0].get("pywebviewFullPath") or "")
        if not path:
            raise RuntimeError("当前桌面内核未提供拖入文件路径，请点击“选择大型语音包 ZIP”")
        return path

    def _handle_drop(self, event):
        if not self._is_local_index():
            return
        local_path = ""
        try:
            local_path = self._dropped_path(event)
            pending = self._queue_pending_drop(local_path)
            self._dispatch("memoTtsPackDropPending", pending)
        except Exception as exc:
            self._dispatch("memoTtsPackDropPending", {"error": self._public_error(exc, local_path)})

    def attach_native_drop_handler(self):
        """每次本地入口页载入后绑定一次 pywebview 原生 drop 监听。"""
        if not self._is_local_index() or self._window is None:
            return
        try:
            page_url = str(self._window.get_current_url() or "")
            if self._drop_bound_for_page == page_url:
                self._announce_ready(True)
                return
            from webview.dom import DOMEventHandler
            dropzone = self._window.dom.get_element("#ttsPackMountDropzone")
            if dropzone is None:
                self._announce_ready(False)
                return
            dropzone.on("drop", DOMEventHandler(self._handle_drop, prevent_default=True, stop_propagation=True))
            self._drop_bound_for_page = page_url
            self._announce_ready(True)
        except Exception as exc:
            _log("desktop native tts drop unavailable: %s" % exc)
            self._announce_ready(False)


class InstanceBroker:
    """带“激活已有实例”通道的本地单实例锁。

    socket 始终作为独占所有权锁，接收循环则让第二次启动恢复已有应用，而不是
    显示含糊的“已在运行”错误。仅接受固定格式的本地 JSON 消息。
    """

    _REQUEST = {"app": "memo-superform", "version": 1, "action": "activate"}
    _OAUTH_ACTION = "maimemo_oauth_callback"

    def __init__(self, listener, port):
        self.listener = listener
        self.port = int(port)
        self._closed = threading.Event()
        self._lock = threading.RLock()
        self._activation_callback = None
        self._pending_activations = 0
        self._oauth_callback_handler = None
        self._pending_oauth_callbacks = []
        self._thread = threading.Thread(target=self._serve, name="MemoInstanceBroker", daemon=True)
        self._thread.start()

    def set_activation_callback(self, callback):
        with self._lock:
            self._activation_callback = callback
            count = self._pending_activations
            self._pending_activations = 0
        for _ in range(count):
            self._dispatch_activation(callback)

    def set_oauth_callback_handler(self, callback):
        """注册自定义协议回传处理器，并消费服务器启动前抵达的回调。"""
        with self._lock:
            self._oauth_callback_handler = callback
            pending = list(self._pending_oauth_callbacks)
            self._pending_oauth_callbacks.clear()
        for callback_url in pending:
            self._dispatch_oauth_callback(callback, callback_url)

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

    @staticmethod
    def _safe_oauth_callback(callback, callback_url):
        try:
            callback(callback_url)
        except Exception as exc:
            _log("maimemo OAuth callback failed: %s" % exc)

    def _trigger_activation(self):
        with self._lock:
            callback = self._activation_callback
            if callback is None:
                self._pending_activations += 1
                return
        self._dispatch_activation(callback)

    def _dispatch_oauth_callback(self, callback, callback_url):
        if callback is None:
            return
        threading.Thread(target=self._safe_oauth_callback, args=(callback, callback_url),
                         name="MemoMaimemoOAuthCallback", daemon=True).start()

    def _trigger_oauth_callback(self, callback_url):
        with self._lock:
            callback = self._oauth_callback_handler
            if callback is None:
                self._pending_oauth_callbacks.append(callback_url)
                return
        self._dispatch_oauth_callback(callback, callback_url)

    @classmethod
    def _is_valid_message(cls, message):
        if message == cls._REQUEST:
            return True
        if not isinstance(message, dict):
            return False
        callback_url = str(message.get("url") or "")
        return (
            message.get("app") == "memo-superform"
            and message.get("version") == 1
            and message.get("action") == cls._OAUTH_ACTION
            and _is_maimemo_oauth_callback_url(callback_url)
        )

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
                        valid = self._is_valid_message(message)
                    except (OSError, ValueError, UnicodeError):
                        valid = False
                    try:
                        connection.sendall(json.dumps({"ok": valid}).encode("utf-8"))
                    except OSError:
                        pass
                    if valid:
                        if message.get("action") == self._OAUTH_ACTION:
                            self._trigger_oauth_callback(str(message["url"]))
                        else:
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


def register_maimemo_oauth_protocol():
    """在当前 Windows 用户下注册 HTTPS 回调使用的自定义协议。

    只写 HKCU，不要求管理员权限；该协议只携带短期 code/state，令牌、PKCE
    verifier 和 client secret 都不会出现在协议 URL 中。
    """
    if os.name != "nt":
        return False
    try:
        import winreg
        command = [sys.executable]
        if not getattr(sys, "frozen", False):
            command.append(os.path.abspath(__file__))
        command += ["--maimemo-oauth-callback", "%1"]
        command_text = subprocess.list2cmdline(command)
        root = winreg.CreateKey(winreg.HKEY_CURRENT_USER, r"Software\Classes\memo-superform")
        try:
            winreg.SetValueEx(root, "", 0, winreg.REG_SZ, "URL:Memo Superform OAuth Callback")
            winreg.SetValueEx(root, "URL Protocol", 0, winreg.REG_SZ, "")
        finally:
            winreg.CloseKey(root)
        command_key = winreg.CreateKey(
            winreg.HKEY_CURRENT_USER, r"Software\Classes\memo-superform\shell\open\command"
        )
        try:
            winreg.SetValueEx(command_key, "", 0, winreg.REG_SZ, command_text)
        finally:
            winreg.CloseKey(command_key)
        _log("maimemo OAuth protocol registered")
        return True
    except Exception as exc:
        _log("maimemo OAuth protocol registration failed: %s" % exc)
        return False


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


def forward_maimemo_oauth_callback(callback_url, port=None, timeout=0.9):
    """将第二个进程接到的授权回传交给已运行的主实例。"""
    if port is None:
        port = _instance_port()
    message = {
        "app": "memo-superform", "version": 1,
        "action": InstanceBroker._OAUTH_ACTION, "url": str(callback_url),
    }
    if not InstanceBroker._is_valid_message(message):
        return False
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=timeout) as connection:
            connection.settimeout(timeout)
            connection.sendall(json.dumps(message).encode("utf-8"))
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


def run_web(guard=None, oauth_callback_url=None):
    """网页模式：后台服务器 + Windows 托盘运行状态 + 浏览器入口。"""
    os.environ["MEMO_MODE"] = "web"
    import server
    server.set_relaunch_handler(request_relaunch)
    server.set_update_handler(request_update_apply)
    if guard is not None and hasattr(guard, "set_oauth_callback_handler"):
        guard.set_oauth_callback_handler(server.complete_maimemo_oauth_callback)
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
        if oauth_callback_url:
            threading.Thread(
                target=server.complete_maimemo_oauth_callback,
                args=(oauth_callback_url,), name="MemoInitialMaimemoOAuth", daemon=True,
            ).start()

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


def run_desktop(guard=None, oauth_callback_url=None):
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
    server.set_update_handler(request_update_apply)
    if guard is not None and hasattr(guard, "set_oauth_callback_handler"):
        guard.set_oauth_callback_handler(server.complete_maimemo_oauth_callback)
    result = server.start_server(open_browser=False, block=False)
    if not result:
        show_message("Memo Superform", "无法启动本地服务器，请检查端口是否被占用。")
        sys.exit(1)
    _log("server started: %s" % result[1])
    if oauth_callback_url:
        threading.Thread(
            target=server.complete_maimemo_oauth_callback,
            args=(oauth_callback_url,), name="MemoInitialMaimemoOAuth", daemon=True,
        ).start()
    httpd, url = result
    # server.start_server 已把 build_info.BUILD_VERSION 写入入口 URL，并为本地
    # HTML/JS/CSS 禁用缓存；不要再附加硬编码的 v=78，以免自动更新后仍命中旧页。
    time.sleep(0.5)

    import webview
    exit_requested = threading.Event()
    gui_ready = threading.Event()
    pending_activation = threading.Event()
    tray_holder = {"tray": None}
    desktop_tts_bridge = _DesktopTtsPackBridge(server, url, webview)

    window = webview.create_window(
        "Memo Superform - 墨墨数据仪表盘",
        url,
        width=1280,
        height=820,
        min_size=(960, 640),
        text_select=False,
        js_api=desktop_tts_bridge,
    )
    desktop_tts_bridge.bind_window(window)

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
        # 中途退出可能在 Windows 的目录原子交换之间终止进程。关闭主窗口仍会正常
        # 隐藏到托盘；显式退出则等待当前挂载完成，避免用户误以为旧包被损坏。
        try:
            if server.is_tts_pack_mount_active():
                show_message("Memo Superform", "语音包正在后台安装。请等待安装完成；关闭窗口可先隐藏到托盘。")
                return
        except Exception:
            pass
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
    # pywebview 的 EdgeChromium 后端会在 Python DOM 的 drop 回调中提供完整文件路径。
    # 此监听只绑定本地 index 页面，远程代理页不会获得本机文件访问能力。
    window.events.before_load += desktop_tts_bridge.reset_native_drop_page
    window.events.loaded += desktop_tts_bridge.attach_native_drop_handler
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


_UPDATE_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_UPDATE_HELPER_PREFIX = "memo-update-helper-"
_UPDATE_REQUEST_PREFIX = "memo-update-request-"
_UPDATE_MAX_BYTES = 2 * 1024 * 1024 * 1024


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(256 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest().lower()


def _atomic_write_json(path, value):
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    temporary = path + ".tmp-" + uuid.uuid4().hex
    try:
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
        os.replace(temporary, path)
    finally:
        try:
            if os.path.exists(temporary):
                os.remove(temporary)
        except OSError:
            pass


def _update_directory():
    path = os.path.join(get_data_dir(), "updates")
    os.makedirs(path, exist_ok=True)
    return os.path.abspath(path)


def _is_child_path(path, parent):
    """只把更新器生成物限制在 data/updates 下，拒绝宽泛的清理路径。"""
    try:
        return os.path.commonpath([os.path.realpath(path), os.path.realpath(parent)]) == os.path.realpath(parent)
    except (OSError, ValueError):
        return False


def _hidden_detached_popen(command, env=None):
    """运行后台更新助手，整个过程不创建或闪烁黑色控制台窗口。"""
    kwargs = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if env is not None:
        kwargs["env"] = env
    if os.name == "nt":
        flags = (
            getattr(subprocess, "CREATE_NO_WINDOW", 0)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            | getattr(subprocess, "DETACHED_PROCESS", 0)
        )
        if flags:
            kwargs["creationflags"] = flags
        startupinfo_factory = getattr(subprocess, "STARTUPINFO", None)
        if startupinfo_factory is not None:
            try:
                startupinfo = startupinfo_factory()
                startupinfo.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 1)
                startupinfo.wShowWindow = getattr(subprocess, "SW_HIDE", 0)
                kwargs["startupinfo"] = startupinfo
            except Exception:
                pass
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen(command, **kwargs)


def _wait_for_process_exit(pid, timeout_seconds=120):
    """更新 helper 等待旧 EXE 真正退出，避免新版抢占旧服务器端口。"""
    if os.name == "nt":
        # Windows 上 ``os.kill(pid, 0)`` 不是 POSIX 的无副作用存在性探测；某些
        # Python 运行时会把 signal 0 传成 TerminateProcess，反而杀掉旧应用。
        # 改用 SYNCHRONIZE 句柄和 WaitForSingleObject，只等待、不发送任何信号。
        try:
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            open_process = kernel32.OpenProcess
            open_process.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
            open_process.restype = wintypes.HANDLE
            wait_for_single_object = kernel32.WaitForSingleObject
            wait_for_single_object.argtypes = (wintypes.HANDLE, wintypes.DWORD)
            wait_for_single_object.restype = wintypes.DWORD
            close_handle = kernel32.CloseHandle
            close_handle.argtypes = (wintypes.HANDLE,)
            close_handle.restype = wintypes.BOOL

            synchronize = 0x00100000
            query_limited_information = 0x00001000
            wait_object_0 = 0x00000000
            wait_failed = 0xFFFFFFFF
            invalid_parameter = 87  # ERROR_INVALID_PARAMETER: PID 已不存在。
            handle = open_process(synchronize | query_limited_information, False, int(pid))
            if not handle:
                return ctypes.get_last_error() == invalid_parameter
            try:
                deadline = time.monotonic() + float(timeout_seconds)
                while time.monotonic() < deadline:
                    remaining_ms = max(1, min(500, int((deadline - time.monotonic()) * 1000)))
                    result = wait_for_single_object(handle, remaining_ms)
                    if result == wait_object_0:
                        return True
                    if result == wait_failed:
                        return False
                return False
            finally:
                close_handle(handle)
        except Exception as exc:
            _log("Windows process wait failed: %s" % exc)
            return False

    # 非 Windows 平台的 helper 不会被启动；保留 POSIX 的 signal 0 分支供单元
    # 测试和开发运行使用，该平台上它是无副作用的存在性探测。
    deadline = time.monotonic() + float(timeout_seconds)
    while time.monotonic() < deadline:
        try:
            os.kill(int(pid), 0)
        except OSError:
            return True
        time.sleep(0.25)
    return False


def _update_result_path():
    return os.path.join(_update_directory(), "last-update-result.json")


def _record_update_result(status, message, **extra):
    payload = {
        "status": status,
        "message": str(message or ""),
        "timestamp": int(time.time()),
    }
    payload.update(extra)
    try:
        _atomic_write_json(_update_result_path(), payload)
    except OSError:
        pass


def _validate_update_request(request):
    """校验 helper 请求；所有路径均由本进程生成，仍在执行前再做一次收口。"""
    if not isinstance(request, dict):
        raise ValueError("更新请求格式不正确")
    update_dir = _update_directory()
    source_path = os.path.abspath(str(request.get("source_path") or ""))
    target_path = os.path.abspath(str(request.get("target_path") or ""))
    expected_sha256 = str(request.get("sha256") or "").lower()
    mode = str(request.get("mode") or "")
    helper_path = os.path.abspath(str(request.get("helper_path") or ""))
    try:
        expected_size = int(request.get("size") or 0)
        parent_pid = int(request.get("parent_pid") or 0)
    except (TypeError, ValueError) as exc:
        raise ValueError("更新请求的大小或进程号不正确") from exc
    if (
        not _is_child_path(source_path, update_dir)
        or not _is_child_path(helper_path, update_dir)
        or not os.path.basename(helper_path).startswith(_UPDATE_HELPER_PREFIX)
        or not helper_path.lower().endswith(".exe")
        or not _UPDATE_SHA256_RE.fullmatch(expected_sha256)
        or not (0 < expected_size <= _UPDATE_MAX_BYTES)
        or parent_pid <= 0
        or mode not in ("desktop", "web")
        or not target_path.lower().endswith(".exe")
    ):
        raise ValueError("更新请求校验失败")
    return {
        "source_path": source_path,
        "target_path": target_path,
        "sha256": expected_sha256,
        "size": expected_size,
        "parent_pid": parent_pid,
        "mode": mode,
        "helper_path": helper_path,
    }


def _cleanup_update_helper(path):
    """新版本启动后延迟清理由旧版本复制出的 helper，不触及用户任何文件。"""
    update_dir = _update_directory()
    candidate = os.path.abspath(str(path or ""))
    if (
        not _is_child_path(candidate, update_dir)
        or not os.path.basename(candidate).startswith(_UPDATE_HELPER_PREFIX)
        or not candidate.lower().endswith(".exe")
    ):
        return

    def remove_later():
        try:
            # helper 可能还在写成功结果；稍等后再删，并只删除精确匹配的本地副本。
            time.sleep(4.0)
            if os.path.isfile(candidate):
                os.remove(candidate)
        except OSError:
            pass

    threading.Thread(target=remove_later, name="memo-update-helper-cleanup", daemon=True).start()


def _restart_old_target_after_update_failure(target_path, mode):
    try:
        if os.path.isfile(target_path):
            _hidden_detached_popen([target_path, "--mode", mode])
    except Exception as exc:
        _log("failed to restart old app after update error: %s" % exc)


def apply_staged_update(request_path):
    """更新 helper 专用入口：等待父进程、核验、替换并启动新版。

    helper 是当前 EXE 的临时副本，因此这里运行时没有服务器、托盘或单实例锁；只做
    文件操作。更新失败会保留旧 EXE 和候选文件，并重新启动旧版应用。
    """
    request_file = os.path.abspath(str(request_path or ""))
    update_dir = _update_directory()
    target_path = ""
    mode = "web"
    backup_path = ""
    temporary_target = ""
    try:
        if (
            not _is_child_path(request_file, update_dir)
            or not os.path.basename(request_file).startswith(_UPDATE_REQUEST_PREFIX)
            or not request_file.lower().endswith(".json")
        ):
            raise ValueError("更新请求路径校验失败")
        with open(request_file, "r", encoding="utf-8") as handle:
            request = _validate_update_request(json.load(handle))
        target_path = request["target_path"]
        mode = request["mode"]
        source_path = request["source_path"]
        if not _wait_for_process_exit(request["parent_pid"]):
            raise RuntimeError("等待旧版本退出超时")
        if not os.path.isfile(target_path):
            raise RuntimeError("当前应用文件不存在，未执行替换")
        if not os.path.isfile(source_path):
            raise RuntimeError("已下载的更新文件不存在")
        if os.path.getsize(source_path) != request["size"]:
            raise RuntimeError("已下载的更新文件大小发生变化")
        if _sha256_file(source_path) != request["sha256"]:
            raise RuntimeError("已下载的更新文件 SHA-256 校验失败")

        target_dir = os.path.dirname(target_path)
        token = uuid.uuid4().hex
        temporary_target = os.path.join(target_dir, ".%s.memo-update-%s.tmp" % (os.path.basename(target_path), token))
        shutil.copy2(source_path, temporary_target)
        if os.path.getsize(temporary_target) != request["size"] or _sha256_file(temporary_target) != request["sha256"]:
            raise RuntimeError("复制到安装目录后的更新文件校验失败")

        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup_path = "%s.previous-%s.exe" % (target_path[:-4], stamp)
        os.replace(target_path, backup_path)
        try:
            os.replace(temporary_target, target_path)
            temporary_target = ""
            _hidden_detached_popen([
                target_path,
                "--mode", mode,
                "--cleanup-update-helper", request["helper_path"],
            ])
        except Exception:
            # 新版未能启动时把旧文件恢复为原名称，保证下次双击仍是可用版本。新
            # 文件保留为 failed 副本，避免在失败处理中无提示地丢弃诊断样本。
            if os.path.exists(backup_path):
                if os.path.exists(target_path):
                    failed_path = "%s.failed-%s.exe" % (target_path[:-4], token)
                    os.replace(target_path, failed_path)
                os.replace(backup_path, target_path)
            raise

        _record_update_result("success", "已安装 v%s" % os.path.basename(source_path), backup_path=backup_path)
        for path in (source_path, request_file):
            try:
                os.remove(path)
            except OSError:
                pass
        return 0
    except Exception as exc:
        if temporary_target:
            try:
                os.remove(temporary_target)
            except OSError:
                pass
        # 如果失败发生在移动旧 EXE 之后，则先恢复它；若新文件已经替换过，保留它
        # 以便人工排查，并让旧备份回到原路径。
        try:
            if backup_path and os.path.exists(backup_path) and not os.path.exists(target_path):
                os.replace(backup_path, target_path)
        except OSError:
            pass
        _record_update_result("failed", str(exc), target_path=target_path)
        _log("update helper failed: %s" % exc)
        _restart_old_target_after_update_failure(target_path, mode)
        show_message("Memo Superform 更新失败", "更新没有安装成功，已保留当前版本。\n\n原因：%s" % str(exc))
        return 1


def request_update_apply(staged, mode):
    """复制当前 EXE 为无界面 helper，并在 HTTP 响应返回后退出给 helper 接管。"""
    if not getattr(sys, "frozen", False) or os.name != "nt":
        raise RuntimeError("当前运行环境不支持自动安装更新")
    if mode not in ("desktop", "web"):
        raise RuntimeError("更新后的启动模式不正确")
    if not isinstance(staged, dict):
        raise RuntimeError("更新文件信息不正确")
    update_dir = _update_directory()
    source_path = os.path.abspath(str(staged.get("path") or ""))
    expected_sha256 = str(staged.get("sha256") or "").lower()
    try:
        expected_size = int(staged.get("size") or 0)
    except (TypeError, ValueError):
        expected_size = 0
    if (
        not _is_child_path(source_path, update_dir)
        or not os.path.isfile(source_path)
        or not _UPDATE_SHA256_RE.fullmatch(expected_sha256)
        or not (0 < expected_size <= _UPDATE_MAX_BYTES)
        or os.path.getsize(source_path) != expected_size
        or _sha256_file(source_path) != expected_sha256
    ):
        raise RuntimeError("更新文件在交接前校验失败")

    target_path = os.path.abspath(sys.executable)
    if not os.path.isfile(target_path) or not os.access(os.path.dirname(target_path), os.W_OK):
        raise RuntimeError("当前安装目录不可写，无法自动安装更新")

    token = uuid.uuid4().hex
    helper_path = os.path.join(update_dir, _UPDATE_HELPER_PREFIX + token + ".exe")
    request_path = os.path.join(update_dir, _UPDATE_REQUEST_PREFIX + token + ".json")
    try:
        # 不能直接让运行中的 exe 自己替换自己；把当前版本复制为最小 helper 后，
        # helper 会等待本进程完全退出，再以目标目录内的原子 os.replace 完成交接。
        shutil.copy2(target_path, helper_path)
        _atomic_write_json(request_path, {
            "parent_pid": os.getpid(),
            "source_path": source_path,
            "target_path": target_path,
            "sha256": expected_sha256,
            "size": expected_size,
            "mode": mode,
            "helper_path": helper_path,
        })
        child_env = dict(os.environ)
        # helper 位于 data/updates；显式保留原数据目录，避免其自身路径被误当成
        # 应用根目录而影响更新请求/结果的验证和记录。
        child_env["MEMO_DATA_DIR"] = get_data_dir()
        process = _hidden_detached_popen([helper_path, "--apply-update", request_path], env=child_env)
        _log("update helper spawned pid=%s" % process.pid)
    except Exception as exc:
        for path in (request_path, helper_path):
            try:
                os.remove(path)
            except OSError:
                pass
        raise RuntimeError("无法启动更新器：" + str(exc)) from exc

    write_launcher_config(mode, remember=True)
    _release_tray()
    _release_guard()
    # 保留短暂窗口让 /api/app/update/apply 的成功响应到达前端；helper 会持续等待
    # 本进程彻底结束，所以不会形成新旧版本同时抢占 HTTP 端口的情况。
    threading.Timer(1.8, lambda: os._exit(0)).start()
    _log("update exit scheduled")
    return True

def main(argv=None):
    parser = argparse.ArgumentParser(description="Memo Superform 统一启动入口")
    parser.add_argument("--mode", choices=["desktop", "web"], help="直接指定启动模式")
    parser.add_argument("--reset", action="store_true", help="清除记住的模式选择")
    parser.add_argument("--apply-update", metavar="REQUEST", help=argparse.SUPPRESS)
    parser.add_argument("--cleanup-update-helper", metavar="PATH", help=argparse.SUPPRESS)
    parser.add_argument("--maimemo-oauth-callback", metavar="URL", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    # 该分支只由临时 helper 使用，必须在实例锁、服务器、网页窗口任何一个启动前
    # 运行；否则旧版尚在时可能出现两份服务器或抢占不同构建端口的问题。
    if args.apply_update:
        return apply_staged_update(args.apply_update)

    if args.cleanup_update_helper:
        _cleanup_update_helper(args.cleanup_update_helper)

    if args.reset:
        clear_launcher_config()
        print("已清除启动模式记忆。")
        return 0

    callback_url = str(args.maimemo_oauth_callback or "").strip()
    if callback_url and not _is_maimemo_oauth_callback_url(callback_url):
        _log("rejected malformed maimemo OAuth callback")
        return 0

    # 每次普通启动都更新当前用户的协议注册；安装包升级后回调仍会定位到最新 EXE。
    # 结果必须在导入 server.py 前传入本机 OAuth 服务：注册失败时设置页会明确
    # 禁用一键授权，而不是让用户完成浏览器操作后无限轮询。
    oauth_protocol_ready = register_maimemo_oauth_protocol()
    os.environ["MEMO_MAIMEMO_PROTOCOL_READY"] = "1" if oauth_protocol_ready else "0"

    mode = args.mode or read_launcher_config()
    if mode is None:
        # 协议回调必须无交互地回到已有授权状态，首次从回调拉起时默认网页模式。
        mode = "web" if callback_url else choose_mode_interactive()
        if mode is None:
            return 0

    guard = acquire_single_instance()
    if guard is None:
        if callback_url and forward_maimemo_oauth_callback(callback_url):
            _log("maimemo OAuth callback forwarded to existing instance")
            return 0
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
        run_desktop(guard=guard, oauth_callback_url=callback_url or None)
    else:
        run_web(guard=guard, oauth_callback_url=callback_url or None)
        _release_guard()
    _log("launcher main: exit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
