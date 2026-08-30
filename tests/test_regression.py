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
        self.assertIn("sqlite_schema.sql", spec)
        self.assertIn("windows_tray", spec)
        self.assertIn("console=False", spec)
        self.assertIn("CHANGELOG.md", spec)
        self.assertIn("excludes=['pyodbc']", spec)
        self.assertFalse((ROOT / "MemoSuperform-Desktop.spec").exists())
        self.assertFalse((ROOT / "MemoSuperform-Web.spec").exists())
        self.assertTrue((ROOT / "_archive/legacy/MemoSuperform-Desktop.spec").exists())
        self.assertTrue((ROOT / "_archive/legacy/MemoSuperform-Web.spec").exists())

    def test_third_party_sources_and_licenses_are_declared_and_packaged(self):
        readme = self.read("README.md")
        notices = self.read("THIRD_PARTY_NOTICES.md")
        spec = self.read("MemoSuperform.spec")
        downloader = "A-kirami/bestdori-live2d-downloader"

        self.assertIn("### Bestdori Live2D 下载器与渲染组件", readme)
        self.assertIn("### Bestdori Live2D downloader and rendering components", readme)
        self.assertIn("### Cherry Studio 的 Codex 集成参考", readme)
        self.assertIn("### Cherry Studio Codex integration reference", readme)
        self.assertGreaterEqual(readme.count(downloader), 2)
        for phrase in (
            downloader,
            "Copyright (c) 2023 Akirami",
            "Apache ECharts 5.5.0",
            "Copyright 2017-2024 The Apache Software Foundation",
            "PixiJS 6.5.10",
            "Copyright (c) 2013-2017 Mathew Groves, Chad Engler",
            "pixi-live2d-display 0.4.0",
            "Live2D Cubism Core for Web",
            "M PLUS Rounded 1c",
            "pywebview BSD 3-Clause License",
            "mkleehammer/pyodbc",
            "pyodbc MIT-0 License",
            "CherryHQ/cherry-studio",
        ):
            self.assertIn(phrase, notices)
        self.assertIn("THIRD_PARTY_NOTICES.md", spec)
        self.assertTrue((ROOT / "vendor/echarts-LICENSE.txt").is_file())
        self.assertTrue((ROOT / "vendor/echarts-NOTICE.txt").is_file())
        self.assertTrue((ROOT / "vendor/echarts-LICENSE-d3.txt").is_file())
        self.assertTrue((ROOT / "vendor/live2d/pixi-LICENSE.txt").is_file())
        self.assertTrue((ROOT / "vendor/live2d/pixi-live2d-display-LICENSE").is_file())
        self.assertTrue((ROOT / "fonts/OFL-1.1.txt").is_file())

    def test_theme_and_study_contracts(self):
        dashboard = self.read("js/dashboard-core.js")
        study = self.read("js/study-web.js")
        lifecycle = self.read("js/study-lifecycle.js")
        injection = self.read("memo_injection.py")
        self.assertIn("!notebook && saved === 'dark'", dashboard)
        self.assertIn("button.hidden = notebook", dashboard)
        self.assertIn("isActualStudyScreen", study)
        self.assertIn("event.source !== iframe.contentWindow", study)
        self.assertIn('action !== \'home-fallback\'', study)
        self.assertIn("observer.disconnect()", lifecycle)
        self.assertIn("clearInterval(poll)", lifecycle)
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

    def test_sqlite_incremental_data_contract(self):
        database = self.read("db.py")
        schema = self.read("sqlite_schema.sql")
        sync = self.read("study_sync.py")
        app_api = self.read("app_api.py")
        self.assertNotRegex(database, r"(?m)^import pyodbc$")
        self.assertIn("ApplicationIntent=ReadOnly", database)
        self.assertIn("PRIMARY KEY (profile_id, voc_id)", schema)
        self.assertIn("PRAGMA journal_mode=WAL", database)
        self.assertIn("MAIMEMO_TODAY_ITEMS_API", sync)
        self.assertNotIn('"offset"', sync)
        self.assertIn('path == "/api/study-sync"', app_api)

    def test_windowed_exe_http_logging_does_not_require_console_stderr(self):
        server = self.read("server.py")
        self.assertIn("if sys.stderr is not None", server)
        self.assertIn('os.path.join(DATA_DIR, "server.log")', server)

    def test_v070_changelog_documents_major_updates(self):
        changelog = self.read("CHANGELOG.md")
        for phrase in ("## 0.70", "SQLite", "按需增量更新", "Windows 后台运行状态", "统一 EXE"):
            self.assertIn(phrase, changelog)

    def test_anon_notebook_terminology_replaces_handbook_descriptions(self):
        descriptions = (
            "CHANGELOG.md", "README.md", "index.html", "index-anon.html",
            "release.ps1", "memo_injection.py", "css/diary.css",
            "css/maimemo-notebook.css", "css/study-web.css",
            "css/study-web-notebook.css", "css/style-anon.css",
            "js/dashboard-core.js", "js/diary.js", "js/layout.js", "js/ui-style.js",
        )
        for path in descriptions:
            self.assertNotRegex(self.read(path), "\u624b\u8d26|\u624b\u5e10", path)
        self.assertIn("Anon的笔记本", self.read("index.html"))
        self.assertIn("Anon的笔记本", self.read("js/diary.js"))

    def test_add_word_overlay_hides_study_response_actions(self):
        study = self.read("js/study-web.js")
        css = self.read("css/study-web.css") + self.read("css/study-web-standard.css") + self.read("css/study-web-notebook.css")
        self.assertIn("hasAddWordOverlay", study)
        self.assertIn("studyAddWordOverlayOpen", study)
        self.assertIn("is-add-word-overlay", study)
        self.assertIn("actions.toggleAttribute('inert'", study)
        self.assertIn(".study-web-actions.is-add-word-overlay", css)

    def test_live2d_companion_contract_is_isolated_from_existing_study_ui(self):
        companion = self.read("js/live2d-companion.js")
        service = self.read("live2d_service.py")
        html = self.read("index.html")
        self.assertIn("Live2DCompanion", companion)
        self.assertIn("CompanionSession", companion)
        self.assertIn("Live2DModelManager", companion)
        self.assertIn("window.Live2DCompanion = Live2DCompanion", companion)
        self.assertIn("companionModeBtn", html)
        self.assertIn("/api/live2d/assets/", service)
        self.assertIn("MAX_MODEL_BYTES", service)

    def test_v071_changelog_documents_anon_overlay_fix(self):
        changelog = self.read("CHANGELOG.md")
        for phrase in ("## 0.71", "Anon的笔记本", "加入复习", "四个判断按钮"):
            self.assertIn(phrase, changelog)

if __name__ == "__main__":
    unittest.main(verbosity=2)

