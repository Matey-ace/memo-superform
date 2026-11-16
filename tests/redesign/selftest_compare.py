# -*- coding: utf-8 -*-
"""Deterministic checks for the redesign-only pixel comparator."""
import contextlib
import io
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

from PIL import Image

import compare


class PixelComparisonTests(unittest.TestCase):
    def test_identical_images(self):
        image = Image.new("RGB", (3, 2), (30, 60, 90))
        self.assertEqual(compare.diff_stats(image, image.copy()), (0, 6, 0.0))

    def test_one_level_difference_in_each_channel(self):
        original = Image.new("RGB", (3, 2), (30, 60, 90))
        for channel in range(3):
            with self.subTest(channel=channel):
                changed = original.copy()
                rgb = [30, 60, 90]
                rgb[channel] += 1
                changed.putpixel((1, 1), tuple(rgb))
                self.assertEqual(compare.diff_stats(original, changed), (1, 6, 1 / 6))

    def test_every_changed_pixel_is_counted_once(self):
        a = Image.new("RGB", (2, 2), (0, 0, 0))
        b = Image.new("RGB", (2, 2), (1, 1, 1))
        self.assertEqual(compare.diff_stats(a, b), (4, 4, 1.0))

    def test_size_change_is_not_identical(self):
        a = Image.new("RGB", (2, 2))
        b = Image.new("RGB", (1, 1))
        self.assertEqual(compare.diff_stats(a, b), (4, 4, 1.0))

    def cli(self, mode, a, b):
        output = io.StringIO()
        with mock.patch.object(sys, "argv", ["compare.py", mode, str(a), str(b)]):
            with contextlib.redirect_stdout(output):
                code = compare.main()
        return code, output.getvalue()

    def test_empty_directories_are_not_proof(self):
        with tempfile.TemporaryDirectory(prefix="redesign-compare-") as temp:
            folder = pathlib.Path(temp)
            code, output = self.cli("identical", folder, folder)
            self.assertEqual(code, 1)
            self.assertIn("No matching screenshots", output)

    def test_missing_directories_fail(self):
        with tempfile.TemporaryDirectory(prefix="redesign-compare-") as temp:
            missing = pathlib.Path(temp) / "missing"
            self.assertEqual(self.cli("identical", missing, missing)[0], 1)

    def test_cli_identical_and_changed_semantics(self):
        with tempfile.TemporaryDirectory(prefix="redesign-compare-") as temp:
            a = pathlib.Path(temp) / "a"
            b = pathlib.Path(temp) / "b"
            a.mkdir()
            b.mkdir()
            image = Image.new("RGB", (2, 2), (0, 0, 0))
            image.save(a / "baseline-dashboard@standard@2x2.png")
            image.save(b / "after-dashboard@standard@2x2.png")
            self.assertEqual(self.cli("identical", a, b)[0], 0)
            self.assertEqual(self.cli("changed", a, b)[0], 1)
            image.putpixel((0, 0), (0, 0, 1))
            image.save(b / "after-dashboard@standard@2x2.png")
            self.assertEqual(self.cli("identical", a, b)[0], 1)
            self.assertEqual(self.cli("changed", a, b)[0], 0)

    def test_unmatched_files_fail(self):
        with tempfile.TemporaryDirectory(prefix="redesign-compare-") as temp:
            a = pathlib.Path(temp) / "a"
            b = pathlib.Path(temp) / "b"
            a.mkdir()
            b.mkdir()
            Image.new("RGB", (1, 1)).save(a / "extra.png")
            self.assertEqual(self.cli("identical", a, b)[0], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
