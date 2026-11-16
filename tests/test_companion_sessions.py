# -*- coding: utf-8 -*-
"""会话、证据与结算的验收测试。"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

import db
import companion_runtime
import companion_progress_sources as ps
import companion_sessions as cs


def _raw(ids, finished=False, is_new=True):
    return [{"voc_id": i, "is_new": is_new, "is_finished": finished} for i in ids]


class Base(unittest.TestCase):
    def setUp(self):
        # 父目录必须自己建：它可能被上一次清理删掉，不能让 mkdtemp 依赖它存在。
        os.makedirs(r"D:\MeMo1\_verification\companion-upgrade\agents\M", exist_ok=True)
        self.tmp = tempfile.mkdtemp(dir=r"D:\MeMo1\_verification\companion-upgrade\agents\M")
        self.addCleanup(self._cleanup)
        db.init_db(self.tmp)
        self.pk = db.ensure_sync_profile("acct-session-%s" % id(self))
        self.epoch = db.companion_account_state(self.pk)["data_epoch"]
        self.day = "2026-11-16"
        self.task = "study-day:%s:role-a" % self.day
        companion_runtime.set_identity_override({"status": "matched"})

    def _cleanup(self):
        companion_runtime.set_identity_override(None)
        db.close_warm()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def snapshot(self, ids, finished=False, *, known=True, fetch_seq=1):
        snap = ps.build_snapshot(self.pk, self.epoch, self.day, self.task,
                                 _raw(ids, finished=finished),
                                 upstream_plan_known=known, fetch_seq=fetch_seq)
        ps.persist_snapshot(snap)
        return snap

    def open(self, *, target=5, kind="session_goal", baseline=None, new_round=False,
             role_id="role-a"):
        return cs.open_session(
            profile_pk=self.pk, data_epoch=self.epoch, study_day=self.day, task_key=self.task,
            goal_kind=kind, target_count=target, role_id=role_id, role_name="测试角色",
            binding=companion_runtime.identity_binding("acct"), baseline_snapshot=baseline,
            new_round=new_round)

    def ack(self, session, ids, source="observed_ack"):
        events = [{"event_id": "evt-%s-%s" % (session["session_id"], i), "type": "answer",
                   "source": source, "item_key": i, "round_key": "r1", "seq": n + 1}
                  for n, i in enumerate(ids)]
        return cs.record_events(profile_pk=self.pk, data_epoch=self.epoch,
                                session_id=session["session_id"], events=events)


class OpenSessionTests(Base):
    def test_repeated_open_returns_same_session(self):
        first = self.open()
        second = self.open()
        self.assertEqual(first["session_id"], second["session_id"])

    def test_two_windows_share_one_session(self):
        a = self.open()
        b = self.open()
        self.assertEqual(a["session_id"], b["session_id"])
        rows = db.companion_query(
            "SELECT COUNT(*) AS c FROM companion_sessions WHERE profile_pk=? AND state IN ('active','paused')",
            (self.pk,))
        self.assertEqual(rows[0]["c"], 1)

    def test_new_round_bumps_generation(self):
        first = self.open()
        cs.set_state(profile_pk=self.pk, data_epoch=self.epoch,
                     session_id=first["session_id"], action="abandon")
        second = self.open(new_round=True)
        self.assertNotEqual(first["session_id"], second["session_id"])
        rows = db.companion_query(
            "SELECT run_generation FROM companion_sessions WHERE session_id=?",
            (second["session_id"],))
        self.assertEqual(rows[0]["run_generation"], 2)

    def test_session_goal_requires_positive_target(self):
        with self.assertRaises(cs.SessionError):
            self.open(target=0)

    def test_unknown_goal_kind_rejected(self):
        with self.assertRaises(cs.SessionError):
            self.open(kind="nope")


class StateMachineTests(Base):
    def test_pause_resume_abandon(self):
        s = self.open()
        paused = cs.set_state(profile_pk=self.pk, data_epoch=self.epoch,
                              session_id=s["session_id"], action="pause",
                              expected_revision=s["revision"])
        self.assertEqual(paused["state"], "paused")
        resumed = cs.set_state(profile_pk=self.pk, data_epoch=self.epoch,
                               session_id=s["session_id"], action="resume",
                               expected_revision=paused["revision"])
        self.assertEqual(resumed["state"], "active")
        done = cs.set_state(profile_pk=self.pk, data_epoch=self.epoch,
                            session_id=s["session_id"], action="abandon")
        self.assertEqual(done["state"], "abandoned")
        with self.assertRaises(cs.ConflictError):
            cs.set_state(profile_pk=self.pk, data_epoch=self.epoch,
                         session_id=s["session_id"], action="pause")

    def test_stale_revision_conflicts(self):
        s = self.open()
        cs.set_state(profile_pk=self.pk, data_epoch=self.epoch,
                     session_id=s["session_id"], action="pause",
                     expected_revision=s["revision"])
        with self.assertRaises(cs.ConflictError):
            cs.set_state(profile_pk=self.pk, data_epoch=self.epoch,
                         session_id=s["session_id"], action="resume",
                         expected_revision=s["revision"])

    def test_set_goal_does_not_settle(self):
        s = self.open(target=5)
        updated = cs.set_state(profile_pk=self.pk, data_epoch=self.epoch,
                               session_id=s["session_id"], action="set_goal",
                               target_count=2)
        self.assertEqual(updated["target_count"], 2)
        self.assertEqual(updated["state"], "active")
        self.assertEqual(updated["goal_revision"], 2)
        self.assertIsNone(cs.get_settlement(self.pk, self.epoch, s["session_id"]))


class EventTests(Base):
    def test_duplicate_event_id_accepted_once(self):
        s = self.open()
        result = self.ack(s, ["w1"])
        self.assertEqual(result["accepted"], 1)
        again = self.ack(s, ["w1"])
        self.assertEqual(again["accepted"], 0)
        self.assertEqual(again["duplicate"], 1)

    def test_batch_limits(self):
        s = self.open()
        events = [{"event_id": "e%d" % i, "type": "answer", "item_key": "w"}
                  for i in range(cs.MAX_EVENTS_PER_REQUEST + 1)]
        with self.assertRaises(cs.SessionError):
            cs.record_events(profile_pk=self.pk, data_epoch=self.epoch,
                             session_id=s["session_id"], events=events)

    def test_intent_source_does_not_count_as_evidence(self):
        s = self.open(target=2)
        self.ack(s, ["w1", "w2"], source="intent")
        snap = self.snapshot(["w1", "w2"], finished=True)
        result = cs.reconcile(profile_pk=self.pk, data_epoch=self.epoch,
                              session_id=s["session_id"], snapshot=snap,
                              binding=companion_runtime.identity_binding("acct"))
        self.assertEqual(result["evidence"]["confirmed_total"], 0)
        self.assertFalse(result["completion"]["can_complete"])


class ActiveTimeTests(Base):
    def test_overlapping_leases_counted_once(self):
        s = self.open()
        sid = s["session_id"]
        now = datetime.now(timezone.utc)
        start = (now - timedelta(minutes=10)).isoformat()
        mid = (now - timedelta(minutes=5)).isoformat()
        db.companion_execute(
            "INSERT INTO companion_activity_leases(lease_id,session_id,profile_pk,instance_id,"
            "started_at,last_seen_at,ended_at) VALUES(?,?,?,?,?,?,?)",
            ("l1", sid, self.pk, "win-a", start, mid, mid))
        db.companion_execute(
            "INSERT INTO companion_activity_leases(lease_id,session_id,profile_pk,instance_id,"
            "started_at,last_seen_at,ended_at) VALUES(?,?,?,?,?,?,?)",
            ("l2", sid, self.pk, "win-b", start, now.isoformat(), now.isoformat()))
        seconds = cs.active_seconds(session_id=sid, now=now.isoformat())
        self.assertAlmostEqual(seconds, 600, delta=5)

    def test_stale_lease_is_capped(self):
        s = self.open()
        sid = s["session_id"]
        old = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
        db.companion_execute(
            "INSERT INTO companion_activity_leases(lease_id,session_id,profile_pk,instance_id,"
            "started_at,last_seen_at,ended_at) VALUES(?,?,?,?,?,?,NULL)",
            ("l3", sid, self.pk, "dead", old, old))
        self.assertEqual(cs.active_seconds(session_id=sid), 0)

    def test_pause_seals_lease_so_paused_time_never_counts(self):
        """暂停期间的时间不能进结算：租约必须在暂停瞬间被封存。

        为什么值得单独测：早先的实现只在**读取**时判断
        ``state == 'paused'`` 然后返回上次持久化的秒数，而那个秒数只在结算时
        才写回。结果暂停期间产生的时间会被并集统计算进去，有效时长偏大。
        """
        s = self.open()
        sid = s["session_id"]
        now = datetime.now(timezone.utc)
        start = (now - timedelta(minutes=10)).isoformat()
        db.companion_execute(
            "INSERT INTO companion_activity_leases(lease_id,session_id,profile_pk,instance_id,"
            "started_at,last_seen_at,ended_at) VALUES(?,?,?,?,?,?,NULL)",
            ("lp", sid, self.pk, "win-a", start, now.isoformat()))

        cs.set_state(profile_pk=self.pk, data_epoch=self.epoch, session_id=sid,
                     action="pause")

        # 暂停必须封存租约，否则后续并集会继续累计。
        rows = db.companion_query(
            "SELECT ended_at FROM companion_activity_leases WHERE lease_id=?", ("lp",))
        self.assertIsNotNone(rows[0]["ended_at"], "暂停后租约必须已有 ended_at")

        # 暂停期间过了一个小时，有效时间不得增加。
        before = cs.active_seconds(session_id=sid)
        later = (now + timedelta(hours=1)).isoformat()
        after = cs.active_seconds(session_id=sid, now=later)
        self.assertEqual(before, after, "暂停后有效时间不得继续增长")
        self.assertAlmostEqual(after, 600, delta=5)

        # 恢复后重新开始累计。
        cs.set_state(profile_pk=self.pk, data_epoch=self.epoch, session_id=sid,
                     action="resume")
        db.companion_execute(
            "INSERT INTO companion_activity_leases(lease_id,session_id,profile_pk,instance_id,"
            "started_at,last_seen_at,ended_at) VALUES(?,?,?,?,?,?,NULL)",
            ("lr", sid, self.pk, "win-a", later,
             (now + timedelta(hours=1, minutes=5)).isoformat()))
        resumed = cs.active_seconds(
            session_id=sid, now=(now + timedelta(hours=1, minutes=5)).isoformat())
        self.assertAlmostEqual(resumed, 900, delta=10)

    def test_abandon_seals_lease(self):
        s = self.open()
        sid = s["session_id"]
        now = datetime.now(timezone.utc)
        old = (now - timedelta(minutes=10)).isoformat()
        db.companion_execute(
            "INSERT INTO companion_activity_leases(lease_id,session_id,profile_pk,instance_id,"
            "started_at,last_seen_at,ended_at) VALUES(?,?,?,?,?,?,NULL)",
            ("la", sid, self.pk, "win-a", old, now.isoformat()))
        cs.set_state(profile_pk=self.pk, data_epoch=self.epoch, session_id=sid,
                     action="abandon")
        rows = db.companion_query(
            "SELECT ended_at FROM companion_activity_leases WHERE lease_id=?", ("la",))
        self.assertIsNotNone(rows[0]["ended_at"], "放弃后租约也必须封存")


class CompletionTests(Base):
    def test_session_goal_settles_once(self):
        s = self.open(target=2)
        self.ack(s, ["w1", "w2"])
        snap = self.snapshot(["w1", "w2"], finished=True)
        cs.reconcile(profile_pk=self.pk, data_epoch=self.epoch,
                     session_id=s["session_id"], snapshot=snap,
                     binding=companion_runtime.identity_binding("acct"))
        first = cs.complete_session(profile_pk=self.pk, data_epoch=self.epoch,
                                    session_id=s["session_id"], snapshot=snap,
                                    binding=companion_runtime.identity_binding("acct"))
        self.assertTrue(first["available"])
        self.assertEqual(first["confirmed_total"], 2)
        second = cs.complete_session(profile_pk=self.pk, data_epoch=self.epoch,
                                     session_id=s["session_id"], snapshot=snap,
                                     binding=companion_runtime.identity_binding("acct"))
        self.assertEqual(first["settlement_id"], second["settlement_id"])
        rows = db.companion_query(
            "SELECT COUNT(*) AS c FROM companion_rewards WHERE profile_pk=? AND session_id=?",
            (self.pk, s["session_id"]))
        self.assertEqual(rows[0]["c"], 2)  # 纪念卡 + 首次徽章，各一份
        outbox = db.companion_query(
            "SELECT COUNT(*) AS c FROM companion_outbox WHERE session_id=?",
            (s["session_id"],))
        self.assertEqual(outbox[0]["c"], 1)

    def test_incomplete_snapshot_blocks_settlement(self):
        s = self.open(target=1)
        self.ack(s, ["w1"])
        snap = self.snapshot(["w1"], finished=True, known=False)
        with self.assertRaises(cs.SessionError):
            cs.complete_session(profile_pk=self.pk, data_epoch=self.epoch,
                                session_id=s["session_id"], snapshot=snap,
                                binding=companion_runtime.identity_binding("acct"))

    def test_unknown_identity_blocks_settlement(self):
        companion_runtime.set_identity_override(None)
        s = self.open(target=1)
        self.ack(s, ["w1"])
        snap = self.snapshot(["w1"], finished=True)
        with self.assertRaises(cs.SessionError):
            cs.complete_session(profile_pk=self.pk, data_epoch=self.epoch,
                                session_id=s["session_id"], snapshot=snap,
                                binding=companion_runtime.identity_binding("acct"))

    def test_preexisting_finished_words_not_counted(self):
        s = self.open(target=1)
        self.ack(s, ["w1"])
        # 基线里 w1 已完成：本轮不得把它算作新增
        snap = self.snapshot(["w1"], finished=True)
        blocked = cs.open_session(
            profile_pk=self.pk, data_epoch=self.epoch, study_day=self.day,
            task_key="study-day:%s:role-b" % self.day, goal_kind="session_goal",
            target_count=1, role_id="role-b", role_name="B",
            baseline_snapshot=snap, binding=companion_runtime.identity_binding("acct"))
        cs.record_events(profile_pk=self.pk, data_epoch=self.epoch,
                         session_id=blocked["session_id"],
                         events=[{"event_id": "x1", "type": "answer",
                                  "source": "observed_ack", "item_key": "w1"}])
        result = cs.reconcile(profile_pk=self.pk, data_epoch=self.epoch,
                              session_id=blocked["session_id"], snapshot=snap,
                              binding=companion_runtime.identity_binding("acct"))
        self.assertEqual(result["evidence"]["confirmed_total"], 0)

    def test_today_plan_requires_all_finished(self):
        s = self.open(target=None, kind="today_plan")
        self.ack(s, ["w1"])
        partial = self.snapshot(["w1", "w2"], finished=False)
        cs.reconcile(profile_pk=self.pk, data_epoch=self.epoch,
                     session_id=s["session_id"], snapshot=partial,
                     binding=companion_runtime.identity_binding("acct"))
        with self.assertRaises(cs.SessionError):
            cs.complete_session(profile_pk=self.pk, data_epoch=self.epoch,
                                session_id=s["session_id"], snapshot=partial,
                                binding=companion_runtime.identity_binding("acct"))

    def test_abandoned_session_cannot_settle(self):
        s = self.open(target=1)
        cs.set_state(profile_pk=self.pk, data_epoch=self.epoch,
                     session_id=s["session_id"], action="abandon")
        with self.assertRaises(cs.ConflictError):
            cs.complete_session(profile_pk=self.pk, data_epoch=self.epoch,
                                session_id=s["session_id"])

    def test_stale_epoch_rejected(self):
        s = self.open()
        db.companion_bump_data_epoch(self.pk)
        with self.assertRaises(cs.StaleEpochError):
            cs.get_session(self.pk, self.epoch, s["session_id"])
        with self.assertRaises(cs.StaleEpochError):
            cs.open_session(profile_pk=self.pk, data_epoch=self.epoch, study_day=self.day,
                            task_key=self.task, goal_kind="session_goal", target_count=3,
                            role_id="role-a")

    def test_cross_day_sessions_independent(self):
        s = self.open()
        other = cs.open_session(
            profile_pk=self.pk, data_epoch=self.epoch, study_day="2026-11-17",
            task_key="study-day:2026-11-17:role-a", goal_kind="session_goal",
            target_count=5, role_id="role-a", role_name="测试角色",
            binding=companion_runtime.identity_binding("acct"))
        self.assertNotEqual(s["session_id"], other["session_id"])


class SegmentTests(Base):
    def test_role_switch_seals_old_segment(self):
        s = self.open(role_id="role-a")
        cs.open_session(profile_pk=self.pk, data_epoch=self.epoch, study_day=self.day,
                        task_key=self.task, goal_kind="session_goal", target_count=5,
                        role_id="role-b", role_name="B",
                        binding=companion_runtime.identity_binding("acct"))
        rows = db.companion_query(
            "SELECT role_id,sealed_at FROM companion_role_segments WHERE session_id=? ORDER BY seq",
            (s["session_id"],))
        self.assertEqual([row["role_id"] for row in rows], ["role-a", "role-b"])
        self.assertIsNotNone(rows[0]["sealed_at"])
        self.assertIsNone(rows[1]["sealed_at"])

    def test_same_role_keeps_one_segment(self):
        s = self.open(role_id="role-a")
        cs.open_session(profile_pk=self.pk, data_epoch=self.epoch, study_day=self.day,
                        task_key=self.task, goal_kind="session_goal", target_count=5,
                        role_id="role-a", role_name="测试角色",
                        binding=companion_runtime.identity_binding("acct"))
        rows = db.companion_query(
            "SELECT COUNT(*) AS c FROM companion_role_segments WHERE session_id=?",
            (s["session_id"],))
        self.assertEqual(rows[0]["c"], 1)


class MemoryQueueTests(Base):
    def test_outbox_survives_missing_settlement(self):
        s = self.open(target=1)
        self.ack(s, ["w1"])
        snap = self.snapshot(["w1"], finished=True)
        cs.reconcile(profile_pk=self.pk, data_epoch=self.epoch,
                     session_id=s["session_id"], snapshot=snap,
                     binding=companion_runtime.identity_binding("acct"))
        cs.complete_session(profile_pk=self.pk, data_epoch=self.epoch,
                            session_id=s["session_id"], snapshot=snap,
                            binding=companion_runtime.identity_binding("acct"))
        # 删除队列行后，记忆补发只能重建队列，不能再发一次奖励
        db.companion_execute("DELETE FROM companion_outbox WHERE session_id=?",
                             (s["session_id"],))
        rewards = db.companion_query(
            "SELECT COUNT(*) AS c FROM companion_rewards WHERE session_id=?",
            (s["session_id"],))
        self.assertEqual(rewards[0]["c"], 2)
        again = cs.complete_session(profile_pk=self.pk, data_epoch=self.epoch,
                                    session_id=s["session_id"], snapshot=snap,
                                    binding=companion_runtime.identity_binding("acct"))
        self.assertTrue(again["available"])
        rewards_after = db.companion_query(
            "SELECT COUNT(*) AS c FROM companion_rewards WHERE session_id=?",
            (s["session_id"],))
        self.assertEqual(rewards_after[0]["c"], 2)


if __name__ == "__main__":
    unittest.main()