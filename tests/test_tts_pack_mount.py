#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Regression coverage for GPT-SoVITS ZIP quick mounting."""

import io
import json
import os
import tempfile
import threading
import time
import types
import unittest
import zipfile
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

import app_api
import tts


class _ApiProbe(app_api.LocalApiMixin):
    def __init__(self, upload=b""):
        self.headers = {"X-Requested-With": "XMLHttpRequest"}
        self.rfile = io.BytesIO(upload)
        self._length = len(upload)
        self.response = None

    def _send_json(self, status, payload):
        self.response = (status, payload)
        return self.response

    def _safe_content_length(self):
        return self._length


@contextmanager
def _configured_local_api(**values):
    old = {name: getattr(app_api, name, None) for name in values}
    missing = {name: not hasattr(app_api, name) for name in values}
    try:
        app_api.configure_local_api(**values)
        yield
    finally:
        for name, value in old.items():
            if missing[name]:
                delattr(app_api, name)
            else:
                setattr(app_api, name, value)


class TTSPackMountTests(unittest.TestCase):
    def setUp(self):
        tts._reset_manager()
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data = self.root / "data"
        self.pack = self.data / "tts_pack"
        self.data.mkdir()
        self._make_pack(self.pack, "oldvoice", marker="old")

    def tearDown(self):
        tts._reset_manager()
        with tts._ENGINE_PROBE_LOCK:
            tts._ENGINE_PROBE_CACHE.clear()
        self.temp.cleanup()

    @staticmethod
    def _make_pack(path, role_id, marker="new"):
        path.mkdir(parents=True, exist_ok=True)
        (path / "pack.json").write_text(json.dumps({
            "name": "fixture " + role_id,
            "version": "1.0.0",
            "engine": "gpt-sovits",
            "voices": [],
        }), encoding="utf-8")
        python_exe = path / ".venv311" / "Scripts" / "python.exe"
        worker = path / "tts_engine" / "worker_main.py"
        python_exe.parent.mkdir(parents=True)
        worker.parent.mkdir(parents=True)
        python_exe.write_bytes(b"fixture interpreter")
        worker.write_text("# worker fixture\n", encoding="utf-8")
        (path / "marker.txt").write_text(marker, encoding="utf-8")
        tts.save_role(str(path), {
            "role_id": role_id,
            "name": "角色 " + role_id,
            "reference_text": "这是完整的参考文本。",
            "reference_language": "中文",
            "live2d_model_id": "fixture-live2d",
        })
        for kind, filename, content in (
            ("ckpt", "voice.ckpt", b"gpt-" + role_id.encode("ascii")),
            ("pth", "voice.pth", b"sovits-" + role_id.encode("ascii")),
            ("audio", "reference.wav", b"RIFF fixture audio"),
        ):
            tts.upload_role_file(str(path), role_id, kind, filename, content)
        tts.activate_role(str(path), role_id)
        # save_role initializes legacy draft roles when no registry exists.
        # A complete fixture instead declares only its supplied role.
        roles_path = path / "roles.json"
        registry = json.loads(roles_path.read_text(encoding="utf-8"))
        registry["roles"] = [role for role in registry["roles"] if role["role_id"] == role_id]
        registry["active_role_id"] = role_id
        roles_path.write_text(json.dumps(registry), encoding="utf-8")

    def _archive_directory(self, directory, archive_path, wrapper="tts_pack"):
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            for source in directory.rglob("*"):
                if source.is_dir():
                    continue
                relative = source.relative_to(directory).as_posix()
                archive.write(source, wrapper + "/" + relative if wrapper else relative)

    def _new_archive(self, wrapper="tts_pack"):
        source = self.root / "source-pack"
        self._make_pack(source, "newvoice", marker="new")
        archive = self.root / "complete-voice-pack.zip"
        self._archive_directory(source, archive, wrapper)
        return archive

    @staticmethod
    def _wait_for_job(manager, job_id, timeout=5.0):
        deadline = time.monotonic() + timeout
        snapshot = manager.get_job(job_id)
        while snapshot["state"] in ("queued", "running") and time.monotonic() < deadline:
            time.sleep(0.02)
            snapshot = manager.get_job(job_id)
        return snapshot

    def test_stream_mount_accepts_one_outer_folder_replaces_old_pack_and_disables_voice(self):
        archive = self._new_archive(wrapper="complete-voice-pack")
        tts._save_state(str(self.data), {"enabled": True, "language": "日文", "speed": 1.1})

        with open(archive, "rb") as stream:
            result = tts.mount_tts_pack_stream(
                str(self.pack), str(self.data), stream, archive.stat().st_size, archive.name
            )

        self.assertTrue(result["ok"])
        self.assertTrue(result["complete"])
        self.assertEqual(result["runtime_missing"], [])
        self.assertEqual(result["incomplete_roles"], [])
        self.assertEqual(result["source_name"], archive.name)
        self.assertIn("newvoice", result["voice_ready_role_ids"])
        self.assertEqual((self.pack / "marker.txt").read_text(encoding="utf-8"), "new")
        self.assertFalse((self.pack / "marker.txt").read_text(encoding="utf-8") == "old")
        self.assertTrue((self.pack / ".venv311" / "Scripts" / "python.exe").is_file())
        self.assertIn("newvoice", [role["role_id"] for role in tts.list_roles(str(self.pack))["roles"]])
        state = tts._load_state(str(self.data))
        self.assertFalse(state["enabled"])
        self.assertEqual(state["language"], "日文")
        self.assertEqual(state["speed"], 1.1)

    def test_partial_archive_mounts_and_reports_every_missing_requirement(self):
        archive = self.root / "partial-voice-pack.zip"
        roles = {
            "version": 1,
            "active_role_id": "",
            "roles": [
                {
                    "role_id": "partial",
                    "name": "待补齐文件",
                    "folder": "roles/partial",
                    "gpt_file": "gpt.ckpt",
                    "sovits_file": "sovits.pth",
                    "audio_file": "reference.wav",
                    "index_file": "",
                    "reference_text": "这是已有的参考文本。",
                    "reference_language": "中文",
                    "live2d_model_id": "fixture-live2d",
                },
                {
                    "role_id": "metadata",
                    "name": "待补齐资料",
                    "folder": "roles/metadata",
                    "gpt_file": "",
                    "sovits_file": "",
                    "audio_file": "",
                    "index_file": "",
                    "reference_text": "",
                    "reference_language": "",
                    "live2d_model_id": "",
                },
            ],
        }
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
            output.writestr("tts_pack/pack.json", json.dumps({"name": "partial fixture"}))
            output.writestr("tts_pack/roles.json", json.dumps(roles))
        tts._save_state(str(self.data), {"enabled": True, "language": "中文", "speed": 1.0})

        result = tts.mount_tts_pack_archive(str(self.pack), str(self.data), str(archive))

        self.assertTrue(result["ok"])
        self.assertFalse(result["complete"])
        self.assertEqual(result["runtime_missing"], [
            ".venv311/Scripts/python.exe",
            "tts_engine/worker_main.py",
        ])
        missing_by_role = {item["role_id"]: item["missing_paths"] for item in result["incomplete_roles"]}
        self.assertEqual(missing_by_role["partial"], [
            "roles/partial/persona.json → 背景",
            "roles/partial/persona.json → 语气",
            "roles/partial/persona.json → 禁忌",
            "roles/partial/persona.json → 示例",
            "roles/partial/gpt.ckpt",
            "roles/partial/sovits.pth",
            "roles/partial/reference.wav（也可为 .mp3 / .flac / .ogg）",
        ])
        self.assertEqual(missing_by_role["metadata"], [
            "roles/metadata/gpt.ckpt",
            "roles/metadata/sovits.pth",
            "roles/metadata/reference.wav（也可为 .mp3 / .flac / .ogg）",
            "roles.json → metadata.reference_text",
            "roles.json → metadata.reference_language",
            "设置 → 角色资料包 → 绑定 Live2D",
            "roles/metadata/persona.json → 背景",
            "roles/metadata/persona.json → 语气",
            "roles/metadata/persona.json → 禁忌",
            "roles/metadata/persona.json → 示例",
        ])
        self.assertFalse((self.pack / "marker.txt").exists())
        self.assertFalse(tts._load_state(str(self.data))["enabled"])
        status = tts.get_status(str(self.pack), str(self.data))
        self.assertFalse(status["engine_ready"])
        self.assertEqual(status["runtime_missing_files"], result["runtime_missing"])
        self.assertEqual(
            {item["role_id"]: item["missing_paths"] for item in status["incomplete_roles"]},
            missing_by_role,
        )

    def test_archive_without_pack_manifest_keeps_previous_pack_and_state(self):
        archive = self.root / "not-a-voice-pack.zip"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
            output.writestr("tts_pack/readme.txt", "not a Memo voice package")
        tts._save_state(str(self.data), {"enabled": True, "language": "中文", "speed": 1.0})

        with self.assertRaisesRegex(tts.TTSException, "根目录必须包含 pack.json"):
            tts.mount_tts_pack_archive(str(self.pack), str(self.data), str(archive))

        self.assertEqual((self.pack / "marker.txt").read_text(encoding="utf-8"), "old")
        self.assertTrue(tts._load_state(str(self.data))["enabled"])

    def test_zip_slip_path_is_rejected_before_live_pack_changes(self):
        archive = self.root / "unsafe.zip"
        escape = self.root / "escape.txt"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
            output.writestr("tts_pack/../../escape.txt", "bad")
            output.writestr("tts_pack/pack.json", "{}")

        with self.assertRaisesRegex(tts.TTSException, "上级目录"):
            tts.mount_tts_pack_archive(str(self.pack), str(self.data), str(archive))

        self.assertEqual((self.pack / "marker.txt").read_text(encoding="utf-8"), "old")
        self.assertFalse(escape.exists())

    def test_failed_directory_exchange_restores_previous_pack_and_switch_state(self):
        archive = self._new_archive(wrapper="tts_pack")
        tts._save_state(str(self.data), {"enabled": True, "language": "日文", "speed": 1.2})
        real_replace = os.replace
        target_pack = os.path.normcase(os.path.abspath(self.pack))

        def fail_only_candidate_promotion(source, destination):
            source_path = os.path.normcase(os.path.abspath(os.fspath(source)))
            destination_path = os.path.normcase(os.path.abspath(os.fspath(destination)))
            if ".tts-pack-ready-" in source_path and destination_path == target_pack:
                raise OSError("injected candidate promotion failure")
            return real_replace(source, destination)

        with mock.patch.object(tts.os, "replace", side_effect=fail_only_candidate_promotion):
            with self.assertRaisesRegex(tts.TTSException, "candidate promotion"):
                tts.mount_tts_pack_archive(str(self.pack), str(self.data), str(archive))

        self.assertEqual((self.pack / "marker.txt").read_text(encoding="utf-8"), "old")
        state = tts._load_state(str(self.data))
        self.assertTrue(state["enabled"])
        self.assertEqual(state["language"], "日文")
        self.assertEqual(state["speed"], 1.2)

    def test_background_manager_reports_safe_progress_and_keeps_source_archive(self):
        archive = self._new_archive(wrapper="tts_pack")
        manager = tts.TTSPackMountJobManager(str(self.pack), str(self.data))
        initial = manager.start_local_archive(str(archive))

        self.assertIn(initial["state"], ("queued", "running"))
        self.assertEqual(initial["source_name"], archive.name)
        self.assertNotIn("path", initial)
        finished = self._wait_for_job(manager, initial["job_id"])

        self.assertEqual(finished["state"], "completed", finished.get("error"))
        self.assertEqual(finished["stage"], "done")
        self.assertEqual(finished["percent"], 100)
        self.assertTrue(finished["result"]["ok"])
        self.assertTrue(archive.is_file(), "native source ZIP must stay in its original location")
        self.assertEqual((self.pack / "marker.txt").read_text(encoding="utf-8"), "new")

    def test_background_manager_rejects_a_second_pack_while_one_is_running(self):
        archive = self._new_archive(wrapper="tts_pack")
        manager = tts.TTSPackMountJobManager(str(self.pack), str(self.data))
        started = time.monotonic()
        # Hold the first job in its progress callback long enough to exercise the
        # manager's single-install gate without making the test depend on ZIP size.
        real_mount = tts.mount_tts_pack_archive

        def delayed_mount(*args, **kwargs):
            time.sleep(0.15)
            return real_mount(*args, **kwargs)

        with mock.patch.object(tts, "mount_tts_pack_archive", side_effect=delayed_mount):
            first = manager.start_local_archive(str(archive))
            while not manager.is_active() and time.monotonic() - started < 1.0:
                time.sleep(0.01)
            with self.assertRaisesRegex(tts.TTSException, "已有语音包"):
                manager.start_local_archive(str(archive))
            finished = self._wait_for_job(manager, first["job_id"])

        self.assertEqual(finished["state"], "completed", finished.get("error"))

    def test_progress_callbacks_cover_check_extract_validate_and_replace(self):
        archive = self._new_archive(wrapper="tts_pack")
        stages = []
        tts.mount_tts_pack_archive(
            str(self.pack), str(self.data), str(archive),
            on_progress=lambda stage, payload: stages.append((stage, dict(payload))),
        )

        self.assertIn("checking", [stage for stage, _payload in stages])
        self.assertIn("extracting", [stage for stage, _payload in stages])
        self.assertIn("validating", [stage for stage, _payload in stages])
        self.assertIn("replacing", [stage for stage, _payload in stages])
        extraction = [payload for stage, payload in stages if stage == "extracting"]
        self.assertTrue(extraction)
        self.assertEqual(extraction[-1]["completed_bytes"], extraction[-1]["total_bytes"])

    def test_public_job_uses_switching_for_the_final_directory_exchange(self):
        manager = tts.TTSPackMountJobManager(str(self.pack), str(self.data))
        job = manager._reserve_job("voice.zip", 1)
        manager._on_progress(job["job_id"], "replacing", {"total_bytes": 1, "completed_bytes": 1})
        snapshot = manager.get_job(job["job_id"])
        self.assertEqual(snapshot["stage"], "switching")
        manager._finish(job["job_id"], result={"ok": True})

    def test_switch_waits_for_current_voice_before_replacing_the_pack(self):
        class BusyWorker:
            is_busy = True

        manager = tts.TTSPackMountJobManager(str(self.pack), str(self.data))
        job = manager._reserve_job("voice.zip", 1)
        worker = BusyWorker()
        finished = threading.Event()
        with mock.patch.object(tts, "_manager_for_pack", return_value=worker):
            thread = threading.Thread(
                target=lambda: (manager._wait_for_voice(job["job_id"]), finished.set()), daemon=True
            )
            thread.start()
            deadline = time.monotonic() + 1.0
            while manager.get_job(job["job_id"])["stage"] != "waiting_for_voice" and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(manager.get_job(job["job_id"])["stage"], "waiting_for_voice")
            self.assertFalse(finished.is_set())
            worker.is_busy = False
            self.assertTrue(finished.wait(1.0))
        manager._finish(job["job_id"], result={"ok": True})

    def test_new_synthesis_is_rejected_while_a_pack_is_mounting(self):
        tts._set_tts_pack_mounting(str(self.pack), True)
        try:
            with self.assertRaisesRegex(tts.TTSException, "后台挂载"):
                tts.speak(str(self.pack), str(self.data), "测试语音")
        finally:
            tts._set_tts_pack_mounting(str(self.pack), False)

    def test_disk_preflight_keeps_existing_pack_when_space_is_insufficient(self):
        archive = self._new_archive(wrapper="tts_pack")
        with mock.patch.object(tts.shutil, "disk_usage", return_value=types.SimpleNamespace(free=0)):
            with self.assertRaisesRegex(tts.TTSException, "磁盘空间不足"):
                tts.mount_tts_pack_archive(str(self.pack), str(self.data), str(archive))

        self.assertEqual((self.pack / "marker.txt").read_text(encoding="utf-8"), "old")

    def test_mount_endpoint_streams_the_zip_without_json_decoding(self):
        archive = self._new_archive(wrapper="")
        payload = archive.read_bytes()
        manager = tts.TTSPackMountJobManager(str(self.pack), str(self.data))
        with _configured_local_api(
            TTS_PACK_DIR=str(self.pack), DATA_DIR=str(self.data), LIVE2D_SERVICE=None,
            TTS_PACK_MOUNT_MANAGER=manager,
        ):
            probe = _ApiProbe(payload)
            probe._handle_api_post("/api/tts/mount-pack", types.SimpleNamespace(query="name=voice-pack.zip"))
            job = self._wait_for_job(manager, probe.response[1]["job_id"])

        self.assertEqual(probe.response[0], 202)
        self.assertTrue(probe.response[1]["ok"])
        self.assertEqual(job["state"], "completed", job.get("error"))
        self.assertEqual((self.pack / "marker.txt").read_text(encoding="utf-8"), "new")

    def test_mount_endpoint_rejects_large_web_upload_before_reading_stream(self):
        manager = tts.TTSPackMountJobManager(str(self.pack), str(self.data))
        with _configured_local_api(
            TTS_PACK_DIR=str(self.pack), DATA_DIR=str(self.data), LIVE2D_SERVICE=None,
            TTS_PACK_MOUNT_MANAGER=manager,
        ):
            probe = _ApiProbe()
            probe._length = tts.TTS_PACK_WEB_UPLOAD_MAX_BYTES + 1
            probe._handle_api_post("/api/tts/mount-pack", types.SimpleNamespace(query="name=too-large.zip"))

        self.assertEqual(probe.response[0], 413)
        self.assertTrue(probe.response[1]["requires_native_import"])
        self.assertEqual((self.pack / "marker.txt").read_text(encoding="utf-8"), "old")


if __name__ == "__main__":
    unittest.main(verbosity=2)
