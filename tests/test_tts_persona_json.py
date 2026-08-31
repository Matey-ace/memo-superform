#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Regression coverage for the versioned per-role ``persona.json`` package.

The v2 roles manifest deliberately has no display-name or companion-prompt
authority.  These tests keep that boundary explicit so later compatibility
changes cannot accidentally reintroduce two competing character records.
"""

import io
import json
import tempfile
import types
import unittest
from contextlib import contextmanager
from pathlib import Path

import app_api
import tts


def _legacy_persona(name="人设里的角色名"):
    return {
        "name": name,
        "background": "这是从旧版 roles.json 迁移出来的角色背景。",
        "tone": "自然、真诚、简短。",
        "avoid": "不要只说语气词。",
        "examples": "这一题记下来就很好。|下一题继续。",
    }


def _persona_json(name="人设角色"):
    return {
        "版本": 1,
        "角色": name,
        "语气": "自然、真诚、简短。",
        "背景": "这是角色的完整背景。",
        "禁忌": "不要只说语气词。",
        "示例": "这一题记下来就很好。\n下一题继续。",
    }


class _ApiProbe(app_api.LocalApiMixin):
    """Minimal local API host for verifying the HTTP-facing creation path."""

    def __init__(self, body):
        self.headers = {"X-Requested-With": "XMLHttpRequest"}
        self.body = dict(body)
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
        return "persona-json-test"


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


class PersonaJsonRoleLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.pack = Path(self.temp.name) / "tts_pack"
        self.pack.mkdir()
        (self.pack / "pack.json").write_text(
            json.dumps({"name": "persona regression pack", "voices": []}),
            encoding="utf-8",
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_v1_inline_persona_migrates_to_per_role_file_and_manifest_loses_authority(self):
        """v1 names/personas move once; responses always read the new file."""
        legacy = _legacy_persona("千早爱音（资料包）")
        old_manifest = {
            "version": 1,
            "active_role_id": "ayane",
            "roles": [{
                "role_id": "ayane",
                # Intentionally disagree with persona.name: the file must win.
                "name": "旧清单名称，不应继续生效",
                "folder": "roles/ayane",
                "gpt_file": "gpt.ckpt",
                "sovits_file": "sovits.pth",
                "audio_file": "reference.wav",
                "index_file": "",
                "reference_text": "旧版参考文本。",
                "reference_language": "日文",
                "live2d_model_id": "ayane-live2d",
                "persona": legacy,
            }],
        }
        (self.pack / "roles.json").write_text(
            json.dumps(old_manifest, ensure_ascii=False), encoding="utf-8"
        )

        migrated = tts.ensure_role_library(str(self.pack))
        self.assertEqual(migrated["version"], 2)
        manifest = json.loads((self.pack / "roles.json").read_text(encoding="utf-8"))
        entry = manifest["roles"][0]
        self.assertEqual(entry["role_id"], "ayane")
        self.assertNotIn("name", entry)
        self.assertNotIn("persona", entry)
        self.assertNotIn("folder", entry)

        document = json.loads(
            (self.pack / "roles" / "ayane" / "persona.json").read_text(encoding="utf-8")
        )
        self.assertEqual(document, {
            "版本": 1,
            "角色": legacy["name"],
            "语气": legacy["tone"],
            "背景": legacy["background"],
            "禁忌": legacy["avoid"],
            "示例": legacy["examples"],
        })
        public = tts.get_role(str(self.pack), "ayane")
        self.assertEqual(public["name"], legacy["name"])
        self.assertEqual(public["persona"], legacy)

    def test_persona_json_schema_is_exact_and_enforces_individual_and_total_limits(self):
        valid = _persona_json()
        self.assertEqual(tts._validate_persona_document(valid), valid)

        unknown = dict(valid, 额外字段="不允许")
        with self.assertRaisesRegex(tts.TTSException, "只包含"):
            tts._validate_persona_document(unknown)

        missing = dict(valid)
        del missing["示例"]
        with self.assertRaisesRegex(tts.TTSException, "只包含"):
            tts._validate_persona_document(missing)

        overlong_background = dict(valid, 背景="甲" * 8001)
        with self.assertRaisesRegex(tts.TTSException, "背景.*8000"):
            tts._validate_persona_document(overlong_background)

        # Every individual field is valid here, but the combined document is
        # one character beyond the 12,000-character dossier budget.
        overlong_total = {
            "版本": 1,
            "角色": "甲",
            "语气": "乙" * 2000,
            "背景": "丙" * 8000,
            "禁忌": "丁" * 2000,
            "示例": "",
        }
        with self.assertRaisesRegex(tts.TTSException, "整份角色人设.*12000"):
            tts._validate_persona_document(overlong_total)

    def test_missing_persona_json_marks_role_incomplete_and_blocks_activation(self):
        tts.save_role(str(self.pack), {
            "role_id": "ayane",
            "name": "千早爱音",
            "reference_text": "これは完全な参考文です。",
            "reference_language": "日文",
            "live2d_model_id": "ayane-live2d",
        })
        for kind, filename, content in (
            ("ckpt", "voice.ckpt", b"gpt"),
            ("pth", "voice.pth", b"sovits"),
            ("audio", "voice.wav", b"RIFF"),
        ):
            tts.upload_role_file(str(self.pack), "ayane", kind, filename, content)

        (self.pack / "roles" / "ayane" / "persona.json").unlink()
        listed = next(
            role for role in tts.list_roles(str(self.pack))["roles"]
            if role["role_id"] == "ayane"
        )
        self.assertFalse(listed["complete"])
        self.assertIn("角色人设", listed["missing"])
        with self.assertRaisesRegex(tts.TTSException, "角色人设"):
            tts.activate_role(str(self.pack), "ayane")

    def test_http_role_creation_generates_id_when_client_omits_it(self):
        body = {
            "persona": _legacy_persona("无需前端 ID 的新角色"),
            "reference_text": "参考文本可以随后再补齐。",
            "reference_language": "日文",
            "live2d_model_id": "",
        }
        with _configured_local_api(
            TTS_PACK_DIR=str(self.pack),
            DATA_DIR=self.temp.name,
            LIVE2D_SERVICE=None,
        ):
            probe = _ApiProbe(body)
            probe._handle_api_post("/api/tts/roles", types.SimpleNamespace(query=""))

        self.assertIsNotNone(probe.response)
        self.assertEqual(probe.response[0], 200, probe.response[1])
        role = probe.response[1]["role"]
        self.assertRegex(role["role_id"], r"^role-[0-9a-f]{16}$")
        self.assertEqual(role["name"], body["persona"]["name"])
        role_dir = self.pack / "roles" / role["role_id"]
        self.assertTrue((role_dir / "persona.json").is_file())

        manifest = json.loads((self.pack / "roles.json").read_text(encoding="utf-8"))
        stored = next(item for item in manifest["roles"] if item["role_id"] == role["role_id"])
        self.assertFalse({"name", "persona"} & set(stored))


if __name__ == "__main__":
    unittest.main(verbosity=2)
