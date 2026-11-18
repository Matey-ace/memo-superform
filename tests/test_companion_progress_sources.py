# -*- coding: utf-8 -*-
import os
import tempfile
import unittest

import db
import companion_progress_sources as ps


class StrictItemTests(unittest.TestCase):
    def test_present_invalid_absent_are_distinct(self):
        item = ps.normalise_strict_item({"voc_id": "v1", "is_new": True, "is_finished": "yes"})
        self.assertIs(item["is_new"], True)
        self.assertIsNone(item["is_finished"])
        self.assertEqual(item["field_state"]["is_new"], "present")
        self.assertEqual(item["field_state"]["is_finished"], "invalid")

        absent = ps.normalise_strict_item({"voc_id": "v2"})
        self.assertIsNone(absent["is_new"])
        self.assertEqual(absent["field_state"]["is_new"], "absent")

    def test_absent_is_not_false(self):
        item = ps.normalise_strict_item({"voc_id": "v3"})
        self.assertIsNot(item["is_finished"], False)

    def test_missing_voc_id_degrades_to_missing_fields(self):
        # 缺 voc_id 不抛错，而是降级成 missing_fields 快照：这样界面能显示
        # 「目标待同步」，而结算被完整性检查挡住。这比直接报错更可用。
        item = ps.normalise_strict_item({"is_new": True})
        self.assertIsNone(item["voc_id"])
        self.assertEqual(item["field_state"]["voc_id"], "absent")
        snap = ps.build_snapshot(1, 1, "d", "k", [{"is_new": True}],
                                 upstream_plan_known=True)
        self.assertEqual(snap["completeness"], "missing_fields")
        self.assertIsNone(snap["total"])

    def test_numeric_voc_id_rejected_not_coerced(self):
        # 数字 ID 若被强行转成字符串，"1" 与 "01" 会被混成同一个词。
        item = ps.normalise_strict_item({"voc_id": 1, "is_new": True})
        self.assertIsNone(item["voc_id"])
        self.assertEqual(item["field_state"]["voc_id"], "invalid")


