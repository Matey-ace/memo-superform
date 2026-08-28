import io
import json
import tempfile
import types
import unittest
from contextlib import contextmanager
from pathlib import Path

import app_api
import tts


class _ApiProbe(app_api.LocalApiMixin):
    def __init__(self, body=None, upload=b""):
        self.headers = {"X-Requested-With": "XMLHttpRequest"}
        self.response = None
        self.body = dict(body or {})
        self.rfile = io.BytesIO(upload)
        self._upload_length = len(upload)

    def _send_json(self, status, payload):
        self.response = (status, payload)
        return self.response

    def _read_json_body(self):
        return self.body

    def _safe_content_length(self):
        return self._upload_length

    def _profile_id(self, required=False):
        return "test-profile"


class _Live2DProbe:
    def __init__(self, fail_set=False):
        self.fail_set = fail_set
        self.validated = []
        self.set_calls = []

    def validate_model(self, model_id):
        self.validated.append(model_id)
        return {"model_id": model_id, "complete": True}

    def set_active(self, profile_id, model_id, companion_enabled):
        self.set_calls.append((profile_id, model_id, companion_enabled))
        if self.fail_set:
            raise RuntimeError("simulated Live2D update failure")
        return {"active_model_id": model_id, "companion_enabled": companion_enabled}

    def list_models(self, profile_id):
        return {
            "models": [{"model_id": "anon-live2d", "complete": True}],
            # This is deliberately stale: runtime selection must come from the
            # active role binding rather than this legacy preference.
            "preference": {"active_model_id": "stale-manual-model"},
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


class TTSRoleApiTests(unittest.TestCase):
    @staticmethod
    def _make_complete_active_role(pack):
        tts.save_role(str(pack), {
            "role_id": "anon", "name": "千早爱音", "reference_text": "参考文本",
            "reference_language": "日文", "live2d_model_id": "anon-live2d",
        })
        for kind, name, data in (("ckpt", "g.ckpt", b"old-gpt"), ("pth", "s.pth", b"old-sovits"), ("audio", "r.wav", b"old-ref")):
            tts.upload_role_file(str(pack), "anon", kind, name, data)
        tts.activate_role(str(pack), "anon")

    def test_legacy_model_upload_route_is_a_non_writing_migration_response(self):
        probe = _ApiProbe()
        probe._handle_api_post("/api/tts/import-model", types.SimpleNamespace(query=""))
        self.assertEqual(probe.response[0], 410)
        self.assertIn("角色编辑器", probe.response[1]["error"])
        self.assertEqual(probe.response[1]["migration"], "使用 /api/tts/roles/<role_id>/upload")

    def test_activation_rolls_back_role_when_live2d_preference_update_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            pack = Path(temp) / "tts_pack"
            pack.mkdir()
            (pack / "pack.json").write_text(json.dumps({"name": "test", "voices": []}), encoding="utf-8")
            tts.save_role(str(pack), {
                "role_id": "anon", "name": "千早爱音", "reference_text": "参考文本",
                "reference_language": "日文", "live2d_model_id": "anon-live2d",
            })
            for kind, name, data in (("ckpt", "g.ckpt", b"gpt"), ("pth", "s.pth", b"sovits"), ("audio", "r.wav", b"RIFF")):
                tts.upload_role_file(str(pack), "anon", kind, name, data)
            with _configured_local_api(TTS_PACK_DIR=str(pack), DATA_DIR=temp, LIVE2D_SERVICE=_Live2DProbe(fail_set=True)):
                service = app_api.LIVE2D_SERVICE
                probe = _ApiProbe()
                probe._handle_api_post("/api/tts/roles/anon/activate", types.SimpleNamespace(query=""))
                self.assertEqual(probe.response[0], 400)
                self.assertIn("simulated Live2D", probe.response[1]["error"])
                self.assertEqual(tts.list_roles(str(pack))["active_role_id"], "")
                self.assertEqual(service.validated, ["anon-live2d"])

    def test_active_role_rejects_direct_asset_upload_and_keeps_canonical_file(self):
        with tempfile.TemporaryDirectory() as temp:
            pack = Path(temp) / "tts_pack"
            pack.mkdir()
            (pack / "pack.json").write_text(json.dumps({"name": "test", "voices": []}), encoding="utf-8")
            self._make_complete_active_role(pack)
            target = pack / "roles" / "anon" / "gpt.ckpt"
            before = target.read_bytes()
            with _configured_local_api(TTS_PACK_DIR=str(pack), DATA_DIR=temp, LIVE2D_SERVICE=_Live2DProbe()):
                probe = _ApiProbe(upload=b"new-gpt")
                probe._handle_api_post(
                    "/api/tts/roles/anon/upload",
                    types.SimpleNamespace(query="kind=ckpt&name=replacement.ckpt"),
                )
                self.assertEqual(probe.response[0], 409)
                self.assertIn("一次性角色更新", probe.response[1]["error"])
            self.assertEqual(target.read_bytes(), before)

    def test_staged_role_api_keeps_active_assets_unchanged_until_commit_and_syncs_live2d(self):
        with tempfile.TemporaryDirectory() as temp:
            pack = Path(temp) / "tts_pack"
            pack.mkdir()
            (pack / "pack.json").write_text(json.dumps({"name": "test", "voices": []}), encoding="utf-8")
            self._make_complete_active_role(pack)
            role_dir = pack / "roles" / "anon"
            service = _Live2DProbe()
            with _configured_local_api(TTS_PACK_DIR=str(pack), DATA_DIR=temp, LIVE2D_SERVICE=service):
                begin = _ApiProbe()
                begin._handle_api_post("/api/tts/roles/anon/begin-update", types.SimpleNamespace(query=""))
                self.assertEqual(begin.response[0], 200)
                batch_id = begin.response[1]["batch_id"]

                for kind, filename, data in (
                    ("ckpt", "new.ckpt", b"new-gpt"),
                    ("pth", "new.pth", b"new-sovits"),
                    ("audio", "new.wav", b"new-ref"),
                ):
                    upload = _ApiProbe(upload=data)
                    upload._handle_api_post(
                        "/api/tts/roles/anon/upload",
                        types.SimpleNamespace(query="kind=%s&name=%s&batch=%s" % (kind, filename, batch_id)),
                    )
                    self.assertEqual(upload.response[0], 200)
                    self.assertTrue(upload.response[1]["staged"])

                # Files in a staged batch are private; the old active package
                # remains usable until the one commit request succeeds.
                self.assertEqual((role_dir / "gpt.ckpt").read_bytes(), b"old-gpt")
                self.assertEqual((role_dir / "sovits.pth").read_bytes(), b"old-sovits")
                self.assertEqual((role_dir / "reference.wav").read_bytes(), b"old-ref")
                commit = _ApiProbe(body={
                    "role_id": "anon", "name": "千早爱音（更新）", "reference_text": "更新后的参考文本。",
                    "reference_language": "日文", "live2d_model_id": "anon-live2d", "batch_id": batch_id,
                })
                commit._handle_api_post("/api/tts/roles/anon/commit-update", types.SimpleNamespace(query=""))
                self.assertEqual(commit.response[0], 200)
                self.assertEqual(commit.response[1]["role"]["name"], "千早爱音（更新）")
                self.assertEqual(service.validated, ["anon-live2d"])
                self.assertEqual(service.set_calls, [("test-profile", "anon-live2d", True)])

            self.assertEqual((role_dir / "gpt.ckpt").read_bytes(), b"new-gpt")
            self.assertEqual((role_dir / "sovits.pth").read_bytes(), b"new-sovits")
            self.assertEqual((role_dir / "reference.wav").read_bytes(), b"new-ref")

    def test_discard_staged_update_removes_private_assets_without_touching_active_role(self):
        with tempfile.TemporaryDirectory() as temp:
            pack = Path(temp) / "tts_pack"
            pack.mkdir()
            (pack / "pack.json").write_text(json.dumps({"name": "test", "voices": []}), encoding="utf-8")
            self._make_complete_active_role(pack)
            role_dir = pack / "roles" / "anon"
            with _configured_local_api(TTS_PACK_DIR=str(pack), DATA_DIR=temp, LIVE2D_SERVICE=_Live2DProbe()):
                begin = _ApiProbe()
                begin._handle_api_post("/api/tts/roles/anon/begin-update", types.SimpleNamespace(query=""))
                batch_id = begin.response[1]["batch_id"]
                upload = _ApiProbe(upload=b"discard-me")
                upload._handle_api_post(
                    "/api/tts/roles/anon/upload",
                    types.SimpleNamespace(query="kind=ckpt&name=new.ckpt&batch=%s" % batch_id),
                )
                stage_dir = role_dir / ".staging" / batch_id
                self.assertTrue((stage_dir / "gpt.ckpt").is_file())

                discard = _ApiProbe(body={"batch_id": batch_id})
                discard._handle_api_post("/api/tts/roles/anon/discard-update", types.SimpleNamespace(query=""))
                self.assertEqual(discard.response, (200, {"ok": True}))
                self.assertFalse(stage_dir.exists())
            self.assertEqual((role_dir / "gpt.ckpt").read_bytes(), b"old-gpt")

    def test_live2d_active_route_rejects_a_model_that_is_not_bound_to_active_role(self):
        with tempfile.TemporaryDirectory() as temp:
            pack = Path(temp) / "tts_pack"
            pack.mkdir()
            (pack / "pack.json").write_text(json.dumps({"name": "test", "voices": []}), encoding="utf-8")
            self._make_complete_active_role(pack)
            service = _Live2DProbe()
            with _configured_local_api(TTS_PACK_DIR=str(pack), DATA_DIR=temp, LIVE2D_SERVICE=service):
                probe = _ApiProbe(body={"model_id": "some-other-model", "companion_enabled": True})
                probe._handle_api_post("/api/live2d/active", types.SimpleNamespace(query=""))
                self.assertEqual(probe.response[0], 409)
                self.assertIn("当前已启用角色绑定", probe.response[1]["error"])
                self.assertEqual(service.set_calls, [])

    def test_live2d_models_response_exposes_active_role_binding_over_stale_preference(self):
        with tempfile.TemporaryDirectory() as temp:
            pack = Path(temp) / "tts_pack"
            pack.mkdir()
            (pack / "pack.json").write_text(json.dumps({"name": "test", "voices": []}), encoding="utf-8")
            self._make_complete_active_role(pack)
            service = _Live2DProbe()
            with _configured_local_api(TTS_PACK_DIR=str(pack), DATA_DIR=temp, LIVE2D_SERVICE=service):
                probe = _ApiProbe()
                probe._handle_api_get("/api/live2d/models", types.SimpleNamespace(query=""))
                self.assertEqual(probe.response[0], 200)
                binding = probe.response[1]["role_binding"]
                self.assertTrue(binding["enforced"])
                self.assertTrue(binding["ready"])
                self.assertEqual(binding["active_role_id"], "anon")
                self.assertEqual(binding["active_model_id"], "anon-live2d")
                self.assertEqual(probe.response[1]["preference"]["active_model_id"], "stale-manual-model")


if __name__ == "__main__":
    unittest.main(verbosity=2)
