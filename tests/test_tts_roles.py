import json
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
