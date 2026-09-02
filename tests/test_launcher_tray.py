#!/usr/bin/env python3
"""Single-instance activation contracts for the Windows tray launcher path."""

import json
import os
import pathlib
import socket
import sys
import threading
import tempfile
import types
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import launcher  # noqa: E402


class LauncherTrayContracts(unittest.TestCase):
    def test_native_tts_picker_bridge_returns_only_safe_job_snapshot(self):
        class FakeServer:
            def __init__(self):
                self.paths = []

            def start_tts_pack_mount_path(self, path):
                self.paths.append(path)
                return {
                    "job_id": "job-1", "source_name": "voice.zip", "source_size": 42,
                    "path": r"C:\\private\\voice.zip",
                }

        class FakeWindow:
            def get_current_url(self):
                return "http://localhost:8888/index.html?v=0.85"

            def create_file_dialog(self, *args, **kwargs):
                self.dialog_args = (args, kwargs)
                return (r"C:\voice-pack.zip",)

        fake_webview = types.SimpleNamespace(FileDialog=types.SimpleNamespace(OPEN=10))
        server = FakeServer()
        bridge = launcher._DesktopTtsPackBridge(server, "http://localhost:8888/index.html?v=0.85", fake_webview)
        window = FakeWindow()
        bridge.bind_window(window)

        result = bridge.choose_tts_pack()

        self.assertEqual(server.paths, [r"C:\voice-pack.zip"])
        self.assertEqual(result, {"job_id": "job-1", "source_name": "voice.zip", "source_size": 42})
        self.assertNotIn("path", result)
        self.assertEqual(window.dialog_args[0][0], 10)

    def test_native_tts_bridge_redacts_paths_from_errors_and_snapshots(self):
        public = launcher._DesktopTtsPackBridge._public_job_snapshot({
            "job_id": "job-2", "source_name": r"C:\\private\\voice.zip",
            "message": r"读取 C:\\private\\voice.zip", "error": r"C:\\private\\detail.txt",
            "path": r"C:\\private\\voice.zip",
        })
        self.assertEqual(public["source_name"], "voice.zip")
        self.assertNotIn("path", public)
        self.assertNotIn("C:\\private", public["message"])
        self.assertNotIn("C:\\private", public["error"])

    def test_native_drop_waits_for_page_confirmation_before_starting_install(self):
        class FakeServer:
            def __init__(self):
                self.paths = []

            def start_tts_pack_mount_path(self, path):
                self.paths.append(path)
                return {"job_id": "job-3", "source_name": os.path.basename(path), "source_size": 3}

        class FakeWindow:
            def get_current_url(self):
                return "http://localhost:8888/index.html?v=0.85"

        with tempfile.TemporaryDirectory() as directory:
            archive = pathlib.Path(directory) / "voice.zip"
            archive.write_bytes(b"zip")
            server = FakeServer()
            bridge = launcher._DesktopTtsPackBridge(
                server, "http://localhost:8888/index.html?v=0.85", types.SimpleNamespace()
            )
            bridge.bind_window(FakeWindow())

            pending = bridge._queue_pending_drop(str(archive))
            self.assertEqual(server.paths, [], "drop must not start an install until the page confirms it")
            result = bridge.start_tts_pack_drop(pending["drop_id"])

        self.assertEqual(server.paths, [str(archive)])
        self.assertEqual(result["job_id"], "job-3")
        self.assertNotIn("path", result)

    def test_native_tts_bridge_rejects_nonlocal_page_and_validates_one_drop_path(self):
        class FakeWindow:
            def get_current_url(self):
                return "https://example.com/"

        bridge = launcher._DesktopTtsPackBridge(
            types.SimpleNamespace(), "http://localhost:8888/index.html", types.SimpleNamespace()
        )
        bridge.bind_window(FakeWindow())
        with self.assertRaisesRegex(RuntimeError, "本地设置页"):
            bridge.choose_tts_pack()

        self.assertEqual(
            launcher._DesktopTtsPackBridge._dropped_path({
                "dataTransfer": {"files": [{"name": "voice.zip", "pywebviewFullPath": r"C:\voice.zip"}]}
            }),
            r"C:\voice.zip",
        )
        with self.assertRaisesRegex(RuntimeError, "一次只拖入"):
            launcher._DesktopTtsPackBridge._dropped_path({"dataTransfer": {"files": []}})

    def test_existing_instance_activation_is_queued_then_delivered(self):
        broker = launcher.acquire_single_instance(0)
        self.assertIsNotNone(broker)
        calls = []
        delivered = threading.Event()
        try:
            self.assertTrue(launcher.activate_existing_instance(broker.port, timeout=1.0))
            broker.set_activation_callback(lambda: (calls.append("activate"), delivered.set()))
            self.assertTrue(delivered.wait(1.0))
            self.assertEqual(["activate"], calls)
            delivered.clear()
            self.assertTrue(launcher.activate_existing_instance(broker.port, timeout=1.0))
            self.assertTrue(delivered.wait(1.0))
            self.assertEqual(["activate", "activate"], calls)
        finally:
            broker.close()

    def test_unrelated_broker_payload_is_not_accepted(self):
        broker = launcher.acquire_single_instance(0)
        self.assertIsNotNone(broker)
        try:
            with socket.create_connection(("127.0.0.1", broker.port), timeout=1.0) as connection:
                connection.sendall(json.dumps({"app": "other", "action": "activate"}).encode("utf-8"))
                reply = json.loads(connection.recv(256).decode("utf-8"))
            self.assertFalse(reply["ok"])
        finally:
            broker.close()

    def test_oauth_callback_is_queued_then_delivered_to_running_instance(self):
        broker = launcher.acquire_single_instance(0)
        self.assertIsNotNone(broker)
        delivered = threading.Event()
        values = []
        callback = "memo-superform://maimemo-oauth/?code=abc&state=state"
        try:
            self.assertTrue(launcher.forward_maimemo_oauth_callback(callback, broker.port, timeout=1.0))
            broker.set_oauth_callback_handler(lambda url: (values.append(url), delivered.set()))
            self.assertTrue(delivered.wait(1.0))
            self.assertEqual([callback], values)
            self.assertFalse(launcher.forward_maimemo_oauth_callback("https://example.com", broker.port))
            self.assertFalse(launcher.forward_maimemo_oauth_callback("memo-superform://maimemo-oauth/extra?code=abc", broker.port))
            self.assertFalse(launcher.forward_maimemo_oauth_callback("memo-superform://maimemo-oauth", broker.port))
        finally:
            broker.close()

    def test_launcher_contains_tray_lifecycle_and_background_web_mode(self):
        source = (ROOT / "launcher.py").read_text(encoding="utf-8-sig")
        self.assertIn("create_windows_tray", source)
        self.assertIn("window.events.closing += close_to_tray", source)
        self.assertIn("window.events.before_load += desktop_tts_bridge.reset_native_drop_page", source)
        self.assertIn("server.start_server(open_browser=False, block=False)", source)
        self.assertIn("activate_existing_instance", source)
        self.assertIn('MEMO_MAIMEMO_PROTOCOL_READY', source)

    def test_source_desktop_entry_uses_the_unified_protocol_registering_launcher(self):
        source = (ROOT / "app.py").read_text(encoding="utf-8-sig")
        self.assertIn('main(["--mode", "desktop"])', source)

    def test_frozen_desktop_build_keeps_pywebview_dom_for_native_drop(self):
        spec = (ROOT / "MemoSuperform.spec").read_text(encoding="utf-8-sig")
        self.assertIn("'webview.dom'", spec)
        self.assertIn("'webview.dom.element'", spec)

    def test_v085_uses_a_build_scoped_broker_instead_of_the_old_8891_port(self):
        # A new executable must not activate an older v0.76 process and exit.
        # Explicit MEMO_INSTANCE_PORT remains an opt-in operator override, so
        # remove it only for this default-release contract.
        environment = dict(os.environ)
        environment.pop("MEMO_INSTANCE_PORT", None)
        with mock.patch.dict(os.environ, environment, clear=True):
            self.assertEqual(launcher.BUILD_VERSION, "0.85")
            self.assertEqual(launcher._instance_port(), 15185)
            self.assertNotEqual(launcher._instance_port(), 8891)


if __name__ == "__main__":
    unittest.main(verbosity=2)
