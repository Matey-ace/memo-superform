#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Windows notification-area (system tray) indicator for Memo Superform.

The module deliberately uses only the Win32 APIs exposed by :mod:`ctypes` so it
can be bundled with the existing executable without adding a runtime dependency.
On non-Windows platforms, :class:`WindowsTray` is a no-op and is safe to import
or instantiate.

Typical desktop launcher usage::

    tray = WindowsTray(
        icon_path=_res_path(os.path.join("img", "icon.ico")),
        on_open=show_main_window,
        on_exit=close_application,
    )
    tray.start()
    tray.set_status("正在运行")
    # ... on every normal shutdown path
    tray.stop()

The native tray host owns a tiny hidden message window on a daemon thread.  All
``Shell_NotifyIconW`` calls happen on that thread.  Public callbacks run on a
separate daemon callback thread, so a slow UI callback never blocks the Windows
shell message pump.
"""

from __future__ import annotations

import ctypes
import logging
import os
import sys
import threading
import time
from ctypes import wintypes
from typing import Callable, Optional


_LOG = logging.getLogger(__name__)
_IS_WINDOWS = sys.platform == "win32"

# The shell silently truncates NOTIFYICONDATAW.szTip after 127 characters.
_MAX_TOOLTIP_LENGTH = 127

# Publicly useful status label for an app that has started but has not supplied a
# more specific lifecycle state yet.
DEFAULT_STATUS = "正在运行"


if _IS_WINDOWS:
    # ctypes.wintypes does not expose all of these consistently across Python
    # versions, hence the explicit pointer-sized declarations.
    _LRESULT = ctypes.c_ssize_t
    _UINT_PTR = ctypes.c_size_t
    _HICON = ctypes.c_void_p
    _HMENU = ctypes.c_void_p
    _HINSTANCE = ctypes.c_void_p
    _WNDPROC = ctypes.WINFUNCTYPE(
        _LRESULT,
        wintypes.HWND,
        wintypes.UINT,
        wintypes.WPARAM,
        wintypes.LPARAM,
    )

    class _GUID(ctypes.Structure):
        _fields_ = [
            ("Data1", wintypes.DWORD),
            ("Data2", wintypes.WORD),
            ("Data3", wintypes.WORD),
            ("Data4", ctypes.c_ubyte * 8),
        ]


    class _NOTIFYICONDATAW(ctypes.Structure):
        """Full Vista+ NOTIFYICONDATAW layout (safe with older shell versions)."""

        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("hWnd", wintypes.HWND),
            ("uID", wintypes.UINT),
            ("uFlags", wintypes.UINT),
            ("uCallbackMessage", wintypes.UINT),
            ("hIcon", _HICON),
            ("szTip", ctypes.c_wchar * 128),
            ("dwState", wintypes.DWORD),
            ("dwStateMask", wintypes.DWORD),
            ("szInfo", ctypes.c_wchar * 256),
            ("uTimeoutOrVersion", wintypes.UINT),
            ("szInfoTitle", ctypes.c_wchar * 64),
            ("dwInfoFlags", wintypes.DWORD),
            ("guidItem", _GUID),
            ("hBalloonIcon", _HICON),
        ]

        @property
        def uVersion(self):
            return self.uTimeoutOrVersion

        @uVersion.setter
        def uVersion(self, value):
            self.uTimeoutOrVersion = value


    class _WNDCLASSW(ctypes.Structure):
        _fields_ = [
            ("style", wintypes.UINT),
            ("lpfnWndProc", _WNDPROC),
            ("cbClsExtra", ctypes.c_int),
            ("cbWndExtra", ctypes.c_int),
            ("hInstance", _HINSTANCE),
            ("hIcon", _HICON),
            ("hCursor", ctypes.c_void_p),
            ("hbrBackground", ctypes.c_void_p),
            ("lpszMenuName", wintypes.LPCWSTR),
            ("lpszClassName", wintypes.LPCWSTR),
        ]


class _WindowsTrayBackend:
    """Thin Win32 binding kept separate from the portable public facade."""

    # Shell_NotifyIconW operations and flags.
    NIM_ADD = 0x00000000
    NIM_MODIFY = 0x00000001
    NIM_DELETE = 0x00000002
    NIM_SETVERSION = 0x00000004
    NOTIFYICON_VERSION_4 = 4
    NIF_MESSAGE = 0x00000001
    NIF_ICON = 0x00000002
    NIF_TIP = 0x00000004

    # Window and menu messages/flags.
    WM_NULL = 0x0000
    WM_DESTROY = 0x0002
    WM_CLOSE = 0x0010
    WM_COMMAND = 0x0111
    WM_CONTEXTMENU = 0x007B
    WM_LBUTTONUP = 0x0202
    WM_LBUTTONDBLCLK = 0x0203
    WM_RBUTTONUP = 0x0205
    WM_APP = 0x8000
    WM_TRAY_CALLBACK = WM_APP + 0x41
    WM_TRAY_UPDATE = WM_APP + 0x42

    MF_STRING = 0x0000
    MF_SEPARATOR = 0x0800
    TPM_RIGHTBUTTON = 0x0002
    TPM_RETURNCMD = 0x0100
    TPM_NONOTIFY = 0x0080

    IMAGE_ICON = 1
    LR_DEFAULTSIZE = 0x0040
    LR_LOADFROMFILE = 0x0010
    IDI_APPLICATION = 32512

    CMD_OPEN = 1001
    CMD_EXIT = 1002

    def __init__(self, owner: "WindowsTray") -> None:
        if not _IS_WINDOWS:
            raise RuntimeError("Windows tray backend is only available on Windows")
        self.owner = owner
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.shell32 = ctypes.WinDLL("shell32", use_last_error=True)
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._configure_apis()
        self.hinstance = self.kernel32.GetModuleHandleW(None)
        self.class_name = "MemoSuperformTray_%d_%x" % (os.getpid(), id(owner))
        self._wndproc = _WNDPROC(self._window_proc)
        self._class_registered = False
        self._icon_handle = None
        self._owns_icon = False

    def _configure_apis(self) -> None:
        self.kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
        self.kernel32.GetModuleHandleW.restype = _HINSTANCE

        self.user32.RegisterClassW.argtypes = [ctypes.POINTER(_WNDCLASSW)]
        self.user32.RegisterClassW.restype = wintypes.ATOM
        self.user32.UnregisterClassW.argtypes = [wintypes.LPCWSTR, _HINSTANCE]
        self.user32.UnregisterClassW.restype = wintypes.BOOL
        self.user32.CreateWindowExW.argtypes = [
            wintypes.DWORD,
            wintypes.LPCWSTR,
            wintypes.LPCWSTR,
            wintypes.DWORD,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            wintypes.HWND,
            _HMENU,
            _HINSTANCE,
            ctypes.c_void_p,
        ]
        self.user32.CreateWindowExW.restype = wintypes.HWND
        self.user32.DefWindowProcW.argtypes = [
            wintypes.HWND,
            wintypes.UINT,
            wintypes.WPARAM,
            wintypes.LPARAM,
        ]
        self.user32.DefWindowProcW.restype = _LRESULT
        self.user32.DestroyWindow.argtypes = [wintypes.HWND]
        self.user32.DestroyWindow.restype = wintypes.BOOL
        self.user32.PostMessageW.argtypes = [
            wintypes.HWND,
            wintypes.UINT,
            wintypes.WPARAM,
            wintypes.LPARAM,
        ]
        self.user32.PostMessageW.restype = wintypes.BOOL
        self.user32.PostQuitMessage.argtypes = [ctypes.c_int]
        self.user32.PostQuitMessage.restype = None
        self.user32.GetMessageW.argtypes = [
            ctypes.POINTER(wintypes.MSG),
            wintypes.HWND,
            wintypes.UINT,
            wintypes.UINT,
        ]
        self.user32.GetMessageW.restype = ctypes.c_int
        self.user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
        self.user32.TranslateMessage.restype = wintypes.BOOL
        self.user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
        self.user32.DispatchMessageW.restype = _LRESULT
        self.user32.LoadImageW.argtypes = [
            _HINSTANCE,
            wintypes.LPCWSTR,
            wintypes.UINT,
            ctypes.c_int,
            ctypes.c_int,
            wintypes.UINT,
        ]
        self.user32.LoadImageW.restype = ctypes.c_void_p
        # The resource identifier passed to LoadIconW is an integer pointer.
        self.user32.LoadIconW.argtypes = [_HINSTANCE, ctypes.c_void_p]
        self.user32.LoadIconW.restype = _HICON
        self.user32.DestroyIcon.argtypes = [_HICON]
        self.user32.DestroyIcon.restype = wintypes.BOOL
        self.user32.CreatePopupMenu.argtypes = []
        self.user32.CreatePopupMenu.restype = _HMENU
        self.user32.AppendMenuW.argtypes = [
            _HMENU,
            wintypes.UINT,
            _UINT_PTR,
            wintypes.LPCWSTR,
        ]
        self.user32.AppendMenuW.restype = wintypes.BOOL
        self.user32.TrackPopupMenu.argtypes = [
            _HMENU,
            wintypes.UINT,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            wintypes.HWND,
            ctypes.c_void_p,
        ]
        self.user32.TrackPopupMenu.restype = wintypes.UINT
        self.user32.DestroyMenu.argtypes = [_HMENU]
        self.user32.DestroyMenu.restype = wintypes.BOOL
        self.user32.SetForegroundWindow.argtypes = [wintypes.HWND]
        self.user32.SetForegroundWindow.restype = wintypes.BOOL
        self.user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
        self.user32.GetCursorPos.restype = wintypes.BOOL

        self.shell32.Shell_NotifyIconW.argtypes = [
            wintypes.DWORD,
            ctypes.POINTER(_NOTIFYICONDATAW),
        ]
        self.shell32.Shell_NotifyIconW.restype = wintypes.BOOL

    @staticmethod
    def _last_error(context: str) -> OSError:
        code = ctypes.get_last_error() or 1
        return OSError(code, "%s (Win32 error %d)" % (context, code))

    def create_window(self):
        window_class = _WNDCLASSW()
        window_class.lpfnWndProc = self._wndproc
        window_class.hInstance = self.hinstance
        window_class.lpszClassName = self.class_name
        atom = self.user32.RegisterClassW(ctypes.byref(window_class))
        if not atom:
            raise self._last_error("RegisterClassW")
        self._class_registered = True

        # A non-visible top-level window avoids taskbar presence while remaining
        # compatible with Shell_NotifyIcon callbacks on all supported Windows
        # versions (unlike a message-only window on older Shell builds).
        hwnd = self.user32.CreateWindowExW(
            0,
            self.class_name,
            self.owner.app_name,
            0,
            0,
            0,
            0,
            0,
            None,
            None,
            self.hinstance,
            None,
        )
        if not hwnd:
            raise self._last_error("CreateWindowExW")
        return hwnd

    def load_icon(self):
        icon_path = self.owner.icon_path
        if icon_path and os.path.isfile(icon_path):
            handle = self.user32.LoadImageW(
                None,
                icon_path,
                self.IMAGE_ICON,
                0,
                0,
                self.LR_LOADFROMFILE | self.LR_DEFAULTSIZE,
            )
            if handle:
                self._icon_handle = handle
                self._owns_icon = True
                return handle
            _LOG.warning("Unable to load tray icon %s; using application icon", icon_path)

        # IDI_APPLICATION is a shared system resource and must not be destroyed.
        handle = self.user32.LoadIconW(None, ctypes.c_void_p(self.IDI_APPLICATION))
        if not handle:
            raise self._last_error("LoadIconW")
        self._icon_handle = handle
        self._owns_icon = False
        return handle

    def _notification_data(self, hwnd, flags):
        data = _NOTIFYICONDATAW()
        data.cbSize = ctypes.sizeof(_NOTIFYICONDATAW)
        data.hWnd = hwnd
        data.uID = 1
        data.uFlags = flags
        data.uCallbackMessage = self.WM_TRAY_CALLBACK
        if self._icon_handle:
            data.hIcon = self._icon_handle
        data.szTip = self.owner._tooltip_for_shell()
        return data

    def add_icon(self, hwnd) -> bool:
        data = self._notification_data(
            hwnd, self.NIF_MESSAGE | self.NIF_ICON | self.NIF_TIP
        )
        return bool(self.shell32.Shell_NotifyIconW(self.NIM_ADD, ctypes.byref(data)))

    def set_version(self, hwnd) -> None:
        data = self._notification_data(hwnd, 0)
        data.uVersion = self.NOTIFYICON_VERSION_4
        # NIM_SETVERSION failure is non-fatal: the icon still works with the
        # legacy callback contract, handled by _window_proc below.
        self.shell32.Shell_NotifyIconW(self.NIM_SETVERSION, ctypes.byref(data))

    def update_icon(self, hwnd) -> bool:
        data = self._notification_data(hwnd, self.NIF_TIP | self.NIF_ICON)
        return bool(self.shell32.Shell_NotifyIconW(self.NIM_MODIFY, ctypes.byref(data)))

    def delete_icon(self, hwnd) -> None:
        if not hwnd:
            return
        data = self._notification_data(hwnd, 0)
        try:
            self.shell32.Shell_NotifyIconW(self.NIM_DELETE, ctypes.byref(data))
        except Exception:
            _LOG.debug("Shell_NotifyIconW(NIM_DELETE) failed", exc_info=True)

    def show_menu(self, hwnd) -> int:
        menu = self.user32.CreatePopupMenu()
        if not menu:
            raise self._last_error("CreatePopupMenu")
        try:
            if not self.user32.AppendMenuW(
                menu, self.MF_STRING, self.CMD_OPEN, "打开 Memo Superform"
            ):
                raise self._last_error("AppendMenuW(open)")
            if not self.user32.AppendMenuW(menu, self.MF_SEPARATOR, 0, None):
                raise self._last_error("AppendMenuW(separator)")
            if not self.user32.AppendMenuW(menu, self.MF_STRING, self.CMD_EXIT, "退出 Memo Superform"):
                raise self._last_error("AppendMenuW(exit)")

            point = wintypes.POINT()
            if not self.user32.GetCursorPos(ctypes.byref(point)):
                raise self._last_error("GetCursorPos")
            # Required by the shell for a popup menu that is dismissed by a
            # subsequent click instead of remaining highlighted/frozen.
            self.user32.SetForegroundWindow(hwnd)
            command = self.user32.TrackPopupMenu(
                menu,
                self.TPM_RIGHTBUTTON | self.TPM_RETURNCMD | self.TPM_NONOTIFY,
                point.x,
                point.y,
                0,
                hwnd,
                None,
            )
            self.user32.PostMessageW(hwnd, self.WM_NULL, 0, 0)
            return int(command)
        finally:
            self.user32.DestroyMenu(menu)

    def post_close(self, hwnd) -> None:
        if hwnd:
            self.user32.PostMessageW(hwnd, self.WM_CLOSE, 0, 0)

    def post_update(self, hwnd) -> None:
        if hwnd:
            self.user32.PostMessageW(hwnd, self.WM_TRAY_UPDATE, 0, 0)

    def destroy_window(self, hwnd) -> None:
        if hwnd:
            self.user32.DestroyWindow(hwnd)

    def dispose(self) -> None:
        if self._icon_handle and self._owns_icon:
            try:
                self.user32.DestroyIcon(self._icon_handle)
            except Exception:
                _LOG.debug("DestroyIcon failed", exc_info=True)
        self._icon_handle = None
        self._owns_icon = False
        if self._class_registered:
            try:
                self.user32.UnregisterClassW(self.class_name, self.hinstance)
            except Exception:
                _LOG.debug("UnregisterClassW failed", exc_info=True)
        self._class_registered = False

    def message_loop(self) -> None:
        message = wintypes.MSG()
        while True:
            result = self.user32.GetMessageW(ctypes.byref(message), None, 0, 0)
            if result == 0:
                return
            if result == -1:
                raise self._last_error("GetMessageW")
            self.user32.TranslateMessage(ctypes.byref(message))
            self.user32.DispatchMessageW(ctypes.byref(message))

    def _window_proc(self, hwnd, message, wparam, lparam):
        try:
            return self.owner._handle_window_message(hwnd, message, wparam, lparam)
        except Exception:
            # A Python exception must never escape a Win32 callback.  Doing so
            # can corrupt the message loop and leaves a stale tray icon behind.
            _LOG.exception("Unhandled exception in Windows tray window procedure")
            return self.user32.DefWindowProcW(hwnd, message, wparam, lparam)


class WindowsTray:
    """Native Windows taskbar notification-area indicator.

    Parameters
    ----------
    app_name:
        Prefix used in the tooltip and hidden host-window title.
    icon_path:
        Optional ``.ico`` file.  The shared Windows application icon is used if
        the file is unavailable.
    on_open:
        Callback fired for left-click/double-click and the **打开** menu action.
    on_exit:
        Callback fired for the **退出** menu action, after the tray host has been
        asked to stop.  The callback should close the application's main window
        and server process.
    status:
        Initial human-readable runtime status shown in the tooltip.
    enabled:
        Test/embedding override.  ``None`` enables the feature only on Windows;
        ``False`` makes every method a no-op.

    ``start()`` returns ``True`` only after ``Shell_NotifyIconW(NIM_ADD)`` has
    succeeded.  Failure is captured in :attr:`last_error` and never prevents the
    application itself from starting.  ``stop()`` is idempotent and safe from a
    callback or any other thread.
    """

    def __init__(
        self,
        app_name: str = "Memo Superform",
        icon_path: Optional[str] = None,
        on_open: Optional[Callable[[], None]] = None,
        on_exit: Optional[Callable[[], None]] = None,
        status: str = DEFAULT_STATUS,
        enabled: Optional[bool] = None,
    ) -> None:
        self.app_name = str(app_name or "Memo Superform")
        self.icon_path = os.path.abspath(icon_path) if icon_path else None
        self._on_open = on_open
        self._on_exit = on_exit
        self._enabled = _IS_WINDOWS if enabled is None else bool(enabled) and _IS_WINDOWS
        self._status = self._coerce_status(status)
        self._lock = threading.RLock()
        self._thread: Optional[threading.Thread] = None
        self._backend: Optional[_WindowsTrayBackend] = None
        self._hwnd = None
        self._started_event = threading.Event()
        self._stopped_event = threading.Event()
        self._stopped_event.set()
        self._stop_requested = False
        self._exit_dispatched = False
        self._icon_added = False
        self._last_error: Optional[BaseException] = None

    @property
    def supported(self) -> bool:
        """Whether this instance will create a native tray icon on this host."""
        return self._enabled

    @property
    def is_running(self) -> bool:
        """Whether the shell has accepted and currently owns this tray icon."""
        with self._lock:
            return bool(self._icon_added and self._thread and self._thread.is_alive())

    @property
    def status(self) -> str:
        with self._lock:
            return self._status

    @property
    def last_error(self) -> Optional[BaseException]:
        with self._lock:
            return self._last_error

    def start(self, timeout: float = 3.0) -> bool:
        """Start the hidden Win32 message thread and add the notification icon."""
        if not self._enabled:
            return False

        with self._lock:
            if self._thread and self._thread.is_alive():
                return bool(self._icon_added)
            self._started_event.clear()
            self._stopped_event.clear()
            self._stop_requested = False
            self._exit_dispatched = False
            self._last_error = None
            self._thread = threading.Thread(
                target=self._thread_main,
                name="MemoSuperformTray",
                daemon=True,
            )
            self._thread.start()

        # Do not make app startup fragile: a missing shell/Explorer only makes
        # the indicator unavailable; the launcher may continue normally.
        self._started_event.wait(max(0.0, float(timeout)))
        return self.is_running

    def stop(self, timeout: float = 2.0) -> bool:
        """Remove the icon and stop the message thread (idempotent)."""
        if not self._enabled:
            return False

        with self._lock:
            self._stop_requested = True
            thread = self._thread
            backend = self._backend
            hwnd = self._hwnd
            active = bool(thread and thread.is_alive())

        if backend and hwnd:
            try:
                backend.post_close(hwnd)
            except Exception:
                _LOG.debug("Unable to post WM_CLOSE to tray window", exc_info=True)

        # Never join the message thread from itself (for example after clicking
        # the native Exit menu item).
        if active and thread is not threading.current_thread():
            thread.join(max(0.0, float(timeout)))
        return active

    def wait_stopped(self, timeout: Optional[float] = None) -> bool:
        """Wait for native icon removal and message-thread termination.

        This is useful for an application shutdown path that wants to make sure
        the taskbar indicator has disappeared before it releases other process
        resources.  It is also safe on non-Windows, where the initial stopped
        state is already set.
        """
        return self._stopped_event.wait(timeout)

    def set_status(self, status: str) -> None:
        """Update the runtime-status tooltip without recreating the icon."""
        with self._lock:
            self._status = self._coerce_status(status)
            backend = self._backend
            hwnd = self._hwnd
            can_update = bool(self._icon_added and backend and hwnd)
        if can_update:
            try:
                backend.post_update(hwnd)
            except Exception:
                _LOG.debug("Unable to post tray tooltip update", exc_info=True)

    def set_callbacks(
        self,
        on_open: Optional[Callable[[], None]] = None,
        on_exit: Optional[Callable[[], None]] = None,
    ) -> None:
        """Replace the menu/click callbacks while the tray host is running."""
        with self._lock:
            self._on_open = on_open
            self._on_exit = on_exit

    def _coerce_status(self, status: str) -> str:
        text = str(status or "").strip()
        return text or DEFAULT_STATUS

    def _tooltip_for_shell(self) -> str:
        with self._lock:
            status = self._status
            text = "%s — %s" % (self.app_name, status) if status else self.app_name
        return text[:_MAX_TOOLTIP_LENGTH]

    def _thread_main(self) -> None:
        backend = None
        hwnd = None
        added = False
        try:
            backend = _WindowsTrayBackend(self)
            with self._lock:
                self._backend = backend
            hwnd = backend.create_window()
            with self._lock:
                self._hwnd = hwnd
                stop_requested = self._stop_requested
            if stop_requested:
                self._started_event.set()
                return

            backend.load_icon()
            if not backend.add_icon(hwnd):
                raise RuntimeError("Shell_NotifyIconW(NIM_ADD) returned false")
            added = True
            with self._lock:
                self._icon_added = True
            backend.set_version(hwnd)
            self._started_event.set()

            with self._lock:
                stop_requested = self._stop_requested
            if stop_requested:
                backend.post_close(hwnd)
            backend.message_loop()
        except BaseException as exc:
            with self._lock:
                self._last_error = exc
            _LOG.warning("Windows tray indicator did not start: %s", exc)
            self._started_event.set()
        finally:
            if added and backend and hwnd:
                backend.delete_icon(hwnd)
            if backend and hwnd:
                try:
                    backend.destroy_window(hwnd)
                except Exception:
                    _LOG.debug("DestroyWindow failed during tray shutdown", exc_info=True)
            if backend:
                backend.dispose()
            with self._lock:
                self._icon_added = False
                self._hwnd = None
                self._backend = None
            self._started_event.set()
            self._stopped_event.set()

    def _handle_window_message(self, hwnd, message, wparam, lparam):
        backend = self._backend
        if not backend:
            return 0

        if message == backend.WM_TRAY_CALLBACK:
            # NOTIFYICON_VERSION_4 stores the event in LOWORD(lParam).  The
            # legacy protocol stores it in lParam directly; this form handles
            # both because all relevant values fit in the low word.
            event = int(lparam) & 0xFFFF
            if event in (backend.WM_LBUTTONUP, backend.WM_LBUTTONDBLCLK):
                self._invoke_open()
            elif event in (backend.WM_RBUTTONUP, backend.WM_CONTEXTMENU):
                self._show_context_menu(hwnd)
            return 0

        if message == backend.WM_TRAY_UPDATE:
            try:
                backend.update_icon(hwnd)
            except Exception:
                _LOG.debug("Tray tooltip update failed", exc_info=True)
            return 0

        if message == backend.WM_COMMAND:
            self._handle_command(int(wparam) & 0xFFFF)
            return 0

        if message == backend.WM_CLOSE:
            backend.delete_icon(hwnd)
            with self._lock:
                self._icon_added = False
            backend.destroy_window(hwnd)
            return 0

        if message == backend.WM_DESTROY:
            backend.user32.PostQuitMessage(0)
            return 0

        return backend.user32.DefWindowProcW(hwnd, message, wparam, lparam)

    def _show_context_menu(self, hwnd) -> None:
        backend = self._backend
        if not backend:
            return
        try:
            command = backend.show_menu(hwnd)
        except Exception:
            _LOG.exception("Unable to show Windows tray context menu")
            return
        self._handle_command(command)

    def _handle_command(self, command: int) -> None:
        backend = self._backend
        if backend and command == backend.CMD_OPEN:
            self._invoke_open()
        elif backend and command == backend.CMD_EXIT:
            # TrackPopupMenu normally closes before this handler runs, but a
            # keyboard repeat or a second shell notification can still arrive
            # before WM_CLOSE removes the icon.  Invoke application shutdown
            # once per tray lifecycle, never once per menu message.
            with self._lock:
                if self._exit_dispatched:
                    return
                self._exit_dispatched = True
            # Request icon removal before application shutdown starts, so the
            # user never keeps a stale "running" indicator after selecting Exit.
            self.stop(timeout=0.0)
            self._dispatch_callback(self._on_exit, "exit")

    def _invoke_open(self) -> None:
        self._dispatch_callback(self._on_open, "open")

    @staticmethod
    def _dispatch_callback(
        callback: Optional[Callable[[], None]], action: str
    ) -> None:
        if callback is None:
            return

        def run_callback() -> None:
            try:
                callback()
            except BaseException:
                _LOG.exception("Windows tray %s callback failed", action)

        threading.Thread(
            target=run_callback,
            name="MemoSuperformTray-%s" % action,
            daemon=True,
        ).start()


__all__ = ["DEFAULT_STATUS", "WindowsTray"]
