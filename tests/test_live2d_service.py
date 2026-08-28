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

    def test_catalog_search_matches_english_name_and_character_id(self):
        def fetch(url):
            if url.endswith("/characters/all.5.json"):
                return {
                    "36": {"characterName": ["高松 灯", "Tomori Takamatsu"]},
                    "37": {"characterName": ["千早 爱音", "Anon Chihaya"]},
                }
            return {"live2d": {"chara": {"036_general": 1, "036_casual": 1, "037_general": 1, "037_casual": 1}}}
        self.service._fetch_json = fetch
        self.assertEqual([m["catalog_name"] for m in self.service.catalog("Anon")["models"]], ["037_casual"])
        self.assertEqual([m["catalog_name"] for m in self.service.catalog("Tomori")["models"]], ["036_casual"])
        self.assertEqual(len(self.service.catalog("037")["models"]), 1)

    def test_delete_refuses_model_still_bound_by_a_role_package(self):
        row = self.service.import_directory(str(self._c2_model("bound")), "profile")
        pack = Path(self.temp.name) / "tts_pack"
        pack.mkdir()
        (pack / "roles.json").write_text(json.dumps({
            "version": 1,
            "active_role_id": "anon",
            "roles": [{"role_id": "anon", "name": "千早爱音", "live2d_model_id": row["model_id"]}],
        }), encoding="utf-8")
        with self.assertRaisesRegex(Live2DError, "仍被角色绑定"):
            self.service.delete_model(row["model_id"])
        self.assertIsNotNone(db.get_live2d_model(row["model_id"]))
        self.assertTrue(self.service.asset_path(row["model_id"], "data/model.moc").is_file())

    def test_validate_model_rechecks_descriptor_assets_after_import(self):
        row = self.service.import_directory(str(self._c2_model("damaged")), "profile")
        installed = self.service.models_root / row["relative_path"]
        (installed / "data" / "textures" / "texture_00.png").unlink()

        with self.assertRaisesRegex(Live2DError, "模型引用文件不存在"):
            self.service.validate_model(row["model_id"])
        with self.assertRaisesRegex(Live2DError, "模型引用文件不存在"):
            self.service.set_active("profile", row["model_id"], True)

    def test_delete_fails_closed_when_role_registry_is_corrupt(self):
        row = self.service.import_directory(str(self._c2_model("unknown-binding")), "profile")
        pack = Path(self.temp.name) / "tts_pack"
        pack.mkdir()
        (pack / "roles.json").write_text("{not valid json", encoding="utf-8")

        with self.assertRaisesRegex(Live2DError, "无法核验角色资料包绑定"):
            self.service.delete_model(row["model_id"])
        self.assertIsNotNone(db.get_live2d_model(row["model_id"]))
        self.assertTrue((self.service.models_root / row["relative_path"] / "data" / "model.moc").is_file())


if __name__ == "__main__":
    unittest.main()
