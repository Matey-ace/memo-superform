#!/usr/bin/env python3
import hashlib
import pathlib
import re
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

class RepositoryContracts(unittest.TestCase):
    def read(self, path):
        return (ROOT / path).read_text(encoding="utf-8-sig")

    def test_font_and_gif_assets_are_byte_identical(self):
        lines = self.read("tests/font-gif-manifest.sha256").splitlines()
        self.assertEqual(1006, len(lines))
        for line in lines:
            expected, rel = line.split("  ", 1)
            actual = hashlib.sha1((ROOT / rel).read_bytes()).hexdigest()
            self.assertEqual(expected, actual, rel)

    def test_unified_packaging_only(self):
        spec = self.read("MemoSuperform.spec")
        self.assertIn("['launcher.py']", spec)
        self.assertFalse((ROOT / "MemoSuperform-Desktop.spec").exists())
        self.assertFalse((ROOT / "MemoSuperform-Web.spec").exists())
        self.assertTrue((ROOT / "_archive/legacy/MemoSuperform-Desktop.spec").exists())
        self.assertTrue((ROOT / "_archive/legacy/MemoSuperform-Web.spec").exists())

    def test_theme_and_study_contracts(self):
        dashboard = self.read("js/dashboard-core.js")
        study = self.read("js/study-web.js")
        injection = self.read("memo_injection.py")
        self.assertIn("!notebook && saved === 'dark'", dashboard)
        self.assertIn("button.hidden = notebook", dashboard)
        self.assertIn("isActualStudyScreen", study)
        self.assertIn("event.source !== iframe.contentWindow", study)
        self.assertIn('action !== \'home-fallback\'', study)
        self.assertIn('EXIT_ID="memo-tts-exit"', injection)
        self.assertIn('action:\"home-fallback\"', injection)

    def test_proxy_route_table_preserves_targets(self):
        from memo_proxy import resolve_web_route
        self.assertEqual(
            ("https://tc-apis.maimemo.com/webstudy/app?x=1", True, False),
            resolve_web_route("/memo-tc/webstudy/app", "x=1", "GET"),
        )
        self.assertEqual(
            ("https://api.maimemo.com/user/info", False, False),
            resolve_web_route("/memo-api/user/info", "", "POST"),
        )
        self.assertEqual(
            ("https://accounts.maimemo.com/oidc/auth", True, True),
            resolve_web_route("/memo-accounts/oidc/auth", "", "GET"),
        )

    def test_static_security_contract(self):
        from static_security import is_forbidden_static_path
        for path in ("/.git/config", "/_archive/legacy/README.md", "/server.py", "/data/launcher.json"):
            self.assertTrue(is_forbidden_static_path(path), path)
        for path in ("/index.html", "/css/style.css", "/js/app.js"):
            self.assertFalse(is_forbidden_static_path(path), path)

    def test_release_is_single_asset_and_non_destructive(self):
        script = self.read("release.ps1")
        self.assertNotRegex(script, r"(?m)^\\s*git add -A")
        self.assertNotIn("Method Delete", script)
        self.assertIn("MemoSuperform-$tag.exe", script)
        self.assertIn("make_latest", script)
        self.assertIn("assets.Count -ne 1", script)

    def test_archived_easter_egg_is_not_loaded(self):
        index = self.read("index.html")
        style = self.read("css/style-anon.css")
        self.assertNotIn("easter-egg.js", index)
        self.assertNotIn(".egg-overlay", style)
        self.assertTrue((ROOT / "_archive/legacy/easter-egg.js").exists())
        self.assertTrue((ROOT / "_archive/legacy/easter-egg.css").exists())

if __name__ == "__main__":
    unittest.main(verbosity=2)

