#!/usr/bin/env python3
"""Single-instance activation contracts for the Windows tray launcher path."""

import json
import pathlib
import socket
import sys
import threading
import unittest

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

    def test_launcher_contains_tray_lifecycle_and_background_web_mode(self):
        source = (ROOT / "launcher.py").read_text(encoding="utf-8-sig")
        self.assertIn("create_windows_tray", source)
        self.assertIn("window.events.closing += close_to_tray", source)
        self.assertIn("server.start_server(open_browser=False, block=False)", source)
        self.assertIn("activate_existing_instance", source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
