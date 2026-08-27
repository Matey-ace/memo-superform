import json
import tempfile
import unittest
from pathlib import Path

import db
from live2d_service import DownloadJob, Live2DError, Live2DService


class Live2DServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        db.init_db(self.temp.name)
        self.service = Live2DService(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def _c2_model(self, name="model"):
        root = Path(self.temp.name) / name
        (root / "data" / "textures").mkdir(parents=True)
        (root / "data" / "model.moc").write_bytes(b"moc")
        (root / "data" / "textures" / "texture_00.png").write_bytes(b"png")
        (root / "model.model.json").write_text(json.dumps({"model": "data/model.moc", "textures": ["data/textures/texture_00.png"]}), encoding="utf-8")
        return root

    def test_import_registers_cubism2_and_serves_only_registered_files(self):
        row = self.service.import_directory(str(self._c2_model()), "profile")
        self.assertEqual(row["model_format"], "cubism2")
        self.assertTrue(self.service.asset_path(row["model_id"], "data/model.moc").is_file())
        with self.assertRaises(Live2DError):
            self.service.asset_path(row["model_id"], "../memo-superform.db")
        self.service.set_active("profile", row["model_id"], True)
        self.assertEqual(self.service.list_models("profile")["preference"]["active_model_id"], row["model_id"])

    def test_import_rejects_missing_texture_and_accepts_cubism3(self):
        bad = Path(self.temp.name) / "bad"
        bad.mkdir()
        (bad / "bad.model.json").write_text(json.dumps({"model": "data/model.moc", "textures": ["missing.png"]}), encoding="utf-8")
        with self.assertRaises(Live2DError):
            self.service.import_directory(str(bad), "profile")
        good = Path(self.temp.name) / "modern"
        good.mkdir()
        (good / "main.moc3").write_bytes(b"moc3")
        (good / "texture.png").write_bytes(b"png")
        (good / "main.model3.json").write_text(json.dumps({"FileReferences": {"Moc": "main.moc3", "Textures": ["texture.png"]}}), encoding="utf-8")
        self.assertEqual(self.service.import_directory(str(good), "profile")["model_format"], "cubism3")

    def test_catalog_filters_and_download_builds_atomic_cubism2_layout(self):
        def fetch(url):
            if url.endswith("/characters/all.5.json"):
                return {"37": {"characterName": ["千早 爱音", "Anon Chihaya"]}}
            return {"live2d": {"chara": {"037_general": 1, "037_casual-2023": 1}}}
        self.service._fetch_json = fetch
        self.assertEqual(self.service.catalog("爱音")["models"][0]["catalog_name"], "037_casual-2023")
        self.service._bestdori_build_data = lambda name: {
            "model": {"bundle": "live2d/chara/037_casual-2023", "file": "model.moc"}, "physics": {"bundle": "", "file": ""},
            "textures": [{"bundle": "live2d/chara/037_casual-2023", "file": "texture.png"}], "motions": [], "expressions": []}
        def fake_download(bundle, file_name, target, job, optional=False):
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"asset")
            job.completed += 1
            return True
        self.service._download_file = fake_download
        job = DownloadJob("job", "037_casual-2023", "profile")
        self.service._download_job(job, self.service.catalog("037")["models"][0])
        self.assertEqual(job.status, "completed")
        self.service._jobs[job.job_id] = job
        self.assertEqual(self.service.download_status(job.job_id)["status"], "completed")
        self.assertEqual(db.get_live2d_model(job.model_id)["entry_file"], "memo.model.json")


if __name__ == "__main__":
    unittest.main()
