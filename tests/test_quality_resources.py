import json
import pathlib
import tempfile
import threading
import unittest
from unittest import mock
import db
import tts
import live2d_service


class ResourceContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        db.init_db(self.temp.name)
        self.service = live2d_service.Live2DService(self.temp.name)
    def tearDown(self): self.temp.cleanup()
    def model(self):
        root = pathlib.Path(self.temp.name) / "测试 模型"
        root.mkdir()
        (root / "main.moc").write_bytes(b"moc")
        (root / "t.png").write_bytes(b"png")
        (root / "main.model.json").write_text(json.dumps({"model": "main.moc", "textures": ["t.png"]}))
        return root
    def test_two_textures_without_primary_and_wrong_field_types_fail_before_registry(self):
        root = self.model()
        for document in ({"textures": ["t.png", "t.png"]}, {"model": "main.moc", "textures": "t.png"},
                         {"model": ["main.moc"], "textures": ["t.png"]}):
            (root / "main.model.json").write_text(json.dumps(document))
            with self.assertRaises(live2d_service.Live2DError): self.service.import_directory(str(root), "profile")
        self.assertEqual([], self.service.list_models("profile")["models"])
    def test_import_limit_is_checked_before_copy(self):
        root = self.model()
        with mock.patch.object(live2d_service, "MAX_MODEL_BYTES", 1), mock.patch.object(self.service, "_copy_import_tree") as copy:
            with self.assertRaises(live2d_service.Live2DError): self.service.import_directory(str(root), "profile")
            copy.assert_not_called()

    def test_transaction_link_paths_are_rejected_before_promotion(self):
        root = self.model()
        original = self.service._is_link
        def linked(path):
            return path.parent == self.service.models_root or original(path)
        with mock.patch.object(self.service, "_is_link", side_effect=linked):
            with self.assertRaises(live2d_service.Live2DError):
                self.service.import_directory(str(root), "profile")
        self.assertEqual([], self.service.list_models("profile")["models"])
    def test_delete_database_failure_restores_model_files_and_registry(self):
        row = self.service.import_directory(str(self.model()), "profile")
        with mock.patch.object(db, "remove_live2d_model", side_effect=RuntimeError("commit failed")):
            with self.assertRaises(RuntimeError): self.service.delete_model(row["model_id"])
        self.assertTrue(self.service.asset_path(row["model_id"], "main.moc").exists())
        self.assertIsNotNone(db.get_live2d_model(row["model_id"]))
    def test_crash_journal_restores_uncommitted_deletion(self):
        row = self.service.import_directory(str(self.model()), "profile")
        transaction = "b" * 32
        target = self.service.models_root / row["model_id"]
        backup = self.service.partial_root / (".rollback-" + transaction)
        self.service._write_journal({"transaction_id": transaction, "operation": "delete", "model_id": row["model_id"]})
        target.replace(backup)
        recovered = live2d_service.Live2DService(self.temp.name)
        self.assertTrue(recovered.asset_path(row["model_id"], "main.moc").exists())
        self.assertFalse(backup.exists())
    def test_tts_admission_is_atomic_between_preload_and_speak(self):
        manager = tts.TTSManager(str(pathlib.Path(self.temp.name) / "pack"), self.temp.name)
        entered, release = threading.Event(), threading.Event()
        manager._resolve_voice_config = lambda name: {"ref_audio_path": "ref.wav", "prompt_text": "text", "ref_language": "zh"}
        calls = []
        def call(message, timeout):
            calls.append(message); entered.set(); release.wait(2)
            return {"type": "ok"}
        manager._call = call
        failures = []
        def preload():
            try: manager.preload("role")
            except Exception as exc: failures.append(exc)
        worker = threading.Thread(target=preload)
        worker.start()
        self.assertTrue(entered.wait(1))
        try:
            with self.assertRaises(tts.TTSException): manager.synthesize("hello", "role")
            with self.assertRaises(tts.TTSException): manager.preload("role")
            self.assertTrue(manager.is_busy)
        finally:
            release.set(); worker.join(2)
            tts._release_pack_lock(manager._lock_file)
        self.assertEqual([], failures)
        self.assertEqual(1, len(calls))
        self.assertFalse(manager.is_busy)


if __name__ == "__main__": unittest.main()
