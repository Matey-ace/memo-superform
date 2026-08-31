#!/usr/bin/env python3
"""Single-instance activation contracts for the Windows tray launcher path."""

import json
import os
import pathlib
import socket
import sys
import threading
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import launcher  # noqa: E402


class LauncherTrayContracts(unittest.TestCase):
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
        callback = "memo-superform://maimemo-oauth?code=abc&state=state"
        try:
            self.assertTrue(launcher.forward_maimemo_oauth_callback(callback, broker.port, timeout=1.0))
            broker.set_oauth_callback_handler(lambda url: (values.append(url), delivered.set()))
            self.assertTrue(delivered.wait(1.0))
            self.assertEqual([callback], values)
            self.assertFalse(launcher.forward_maimemo_oauth_callback("https://example.com", broker.port))
        finally:
            broker.close()

    def test_launcher_contains_tray_lifecycle_and_background_web_mode(self):
        source = (ROOT / "launcher.py").read_text(encoding="utf-8-sig")
        self.assertIn("create_windows_tray", source)
        self.assertIn("window.events.closing += close_to_tray", source)
        self.assertIn("server.start_server(open_browser=False, block=False)", source)
        self.assertIn("activate_existing_instance", source)

    def test_v078_uses_a_build_scoped_broker_instead_of_the_old_8891_port(self):
        # A new executable must not activate an older v0.76 process and exit.
        # Explicit MEMO_INSTANCE_PORT remains an opt-in operator override, so
        # remove it only for this default-release contract.
        environment = dict(os.environ)
        environment.pop("MEMO_INSTANCE_PORT", None)
        with mock.patch.dict(os.environ, environment, clear=True):
            self.assertEqual(launcher.BUILD_VERSION, "0.78")
            self.assertEqual(launcher._instance_port(), 15178)
            self.assertNotEqual(launcher._instance_port(), 8891)


if __name__ == "__main__":
    unittest.main(verbosity=2)
