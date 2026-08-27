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

    def test_import_model_file_writes_into_voice_model_dir(self):
        self._write_pack([{
            "name": "anon",
            "folder": "reference_audio/anon",
            "model_dir": "GPT-SoVITS_models",
        }])
        target = tts.import_model_file(str(self.pack_dir), "anon", "ckpt", b"gpt-bytes")
        self.assertTrue(Path(target).is_file())
        self.assertEqual(Path(target).read_bytes(), b"gpt-bytes")
        self.assertEqual(Path(target).name, "gpt.ckpt")
        self.assertIn("reference_audio/anon/GPT-SoVITS_models", Path(target).as_posix())

    def test_import_model_file_rejects_unknown_kind_and_voice(self):
        self._write_pack([{"name": "anon", "folder": "reference_audio/anon"}])
        with self.assertRaises(tts.TTSException):
            tts.import_model_file(str(self.pack_dir), "anon", "nope", b"x")
        with self.assertRaises(tts.TTSException):
            tts.import_model_file(str(self.pack_dir), "missing", "pth", b"x")


if __name__ == "__main__":
    unittest.main(verbosity=2)
