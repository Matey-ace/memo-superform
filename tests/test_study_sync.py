#!/usr/bin/env python3
"""Pure-Python regression tests for study_sync (no HTTP or database needed)."""

from __future__ import annotations

import pathlib
import sys
import threading
import unittest
from datetime import datetime, timedelta, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from study_sync import (  # noqa: E402
    HTTPResponse,
    MaimemoStudyClient,
    ProfileRateLimiter,
    StudySyncService,
    SyncManager,
    beijing_today,
    normalise_record,
    record_fingerprint,
    token_profile_id,
)


NOW = datetime(2026, 8, 26, 2, 0, tzinfo=timezone.utc)  # 10:00 Beijing


def record(voc_id, next_date="2026-08-26T00:00:00+08:00", *, count=1, response="FAMILIAR"):
    return {
        "voc_id": voc_id,
        "voc_spelling": "word-" + voc_id,
        "add_date": "2021-03-04T00:00:00+08:00",
        "first_study_date": "2021-03-05T00:00:00+08:00",
        "last_study_date": "2026-08-25T00:00:00+08:00",
        "next_study_date": next_date,
        "last_response": response,
        "study_count": count,
        "tags": "",
    }


def today_item(voc_id, *, order=1, is_new=False, is_finished=False, first_response="FAMILIAR"):
    return {
        "voc_id": voc_id,
        "voc_spelling": "word-" + voc_id,
        "order": order,
        "first_response": first_response,
        "is_new": is_new,
        "is_finished": is_finished,
    }


class FakeTransport:
    def __init__(self, handler):
        self.handler = handler
        self.calls = []
        self.urls = []

    def post_json(self, url, payload, headers, timeout):
        self.urls.append(url)
        self.calls.append(dict(payload))
        return self.handler(payload, len(self.calls))


class FakeRepository:
    def __init__(self):
        self.states = {}
        self.records = {}
        self.due_ids = []
        self.intervals = []
        self.runs = []
        self.business_write_batches = 0
        self.needs_reconcile_reasons = []
        self.seen = []
        self.disabled_count = 0
        self.today_items = {}
        self.today_item_write_batches = 0

    def ensure_sync_profile(self, profile_id):
        self.states.setdefault(profile_id, {})
        self.records.setdefault(profile_id, {})

    def get_sync_state(self, profile_id):
        return dict(self.states.get(profile_id, {}))

    def set_sync_state(self, profile_id, **values):
        self.ensure_sync_profile(profile_id)
        self.states[profile_id].update(values)

    def get_study_record_hashes(self, profile_id, voc_ids):
        return {
            voc_id: self.records.get(profile_id, {}).get(voc_id, {}).get("content_hash")
            for voc_id in voc_ids
            if voc_id in self.records.get(profile_id, {})
        }

    def get_today_item_hashes(self, profile_id, item_date, voc_ids):
        values = self.today_items.get((profile_id, item_date.isoformat()), {})
        return {voc_id: values[voc_id]["content_hash"] for voc_id in voc_ids if voc_id in values}

    def upsert_today_items(self, profile_id, item_date, items):
        key = (profile_id, item_date.isoformat())
        values = self.today_items.setdefault(key, {})
        added = updated = unchanged = 0
        for item in items:
            previous = values.get(item["voc_id"])
            if previous is None:
                added += 1
            elif previous["content_hash"] != item["content_hash"]:
                updated += 1
            else:
                unchanged += 1
            values[item["voc_id"]] = dict(item)
        if added or updated:
            self.today_item_write_batches += 1
        return {"added": added, "updated": updated, "unchanged": unchanged}

    def get_due_candidate_voc_ids(self, profile_id, start_date, end_date):
        return list(self.due_ids)

    def upsert_study_records(self, profile_id, records):
        self.ensure_sync_profile(profile_id)
        added = updated = unchanged = 0
        for raw in records:
            item = normalise_record(raw)
            previous = self.records[profile_id].get(item["voc_id"])
            if previous is None:
                added += 1
                self.records[profile_id][item["voc_id"]] = item
            elif previous["content_hash"] == item["content_hash"]:
                unchanged += 1
            else:
                updated += 1
                self.records[profile_id][item["voc_id"]] = item
        if added or updated:
            self.business_write_batches += 1
        return {"added": added, "updated": updated, "unchanged": unchanged}

    def is_sync_interval_complete(self, profile_id, start_date, end_date):
        return False

    def record_sync_interval(self, profile_id, start_date, end_date, *, complete, source):
        self.intervals.append((start_date, end_date, complete, source))

    def begin_sync_run(self, profile_id, mode, reason):
        run_id = "%s-%d" % (mode, len(self.runs))
        self.runs.append([run_id, mode, reason, None])
        return run_id

    def finish_sync_run(self, run_id, status, details):
        for run in self.runs:
            if run[0] == run_id:
                run[3] = (status, dict(details))

    def mark_needs_reconcile(self, profile_id, reason):
        self.ensure_sync_profile(profile_id)
        self.states[profile_id]["needs_reconcile"] = True
        self.needs_reconcile_reasons.append(reason)

    def mark_reconcile_seen(self, profile_id, voc_ids):
        self.seen.append((profile_id, tuple(voc_ids)))

    def mark_absent_after_two_reconciles(self, profile_id):
        return self.disabled_count


