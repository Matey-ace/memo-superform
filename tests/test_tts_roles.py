import json
import os
import tempfile
import unittest
from pathlib import Path

import tts


class TTSRoleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.pack = Path(self.temp.name)
        (self.pack / "pack.json").write_text(json.dumps({"name": "test", "voices": []}), encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_role_uses_only_manifest_bound_assets(self):
        role = tts.save_role(str(self.pack), {
            "role_id": "anon", "name": "千早爱音", "reference_text": "これは参考音声です。",
            "reference_language": "日文", "live2d_model_id": "anon-live2d",
        })
        self.assertFalse(role["complete"])
        for kind, filename, content in (("ckpt", "anon.ckpt", b"gpt"), ("pth", "anon.pth", b"sovits"), ("audio", "anon.wav", b"RIFF")):
            tts.upload_role_file(str(self.pack), "anon", kind, filename, content)
        # Unrelated assets must not affect this role's resolved paths.
        extra = self.pack / "roles" / "anon" / "aaa.wav"
        extra.write_bytes(b"wrong")
        config = tts._resolve_role(str(self.pack), "anon")
        self.assertTrue(config["ref_audio_path"].endswith("reference.wav"))
        self.assertTrue(config["gpt_model_path"].endswith("gpt.ckpt"))
        self.assertTrue(config["sovits_model_path"].endswith("sovits.pth"))
        self.assertEqual(config["ref_language"], "日文")
        self.assertEqual(tts.activate_role(str(self.pack), "anon")["role_id"], "anon")

    def test_legacy_language_file_with_comments_extracts_last_number(self):
        language = self.pack / "reference_audio_language.txt"
        language.write_text("# comment\n# another comment\n3\n", encoding="utf-8")
        self.assertEqual(tts._read_reference_language(str(language)), "日文")

    def test_incomplete_migrated_anon_cannot_activate(self):
        state = tts.ensure_role_library(str(self.pack))
        anon = next(role for role in state["roles"] if role["role_id"] == "anon")
        self.assertIn("参考音频", tts._role_status(anon))
        with self.assertRaises(tts.TTSException):
            tts.activate_role(str(self.pack), "anon")

    def test_legacy_sakiko_assets_are_copied_as_an_isolated_japanese_role(self):
        legacy = self.pack / "reference_audio" / "sakiko"
        models = legacy / "GPT-SoVITS_models"
        models.mkdir(parents=True)
        (models / "sakiko_v2pp-e15.ckpt").write_bytes(b"sakiko-gpt")
        (models / "sakiko_v2pp_e8_s520.pth").write_bytes(b"sakiko-sovits")
        (legacy / "black_sakiko.wav").write_bytes(b"RIFF")
        (legacy / "reference_text_black_sakiko.txt").write_text("日本語の参考文です。", encoding="utf-8")
        state = tts.ensure_role_library(str(self.pack))
        sakiko = next(role for role in state["roles"] if role["role_id"] == "sakiko")
        self.assertEqual(sakiko["reference_language"], "日文")
        self.assertEqual(sakiko["reference_text"], "日本語の参考文です。")
        self.assertTrue((self.pack / "roles" / "sakiko" / "reference.wav").is_file())

    def _make_complete_role(self, role_id="anon", live2d_id="anon-live2d"):
        tts.save_role(str(self.pack), {
            "role_id": role_id,
            "name": "千早爱音" if role_id == "anon" else role_id,
            "reference_text": "これは参考音声です。",
            "reference_language": "日文",
            "live2d_model_id": live2d_id,
        })
        for kind, filename, content in (
            ("ckpt", "voice.ckpt", b"gpt"),
            ("pth", "voice.pth", b"sovits"),
            ("audio", "voice.wav", b"RIFF"),
        ):
            tts.upload_role_file(str(self.pack), role_id, kind, filename, content)

    def test_active_role_cannot_be_deleted_or_bypassed_by_another_voice_name(self):
        self._make_complete_role()
        tts.activate_role(str(self.pack), "anon")
        self.assertEqual(tts._active_role_for_request(str(self.pack)), "anon")
        with self.assertRaisesRegex(tts.TTSException, "当前已启用角色"):
            tts.delete_role(str(self.pack), "anon")
        with self.assertRaisesRegex(tts.TTSException, "仅使用当前已启用角色"):
            tts._active_role_for_request(str(self.pack), "sakiko")

    def test_listed_completeness_tracks_missing_manifest_file_and_is_repairable(self):
        self._make_complete_role()
        role_path = self.pack / "roles" / "anon" / "gpt.ckpt"
        role_path.unlink()
        listed = next(item for item in tts.list_roles(str(self.pack))["roles"] if item["role_id"] == "anon")
        self.assertFalse(listed["complete"])
        self.assertIn("GPT 模型", listed["missing"])
        with self.assertRaises(tts.TTSException):
            tts.activate_role(str(self.pack), "anon")
        tts.upload_role_file(str(self.pack), "anon", "ckpt", "replacement.ckpt", b"replacement")
        repaired = tts.get_role(str(self.pack), "anon", require_complete=True)
        self.assertTrue(repaired["complete"])

    def test_role_manifest_folder_cannot_redirect_assets_to_another_role(self):
        self._make_complete_role()
        state = tts.ensure_role_library(str(self.pack))
        anon = next(item for item in state["roles"] if item["role_id"] == "anon")
        anon["folder"] = "roles/sakiko"
        tts._write_roles(str(self.pack), state)
        config = tts._resolve_role(str(self.pack), "anon")
        self.assertTrue(config["gpt_model_path"].endswith("roles" + os.sep + "anon" + os.sep + "gpt.ckpt"))

    def test_manifest_rejects_noncanonical_audio_path_before_it_can_escape_role_folder(self):
        self._make_complete_role()
        # A file outside the role package must never make a hand-edited manifest
        # look complete.  The resolver must reject the noncanonical name before
        # it has a chance to concatenate a path outside roles/anon.
        (self.pack / "roles" / "escaped.wav").write_bytes(b"not-a-reference")
        state = tts.ensure_role_library(str(self.pack))
        anon = next(item for item in state["roles"] if item["role_id"] == "anon")
        anon["audio_file"] = "reference/../../escaped.wav"
        tts._write_roles(str(self.pack), state)

        listed = next(item for item in tts.list_roles(str(self.pack))["roles"] if item["role_id"] == "anon")
        self.assertFalse(listed["complete"])
        self.assertIn("参考音频", listed["missing"])
        with self.assertRaisesRegex(tts.TTSException, "参考音频"):
            tts._resolve_role(str(self.pack), "anon")

    def test_active_role_staged_update_rolls_back_every_asset_then_commits_together(self):
        self._make_complete_role()
        tts.activate_role(str(self.pack), "anon")
        role_dir = self.pack / "roles" / "anon"
        original_assets = {
            "gpt.ckpt": (role_dir / "gpt.ckpt").read_bytes(),
            "sovits.pth": (role_dir / "sovits.pth").read_bytes(),
            "reference.wav": (role_dir / "reference.wav").read_bytes(),
        }
        original_roles = json.loads((self.pack / "roles.json").read_text(encoding="utf-8"))
        batch_id = tts.begin_role_update(str(self.pack), "anon")
        for kind, filename, content in (
            ("ckpt", "replacement.ckpt", b"new-gpt"),
            ("pth", "replacement.pth", b"new-sovits"),
            ("audio", "replacement.wav", b"new-reference"),
        ):
            tts.stage_role_file(str(self.pack), "anon", batch_id, kind, filename, content)
        update = {
            "role_id": "anon",
            "name": "爱音（新资料）",
            "reference_text": "新しい参考文です。",
            "reference_language": "日文",
            "live2d_model_id": "anon-live2d",
        }

        def fail_live2d_sync(_role):
            raise RuntimeError("simulated paired-service failure")

        with self.assertRaisesRegex(RuntimeError, "paired-service"):
            tts.commit_role_update(str(self.pack), "anon", batch_id, update, after_commit=fail_live2d_sync)

        # The manifest and all three assets return to their original generation;
        # the private stage remains retryable rather than leaking a half update.
        self.assertEqual(json.loads((self.pack / "roles.json").read_text(encoding="utf-8")), original_roles)
        for filename, content in original_assets.items():
            self.assertEqual((role_dir / filename).read_bytes(), content)
        stage_dir = role_dir / ".staging" / batch_id
        self.assertTrue(stage_dir.is_dir())
        self.assertEqual((stage_dir / "gpt.ckpt").read_bytes(), b"new-gpt")
        self.assertEqual((stage_dir / "sovits.pth").read_bytes(), b"new-sovits")
        self.assertEqual((stage_dir / "reference.wav").read_bytes(), b"new-reference")

        committed = tts.commit_role_update(str(self.pack), "anon", batch_id, update)
        self.assertEqual(committed["name"], "爱音（新资料）")
        self.assertTrue(committed["complete"])
        self.assertFalse(stage_dir.exists())
        self.assertEqual((role_dir / "gpt.ckpt").read_bytes(), b"new-gpt")
        self.assertEqual((role_dir / "sovits.pth").read_bytes(), b"new-sovits")
        self.assertEqual((role_dir / "reference.wav").read_bytes(), b"new-reference")


if __name__ == "__main__":
    unittest.main(verbosity=2)
