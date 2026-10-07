"""HTTP and auth failures exercised without cloud credentials."""
import io
import json
import pathlib
import sys
import tempfile
import threading
import unittest
import urllib.error
import http.client
import http.server
from unittest import mock
from types import SimpleNamespace

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import server
import codex_auth
from maimemo_auth import CredentialStore, MaimemoAuthError
import test_maimemo_oauth as auth_fixture
_Protector = auth_fixture._Protector


class AuthRaceTests(unittest.TestCase):
    setUp = auth_fixture.MaimemoOAuthTests.setUp
    tearDown = auth_fixture.MaimemoOAuthTests.tearDown
    def test_token_and_profile_snapshot_rejects_mid_read_account_switch(self):
        self.oauth.set_manual_token("old-account")
        original = self.oauth.access_token
        def switching():
            value = original()
            self.oauth.set_manual_token("new-account")
            return value
        with mock.patch.object(self.oauth, "access_token", side_effect=switching):
            with self.assertRaisesRegex(MaimemoAuthError, "账号"):
                self.oauth.authorization_context()
        token, profile = self.oauth.authorization_context()
        self.assertEqual("new-account", token)
        self.assertEqual(self.oauth.profile_key(), profile)
    def test_refresh_preserves_account_identity(self):
        self.oauth._save_oauth_tokens({"access_token": "old", "refresh_token": "old-refresh", "expires_in": 1,
                                       "id_token": "header.eyJzdWIiOiJ1c2VyIn0.signature"})
        self.oauth.post_form = lambda *args: {"access_token": "new", "expires_in": 3600,
                                            "id_token": "header.eyJzdWIiOiJvdGhlciJ9.signature"}
        with self.assertRaisesRegex(MaimemoAuthError, "身份"):
            self.oauth.access_token()
        self.assertEqual("old", self.oauth.credentials.load()["tokens"]["access_token"])
    def test_late_refresh_never_restores_disconnected_credentials(self):
        self.oauth._save_oauth_tokens({"access_token": "old", "refresh_token": "old-refresh", "expires_in": 1,
                                       "id_token": "header.eyJzdWIiOiJ1c2VyIn0.signature"})
        entered, resume = threading.Event(), threading.Event()
        failures = []
        def post(url, fields):
            if fields.get("grant_type") == "refresh_token":
                entered.set(); resume.wait(2)
                return {"access_token": "new", "refresh_token": "new-refresh", "expires_in": 3600}
            return {}
        self.oauth.post_form = post
        def refresh():
            try: self.oauth.access_token()
            except MaimemoAuthError as exc: failures.append(str(exc))
        worker = threading.Thread(target=refresh)
        worker.start()
        self.assertTrue(entered.wait(1))
        self.oauth.disconnect()
        resume.set(); worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertTrue(failures)
        self.assertFalse(self.oauth.status()["connected"])
        self.assertFalse(self.oauth.credentials.path.exists())


