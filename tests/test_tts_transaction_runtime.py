#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Transaction, role-persona, and runtime-status regression coverage.

These tests deliberately stub the worker boundary.  They exercise the state
changes that must stay correct even when the GPU engine or the paired Live2D
service is unavailable.
"""

import io
import json
import os
import tempfile
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

import app_api
import tts


def _persona(name):
    return {
        "name": name,
        "background": name + " 的角色背景",
        "tone": name + " 的说话语气",
        "avoid": "不要只说语气词。",
        "examples": "这是一句完整的示例。",
    }


class _ApiProbe(app_api.LocalApiMixin):
    def __init__(self, body=None):
        self.headers = {"X-Requested-With": "XMLHttpRequest"}
        self.body = dict(body or {})
        self.response = None
        self.rfile = io.BytesIO()

    def _send_json(self, status, payload):
        self.response = (status, payload)
        return self.response

    def _read_json_body(self):
        return self.body

    def _safe_content_length(self):
        return 0

    def _profile_id(self, required=False):
        return "test-profile"


class _SharedCharacterLive2D:
    """Two role packages deliberately share one character id/model metadata."""

    def __init__(self):
        self.validated = []

    def validate_model(self, model_id):
        self.validated.append(model_id)
        return {"model_id": model_id, "character_id": "037", "complete": True}

    def list_models(self, profile_id):
        return {
            "models": [{"model_id": "shared-live2d", "character_id": "037", "complete": True}],
            "preference": {"active_model_id": "stale-legacy-model"},
        }


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


class TTSRoleTransactionRuntimeTests(unittest.TestCase):
    def setUp(self):
        # The manager is process-local, so make every test independent of a
        # previous unittest case that may have installed a mocked manager.
        tts._reset_manager()
        self.temp = tempfile.TemporaryDirectory()
        self.pack = Path(self.temp.name) / "tts_pack"
        self.data = Path(self.temp.name) / "data"
        self.pack.mkdir()
        self.data.mkdir()
        (self.pack / "pack.json").write_text(
            json.dumps({"name": "test pack", "version": "1.0.0", "voices": []}),
            encoding="utf-8",
        )
        with tts._ENGINE_PROBE_LOCK:
            tts._ENGINE_PROBE_CACHE.clear()

    def tearDown(self):
        tts._reset_manager()
        with tts._ENGINE_PROBE_LOCK:
            tts._ENGINE_PROBE_CACHE.clear()
        self.temp.cleanup()

    def _make_complete_role(self, role_id="anon", *, name="千早爱音", live2d_id="shared-live2d", persona=None):
        body = {
            "role_id": role_id,
            "name": name,
            "reference_text": "これは完全な参考文です。",
            "reference_language": "日文",
            "live2d_model_id": live2d_id,
        }
        if persona is not None:
            body["persona"] = persona
        tts.save_role(str(self.pack), body)
        for kind, filename, content in (
            ("ckpt", "voice.ckpt", ("gpt-" + role_id).encode("utf-8")),
            ("pth", "voice.pth", ("sovits-" + role_id).encode("utf-8")),
            ("audio", "voice.wav", ("reference-" + role_id).encode("utf-8")),
        ):
            tts.upload_role_file(str(self.pack), role_id, kind, filename, content)

    def _stage_full_replacement(self, role_id="anon"):
        batch_id = tts.begin_role_update(str(self.pack), role_id)
        for kind, filename, content in (
            ("ckpt", "replacement.ckpt", b"new-gpt"),
            ("pth", "replacement.pth", b"new-sovits"),
            ("audio", "replacement.wav", b"new-reference"),
        ):
            tts.stage_role_file(str(self.pack), role_id, batch_id, kind, filename, content)
        return batch_id

    @staticmethod
    def _update_body(role_id="anon", name="千早爱音"):
        return {
            "role_id": role_id,
            "name": name,
            "reference_text": "更新后的完整参考文本。",
            "reference_language": "日文",
            "live2d_model_id": "shared-live2d",
        }

    def test_second_staged_asset_replace_failure_restores_every_old_asset(self):
        """A failed second asset swap may not strand the first new model live."""
        self._make_complete_role()
        tts.activate_role(str(self.pack), "anon")
        role_dir = self.pack / "roles" / "anon"
        before_manifest = json.loads((self.pack / "roles.json").read_text(encoding="utf-8"))
        before_assets = {
            name: (role_dir / name).read_bytes()
            for name in ("gpt.ckpt", "sovits.pth", "reference.wav")
        }
        batch_id = self._stage_full_replacement()
        stage_dir = role_dir / ".staging" / batch_id
        real_replace = os.replace
        second_swap = {"failed": False}

        def fail_only_second_staged_swap(source, destination):
            # The first GPT rename completed.  Simulate the *next* staged
            # model promotion failing after the old SoVITS file entered the
            # rollback directory.  This is the failure window that used to
            # leave a role with gpt(new) + sovits(old/missing).
            source_path = os.path.normcase(os.path.abspath(os.fspath(source)))
            destination_path = os.path.normcase(os.path.abspath(os.fspath(destination)))
            expected_source = os.path.normcase(os.path.abspath(stage_dir / "sovits.pth"))
            expected_destination = os.path.normcase(os.path.abspath(role_dir / "sovits.pth"))
            if source_path == expected_source and destination_path == expected_destination:
                second_swap["failed"] = True
                raise OSError("injected second staged replacement failure")
            return real_replace(source, destination)

        with mock.patch.object(tts.os, "replace", side_effect=fail_only_second_staged_swap):
            with self.assertRaisesRegex(OSError, "second staged"):
                tts.commit_role_update(str(self.pack), "anon", batch_id, self._update_body())

        self.assertTrue(second_swap["failed"], "fixture must fail the second staged model swap")
        self.assertEqual(json.loads((self.pack / "roles.json").read_text(encoding="utf-8")), before_manifest)
        for name, old_bytes in before_assets.items():
            self.assertEqual((role_dir / name).read_bytes(), old_bytes, name + " must be restored")
        # The complete proposal remains private and retryable, not partially
        # consumed by rollback.
        self.assertEqual((stage_dir / "gpt.ckpt").read_bytes(), b"new-gpt")
        self.assertEqual((stage_dir / "sovits.pth").read_bytes(), b"new-sovits")
        self.assertEqual((stage_dir / "reference.wav").read_bytes(), b"new-reference")

    def test_literal_second_os_replace_failure_restores_asset_moved_to_rollback(self):
        """The second rename is staged GPT -> canonical GPT after old GPT moved."""
        self._make_complete_role()
        tts.activate_role(str(self.pack), "anon")
        role_dir = self.pack / "roles" / "anon"
        before_manifest = json.loads((self.pack / "roles.json").read_text(encoding="utf-8"))
        before_assets = {
            name: (role_dir / name).read_bytes()
            for name in ("gpt.ckpt", "sovits.pth", "reference.wav")
        }
        batch_id = self._stage_full_replacement()
        stage_dir = role_dir / ".staging" / batch_id
        real_replace = os.replace
        calls = {"count": 0, "failed_at": 0}

        def fail_on_second_replace(source, destination):
            calls["count"] += 1
            if calls["count"] == 2:
                calls["failed_at"] = calls["count"]
                raise OSError("injected literal second os.replace failure")
            return real_replace(source, destination)

        with mock.patch.object(tts.os, "replace", side_effect=fail_on_second_replace):
            with self.assertRaisesRegex(OSError, "literal second"):
                tts.commit_role_update(str(self.pack), "anon", batch_id, self._update_body())

        self.assertEqual(calls["failed_at"], 2)
        self.assertEqual(json.loads((self.pack / "roles.json").read_text(encoding="utf-8")), before_manifest)
        for name, old_bytes in before_assets.items():
            self.assertEqual((role_dir / name).read_bytes(), old_bytes, name + " must be restored")
        self.assertEqual((stage_dir / "gpt.ckpt").read_bytes(), b"new-gpt")

    def test_save_role_callback_failure_restores_active_manifest(self):
        self._make_complete_role()
        tts.activate_role(str(self.pack), "anon")
        before = json.loads((self.pack / "roles.json").read_text(encoding="utf-8"))

        def paired_live2d_failure(_role):
            raise RuntimeError("paired Live2D save failure")

        with self.assertRaisesRegex(RuntimeError, "paired Live2D save"):
            tts.save_role(
                str(self.pack),
                self._update_body(name="千早爱音（不应提交）"),
                after_commit=paired_live2d_failure,
            )

        self.assertEqual(json.loads((self.pack / "roles.json").read_text(encoding="utf-8")), before)
        active = tts.get_role(str(self.pack), "anon", require_complete=True)
        self.assertEqual(active["name"], "千早爱音")

    def test_activate_role_callback_failure_restores_previous_active_role(self):
        self._make_complete_role("anon", name="角色 A")
        self._make_complete_role("beta", name="角色 B")
        tts.activate_role(str(self.pack), "anon")
        before = json.loads((self.pack / "roles.json").read_text(encoding="utf-8"))
        observed = []

        def paired_live2d_failure(role):
            observed.append(role["role_id"])
            raise RuntimeError("paired Live2D activate failure")

        with self.assertRaisesRegex(RuntimeError, "paired Live2D activate"):
            tts.activate_role(str(self.pack), "beta", after_commit=paired_live2d_failure)

        self.assertEqual(observed, ["beta"])
        self.assertEqual(json.loads((self.pack / "roles.json").read_text(encoding="utf-8")), before)
        self.assertEqual(tts.list_roles(str(self.pack))["active_role_id"], "anon")

    def test_role_persona_persists_via_api_and_active_binding_uses_role_not_character_id(self):
        # Both voices deliberately share the same Live2D character id.  If
        # runtime persona selection accidentally falls back to character_id,
        # the second assertion below would return role A's persona.
        alpha = _persona("资料包 A")
        beta = _persona("资料包 B")
        self._make_complete_role("alpha", name="角色 A", persona=alpha)
        self._make_complete_role("beta", name="角色 B", persona=beta)
        changed_alpha = _persona("资料包 A（已保存）")
        live2d = _SharedCharacterLive2D()

        with _configured_local_api(TTS_PACK_DIR=str(self.pack), DATA_DIR=str(self.data), LIVE2D_SERVICE=live2d):
            save = _ApiProbe({"persona": changed_alpha})
            save._handle_api_post("/api/tts/roles/alpha/persona", types.SimpleNamespace(query=""))
            self.assertEqual(save.response[0], 200)
            self.assertEqual(save.response[1]["role"]["persona"], changed_alpha)
            self.assertEqual(tts.get_role(str(self.pack), "alpha")["persona"], changed_alpha)

            tts.activate_role(str(self.pack), "alpha")
            alpha_binding = _ApiProbe()
            alpha_binding._handle_api_get("/api/live2d/models", types.SimpleNamespace(query=""))
            self.assertEqual(alpha_binding.response[0], 200)
            binding = alpha_binding.response[1]["role_binding"]
            self.assertTrue(binding["ready"])
            self.assertEqual(binding["active_role_id"], "alpha")
            self.assertEqual(binding["model_character_id"], "037")
            self.assertEqual(binding["persona"], changed_alpha)

            tts.activate_role(str(self.pack), "beta")
            beta_binding = _ApiProbe()
            beta_binding._handle_api_get("/api/live2d/models", types.SimpleNamespace(query=""))
            self.assertEqual(beta_binding.response[0], 200)
            switched = beta_binding.response[1]["role_binding"]
            self.assertEqual(switched["active_role_id"], "beta")
            self.assertEqual(switched["model_character_id"], "037")
            self.assertEqual(switched["persona"], beta)
            self.assertNotEqual(switched["persona"], changed_alpha)

    def _make_engine_layout(self):
        (self.pack / "install.json").write_text(json.dumps({"installed": True}), encoding="utf-8")
        python_exe = self.pack / ".venv311" / "Scripts" / "python.exe"
        worker = self.pack / "tts_engine" / "worker_main.py"
        python_exe.parent.mkdir(parents=True)
        worker.parent.mkdir(parents=True)
        python_exe.write_bytes(b"placeholder interpreter")
        worker.write_text("# worker fixture\n", encoding="utf-8")
        return python_exe

    def test_engine_dependency_preflight_surfaces_missing_module_before_touch(self):
        python_exe = self._make_engine_layout()
        probe_result = types.SimpleNamespace(
            returncode=0,
            stdout='__MEMO_TTS_PROBE__[["pyopenjtalk", "No module named pyopenjtalk"]]\n',
            stderr="",
        )
        with mock.patch.object(tts.subprocess, "run", return_value=probe_result) as run:
            ready, reason, missing = tts._engine_dependency_status(str(self.pack), force=True)
            status = tts.get_status(str(self.pack), str(self.data))

        self.assertFalse(ready)
        self.assertEqual(missing, ["pyopenjtalk"])
        self.assertIn("修复语音环境", reason)
        self.assertFalse(status["engine_ready"])
        self.assertIn("pyopenjtalk", status["install_error"])
        command = run.call_args.args[0]
        self.assertEqual(os.path.normcase(command[0]), os.path.normcase(str(python_exe)))
        self.assertEqual(command[1], "-c")
        self.assertIn("pyopenjtalk", command[2])

    def test_successful_environment_repair_restores_previous_voice_switch(self):
        """Repair temporarily stops the worker but must preserve user intent."""
        python_exe = self._make_engine_layout()
        tts._save_state(str(self.data), {"enabled": True, "language": "日文", "speed": 1.1})
        probes = [
            (False, "缺少 pyopenjtalk", ["pyopenjtalk"]),
            (True, "", []),
        ]
        installed = types.SimpleNamespace(returncode=0, stdout="")
        with mock.patch.object(tts, "_engine_dependency_status", side_effect=probes) as dependency_probe, \
             mock.patch.object(tts, "_assert_role_write_allowed"), \
             mock.patch.object(tts, "_reset_manager"), \
             mock.patch.object(tts.shutil, "which", return_value="uv"), \
             mock.patch.object(tts.subprocess, "run", return_value=installed) as run:
            result = tts.repair_environment(str(self.pack), str(self.data))

        self.assertTrue(result["ok"])
        self.assertTrue(result["enabled"])
        self.assertIn("已恢复此前的语音开关", result["message"])
        self.assertEqual(dependency_probe.call_count, 2)
        restored = tts._load_state(str(self.data))
        self.assertTrue(restored["enabled"])
        self.assertEqual(restored["language"], "日文")
        self.assertEqual(restored["speed"], 1.1)
        command = run.call_args.args[0]
        self.assertEqual(command[:4], ["uv", "pip", "install", "--python"])
        self.assertEqual(os.path.normcase(command[4]), os.path.normcase(str(python_exe)))
        self.assertIn(tts._ENGINE_IMPORT_PACKAGES["pyopenjtalk"], command)

    def test_runtime_lock_is_exposed_as_not_ready_in_status(self):
        self._make_complete_role()
        tts.activate_role(str(self.pack), "anon")
        tts._save_state(str(self.data), {"enabled": True, "language": "中文", "speed": 1.0})
        lock_error = tts.TTSException("语音资源包正被另一个 Memo Superform 实例使用")
        with mock.patch.object(tts, "_engine_ready", return_value=(True, "")), \
             mock.patch.object(tts, "_check_pack_runtime_available", side_effect=lock_error):
            status = tts.get_status(str(self.pack), str(self.data))

        self.assertTrue(status["enabled"])
        self.assertTrue(status["engine_ready"])
        self.assertTrue(status["role_ready"])
        self.assertFalse(status["runtime_ready"])
        self.assertIn("另一个 Memo Superform", status["runtime_error"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
