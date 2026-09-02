#!/usr/bin/env python3
"""OAuth + DPAPI storage contracts; all network calls are faked."""

from __future__ import annotations

import base64
import json
import pathlib
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, urlparse

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from maimemo_auth import (  # noqa: E402
    DEFAULT_SCOPES,
    MAIMEMO_CLIENT_ID,
    CredentialStore,
    MaimemoAuthError,
    MaimemoOAuth,
)


class _Protector:
    """Test-only reversible protector; production always uses DPAPI."""
    def protect(self, data): return b"protected:" + bytes(data)[::-1]
    def unprotect(self, data):
        if not bytes(data).startswith(b"protected:"):
            raise MaimemoAuthError("bad test blob")
        return bytes(data)[len(b"protected:"):][::-1]


def _jwt(claims):
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return "header.%s.signature" % payload


class MaimemoOAuthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clock = [1_700_000_000.0]
        self.calls = []
        protector = _Protector()

        def post_form(url, fields):
            self.calls.append((url, dict(fields)))
            if fields["grant_type"] == "authorization_code":
                return {
                    "access_token": "access-a", "refresh_token": "refresh-a", "expires_in": 3600,
                    "id_token": _jwt({"sub": "stable-user", "name": "Alice"}),
                }
            if fields["grant_type"] == "refresh_token":
                return {
                    "access_token": "access-b", "refresh_token": "refresh-b", "expires_in": 3600,
                    "id_token": _jwt({"sub": "stable-user", "name": "Alice"}),
                }
            return {}

        self.oauth = MaimemoOAuth(
            self.temp.name, client_id="memo-client", now=lambda: self.clock[0],
            opener=lambda *_args, **_kwargs: False, post_form=post_form,
            credential_store=CredentialStore(pathlib.Path(self.temp.name) / "credentials.bin", protector),
            pending_store=CredentialStore(pathlib.Path(self.temp.name) / "pending.bin", protector),
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_pkce_callback_exchanges_code_without_exposing_verifier(self):
        started = self.oauth.start_login(open_browser=False)
        query = parse_qs(urlparse(started["authorization_url"]).query)
        self.assertEqual(["S256"], query["code_challenge_method"])
        self.assertEqual([DEFAULT_SCOPES], query["scope"])
        self.assertNotIn("code_verifier", query)
        state = query["state"][0]

        status = self.oauth.complete_callback_url("memo-superform://maimemo-oauth/?code=abc&state=" + state)
        self.assertTrue(status["connected"])
        self.assertEqual("oauth", status["mode"])
        self.assertEqual("Alice", status["display_name"])
        self.assertEqual("access-a", self.oauth.access_token())
        self.assertNotEqual("stable-user", status["profile_id"])
        token_request = self.calls[-1][1]
        self.assertEqual("abc", token_request["code"])
        self.assertIn("code_verifier", token_request)
        self.assertFalse((pathlib.Path(self.temp.name) / "pending.bin").exists())

    def test_shipped_configuration_uses_the_approved_public_client_and_scopes(self):
        self.assertEqual("6a968536c8e75d605a3c9f13", MAIMEMO_CLIENT_ID)
        self.assertTrue(MaimemoOAuth(self.temp.name).configured)
        self.assertEqual(
            {"openid", "profile", "offline_access", "open.memo.study", "open.memo.content"},
            set(DEFAULT_SCOPES.split()),
        )

    def test_known_callback_protocol_failure_is_reported_and_blocks_new_login(self):
        self.oauth.set_callback_protocol_status(False, "回调协议注册失败")
        status = self.oauth.status()
        self.assertFalse(status["callback_ready"])
        self.assertEqual("回调协议注册失败", status["callback_error"])
        with self.assertRaisesRegex(MaimemoAuthError, "回调协议注册失败"):
            self.oauth.start_login(open_browser=False)

    def test_bad_or_repeated_state_is_rejected(self):
        started = self.oauth.start_login(open_browser=False)
        state = parse_qs(urlparse(started["authorization_url"]).query)["state"][0]
        with self.assertRaises(MaimemoAuthError):
            self.oauth.complete_callback_url("memo-superform://maimemo-oauth?code=abc&state=wrong")
        self.oauth.complete_callback_url("memo-superform://maimemo-oauth?code=abc&state=" + state)
        with self.assertRaises(MaimemoAuthError):
            self.oauth.complete_callback_url("memo-superform://maimemo-oauth?code=again&state=" + state)

    def test_refresh_keeps_oidc_profile_key_stable(self):
        state = parse_qs(urlparse(self.oauth.start_login(open_browser=False)["authorization_url"]).query)["state"][0]
        self.oauth.complete_callback_url("memo-superform://maimemo-oauth?code=abc&state=" + state)
        before = self.oauth.profile_key()
        self.clock[0] += 3600
        self.assertEqual("access-b", self.oauth.access_token())
        self.assertEqual(before, self.oauth.profile_key())

    def test_manual_token_is_encrypted_and_can_disconnect(self):
        self.oauth.set_manual_token("legacy-token")
        self.assertTrue(self.oauth.status()["connected"])
        raw = (pathlib.Path(self.temp.name) / "credentials.bin").read_bytes()
        self.assertNotIn(b"legacy-token", raw)
        self.assertEqual("legacy-token", self.oauth.access_token())
        self.oauth.disconnect()
        self.assertFalse(self.oauth.status()["connected"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
