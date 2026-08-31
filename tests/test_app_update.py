#!/usr/bin/env python3
"""Regression coverage for the local GitHub Release updater."""

import hashlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import app_update  # noqa: E402
import app_api  # noqa: E402
import launcher  # noqa: E402


class FakeResponse:
    def __init__(self, payload):
        self.stream = io.BytesIO(payload)

    def read(self, size=-1):
        return self.stream.read(size)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False


def release_payload(version, binary=b"new executable", digest=None, **flags):
    digest = digest if digest is not None else "sha256:" + hashlib.sha256(binary).hexdigest()
    tag = "v" + version
    data = {
        "tag_name": tag,
        "html_url": "https://github.com/Matey-ace/memo-superform/releases/tag/" + tag,
        "published_at": "2026-08-30T10:00:00Z",
        "body": "修复更新流程\n- 保留本地数据",
        "draft": False,
        "prerelease": False,
        "assets": [{
            "name": "MemoSuperform-v%s.exe" % version,
            "size": len(binary),
            "digest": digest,
            "browser_download_url": "https://github.com/Matey-ace/memo-superform/releases/download/%s/MemoSuperform-v%s.exe" % (tag, version),
        }],
    }
    data.update(flags)
    return data


class AppUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.target = self.root / "MemoSuperform.exe"
        self.target.write_bytes(b"old executable")

    def tearDown(self):
        self.temporary.cleanup()

    def make_manager(self, urlopen, current="0.78"):
        return app_update.UpdateManager(
            self.root / "data",
            current_version=current,
            frozen=True,
            platform="win32",
            executable=str(self.target),
            urlopen=urlopen,
        )

    def test_version_comparison_and_important_policy(self):
        self.assertEqual(app_update.compare_versions("0.78", "0.79"), -1)
        self.assertEqual(app_update.compare_versions("v1.0", "1.0.0"), 0)
        self.assertTrue(app_update.is_important_update("0.78", "1.0"))
        self.assertTrue(app_update.is_important_update("0.78", "0.81"))
        self.assertFalse(app_update.is_important_update("0.78", "0.79"))
        self.assertIsNone(app_update.parse_version("release-latest"))

    def test_status_uses_only_expected_release_asset(self):
        binary = b"v079"
        payload = release_payload("0.79", binary)
        calls = []

        def urlopen(request, timeout):
            calls.append((request.full_url, timeout, request.get_header("User-agent")))
            return FakeResponse(json.dumps(payload).encode("utf-8"))

        status = self.make_manager(urlopen).get_status()
        self.assertTrue(status["update_available"])
        self.assertFalse(status["important"])
        self.assertTrue(status["can_download"])
        self.assertEqual(status["latest_version"], "0.79")
        self.assertEqual(calls[0][0], "https://api.github.com/repos/Matey-ace/memo-superform/releases/latest")
        self.assertIn("MemoSuperform/0.78", calls[0][2])

    def test_major_update_is_important_and_draft_is_rejected(self):
        binary = b"v100"
        manager = self.make_manager(lambda request, timeout: FakeResponse(json.dumps(release_payload("1.0", binary)).encode("utf-8")))
        self.assertTrue(manager.get_status()["important"])

        draft = release_payload("1.0", binary, draft=True)
        rejected = app_update.UpdateManager(
            self.root / "draft-data",
            current_version="0.78",
            frozen=True,
            platform="win32",
            executable=str(self.target),
            urlopen=lambda request, timeout: FakeResponse(json.dumps(draft).encode("utf-8")),
        )
        status = rejected.get_status()
        self.assertFalse(status["update_available"])
        self.assertIn("稳定版", status["check_error"])

    def test_network_failure_falls_back_to_checked_cache(self):
        payload = release_payload("0.79", b"cached")
        initial = self.make_manager(lambda request, timeout: FakeResponse(json.dumps(payload).encode("utf-8")))
        self.assertTrue(initial.get_status()["update_available"])

        def offline(request, timeout):
            raise OSError("offline")

        status = self.make_manager(offline).get_status()
        self.assertTrue(status["update_available"])
        self.assertTrue(status["cached"])
        self.assertTrue(status["check_error"])

    def test_download_is_verified_before_it_becomes_installable(self):
        binary = b"fully verified binary" * 700
        payload = release_payload("0.79", binary)

        def urlopen(request, timeout):
            if request.full_url.endswith("/releases/latest"):
                return FakeResponse(json.dumps(payload).encode("utf-8"))
            return FakeResponse(binary)

        manager = self.make_manager(urlopen)
        self.assertTrue(manager.get_status()["can_download"])
        self.assertEqual(manager.start_download()["state"], "downloading")
        deadline = time.time() + 3
        while time.time() < deadline:
            state = manager.get_status()["download"]["state"]
            if state != "downloading":
                break
            time.sleep(0.01)
        self.assertEqual(manager.get_status()["download"]["state"], "ready")
        staged = manager.prepare_apply()
        self.assertEqual(pathlib.Path(staged["path"]).read_bytes(), binary)
        self.assertEqual(staged["sha256"], hashlib.sha256(binary).hexdigest())

    def test_hash_mismatch_never_becomes_ready(self):
        payload = release_payload("0.79", b"expected")

        def urlopen(request, timeout):
            if request.full_url.endswith("/releases/latest"):
                return FakeResponse(json.dumps(payload).encode("utf-8"))
            return FakeResponse(b"tampered")

        manager = self.make_manager(urlopen)
        manager.get_status()
        manager.start_download()
        deadline = time.time() + 3
        while time.time() < deadline:
            state = manager.get_status()["download"]["state"]
            if state != "downloading":
                break
            time.sleep(0.01)
        status = manager.get_status()
        self.assertEqual(status["download"]["state"], "error")
        self.assertFalse((self.root / "data" / "updates" / "MemoSuperform-v0.79.exe").exists())
        with self.assertRaises(app_update.UpdateError):
            manager.prepare_apply()

    def test_helper_replaces_target_only_after_parent_exit_and_keeps_backup(self):
        data_dir = self.root / "data"
        update_dir = data_dir / "updates"
        update_dir.mkdir(parents=True)
        target = self.root / "MemoSuperform.exe"
        target.write_bytes(b"old")
        source = update_dir / "MemoSuperform-v0.79.exe"
        source.write_bytes(b"new")
        helper = update_dir / "memo-update-helper-test.exe"
        helper.write_bytes(b"helper")
        request = update_dir / "memo-update-request-test.json"
        request.write_text(json.dumps({
            "parent_pid": 321,
            "source_path": str(source),
            "target_path": str(target),
            "sha256": hashlib.sha256(b"new").hexdigest(),
            "size": 3,
            "mode": "desktop",
            "helper_path": str(helper),
        }), encoding="utf-8")

        with mock.patch.dict(os.environ, {"MEMO_DATA_DIR": str(data_dir)}, clear=False), \
             mock.patch.object(launcher, "_wait_for_process_exit", return_value=True) as wait, \
             mock.patch.object(launcher, "_hidden_detached_popen") as spawned:
            self.assertEqual(launcher.apply_staged_update(str(request)), 0)

        wait.assert_called_once_with(321)
        self.assertEqual(target.read_bytes(), b"new")
        self.assertFalse(source.exists())
        self.assertFalse(request.exists())
        backups = list(self.root.glob("MemoSuperform.previous-*.exe"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), b"old")
        self.assertEqual(spawned.call_args.args[0][:3], [str(target), "--mode", "desktop"])

    def test_helper_restores_old_target_when_new_process_cannot_start(self):
        data_dir = self.root / "data"
        update_dir = data_dir / "updates"
        update_dir.mkdir(parents=True)
        target = self.root / "MemoSuperform.exe"
        target.write_bytes(b"old")
        source = update_dir / "MemoSuperform-v0.79.exe"
        source.write_bytes(b"new")
        helper = update_dir / "memo-update-helper-test.exe"
        helper.write_bytes(b"helper")
        request = update_dir / "memo-update-request-test.json"
        request.write_text(json.dumps({
            "parent_pid": 321,
            "source_path": str(source),
            "target_path": str(target),
            "sha256": hashlib.sha256(b"new").hexdigest(),
            "size": 3,
            "mode": "web",
            "helper_path": str(helper),
        }), encoding="utf-8")

        with mock.patch.dict(os.environ, {"MEMO_DATA_DIR": str(data_dir)}, clear=False), \
             mock.patch.object(launcher, "_wait_for_process_exit", return_value=True), \
             mock.patch.object(launcher, "_hidden_detached_popen", side_effect=OSError("start failed")), \
             mock.patch.object(launcher, "show_message"):
            self.assertEqual(launcher.apply_staged_update(str(request)), 1)

        self.assertEqual(target.read_bytes(), b"old")
        self.assertTrue(source.exists(), "failed candidates stay available for retry/diagnostics")

    @unittest.skipUnless(os.name == "nt", "Windows helper process wait is Windows-specific")
    def test_windows_wait_for_parent_is_non_destructive(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(4)"])
        try:
            self.assertFalse(launcher._wait_for_process_exit(child.pid, timeout_seconds=0.15))
            self.assertIsNone(child.poll(), "waiting for the old app must never signal or terminate it")
        finally:
            child.terminate()
            child.wait(timeout=5)
        self.assertTrue(launcher._wait_for_process_exit(child.pid, timeout_seconds=0.15))

    def test_local_update_api_routes_keep_paths_and_installer_private(self):
        class Manager:
            def __init__(self):
                self.force = None
                self.prepared = False
                self.failed = ""

            def get_status(self, force=False):
                self.force = force
                return {"current_version": "0.78", "latest_version": "0.79", "update_available": True}

            def start_download(self):
                return {"state": "downloading", "progress": 0}

            def prepare_apply(self):
                self.prepared = True
                return {"path": "private staged path", "sha256": "a" * 64, "size": 1}

            def apply_failed(self, message):
                self.failed = str(message)

        class Probe(app_api.LocalApiMixin):
            def __init__(self):
                self.headers = {"X-Requested-With": "XMLHttpRequest"}
                self.responses = []

            def _send_json(self, code, data):
                self.responses.append((code, data))
                return data

            def _read_json_body(self):
                return {}

        manager = Manager()
        tts_stub = types.SimpleNamespace(shutdown=mock.Mock())
        applied = []
        with mock.patch.dict(app_api.__dict__, {
            "UPDATE_MANAGER": manager,
            "_apply_update": lambda staged: (applied.append(staged) or True, "started"),
            "TTS_PACK_DIR": str(self.root / "pack"),
            "DATA_DIR": str(self.root / "data"),
        }), mock.patch.dict(sys.modules, {"tts": tts_stub}):
            probe = Probe()
            probe._handle_api_get("/api/app/update-status", types.SimpleNamespace(query="force=1"))
            self.assertTrue(manager.force)
            self.assertEqual(probe.responses[-1][0], 200)

            probe._handle_api_post("/api/app/update/download", types.SimpleNamespace(query=""))
            self.assertEqual(probe.responses[-1][0], 202)
            self.assertEqual(probe.responses[-1][1]["download"]["state"], "downloading")

            probe._handle_api_post("/api/app/update/apply", types.SimpleNamespace(query=""))
            self.assertEqual(probe.responses[-1][0], 200)
            self.assertTrue(manager.prepared)
            self.assertEqual(len(applied), 1)
            self.assertNotIn("private staged path", json.dumps(probe.responses[-1][1]))
            tts_stub.shutdown.assert_called_once()


if __name__ == "__main__":
    unittest.main(verbosity=2)
