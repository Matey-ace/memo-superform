#!/usr/bin/env python3
"""Regression tests for the embedded Maimemo account/web proxy."""

from __future__ import annotations

import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server import MemoProxyHandler  # noqa: E402


class WebProxyRewriteTests(unittest.TestCase):
    def test_account_html_rewrites_inline_absolute_paths(self):
        handler = object.__new__(MemoProxyHandler)
        html = (
            '<form action="/interaction/abc/login"></form>'
            '<script>var verifycodePath = "/interaction/abc/verifycode";'
            'fetch("/oidc/health"); fetch("/static/app.js");</script>'
        ).encode("utf-8")
        rewritten = handler._rewrite_content(html, "text/html; charset=utf-8", "/memo-accounts").decode("utf-8")
        self.assertIn('action="/memo-accounts/interaction/abc/login"', rewritten)
        self.assertIn('"/memo-accounts/interaction/abc/verifycode"', rewritten)
        self.assertIn('fetch("/memo-accounts/oidc/health")', rewritten)
        self.assertIn('fetch("/memo-accounts/static/app.js")', rewritten)
        self.assertNotIn('"/interaction/abc/verifycode"', rewritten)

    def test_account_html_does_not_double_prefix_paths(self):
        handler = object.__new__(MemoProxyHandler)
        html = b'<script>fetch("/memo-accounts/interaction/abc/verifycode")</script>'
        rewritten = handler._rewrite_content(html, "text/html", "/memo-accounts").decode("utf-8")
        self.assertEqual(rewritten, html.decode("utf-8"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
