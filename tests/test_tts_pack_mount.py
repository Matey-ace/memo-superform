#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Regression coverage for complete GPT-SoVITS ZIP quick mounting."""

import io
import json
import os
import tempfile
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

    def test_stream_mount_accepts_one_outer_folder_replaces_old_pack_and_disables_voice(self):
        archive = self._new_archive(wrapper="complete-voice-pack")
        tts._save_state(str(self.data), {"enabled": True, "language": "日文", "speed": 1.1})

        with open(archive, "rb") as stream:
            result = tts.mount_tts_pack_stream(
                str(self.pack), str(self.data), stream, archive.stat().st_size, archive.name
            )

        self.assertTrue(result["ok"])
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

    def test_invalid_archive_keeps_previous_pack_and_state(self):
        archive = self.root / "missing-runtime.zip"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
            output.writestr("tts_pack/pack.json", json.dumps({"name": "incomplete"}))
        tts._save_state(str(self.data), {"enabled": True, "language": "中文", "speed": 1.0})

        with self.assertRaisesRegex(tts.TTSException, "缺少 .venv311"):
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

    def test_mount_endpoint_streams_the_zip_without_json_decoding(self):
        archive = self._new_archive(wrapper="")
        payload = archive.read_bytes()
        with _configured_local_api(TTS_PACK_DIR=str(self.pack), DATA_DIR=str(self.data), LIVE2D_SERVICE=None):
            probe = _ApiProbe(payload)
            probe._handle_api_post("/api/tts/mount-pack", types.SimpleNamespace(query="name=voice-pack.zip"))

        self.assertEqual(probe.response[0], 200)
        self.assertTrue(probe.response[1]["ok"])
        self.assertEqual((self.pack / "marker.txt").read_text(encoding="utf-8"), "new")


if __name__ == "__main__":
    unittest.main(verbosity=2)
