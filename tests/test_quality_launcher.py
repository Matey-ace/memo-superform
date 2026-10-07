import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import launcher


class LauncherReadinessTests(unittest.TestCase):
    def test_three_part_versions_have_build_scoped_ports_and_overrides_are_validated(self):
        with mock.patch.dict(os.environ, {"MEMO_INSTANCE_PORT": ""}):
            for version in ("0.87", "1.0.0", "1.0.1", "1.0.2"):
                with mock.patch.object(launcher, "BUILD_VERSION", version):
                    self.assertTrue(15100 <= launcher._instance_port() < 15900)
            with mock.patch.object(launcher, "BUILD_VERSION", "1.0.1"):
                first = launcher._instance_port()
            with mock.patch.object(launcher, "BUILD_VERSION", "1.0.2"):
                self.assertNotEqual(first, launcher._instance_port())
        with mock.patch.dict(os.environ, {"MEMO_INSTANCE_PORT": "-1"}):
            self.assertGreater(launcher._instance_port(), 0)

    def test_spawned_process_early_exit_and_timeout_are_not_success(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(os.environ, {"MEMO_DATA_DIR": root}):
            process = mock.Mock(pid=123)
            process.poll.return_value = 1
            with self.assertRaisesRegex(RuntimeError, "退出"):
                launcher._wait_for_update_ready(process, "a" * 32, timeout=0.1)
            process.poll.return_value = None
            with self.assertRaisesRegex(RuntimeError, "超时"):
                launcher._wait_for_update_ready(process, "a" * 32, timeout=0.1)

    def test_readiness_confirmation_matches_the_spawned_process(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(os.environ, {"MEMO_DATA_DIR": root}):
            token = "a" * 32
            directory = pathlib.Path(launcher._update_directory())
            ready = directory / (launcher._UPDATE_READY_PREFIX + token + ".json")
            process = mock.Mock(pid=123)
            process.poll.return_value = None
            ready.write_text(json.dumps({"token": token, "pid": 321}))
            with self.assertRaises(RuntimeError): launcher._wait_for_update_ready(process, token, timeout=0.1)
            ready.write_text(json.dumps({"token": token, "pid": 123}))
            launcher._wait_for_update_ready(process, token, timeout=3)
            self.assertFalse(ready.exists())

    def test_readiness_failure_rolls_back_replaced_executable_and_keeps_candidate(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(os.environ, {"MEMO_DATA_DIR": str(pathlib.Path(root) / "data")}):
            directory = pathlib.Path(launcher._update_directory())
            target = pathlib.Path(root) / "程序 启动.exe"; target.write_bytes(b"old")
            candidate = directory / "candidate.exe"; candidate.write_bytes(b"new")
            helper = directory / "memo-update-helper-test.exe"; helper.write_bytes(b"helper")
            request = directory / "memo-update-request-test.json"
            request.write_text(json.dumps({"target_path": str(target), "source_path": str(candidate), "helper_path": str(helper),
                "parent_pid": 1, "size": 3, "sha256": hashlib.sha256(b"new").hexdigest(), "mode": "web"}))
            process = mock.Mock(pid=2); process.poll.return_value = 1
            with mock.patch.object(launcher, "_wait_for_process_exit", return_value=True), \
                 mock.patch.object(launcher, "_hidden_detached_popen", return_value=process), \
                 mock.patch.object(launcher, "_wait_for_update_ready", side_effect=RuntimeError("startup failed")), \
                 mock.patch.object(launcher, "show_message"):
                self.assertEqual(1, launcher.apply_staged_update(str(request)))
            self.assertEqual(b"old", target.read_bytes()); self.assertTrue(candidate.exists())
            self.assertEqual(b"new", next(pathlib.Path(root).glob("*.failed-*.exe")).read_bytes())


if __name__ == "__main__": unittest.main()
