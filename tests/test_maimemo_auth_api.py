#!/usr/bin/env python3
"""Local API contracts for managed Maimemo credentials."""

from __future__ import annotations

import pathlib
import sys
import types
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import app_api  # noqa: E402
import study_sync  # noqa: E402


class _Service:
    def __init__(self):
        self.manual = []
        self.disconnected = False

    def access_token(self): return "managed-token"
    def profile_key(self): return "d" * 64
    def status(self): return {"connected": True, "mode": "oauth", "profile_id": "d" * 64}
    def start_login(self): return {"authorization_url": "https://example.test", "opened": False}
    def set_manual_token(self, token):
        self.manual.append(token)
        return {"connected": True, "mode": "manual", "profile_id": "e" * 64}
    def disconnect(self): self.disconnected = True


class _Probe(app_api.LocalApiMixin):
    def __init__(self, *, body=None, headers=None):
        self.headers = {"X-Requested-With": "XMLHttpRequest"}
        self.headers.update(headers or {})
        self.body = body or {}
        self.response = None

    def _send_json(self, code, data):
        self.response = (code, data)
        return self.response

    def _read_json_body(self): return self.body


class MaimemoAuthApiTests(unittest.TestCase):
    def test_managed_identity_uses_stable_profile_not_access_token_hash(self):
        service = _Service()
        with mock.patch.dict(app_api.__dict__, {"MAIMEMO_OAUTH": service}):
            probe = _Probe()
            token, profile = probe._memo_identity()
            self.assertEqual("managed-token", token)
            self.assertEqual("d" * 64, profile)

    def test_legacy_bearer_header_remains_compatible(self):
        with mock.patch.dict(app_api.__dict__, {"MAIMEMO_OAUTH": _Service()}):
            probe = _Probe(headers={"Authorization": "Bearer legacy-value"})
            token, profile = probe._memo_identity()
            self.assertEqual("legacy-value", token)
            self.assertEqual(study_sync.token_profile_id("legacy-value"), profile)

    def test_status_and_manual_token_routes_are_local_only(self):
        service = _Service()
        with mock.patch.dict(app_api.__dict__, {"MAIMEMO_OAUTH": service}):
            probe = _Probe()
            probe._handle_api_get("/api/maimemo-auth/status", types.SimpleNamespace(query=""))
            self.assertEqual((200, service.status()), probe.response)
            probe = _Probe(body={"token": "old-token"})
            probe._handle_api_post("/api/maimemo-auth/manual-token", types.SimpleNamespace(query=""))
            self.assertEqual(["old-token"], service.manual)
            self.assertEqual(200, probe.response[0])

    def test_delete_current_profile_data_does_not_need_browser_token(self):
        service = _Service()
        calls = []
        database = types.SimpleNamespace(delete_profile_learning_data=lambda profile: calls.append(profile) or {"study_records": 2})
        with mock.patch.dict(app_api.__dict__, {"MAIMEMO_OAUTH": service, "DB_READY": True, "db": database}):
            probe = _Probe()
            probe._handle_api_delete("/api/maimemo-auth/data", types.SimpleNamespace(query=""))
            self.assertEqual(["d" * 64], calls)
            self.assertEqual(200, probe.response[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
