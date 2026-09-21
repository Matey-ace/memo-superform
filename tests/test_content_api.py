#!/usr/bin/env python3
"""Contracts for the scoped Maimemo content API proxy."""

from __future__ import annotations

import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server import MemoProxyHandler  # noqa: E402


class ContentApiProxyTests(unittest.TestCase):
    allowed = staticmethod(MemoProxyHandler._official_api_allowed)

    def test_content_reads_require_expected_query_parameters(self):
        self.assertTrue(self.allowed("vocabulary", "GET", "spelling=apple"))
        self.assertTrue(self.allowed("interpretations", "GET", "voc_id=voc-1"))
        self.assertTrue(self.allowed("notes", "GET", "voc_id=voc-1"))
        self.assertFalse(self.allowed("vocabulary", "GET", ""))
        self.assertFalse(self.allowed("notes", "GET", "spelling=apple"))
        self.assertFalse(self.allowed("notes", "GET", "voc_id=voc-1&redirect=https://evil"))

    def test_content_mutations_are_scoped_to_supported_resources(self):
        for path in ("interpretations", "interpretations/i_1", "notes", "notes/n_1"):
            self.assertTrue(self.allowed(path, "POST"), path)
        for path in ("interpretations/i_1", "notes/n_1"):
            self.assertTrue(self.allowed(path, "DELETE"), path)
        self.assertFalse(self.allowed("vocabulary", "POST"))
        self.assertFalse(self.allowed("notes", "DELETE"))
        self.assertFalse(self.allowed("notes/../other", "DELETE"))
        self.assertFalse(self.allowed("notes/n_1", "POST", "unexpected=1"))

    def test_existing_read_routes_remain_available(self):
        self.assertTrue(self.allowed("study/get_study_progress", "POST"))
        self.assertTrue(self.allowed("notepads", "GET", "limit=10&offset=0"))
        self.assertTrue(self.allowed("notepads/book_1", "GET"))
        self.assertFalse(self.allowed("notepads", "GET", "limit="))
        self.assertFalse(self.allowed("notepads", "GET", "limit=ten"))
        self.assertFalse(self.allowed("study/get_study_progress", "POST", "extra=1"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
