#!/usr/bin/env python3
import hashlib
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]

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
        app = self.read("js/app.js")
        study = self.read("js/study-web.js")
        server = self.read("server.py")
        self.assertIn("!notebook && saved === 'dark'", app)
        self.assertIn("themeBtn.hidden = notebook", app)
        self.assertIn("isActualStudyScreen", study)
        self.assertIn("event.source !== iframe.contentWindow", study)
        self.assertIn('action !== \'home-fallback\'', study)
        self.assertIn('EXIT_ID="memo-tts-exit"', server)
        self.assertIn('action:\"home-fallback\"', server)

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