class CodexContracts(unittest.TestCase):
    def test_partial_failed_and_incomplete_streams_are_rejected(self):
        delta = 'data: {"type":"response.output_text.delta","delta":"half"}\n'
        for ending in ('', 'data: {"type":"response.failed"}', 'data: {"type":"response.incomplete"}'):
            with self.subTest(ending=ending), self.assertRaises(RuntimeError):
                codex_auth._decode_codex_response((delta + ending).encode(), "text/event-stream")
        completed = 'data: {"type":"response.completed","response":{"status":"completed"}}'
        self.assertEqual("half", codex_auth._decode_codex_response((delta + completed).encode(), "text/event-stream")["output_text"])

    def test_verified_legacy_migration_and_failed_protection_preserve_recovery(self):
        with tempfile.TemporaryDirectory() as root:
            legacy = pathlib.Path(root) / "codex_auth.json"
            data = {"tokens": {"access_token": "secret-access", "refresh_token": "secret-refresh"}}
            legacy.write_text(json.dumps(data))
            auth = codex_auth.CodexOAuth(root, protector=_Protector())
            self.assertTrue(auth.status()["connected"])
            self.assertFalse(legacy.exists())
            self.assertNotIn(b"secret-access", auth.credentials.path.read_bytes())
        with tempfile.TemporaryDirectory() as root:
            legacy = pathlib.Path(root) / "codex_auth.json"
            legacy.write_text(json.dumps(data))
            protector = _Protector()
            protector.protect = mock.Mock(side_effect=MaimemoAuthError("protection failed"))
            auth = codex_auth.CodexOAuth(root, protector=protector)
            with self.assertRaises(MaimemoAuthError): auth.status()
            self.assertTrue(legacy.exists())

    def test_wrong_callback_state_keeps_valid_flow_alive(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.object(codex_auth, "CALLBACK_PORTS", (0,)):
            auth = codex_auth.CodexOAuth(root, protector=_Protector())
            auth.start_login(open_browser=False)
            callback = auth._callback_server
            try:
                host, port = callback.server_address
                connection = http.client.HTTPConnection(host, port, timeout=2)
                connection.request("GET", "/auth/callback?code=bad&state=wrong")
                self.assertEqual(400, connection.getresponse().status)
                connection.close()
                self.assertIs(callback, auth._callback_server)
                with mock.patch.object(codex_auth, "_form_post", return_value={"access_token": "a", "refresh_token": "r"}):
                    self.assertTrue(auth._complete_login({"state": [auth._pending["state"]], "code": ["good"]})[0])
            finally:
                auth._stop_callback_server(callback)


class ProxyHTTPTests(unittest.TestCase):
    def setUp(self):
        class Handler(server.MemoProxyHandler):
            def log_message(self, *args): pass
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
    def tearDown(self):
        self.httpd.shutdown(); self.httpd.server_close(); self.thread.join(2)
    def request(self, path, *, method="GET", body=None, headers=None):
        connection = http.client.HTTPConnection(*self.httpd.server_address, timeout=2)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        value = response.read()
        connection.close()
        return response.status, value
    def test_ai_mutation_guard_precedes_managed_model_call(self):
        with mock.patch.object(server.CODEX_OAUTH, "chat") as chat:
            for headers in ({}, {"X-Requested-With": "MemoSuperform", "Origin": "https://foreign.example"}):
                code, body = self.request("/proxy/ai", method="POST", body='{"provider":"codex"}', headers=headers)
                self.assertEqual(403, code); json.loads(body)
            chat.assert_not_called()
    def test_non_object_and_bad_body_length_are_rejected(self):
        for body in ("[]", "null", '"text"'):
            code, value = self.request("/proxy/ai", method="POST", body=body, headers={"X-Requested-With": "MemoSuperform"})
            self.assertEqual(400, code); json.loads(value)
        code, _ = self.request("/proxy/ai", method="POST", headers={"Content-Length": "-1"})
        self.assertEqual(400, code)
    def test_html_upstream_keeps_http_status_and_becomes_json(self):
        auth = SimpleNamespace(access_token=lambda: "hosted-token", profile_key=lambda: "profile")
        for status in (403, 429):
            error = urllib.error.HTTPError("https://api.example", status, "failed", {"Retry-After": "0"}, io.BytesIO(b"<!DOCTYPE html>upstream error"))
            with mock.patch.object(server, "MAIMEMO_OAUTH", auth), mock.patch.object(server, "OFFICIAL_API_LIMITER", None), \
                 mock.patch.object(server.urllib.request, "urlopen", side_effect=error):
                code, body = self.request("/proxy/memo/notepads?limit=1&offset=0")
                self.assertEqual(status, code); self.assertIn("error", json.loads(body))
    def test_public_static_assets_exclude_new_source_and_database_schema(self):
        for path in ("/codex_auth.py", "/maimemo_auth.py", "/sqlite_schema.sql", "/js/../codex_auth.py", "/%63odex_auth.py", "/js/"):
            for method in ("GET", "HEAD"):
                self.assertEqual(404, self.request(path, method=method)[0], path)
        self.assertEqual(200, self.request("/js/api.js")[0])

    def test_asset_named_directory_never_exposes_a_listing(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.object(server, "WEB_DIR", root):
            (pathlib.Path(root) / "js" / "listing.js").mkdir(parents=True)
            for method in ("GET", "HEAD"):
                self.assertEqual(404, self.request("/js/listing.js", method=method)[0])


if __name__ == "__main__": unittest.main()
