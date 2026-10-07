"""Behavior tests for deletion barriers and resurrected records."""
import pathlib
import sys
import tempfile
import sqlite3
import shutil
import threading
import unittest
from datetime import date
from types import SimpleNamespace

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import db
from study_sync import SyncManager, StudySyncError, StudySyncService, normalise_record


class DataRaceTests(unittest.TestCase):
    def test_date_formats_use_beijing_day_and_early_millisecond_timestamps(self):
        self.assertEqual(date(2026, 10, 7), db._parse_date("20261007"))
        self.assertIsNone(db._parse_date("20260230"))
        self.assertEqual(date(2000, 1, 1), db._parse_date(946684800000))
        self.assertEqual(date(2000, 1, 1), db._parse_date(946684800))
        self.assertEqual(date(2026, 10, 8), db._parse_date("2026-10-07T16:00:00Z"))

    def test_sync_database_initialization_failure_reports_a_retryable_terminal_state(self):
        def failed(*args, **kwargs):
            raise RuntimeError("database full")
        manager = SyncManager(SimpleNamespace(run=failed))
        manager.start("token")
        next(iter(manager._tasks.values())).thread.join(2)
        status = manager.status("token")
        self.assertFalse(status["active"])
        self.assertEqual("failed", status["status"])
        self.assertTrue(status["needs_reconcile"])
        self.assertIn("database full", status["error"])

    def test_online_backup_contains_committed_wal_and_restores_independently(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / '原始 数据'
            db.init_db(str(source))
            profile = 'b' * 64
            db.upsert_study_records(profile, [{"voc_id": "wal", "voc_spelling": "word", "study_count": 7}])
            connection = db.get_connection()
            try:
                backup = db.create_database_backup()
                restored = pathlib.Path(directory) / '恢复 数据'; restored.mkdir()
                shutil.copy2(backup, restored / 'memo-superform.db')
                db.init_db(str(restored))
                self.assertEqual(7, db.get_records(profile)[0]['study_count'])
                checked = sqlite3.connect(backup)
                try: self.assertEqual('ok', checked.execute('PRAGMA integrity_check').fetchone()[0])
                finally: checked.close()
            finally:
                connection.close()

    def test_unchanged_inactive_word_is_restored_through_service(self):
        with tempfile.TemporaryDirectory() as directory:
            db.init_db(directory)
            profile = "a" * 64
            record = normalise_record({"voc_id": "a", "voc_spelling": "apple", "study_count": 1})
            db.upsert_study_records(profile, [record])
            for _ in range(2):
                db.mark_reconcile_seen(profile, [])
                db.mark_absent_after_two_reconciles(profile)
            self.assertEqual(0, db.get_record_count(profile))
            self.assertEqual({}, db.get_study_record_hashes(profile, ["a"]))
            result = db.upsert_study_records(profile, [record])
            self.assertEqual(1, result["updated"])
            self.assertEqual(1, db.get_record_count(profile))
            connection = db.get_connection()
            try:
                self.assertEqual(0, connection.execute("SELECT missing_reconcile_count FROM study_records").fetchone()[0])
            finally:
                connection.close()

    def test_delete_drains_late_writes_and_blocks_new_sync(self):
        entered, release, deleting = threading.Event(), threading.Event(), threading.Event()
        writes, results, errors = [], [], []
        def run(*args, **kwargs):
            entered.set()
            if not release.wait(3):
                raise AssertionError("test worker timed out")
            writes.append("late write")
            return {}
        manager = SyncManager(SimpleNamespace(run=run))
        manager.start("token")
        self.assertTrue(entered.wait(1))
        def delete(profile):
            deleting.set()
            with self.assertRaises(StudySyncError):
                manager.start("token")
            writes.clear()
            return 1
        def deleting_thread():
            try:
                results.append(manager.delete_profile_data("token", delete, timeout=2))
            except Exception as exc:
                errors.append(exc)
        thread = threading.Thread(target=deleting_thread)
        thread.start()
        self.assertTrue(manager._tasks[manager._resolve_profile("token")].cancel_event.wait(1))
        self.assertFalse(deleting.is_set())
        release.set()
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual([], errors)
        self.assertEqual([1], results)
        self.assertEqual([], writes)
        self.assertEqual("idle", manager.status("token")["status"])

    def test_timeout_keeps_data_and_failed_delete_can_be_retried(self):
        entered, release = threading.Event(), threading.Event()
        def run(*args, **kwargs):
            entered.set()
            release.wait(3)
            return {}
        manager = SyncManager(SimpleNamespace(run=run))
        manager.start("token")
        self.assertTrue(entered.wait(1))
        deleted = []
        try:
            with self.assertRaises(StudySyncError):
                manager.delete_profile_data("token", lambda profile: deleted.append(profile), timeout=0)
            self.assertEqual([], deleted)
        finally:
            release.set()
            manager._tasks[manager._resolve_profile("token")].thread.join(2)
        manager.delete_profile_data("token", lambda profile: deleted.append(profile))
        self.assertEqual(1, len(deleted))


if __name__ == "__main__":
    unittest.main()
