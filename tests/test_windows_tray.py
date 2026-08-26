#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Focused contract tests for the optional native Windows tray host."""

import pathlib
import sys
import threading
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from windows_tray import DEFAULT_STATUS, WindowsTray


class WindowsTrayContracts(unittest.TestCase):
    def test_disabled_instance_is_a_cross_platform_noop(self):
        tray = WindowsTray(enabled=False)
        self.assertFalse(tray.supported)
        self.assertFalse(tray.start(timeout=0))
        self.assertFalse(tray.is_running)
        self.assertFalse(tray.stop(timeout=0))
        self.assertTrue(tray.wait_stopped(timeout=0))
        self.assertIsNone(tray.last_error)

    def test_status_is_tooltip_safe_and_has_a_default(self):
        tray = WindowsTray(app_name="Memo", status="", enabled=False)
        self.assertEqual(DEFAULT_STATUS, tray.status)
        self.assertEqual("Memo — " + DEFAULT_STATUS, tray._tooltip_for_shell())
        tray.set_status("x" * 300)
        self.assertEqual(127, len(tray._tooltip_for_shell()))
        self.assertEqual("x" * 300, tray.status)

    def test_callbacks_can_be_replaced_without_native_startup(self):
        calls = []
        done = threading.Event()

        def on_open():
            calls.append("open")
            done.set()

        tray = WindowsTray(enabled=False)
        tray.set_callbacks(on_open=on_open)
        tray._invoke_open()
        self.assertTrue(done.wait(1.0))
        self.assertEqual(["open"], calls)

    def test_module_remains_dependency_free(self):
        source = (ROOT / "windows_tray.py").read_text(encoding="utf-8-sig")
        self.assertIn("Shell_NotifyIconW", source)
        self.assertIn("TrackPopupMenu", source)
        self.assertNotIn("pystray", source)
        self.assertNotIn("win10toast", source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
