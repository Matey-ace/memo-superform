#!/usr/bin/env python3
import pathlib
import sqlite3
import sys
import tempfile
import unittest
from datetime import timedelta

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import db  # noqa: E402
import recommender  # noqa: E402
import study_sync  # noqa: E402


class SQLiteCoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        db.init_db(self.temp.name)
        self.profile = "c" * 64

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def record(voc_id="one", spelling="same", **changes):
        value = {
            "voc_id": voc_id,
            "voc_spelling": spelling,
            "add_date": "2020-05-01T00:00:00+08:00",
            "first_study_date": "2020-05-02T00:00:00+08:00",
            "last_study_date": "2026-08-20T00:00:00+08:00",
            "next_study_date": "2026-08-24T00:00:00+08:00",
            "last_response": "FORGET",
            "study_count": 3,
            "tags": "",
        }
        value.update(changes)
        return value

    def test_schema_is_idempotent_and_uses_expected_pragmas(self):
        first = db.database_path()
        self.assertEqual(first, db.init_db(self.temp.name))
        conn = db.get_connection()
        try:
            self.assertEqual(1, conn.execute("PRAGMA foreign_keys").fetchone()[0])
            self.assertEqual("wal", conn.execute("PRAGMA journal_mode").fetchone()[0].lower())
            self.assertEqual("ok", conn.execute("PRAGMA quick_check").fetchone()[0])
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertTrue({"profiles", "study_records", "sync_state", "sync_runs", "sync_segments"} <= tables)
        finally:
            conn.close()

    def test_voc_id_is_identity_and_unchanged_record_performs_no_update(self):
        first = self.record("one", "repeat")
        second = self.record("two", "repeat")
        self.assertEqual({"added": 2, "updated": 0, "unchanged": 0},
                         db.upsert_study_records(self.profile, [first, second]))
        pk = db._profile_pk(self.profile)
        conn = db.get_connection()
        try:
            before = conn.execute("SELECT updated_at FROM study_records WHERE profile_id=? AND voc_id='one'", (pk,)).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual({"added": 0, "updated": 0, "unchanged": 1},
                         db.upsert_study_records(self.profile, [first]))
        conn = db.get_connection()
        try:
            after = conn.execute("SELECT updated_at FROM study_records WHERE profile_id=? AND voc_id='one'", (pk,)).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(before, after)
        self.assertEqual(2, len(db.get_records(self.profile)))

    def test_old_word_current_state_updates_without_rewriting_snapshot(self):
        old = self.record()
        db.upsert_study_records(self.profile, [old])
        self.assertEqual(1, db.save_snapshot(db.get_records(self.profile), self.profile))
        changed = self.record(study_count=4, last_study_date="2026-08-26T00:00:00+08:00",
                              next_study_date="2026-09-26T00:00:00+08:00")
        self.assertEqual(1, db.upsert_study_records(self.profile, [changed])["updated"])
        self.assertEqual(0, db.save_snapshot(db.get_records(self.profile), self.profile))
        pk = db._profile_pk(self.profile)
        conn = db.get_connection()
        try:
            snapshot = conn.execute("SELECT study_count,next_study_date FROM study_record_snapshots WHERE profile_id=?", (pk,)).fetchone()
            current = conn.execute("SELECT study_count,next_study_date FROM study_records WHERE profile_id=?", (pk,)).fetchone()
        finally:
            conn.close()
        self.assertEqual((3, "2026-08-24"), tuple(snapshot))
        self.assertEqual((4, "2026-09-26"), tuple(current))

    def test_recommendation_score_and_reviewed_state_are_preserved(self):
        today = db.beijing_today()
        record = self.record(next_study_date=(today - timedelta(days=6)).isoformat(),
                             last_study_date=(today - timedelta(days=25)).isoformat())
        db.upsert_study_records(self.profile, [record])
        self.assertEqual(1, recommender.generate_recommendations(30, self.profile))
        item = recommender.get_today_recommendations(self.profile)[0]
        self.assertEqual(80, item["risk_score"])
        self.assertEqual(1, recommender.mark_reviewed(item["id"], self.profile))
        self.assertEqual(1, recommender.generate_recommendations(30, self.profile))
        self.assertEqual("reviewed", recommender.get_today_recommendations(self.profile)[0]["status"])

    def test_completed_bootstrap_intervals_cover_parent_and_skip_old_range(self):
        db.record_sync_interval(self.profile, db.date(2020, 1, 1), db.date(2021, 12, 31), complete=True, source="bootstrap")
        db.record_sync_interval(self.profile, db.date(2022, 1, 1), db.date(2022, 12, 31), complete=True, source="bootstrap")
        self.assertTrue(db.is_sync_interval_complete(self.profile, db.date(2020, 1, 1), db.date(2022, 12, 31)))

    def test_real_sqlite_adapter_only_writes_changed_today_record(self):
        self.profile = study_sync.token_profile_id("local-test-token")
        original = self.record("old", "old-word", study_count=1,
                               next_study_date="2021-01-01T00:00:00+08:00")
        db.upsert_study_records(self.profile, [original])
        now = study_sync.datetime(2026, 8, 26, 2, 0, tzinfo=study_sync.timezone.utc)
        db.set_sync_state(self.profile, bootstrap_complete=True, last_remote_count=1,
                          last_incremental_date="2026-08-25", last_today_probe_at="2026-08-25T02:00:00+00:00")
        changed = dict(original, study_count=2, last_study_date="2026-08-26T00:00:00+08:00",
                       next_study_date="2026-09-26T00:00:00+08:00")

        class Transport:
            def __init__(self): self.calls = []
            def post_json(self, url, payload, headers, timeout):
                self.calls.append((url, dict(payload)))
                if payload.get("as_count"):
                    return study_sync.HTTPResponse(200, body={"data": {"count": 1}})
                if url.endswith("get_today_items"):
                    return study_sync.HTTPResponse(200, body={"data": {"today_items": [{
                        "voc_id": "old", "voc_spelling": "old-word", "order": 1,
                        "first_response": "FORGET", "is_new": False, "is_finished": True,
                    }]}})
                return study_sync.HTTPResponse(200, body={"data": {"records": [changed]}})

        transport = Transport()
        client = study_sync.MaimemoStudyClient(transport, max_retries=0)
        service = study_sync.StudySyncService(study_sync.DbStudySyncRepository(db), client=client, now=lambda: now)
        result = service.run("local-test-token", "incremental", reason="auto")
        self.assertEqual("completed", result["status"])
        self.assertEqual(1, result["updated"])
        self.assertEqual(2, db.get_records(self.profile)[0]["study_count"])
        self.assertTrue(any(payload.get("voc_ids") == ["old"] for _url, payload in transport.calls))


if __name__ == "__main__":
    unittest.main(verbosity=2)
