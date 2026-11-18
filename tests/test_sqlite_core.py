#!/usr/bin/env python3
import os
import pathlib
import sqlite3
import sys
import tempfile
import threading
import unittest
import uuid
from datetime import timedelta

# 并发用例的规模：足以触发 WAL 文件反复重建，又不至于让回归套件变慢。
THREADS = 8
WRITES_PER_THREAD = 15

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

    def test_delete_profile_learning_data_keeps_local_profile_preferences(self):
        db.upsert_study_records(self.profile, [self.record("delete-me")])
        db.save_snapshot(db.get_records(self.profile), self.profile)
        db.set_sync_state(self.profile, bootstrap_complete=True)
        db.set_live2d_preference(self.profile, companion_enabled=True)
        deleted = db.delete_profile_learning_data(self.profile)
        self.assertGreaterEqual(deleted["study_records"], 1)
        self.assertEqual([], db.get_records(self.profile))
        self.assertTrue(db.get_live2d_preference(self.profile)["companion_enabled"])


class WarmConnectionTests(unittest.TestCase):
    """WAL 保活连接：默认关闭，启用后可关闭，切换数据目录时必须释放句柄。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        db.init_db(self.temp.name)
        self.profile = "d" * 64

    def tearDown(self):
        db.close_warm()
        self.temp.cleanup()

    def test_keep_warm_reads_identical_records_and_releases_the_handle(self):
        db.upsert_study_records(self.profile, [dict(voc_id="warm-one", voc_spelling="alpha",
                                                    add_date="2026-08-01", last_study_date="2026-08-20",
                                                    study_count=2)])
        baseline = db.get_records(self.profile)
        db.keep_warm(True)
        try:
            warmed = db.get_records(self.profile)
            self.assertEqual(baseline, warmed, "保活连接不得改变读取结果")
            self.assertEqual(1, db.get_record_count(self.profile))
        finally:
            db.close_warm()
        # 关闭后仍可正常读取，且临时目录能被清理（tearDown 会验证）。
        self.assertEqual(baseline, db.get_records(self.profile))

    def test_switching_data_dir_releases_the_warm_connection(self):
        db.keep_warm(True)
        self.assertTrue(os.path.exists(db.database_path()))
        other = tempfile.TemporaryDirectory()
        try:
            db.init_db(other.name)
            # 旧库句柄必须已释放：Windows 上未释放时这里会抛 PermissionError。
            os.remove(os.path.join(self.temp.name, "memo-superform.db"))
        finally:
            other.cleanup()

    def test_warm_connection_removes_readonly_failures_under_concurrency(self):
        """并发下 WAL 的 -wal/-shm 反复删除重建会偶发 SQLITE_READONLY。

        保活连接让这两个文件常驻，实测可把该错误降到 0；这是保活连接除耗时以外的
        正确性收益。断言的是"并发写入零异常、全部落库"，而不仅是"没有 readonly"：
        否则全部写入抛 `database is locked` 等其他异常时，本用例仍会假通过。
        这里只断言"保活后不出现该错误"，不反断言无保活时必然复现（那取决于并发
        强度，属于概率事件）。
        """
        db.keep_warm(True)
        try:
            errors = []
            barrier = threading.Barrier(THREADS)
            # 主键在循环外解析一次：ensure_sync_profile 自身是写事务，放在循环里会
            # 把锁竞争放大一倍，也让用例慢到不适合回归套件。
            pk = db._profile_pk(self.profile)
            expected_rows = THREADS * WRITES_PER_THREAD

            def worker():
                barrier.wait()
                for _ in range(WRITES_PER_THREAD):
                    try:
                        with db._write_connection() as conn:
                            conn.execute("INSERT INTO study_records(profile_id,voc_id,voc_spelling,"
                                         "record_hash,is_active,created_at,updated_at,last_seen_at) "
                                         "VALUES(?,?,?,?,1,?,?,?)",
                                         (pk, uuid.uuid4().hex[:12], uuid.uuid4().hex[:8],
                                          uuid.uuid4().hex, db._utc_now(), db._utc_now(), db._utc_now()))
                    except Exception as exc:  # 记录后继续，统计全部失败类型
                        errors.append(type(exc).__name__ + ": " + str(exc))

            threads = [threading.Thread(target=worker) for _ in range(THREADS)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=120)
            # 线程必须全部正常结束：仍存活说明有写入卡死，此时异常统计也不完整。
            self.assertEqual([], [t for t in threads if t.is_alive()], "工作线程必须全部结束")
            # 任何写入异常都算失败（readonly 只是其中一种），不允许"全失败也通过"。
            self.assertEqual([], errors, "并发写入不允许出现任何异常：" + str(errors[:3]))
            conn = db.get_connection()
            try:
                inserted = conn.execute(
                    "SELECT COUNT(*) FROM study_records WHERE profile_id=?", (pk,)).fetchone()[0]
            finally:
                conn.close()
            self.assertEqual(expected_rows, inserted,
                             "实际落库数量必须等于 THREADS×WRITES_PER_THREAD")
        finally:
            db.close_warm()

    def test_backup_and_write_still_succeed_with_warm_connection(self):
        db.upsert_study_records(self.profile, [dict(voc_id="warm-two", voc_spelling="beta",
                                                    add_date="2026-08-02", last_study_date="2026-08-21",
                                                    study_count=1)])
        db.keep_warm(True)
        try:
            target = db.create_database_backup()
            self.assertTrue(os.path.exists(target), "保活连接下在线备份必须成功")
            db.upsert_study_records(self.profile, [dict(voc_id="warm-three", voc_spelling="gamma",
                                                        add_date="2026-08-03", last_study_date="2026-08-22",
                                                        study_count=1)])
            self.assertEqual(2, db.get_record_count(self.profile))
        finally:
            db.close_warm()


if __name__ == "__main__":
    unittest.main(verbosity=2)