class CompletenessTests(unittest.TestCase):
    def _items(self, count, finished=False):
        raw = [{"voc_id": "v%d" % i, "is_new": True, "is_finished": finished}
               for i in range(count)]
        return [ps.normalise_strict_item(entry) for entry in raw]

    def test_limit_reached(self):
        items = self._items(1000)
        self.assertEqual(ps.classify_completeness(items, raw_count=1000,
                                                  upstream_plan_known=True), "limit_reached")

    def test_missing_fields(self):
        items = self._items(3)
        items[1]["is_finished"] = None
        items[1]["field_state"]["is_finished"] = "absent"
        self.assertEqual(ps.classify_completeness(items, raw_count=3,
                                                  upstream_plan_known=True), "missing_fields")

    def test_plan_unknown_without_verified_plan(self):
        items = self._items(3)
        self.assertEqual(ps.classify_completeness(items, raw_count=3,
                                                  upstream_plan_known=False), "plan_unknown")

    def test_complete(self):
        items = self._items(3)
        self.assertEqual(ps.classify_completeness(items, raw_count=3,
                                                  upstream_plan_known=True), "complete")

    def test_truncated_when_declared_more_than_present(self):
        items = self._items(2)
        self.assertEqual(ps.classify_completeness(items, raw_count=5,
                                                  upstream_plan_known=True), "truncated")


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        # 父目录必须自己建：它可能被上一次清理删掉，不能让 mkdtemp 依赖它存在。
        os.makedirs(r"D:\MeMo1\_verification\companion-upgrade\agents\M", exist_ok=True)
        self.tmp = tempfile.mkdtemp(dir=r"D:\MeMo1\_verification\companion-upgrade\agents\M")
        self.addCleanup(self._cleanup)
        db.init_db(self.tmp)
        self.pk = db.ensure_sync_profile("acct-snap")
        self.epoch = db.companion_account_state(self.pk)["data_epoch"]

    def _cleanup(self):
        import shutil
        db.close_warm()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _raw(self, ids, finished=False):
        return [{"voc_id": i, "is_new": True, "is_finished": finished} for i in ids]

    def test_incomplete_snapshot_has_no_total(self):
        snap = ps.build_snapshot(self.pk, self.epoch, "2026-11-16",
                                 "study-day:2026-11-16:r", self._raw(["a", "b"]))
        self.assertNotEqual(snap["completeness"], "complete")
        self.assertIsNone(snap["total"])

    def test_complete_snapshot_has_total(self):
        snap = ps.build_snapshot(self.pk, self.epoch, "2026-11-16",
                                 "study-day:2026-11-16:r", self._raw(["a", "b"]),
                                 upstream_plan_known=True)
        self.assertEqual(snap["completeness"], "complete")
        self.assertEqual(snap["total"], 2)

    def test_fingerprint_ignores_is_finished(self):
        before = ps.build_snapshot(self.pk, self.epoch, "2026-11-16", "k",
                                   self._raw(["a", "b"]), upstream_plan_known=True)
        after = ps.build_snapshot(self.pk, self.epoch, "2026-11-16", "k",
                                  self._raw(["a", "b"], finished=True), upstream_plan_known=True)
        self.assertEqual(before["plan_fingerprint"], after["plan_fingerprint"])

    def test_duplicate_voc_id_rejected(self):
        # 重复成员无法判定“谁是同一个词”，必须报错而不是静默去重。
        with self.assertRaises(ps.SnapshotFormatError):
            ps.build_snapshot(self.pk, self.epoch, "2026-11-16", "k",
                              self._raw(["a", "a", "b"]), upstream_plan_known=True)

    def test_stale_fetch_seq_does_not_overwrite(self):
        newer = ps.build_snapshot(self.pk, self.epoch, "2026-11-16", "k",
                                  self._raw(["a"]), upstream_plan_known=True, fetch_seq=5)
        self.assertTrue(ps.persist_snapshot(newer)["persisted"])
        older = ps.build_snapshot(self.pk, self.epoch, "2026-11-16", "k",
                                  self._raw(["a", "b"]), upstream_plan_known=True, fetch_seq=2)
        outcome = ps.persist_snapshot(older)
        self.assertFalse(outcome["persisted"])
        self.assertEqual(outcome["reason"], "stale_fetch_seq")
        latest = ps.latest_snapshot(self.pk, self.epoch, "2026-11-16", "k")
        self.assertEqual(latest["fetch_seq"], 5)

    def test_duplicate_snapshot_id_not_rewritten(self):
        snap = ps.build_snapshot(self.pk, self.epoch, "2026-11-16", "k",
                                 self._raw(["a"]), upstream_plan_known=True, fetch_seq=1)
        self.assertTrue(ps.persist_snapshot(snap)["persisted"])
        again = ps.persist_snapshot(snap)
        self.assertFalse(again["persisted"])
        self.assertEqual(again["reason"], "duplicate_snapshot")

    def test_items_not_array_rejected(self):
        with self.assertRaises(ps.SnapshotFormatError):
            ps.build_snapshot(self.pk, self.epoch, "2026-11-16", "k", {"a": 1})

    def test_plan_change_detection(self):
        first = ps.build_snapshot(self.pk, self.epoch, "d", "k", self._raw(["a", "b"]),
                                  upstream_plan_known=True)
        second = ps.build_snapshot(self.pk, self.epoch, "d", "k", self._raw(["b", "c"]),
                                   upstream_plan_known=True)
        diff = ps.compare_plans(dict(first, items_json=__import__("json").dumps(first["items"])),
                                dict(second, items_json=__import__("json").dumps(second["items"])))
        self.assertTrue(diff["plan_changed"])
        self.assertEqual(diff["added"], ["c"])
        self.assertEqual(diff["removed"], ["a"])
        self.assertFalse(diff["reset"])


if __name__ == "__main__":
    unittest.main()