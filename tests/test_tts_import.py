import json
import tempfile
import unittest
from pathlib import Path

import tts


class TTSModelImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.pack_dir = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def _write_pack(self, voices):
        (self.pack_dir / "pack.json").write_text(
            json.dumps({"name": "test", "version": "1.0.0", "engine": "gpt-sovits", "voices": voices}),
            encoding="utf-8",
        )

    def test_legacy_import_model_file_is_rejected_without_writing(self):
        self._write_pack([{
            "name": "anon",
            "folder": "reference_audio/anon",
            "model_dir": "GPT-SoVITS_models",
        }])
        with self.assertRaisesRegex(tts.TTSException, "旧模型上传入口已移除"):
            tts.import_model_file(str(self.pack_dir), "anon", "ckpt", b"gpt-bytes")
        self.assertFalse((self.pack_dir / "reference_audio" / "anon" / "GPT-SoVITS_models" / "gpt.ckpt").exists())

    def test_legacy_import_model_file_is_rejected_for_any_legacy_arguments(self):
        self._write_pack([{"name": "anon", "folder": "reference_audio/anon"}])
        with self.assertRaises(tts.TTSException):
            tts.import_model_file(str(self.pack_dir), "anon", "nope", b"x")
        with self.assertRaises(tts.TTSException):
            tts.import_model_file(str(self.pack_dir), "missing", "pth", b"x")


if __name__ == "__main__":
    unittest.main(verbosity=2)