def direct_client(handler):
    return MaimemoStudyClient(FakeTransport(handler), max_retries=1, random_fn=lambda: 0.0)


class StudySyncTests(unittest.TestCase):
    def test_profile_rate_limiter_isolated_by_stable_profile_key(self):
        limiter = ProfileRateLimiter()
        limiter.acquire(threading.Event(), "a" * 64)
        limiter.acquire(threading.Event(), "b" * 64)
        self.assertEqual({"a" * 64, "b" * 64}, set(limiter._limiters))
        self.assertEqual(1, len(limiter._limiters["a" * 64]._timestamps))
        self.assertEqual(1, len(limiter._limiters["b" * 64]._timestamps))

    def service(self, repo, handler, *, start=None, end=None):
        return StudySyncService(
            repo,
            client=direct_client(handler),
            now=lambda: NOW,
            bootstrap_start=start or beijing_today(NOW),
            bootstrap_end=end or beijing_today(NOW),
            today_probe_interval=timedelta(minutes=15),
        )

    def test_profile_and_content_hash_are_deterministic_and_token_safe(self):
        profile = token_profile_id(" secret-token ")
        self.assertEqual(64, len(profile))
        self.assertNotIn("secret-token", profile)
        a = record("a")
        b = dict(a, study_count=2)
        self.assertEqual(record_fingerprint(a), record_fingerprint(dict(a)))
        self.assertNotEqual(record_fingerprint(a), record_fingerprint(b))

    def test_bootstrap_persists_current_state_and_interval_without_offset(self):
        repo = FakeRepository()

        def handler(payload, _call):
            if payload.get("as_count"):
                return HTTPResponse(200, body={"data": {"count": 2, "records": []}})
            self.assertNotIn("offset", payload)
            return HTTPResponse(200, body={"data": {"records": [record("a"), record("b")]}})

        result = self.service(repo, handler).run("token", "bootstrap")
        self.assertEqual("completed", result["status"])
        self.assertEqual(2, result["added"])
        self.assertTrue(result["progress"]["total"] == 2)
        self.assertEqual(2, len(repo.records[result["profile_id"]]))
        self.assertTrue(repo.states[result["profile_id"]]["bootstrap_complete"])
        self.assertEqual(1, len(repo.intervals))

    def test_trusted_seed_with_matching_count_becomes_baseline_without_historical_range_requests(self):
        repo = FakeRepository()
        transport = FakeTransport(lambda payload, _number: HTTPResponse(200, body={"data": {"count": 2, "records": []}}))
        service = StudySyncService(repo, client=MaimemoStudyClient(transport, max_retries=0), now=lambda: NOW)
        result = service.run("token", "bootstrap", seed_records=[record("cached-a"), record("cached-b")])
        self.assertEqual("completed", result["status"])
        self.assertEqual(1, len(transport.calls))
        self.assertEqual({"as_count": True}, transport.calls[0])
        self.assertEqual(0, len(repo.intervals))
        self.assertEqual("browser_seed", repo.states[result["profile_id"]]["bootstrap_source"])
        self.assertEqual(2, len(repo.records[result["profile_id"]]))

    def test_invalid_seed_is_not_a_baseline_and_falls_back_to_verified_range_bootstrap(self):
        repo = FakeRepository()
        invalid = record("cached")
        invalid.pop("tags")

        def handler(payload, _number):
            if payload.get("as_count"):
                return HTTPResponse(200, body={"data": {"count": 1, "records": []}})
            self.assertIn("next_study_date", payload)
            return HTTPResponse(200, body={"data": {"records": [record("remote")]}})

        result = self.service(repo, handler).run("token", "bootstrap", seed_records=[invalid])
        self.assertEqual("completed", result["status"])
        self.assertNotIn("bootstrap_source", repo.states[result["profile_id"]])
        self.assertEqual(["remote"], list(repo.records[result["profile_id"]]))

    def test_same_day_unchanged_auto_refresh_only_makes_a_count_request_and_zero_business_writes(self):
        repo = FakeRepository()
        profile = token_profile_id("token")
        repo.ensure_sync_profile(profile)
        repo.upsert_study_records(profile, [record("a")])
        repo.business_write_batches = 0
        repo.set_sync_state(
            profile,
            bootstrap_complete=True,
            last_remote_count=1,
            last_incremental_date=beijing_today(NOW).isoformat(),
            last_today_probe_at=NOW.isoformat(),
        )
        transport = FakeTransport(lambda payload, _: HTTPResponse(200, body={"data": {"count": 1, "records": []}}))
        service = StudySyncService(repo, client=MaimemoStudyClient(transport, max_retries=0), now=lambda: NOW)
        result = service.run("token", "incremental", reason="auto")
        self.assertEqual("completed", result["status"])
        self.assertEqual(1, len(transport.calls))
        self.assertEqual({"as_count": True}, transport.calls[0])
        self.assertEqual(0, repo.business_write_batches)
        self.assertEqual(0, result["changed"])

    def test_count_growth_scans_only_active_window_and_marks_unlocated_growth(self):
        repo = FakeRepository()
        profile = token_profile_id("token")
        repo.ensure_sync_profile(profile)
        repo.upsert_study_records(profile, [record("a")])
        repo.set_sync_state(profile, bootstrap_complete=True, last_remote_count=3,
                            last_incremental_date="2026-08-25", last_today_probe_at=NOW.isoformat())

        def handler(payload, _call):
            if payload.get("as_count"):
                return HTTPResponse(200, body={"data": {"count": 5, "records": []}})
            self.assertIn("next_study_date", payload)
            return HTTPResponse(200, body={"data": {"records": [record("new-1")]}})

        result = self.service(repo, handler).run("token", "incremental", reason="auto")
        self.assertEqual("completed", result["status"])
        self.assertEqual(1, result["added"])
        self.assertTrue(result["needs_reconcile"])
        self.assertTrue(repo.needs_reconcile_reasons)
        self.assertNotIn("offset", str(self.service(repo, handler)))

    def test_due_candidates_are_refreshed_by_voc_id_and_can_update_old_word_without_history_range(self):
        repo = FakeRepository()
        profile = token_profile_id("token")
        repo.ensure_sync_profile(profile)
        repo.upsert_study_records(profile, [record("old", "2021-01-01T00:00:00+08:00", count=1)])
        repo.due_ids = ["old"]
        repo.set_sync_state(profile, bootstrap_complete=True, last_remote_count=1,
                            last_incremental_date="2026-08-25", last_today_probe_at=NOW.isoformat())

        changed = record("old", "2026-09-26T00:00:00+08:00", count=2)

        def handler(payload, _call):
            if payload.get("as_count"):
                return HTTPResponse(200, body={"data": {"count": 1, "records": []}})
            self.assertEqual(["old"], payload.get("voc_ids"))
            return HTTPResponse(200, body={"data": {"records": [changed]}})

        result = self.service(repo, handler).run("token", "incremental", reason="auto")
        self.assertEqual("completed", result["status"])
        self.assertEqual(1, result["updated"])
        self.assertEqual(2, repo.records[profile]["old"]["study_count"])

    def test_today_items_only_queries_changed_ids_and_never_uses_today_date_range(self):
        repo = FakeRepository()
        profile = token_profile_id("token")
        repo.ensure_sync_profile(profile)
        repo.upsert_study_records(profile, [record("today", count=1)])
        repo.set_sync_state(profile, bootstrap_complete=True, last_remote_count=1,
                            last_incremental_date="2026-08-25", last_today_probe_at="2026-08-25T02:00:00+00:00")
        transport = FakeTransport(lambda payload, _number: HTTPResponse(200, body={"data": {}}))

        def handler(payload, _number):
            endpoint = transport.urls[-1]
            if payload.get("as_count"):
                return HTTPResponse(200, body={"data": {"count": 1, "records": []}})
            if endpoint.endswith("/get_today_items"):
                return HTTPResponse(200, body={"data": {"today_items": [today_item("today", is_finished=True)]}})
            self.assertEqual(["today"], payload.get("voc_ids"))
            self.assertNotIn("next_study_date", payload)
            return HTTPResponse(200, body={"data": {"records": [record("today", count=2)]}})

        transport.handler = handler
        service = StudySyncService(repo, client=MaimemoStudyClient(transport, max_retries=0), now=lambda: NOW)
        result = service.run("token", "incremental", reason="auto")
        self.assertEqual("completed", result["status"])
        self.assertEqual(1, result["updated"])
        self.assertEqual(3, len(transport.calls))
        self.assertTrue(any(url.endswith("/get_today_items") for url in transport.urls))
        self.assertFalse(any("next_study_date" in payload for payload in transport.calls))

    def test_today_items_failure_keeps_old_records_and_does_not_fallback_to_date_range(self):
        repo = FakeRepository()
        profile = token_profile_id("token")
        repo.ensure_sync_profile(profile)
        repo.upsert_study_records(profile, [record("keep", count=1)])
        repo.set_sync_state(profile, bootstrap_complete=True, last_remote_count=1,
                            last_incremental_date="2026-08-25", last_today_probe_at="2026-08-25T02:00:00+00:00")
        transport = FakeTransport(lambda payload, _number: HTTPResponse(200, body={"data": {}}))

        def handler(payload, _number):
            if payload.get("as_count"):
                return HTTPResponse(200, body={"data": {"count": 1, "records": []}})
            self.assertTrue(transport.urls[-1].endswith("/get_today_items"))
            return HTTPResponse(503, body={"error": "upstream unavailable"})

        transport.handler = handler
        service = StudySyncService(repo, client=MaimemoStudyClient(transport, max_retries=0), now=lambda: NOW)
        result = service.run("token", "incremental", reason="auto")
        self.assertEqual("failed", result["status"])
        self.assertTrue(result["needs_reconcile"])
        self.assertEqual(1, repo.records[profile]["keep"]["study_count"])
        self.assertFalse(any("next_study_date" in payload for payload in transport.calls))

    def test_single_day_at_limit_fails_closed_and_requests_reconciliation(self):
        repo = FakeRepository()
        items = [record("id-%d" % value) for value in range(1000)]

        def handler(payload, _call):
            if payload.get("as_count"):
                return HTTPResponse(200, body={"data": {"count": 1000, "records": []}})
            return HTTPResponse(200, body={"data": {"records": items}})

        result = self.service(repo, handler).run("token", "bootstrap")
        self.assertEqual("failed", result["status"])
        self.assertTrue(result["needs_reconcile"])
        self.assertEqual(0, len(repo.records[result["profile_id"]]))
        self.assertFalse(repo.intervals[-1][2])

    def test_429_honours_retry_and_then_succeeds(self):
        calls = []

        def handler(payload, number):
            calls.append(payload)
            if number == 1:
                return HTTPResponse(429, headers={"Retry-After": "0"}, body={"error": "busy"})
            return HTTPResponse(200, body={"data": {"count": 7, "records": []}})

        client = direct_client(handler)
        self.assertEqual(7, client.count("token", threading.Event()))
        self.assertEqual(2, len(calls))

    def test_cancelled_task_never_reports_success_and_marks_reconcile(self):
        repo = FakeRepository()
        service = self.service(repo, lambda p, n: HTTPResponse(200, body={"data": {"count": 0, "records": []}}))
        event = threading.Event()
        event.set()
        result = service.run("token", "incremental", cancel_event=event)
        self.assertEqual("cancelled", result["status"])
        self.assertTrue(result["needs_reconcile"])

    def test_weekly_gate_and_manager_reuses_one_active_task_per_profile(self):
        repo = FakeRepository()
        entered = threading.Event()
        release = threading.Event()

        def slow_handler(payload, _number):
            if payload.get("as_count"):
                entered.set()
                release.wait(1)
                return HTTPResponse(200, body={"data": {"count": 0, "records": []}})
            return HTTPResponse(200, body={"data": {"records": []}})

        service = self.service(repo, slow_handler)
        profile = token_profile_id("token")
        repo.ensure_sync_profile(profile)
        self.assertTrue(service.should_run_weekly_reconcile(profile))
        repo.set_sync_state(profile, last_reconcile_at=NOW.isoformat())
        self.assertFalse(service.should_run_weekly_reconcile(profile))
        manager = SyncManager(service)
        first = manager.start("token", "incremental", reason="auto")
        self.assertTrue(entered.wait(1))
        second = manager.start("token", "incremental", reason="auto")
        self.assertEqual(first["task_id"], second["task_id"])
        release.set()


if __name__ == "__main__":
    unittest.main(verbosity=2)
