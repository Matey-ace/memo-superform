"""companion_memory 的契约测试（unittest）。

每个用例使用独立的临时数据目录，绝不触碰真实数据目录。
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import db
import companion_memory as cm


TMP_ROOT = r"D:\MeMo1\_verification\companion-upgrade\agents\A"


class MemoryTestBase(unittest.TestCase):
    def setUp(self):
        os.makedirs(TMP_ROOT, exist_ok=True)
        self.tmp = tempfile.mkdtemp(dir=TMP_ROOT, prefix="mem-")
        db.init_db(self.tmp)
        self.pk = db.ensure_sync_profile("acct-%s" % uuid.uuid4().hex)
        self.role = "role-a"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---------------- 辅助 ----------------

    def epochs(self, role_id=None):
        state = db.companion_account_state(self.pk)
        role = db.companion_role_epoch(self.pk, role_id or self.role)
        return int(state["data_epoch"]), int(role["role_epoch"])

    def push_outbox(self, index, *, role_id=None, new=20, review=8, seconds=1920,
                    day="2026-11-15", occurred_at=None, weak=None):
        role_id = role_id or self.role
        data_epoch, role_epoch = self.epochs(role_id)
        session_id = "sess-%02d" % index
        segment_id = "seg-%02d" % index
        occurred_at = occurred_at or ("2026-11-15T11:00:%02d+00:00" % index)
        payload = {
            "session_id": session_id,
            "segment_id": segment_id,
            "role_id": role_id,
            "study_day": day,
            "occurred_at": occurred_at,
            "confirmed_new": new,
            "confirmed_review": review,
            "active_seconds": seconds,
            "weak_words": weak if weak is not None else ["abandon"],
            "completion_role_name": "小艾",
        }
        db.companion_execute(
            "INSERT INTO companion_outbox(profile_pk,data_epoch,account_epoch,role_epoch,"
            "session_id,segment_id,role_id,event_type,payload_json,status,attempts,created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,'pending',0,?)",
            (self.pk, data_epoch, data_epoch, role_epoch, session_id, segment_id,
             role_id, "session_settlement", json.dumps(payload, ensure_ascii=False),
             db._utc_now()),
        )
        return session_id

    def session_rows(self, role_id=None):
        return [row for row in cm.list_memories(self.pk, role_id or self.role, limit=500)
                if row["kind"] == cm.SESSION_KIND]

    def summary_row(self, role_id=None):
        rows = db.companion_query(
            "SELECT * FROM companion_memories WHERE profile_pk=? AND role_id=? AND kind=?",
            (self.pk, role_id or self.role, cm.SUMMARY_KIND),
        )
        return rows[0] if rows else None


class PreferenceTests(MemoryTestBase):
    def test_preference_write_read_and_edit_bumps_revision(self):
        first = cm.set_preference(self.pk, self.role, "preference_name", "小艾")
        self.assertEqual(first["text"], "小艾")
        self.assertEqual(first["revision"], 1)

        again = cm.list_memories(self.pk, self.role)
        self.assertEqual(len(again), 1)
        self.assertEqual(again[0]["kind"], "preference_name")

        second = cm.set_preference(self.pk, self.role, "preference_name", "艾米")
        self.assertEqual(second["memory_id"], first["memory_id"])
        self.assertEqual(second["revision"], 2)
        self.assertEqual(second["text"], "艾米")
        self.assertEqual(len(cm.list_memories(self.pk, self.role)), 1)

    def test_preference_expected_revision_conflict(self):
        first = cm.set_preference(self.pk, self.role, "preference_goal", "每天 20 词")
        with self.assertRaises(cm.MemoryConflictError):
            cm.set_preference(self.pk, self.role, "preference_goal", "每天 40 词",
                              expected_revision=first["revision"] + 5)
        ok = cm.set_preference(self.pk, self.role, "preference_goal", "每天 40 词",
                               expected_revision=first["revision"])
        self.assertEqual(ok["revision"], 2)
        self.assertTrue(issubclass(cm.MemoryConflictError, cm.MemoryStoreError))

    def test_invalid_preference_kind_rejected(self):
        with self.assertRaises(cm.MemoryStoreError):
            cm.set_preference(self.pk, self.role, "preference_unknown", "x")


class OutboxTests(MemoryTestBase):
    def test_consume_creates_single_study_session_and_is_idempotent(self):
        session_id = self.push_outbox(1)
        result = cm.consume_outbox(self.pk)
        self.assertEqual(result["consumed_count"], 1)
        rows = self.session_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["source_session_id"], session_id)

        # 强行重放同一条事件：仍只有一条记忆。
        db.companion_execute(
            "UPDATE companion_outbox SET status='pending',consumed_at=NULL WHERE session_id=?",
            (session_id,),
        )
        again = cm.consume_outbox(self.pk)
        self.assertEqual(again["scanned"], 1)
        self.assertEqual(len(self.session_rows()), 1)

        outbox = db.companion_query(
            "SELECT status,attempts,consumed_at FROM companion_outbox WHERE session_id=?",
            (session_id,),
        )[0]
        self.assertEqual(outbox["status"], "consumed")
        self.assertTrue(outbox["consumed_at"])
        self.assertGreaterEqual(outbox["attempts"], 2)

    def test_summary_tracks_covered_sessions_and_grows(self):
        self.push_outbox(1, occurred_at="2026-11-15T11:00:00+00:00")
        cm.consume_outbox(self.pk)
        summary = self.summary_row()
        self.assertIsNotNone(summary)
        fact = json.loads(summary["fact_json"])
        self.assertEqual(len(fact["covered_session_ids"]), 1)
        self.assertEqual(fact["covered_until"], "2026-11-15T11:00:00+00:00")
        self.assertEqual(fact["sessions"], 1)
        self.assertLessEqual(len(summary["local_text"]), cm.MAX_SUMMARY_CHARS)

        self.push_outbox(2, occurred_at="2026-11-16T12:00:00+00:00", new=10, review=4)
        cm.consume_outbox(self.pk)
        summary = self.summary_row()
        fact = json.loads(summary["fact_json"])
        self.assertEqual(len(fact["covered_session_ids"]), 2)
        self.assertEqual(fact["covered_until"], "2026-11-16T12:00:00+00:00")
        self.assertEqual(fact["sessions"], 2)
        self.assertEqual(fact["new_words"], 30)
        self.assertEqual(fact["review_words"], 12)
        self.assertEqual(fact["active_minutes"], 64)
        self.assertEqual(
            len(db.companion_query(
                "SELECT memory_id FROM companion_memories WHERE profile_pk=? AND kind=?",
                (self.pk, cm.SUMMARY_KIND))),
            1,
        )

    def test_summary_rebuild_failure_keeps_old_row(self):
        self.push_outbox(1)
        cm.consume_outbox(self.pk)
        before = self.summary_row()
        self.assertIsNotNone(before)

        original = cm._render_summary
        cm._render_summary = lambda fact: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            result = cm.rebuild_summary(self.pk, self.role)
        finally:
            cm._render_summary = original

        self.assertFalse(result["ok"])
        after = self.summary_row()
        self.assertEqual(after["memory_id"], before["memory_id"])
        self.assertEqual(after["local_text"], before["local_text"])
        self.assertEqual(after["revision"], before["revision"])

    def test_clear_role_drops_late_outbox_without_resurrection(self):
        self.push_outbox(1)
        cm.consume_outbox(self.pk)
        self.assertEqual(len(self.session_rows()), 1)

        cleared = cm.clear_role(self.pk, self.role)
        self.assertEqual(cleared["deleted_count"], 2)  # 学习记录 + 摘要
        self.assertEqual(len(self.session_rows()), 0)

        # 清空之后晚到的事件：代次更旧，只能被丢弃。
        data_epoch, role_epoch = self.epochs()
        payload = {
            "session_id": "sess-late", "segment_id": "seg-late", "role_id": self.role,
            "study_day": "2026-11-14", "occurred_at": "2026-11-14T10:00:00+00:00",
            "confirmed_new": 5, "confirmed_review": 1, "active_seconds": 600,
            "weak_words": [], "completion_role_name": "小艾",
        }
        db.companion_execute(
            "INSERT INTO companion_outbox(profile_pk,data_epoch,account_epoch,role_epoch,"
            "session_id,segment_id,role_id,event_type,payload_json,status,attempts,created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,'pending',0,?)",
            (self.pk, data_epoch, data_epoch, max(1, role_epoch - 1), "sess-late",
             "seg-late", self.role, "session_settlement",
             json.dumps(payload, ensure_ascii=False), db._utc_now()),
        )
        result = cm.consume_outbox(self.pk)
        self.assertEqual(result["consumed_count"], 0)
        self.assertEqual(result["dropped_count"], 1)
        self.assertEqual(len(self.session_rows()), 0)
        status = db.companion_query(
            "SELECT status FROM companion_outbox WHERE session_id='sess-late'",
        )[0]["status"]
        self.assertEqual(status, "dropped")

    def test_clear_account_invalidates_all_roles(self):
        other = "role-b"
        self.push_outbox(1)
        self.push_outbox(2, role_id=other)
        cm.set_preference(self.pk, self.role, "preference_name", "小艾")
        cm.set_preference(self.pk, other, "preference_name", "小北")
        cm.consume_outbox(self.pk)
        self.assertEqual(len(cm.list_memories(self.pk, self.role, limit=100)), 3)
        self.assertEqual(len(cm.list_memories(self.pk, other, limit=100)), 3)

        cleared = cm.clear_account(self.pk)
        self.assertGreaterEqual(cleared["deleted_count"], 6)
        self.assertEqual(cm.list_memories(self.pk, self.role, limit=100), [])
        self.assertEqual(cm.list_memories(self.pk, other, limit=100), [])
        logs = db.companion_query(
            "SELECT scope,role_id FROM companion_memory_deletion_log WHERE profile_pk=?",
            (self.pk,),
        )
        self.assertTrue(any(row["scope"] == "account" for row in logs))


class RetrievalTests(MemoryTestBase):
    def _bulk_sessions(self, count):
        for index in range(count):
            occurred = "2026-11-%02dT10:%02d:00+00:00" % (1 + (index % 20), index % 60)
            self.push_outbox(index, occurred_at=occurred,
                             weak=["w%02d" % index])
        cm.consume_outbox(self.pk, limit=200)

    def test_retrieve_respects_item_and_char_limits(self):
        self._bulk_sessions(20)
        self.assertGreaterEqual(len(self.session_rows()), 20)
        result = cm.retrieve(self.pk, self.role)
        self.assertLessEqual(len(result["items"]), cm.MAX_CONTEXT_ITEMS)
        self.assertLessEqual(result["chars"], cm.MAX_CONTEXT_CHARS)
        self.assertTrue(result["truncated"])
        for item in result["items"]:
            self.assertTrue(item["text"])
            self.assertTrue(item["source_label"])
            self.assertTrue(item["occurred_at"])

    def test_retrieve_prefers_preferences_and_keywords(self):
        self._bulk_sessions(3)
        cm.set_preference(self.pk, self.role, "preference_name", "小艾")
        cm.set_preference(self.pk, self.role, "preference_goal", "每天 20 词")
        result = cm.retrieve(self.pk, self.role, "每天")
        kinds = [item["kind"] for item in result["items"]]
        self.assertEqual(kinds[0], "preference_name")
        self.assertEqual(kinds[1], "preference_goal")
        self.assertLessEqual(result["chars"], cm.MAX_CONTEXT_CHARS)


class TicketTests(MemoryTestBase):
    def test_issue_refused_when_outbound_disabled(self):
        cm.ensure_settings(self.pk)
        with self.assertRaises(cm.MemoryStoreError):
            cm.issue_context_ticket(self.pk, self.role)
        settings = cm.get_settings(self.pk)
        self.assertFalse(settings["outbound_enabled"])

    def test_ticket_invalid_after_outbound_disabled(self):
        cm.update_settings(self.pk, use_enabled=True, outbound_enabled=True)
        ticket = cm.issue_context_ticket(self.pk, self.role)
        self.assertTrue(ticket["ok"])
        valid = cm.resolve_context_ticket(self.pk, ticket["ticket_id"])
        self.assertTrue(valid["ok"])
        # 一张票只能用一次。
        self.assertFalse(cm.resolve_context_ticket(self.pk, ticket["ticket_id"])["ok"])

        second = cm.issue_context_ticket(self.pk, self.role)
        cm.update_settings(self.pk, outbound_enabled=False)
        rejected = cm.resolve_context_ticket(self.pk, second["ticket_id"])
        self.assertFalse(rejected["ok"])
        self.assertTrue(rejected["reason"])
        self.assertNotIn("text", rejected)

    def test_ticket_rejected_after_clear_role(self):
        cm.update_settings(self.pk, use_enabled=True, outbound_enabled=True)
        ticket = cm.issue_context_ticket(self.pk, self.role)
        cm.clear_role(self.pk, self.role)
        rejected = cm.resolve_context_ticket(self.pk, ticket["ticket_id"])
        self.assertFalse(rejected["ok"])
        self.assertNotIn("items", rejected)

    def test_ticket_rejects_foreign_profile(self):
        cm.update_settings(self.pk, use_enabled=True, outbound_enabled=True)
        ticket = cm.issue_context_ticket(self.pk, self.role)
        other_pk = db.ensure_sync_profile("acct-%s" % uuid.uuid4().hex)
        self.assertFalse(cm.resolve_context_ticket(other_pk, ticket["ticket_id"])["ok"])


class PromptBlockTests(MemoryTestBase):
    def test_prompt_block_has_no_internal_nouns(self):
        cm.update_settings(self.pk, use_enabled=True, outbound_enabled=True)
        self.push_outbox(1, new=20, review=8, seconds=1920,
                         occurred_at="2026-11-15T11:00:00+00:00")
        cm.consume_outbox(self.pk)
        cm.set_preference(self.pk, self.role, "preference_name", "小艾")
        cm.set_preference(self.pk, self.role, "preference_goal", "每天 20 词")
        cm.set_preference(self.pk, self.role, "preference_encouragement", "简短、不要夸张")

        block = cm.build_prompt_block(self.pk, self.role)
        self.assertTrue(block)
        self.assertIn("【共同学习记录", block)
        self.assertIn("【用户明确告诉你的偏好】", block)
        self.assertIn("称呼：小艾", block)
        self.assertIn("目标：每天 20 词", block)
        for noun in ("revision", "outbox", "epoch", "segment", "memory_id"):
            self.assertNotIn(noun, block)
        self.assertLessEqual(len(block), 4000)

    def test_prompt_block_empty_when_disabled(self):
        self.push_outbox(1)
        cm.consume_outbox(self.pk)
        cm.set_preference(self.pk, self.role, "preference_name", "小艾")
        self.assertEqual(cm.build_prompt_block(self.pk, self.role), "")

        cm.update_settings(self.pk, use_enabled=True, outbound_enabled=True)
        self.assertTrue(cm.build_prompt_block(self.pk, self.role))
        cm.update_settings(self.pk, outbound_enabled=False)
        self.assertEqual(cm.build_prompt_block(self.pk, self.role), "")


class PruneTests(MemoryTestBase):
    def test_prune_removes_old_sessions_keeps_summary_without_log(self):
        cm.set_preference(self.pk, self.role, "preference_name", "小艾")
        self.push_outbox(1, occurred_at="2026-01-01T10:00:00+00:00")
        cm.consume_outbox(self.pk)
        self.assertEqual(len(self.session_rows()), 1)
        self.assertIsNotNone(self.summary_row())

        logs_before = db.companion_query(
            "SELECT COUNT(*) AS n FROM companion_memory_deletion_log WHERE profile_pk=?",
            (self.pk,),
        )[0]["n"]
        result = cm.prune(self.pk, now="2026-11-16T00:00:00+00:00")
        self.assertEqual(result["deleted_count"], 1)
        self.assertEqual(len(self.session_rows()), 0)
        self.assertIsNotNone(self.summary_row())
        kinds = [row["kind"] for row in cm.list_memories(self.pk, self.role, limit=100)]
        self.assertIn("preference_name", kinds)
        logs_after = db.companion_query(
            "SELECT COUNT(*) AS n FROM companion_memory_deletion_log WHERE profile_pk=?",
            (self.pk,),
        )[0]["n"]
        self.assertEqual(logs_after, logs_before)

    def test_prune_keeps_recent_sessions(self):
        self.push_outbox(1, occurred_at="2026-11-15T10:00:00+00:00")
        cm.consume_outbox(self.pk)
        result = cm.prune(self.pk, now="2026-11-16T00:00:00+00:00")
        self.assertEqual(result["deleted_count"], 0)
        self.assertEqual(len(self.session_rows()), 1)


class IsolationTests(MemoryTestBase):
    def test_account_isolation(self):
        other_pk = db.ensure_sync_profile("acct-%s" % uuid.uuid4().hex)
        cm.set_preference(self.pk, self.role, "preference_name", "小艾")
        cm.set_preference(other_pk, self.role, "preference_name", "小北")

        mine = cm.list_memories(self.pk, self.role)
        theirs = cm.list_memories(other_pk, self.role)
        self.assertEqual([row["text"] for row in mine], ["小艾"])
        self.assertEqual([row["text"] for row in theirs], ["小北"])

        cm.clear_account(self.pk)
        self.assertEqual(cm.list_memories(self.pk, self.role), [])
        self.assertEqual([row["text"] for row in cm.list_memories(other_pk, self.role)],
                         ["小北"])

    def test_role_isolation_and_stable_role_id(self):
        other = "role-b"
        cm.set_preference(self.pk, self.role, "preference_name", "小艾")
        cm.set_preference(self.pk, other, "preference_name", "小北")

        self.assertEqual([row["text"] for row in cm.list_memories(self.pk, self.role)],
                         ["小艾"])
        self.assertEqual([row["text"] for row in cm.list_memories(self.pk, other)],
                         ["小北"])

        self.push_outbox(1)
        cm.consume_outbox(self.pk)
        self.assertEqual(len(self.session_rows(self.role)), 1)
        self.assertEqual(len(self.session_rows(other)), 0)

        # 同一 role_id 换了外观（live2d_model_id），记忆仍然可见。
        original = cm.companion_runtime.active_role
        cm.companion_runtime.active_role = lambda: {
            "role_id": self.role, "live2d_model_id": "model-new", "display_name": "小艾"}
        try:
            prefs = [row["text"] for row in cm.list_memories(self.pk, self.role)
                     if row["kind"].startswith("preference_")]
            self.assertEqual(prefs, ["小艾"])
            self.assertEqual(len(self.session_rows(self.role)), 1)
        finally:
            cm.companion_runtime.active_role = original


class PersistenceTests(MemoryTestBase):
    def test_restart_keeps_preferences_and_memories(self):
        cm.set_preference(self.pk, self.role, "preference_name", "小艾")
        self.push_outbox(1)
        cm.consume_outbox(self.pk)

        db.init_db(self.tmp)  # 同一数据目录重新初始化
        rows = cm.list_memories(self.pk, self.role, limit=100)
        self.assertEqual(len(rows), 3)  # 偏好 + 学习记录 + 摘要
        self.assertIn("小艾", [row["text"] for row in rows])
        self.assertEqual(len(self.session_rows()), 1)
        settings = cm.get_settings(self.pk)
        self.assertIn("retention_days", settings)


class SettingsTests(MemoryTestBase):
    def test_settings_creation_and_revision_conflict(self):
        settings = cm.ensure_settings(self.pk)
        self.assertEqual(settings["retention_days"], cm.DEFAULT_RETENTION_DAYS)
        self.assertFalse(settings["outbound_enabled"])

        updated = cm.update_settings(self.pk, outbound_enabled=True,
                                     expected_settings_revision=settings["settings_revision"])
        self.assertTrue(updated["outbound_enabled"])
        self.assertEqual(updated["settings_revision"],
                         settings["settings_revision"] + 1)
        with self.assertRaises(cm.MemoryConflictError):
            cm.update_settings(self.pk, use_enabled=False,
                               expected_settings_revision=settings["settings_revision"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
