# -*- coding: utf-8 -*-
"""HTTP 层验收：陪伴接口的路由、错误码与身份要求。

业务模块的单元测试已经覆盖判定逻辑；这里只验证**接缝**：
路由是否命中、错误是否映射成正确状态码、未登录是否被挡住。
"""
from __future__ import annotations

import io
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

import db
import study_sync
import app_api


class FakeHandler:
    """最小 Handler 替身：捕获发出的状态码与 JSON 正文。"""

    def __init__(self, path, *, body=None, headers=None, query=""):
        self.path = path
        self._body = body
        self.headers = headers or {}
        self.status = None
        self.payload = None
        self._query = query

    # --- 被 app_api 依赖的接口 ---
    def _send_json(self, status, payload):
        self.status = status
        self.payload = payload
        return None

    def _read_json_body(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body

    def send_error(self, status, message=""):
        self.status = status
        self.payload = {"error": message}


def make_handler(path, *, body=None, headers=None):
    """把 ``LocalApiMixin`` 的方法绑定到一个最小 handler 替身上。

    ``app_api`` 是 mixin 而不是完整 Handler，因此这里直接绑定需要的方法，
    既不启动真实服务器，也不复制业务逻辑。
    """
    from urllib.parse import urlparse
    parsed = urlparse(path)
    handler = FakeHandler(path, body=body, headers=headers, query=parsed.query)
    mixin = app_api.LocalApiMixin
    for name in ("_companion_get", "_companion_post", "_companion_context",
                 "_companion_error", "_companion_epoch_guard", "_send_json",
                 "send_error", "_memo_identity", "_read_json_body", "_role_package_post"):
        if hasattr(mixin, name):
            setattr(handler, name, getattr(mixin, name).__get__(handler))
    return handler, parsed


class Base(unittest.TestCase):
    def setUp(self):
        # 父目录必须自己建：它可能被上一次清理删掉，不能让 mkdtemp 依赖它存在。
        os.makedirs(r"D:\MeMo1\_verification\companion-upgrade\agents\M", exist_ok=True)
        self.tmp = tempfile.mkdtemp(dir=r"D:\MeMo1\_verification\companion-upgrade\agents\M")
        self.addCleanup(self._cleanup)
        db.init_db(self.tmp)
        # 生产环境由 server.py 通过 configure_local_api 注入 DB_READY；
        # 测试必须复现这一注入，否则会在 _companion_context 里读到未定义名。
        app_api.configure_local_api(DB_READY=True)
        self.addCleanup(app_api.configure_local_api, DB_READY=False)
        self.token = "test-token"
        self.account = study_sync.token_profile_id(self.token)
        self.pk = db.ensure_sync_profile(self.account)
        self.epoch = db.companion_account_state(self.pk)["data_epoch"]

    def _cleanup(self):
        db.close_warm()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def headers(self):
        return {"Authorization": "Bearer " + self.token}

    def get(self, path):
        handler, parsed = make_handler(path, headers=self.headers())
        result = handler._companion_get(parsed.path, parsed)
        return handler, result


class IdentityTests(Base):
    def test_missing_token_is_rejected(self):
        handler, parsed = make_handler("/api/companion/memory/settings")
        handler._companion_get(parsed.path, parsed)
        self.assertEqual(handler.status, 401)

    def test_bad_token_is_rejected(self):
        handler, parsed = make_handler("/api/companion/memory/settings",
                                       headers={"Authorization": "Bearer "})
        handler._companion_get(parsed.path, parsed)
        self.assertEqual(handler.status, 401)


class GetRouteTests(Base):
    def test_memory_settings(self):
        handler, result = self.get("/api/companion/memory/settings")
        self.assertIsNone(result)
        self.assertEqual(handler.status, 200)
        self.assertIn("use_enabled", handler.payload)
        self.assertIn("outbound_enabled", handler.payload)

    def test_memory_context_hidden_until_outbound_enabled(self):
        import companion_memory
        companion_memory.ensure_settings(self.pk)
        handler, _ = self.get("/api/companion/memory/context")
        self.assertEqual(handler.status, 200)
        self.assertFalse(handler.payload["available"],
                         "出站默认关闭时不得下发可发送的上下文")

    def test_memory_list(self):
        import companion_memory
        companion_memory.ensure_settings(self.pk)
        handler, _ = self.get("/api/companion/memories")
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.payload["items"], [])

    def test_unknown_session_returns_unavailable(self):
        handler, _ = self.get("/api/companion/sessions/ses-nope")
        self.assertEqual(handler.status, 200)
        self.assertFalse(handler.payload["available"])

    def test_unknown_subroute_is_404(self):
        handler, _ = self.get("/api/companion/sessions/ses-x/weird")
        self.assertEqual(handler.status, 404)

    def test_package_registry(self):
        handler, _ = self.get("/api/role-packages/registry")
        self.assertEqual(handler.status, 200)
        self.assertIn("roles", handler.payload)

    def test_job_list(self):
        handler, _ = self.get("/api/role-packages/jobs")
        self.assertEqual(handler.status, 200)
        self.assertIn("items", handler.payload)

    def test_unrelated_path_not_handled(self):
        handler, parsed = make_handler("/api/records", headers=self.headers())
        self.assertIsNone(handler._companion_get(parsed.path, parsed))


class PostRouteTests(Base):
    def post(self, path, body):
        handler, parsed = make_handler(path, body=body, headers=self.headers())
        handler._companion_post(parsed.path, parsed)
        return handler

    def open_session(self):
        handler = self.post("/api/companion/sessions", {
            "study_day": "2026-11-16",
            "task_key": "study-day:2026-11-16:role-a",
            "goal_kind": "session_goal",
            "target_count": 5,
            "role_id": "role-a",
        })
        return handler

    def test_open_session_succeeds(self):
        handler = self.open_session()
        self.assertEqual(handler.status, 200, handler.payload)
        self.assertIn("session_id", handler.payload)
        self.assertTrue(handler.payload["progress"]["known"])

    def test_open_session_rejects_zero_target(self):
        handler = self.post("/api/companion/sessions", {
            "study_day": "2026-11-16", "task_key": "k",
            "goal_kind": "session_goal", "target_count": 0, "role_id": "role-a",
        })
        self.assertEqual(handler.status, 400)
        self.assertEqual(handler.payload["code"], "invalid")

    def test_settlement_before_completion_is_unavailable(self):
        handler = self.open_session()
        session_id = handler.payload["session_id"]
        handler, _ = self.get("/api/companion/sessions/%s/settlement" % session_id)
        self.assertEqual(handler.status, 200)
        self.assertFalse(handler.payload["available"])

    def test_abandon_then_pause_conflicts(self):
        handler = self.open_session()
        session_id = handler.payload["session_id"]
        revision = handler.payload["revision"]
        abandoned = self.post("/api/companion/sessions/%s/state" % session_id,
                              {"action": "abandon", "expected_revision": revision})
        self.assertEqual(abandoned.status, 200)
        again = self.post("/api/companion/sessions/%s/state" % session_id,
                          {"action": "pause"})
        self.assertEqual(again.status, 409)
        self.assertTrue(again.payload["retryable"])

    def test_stale_revision_conflicts(self):
        handler = self.open_session()
        session_id = handler.payload["session_id"]
        first = self.post("/api/companion/sessions/%s/state" % session_id,
                          {"action": "pause", "expected_revision": handler.payload["revision"]})
        self.assertEqual(first.status, 200)
        stale = self.post("/api/companion/sessions/%s/state" % session_id,
                          {"action": "resume",
                           "expected_revision": handler.payload["revision"]})
        self.assertEqual(stale.status, 409)

    def test_events_accepted(self):
        handler = self.open_session()
        session_id = handler.payload["session_id"]
        result = self.post("/api/companion/sessions/%s/events" % session_id, {
            "events": [{"event_id": "e1", "type": "answer",
                        "source": "observed_ack", "item_key": "w1"}]
        })
        self.assertEqual(result.status, 200, result.payload)
        self.assertEqual(result.payload["accepted"], 1)

    def test_complete_without_evidence_is_rejected(self):
        handler = self.open_session()
        session_id = handler.payload["session_id"]
        result = self.post("/api/companion/sessions/%s/complete" % session_id, {})
        self.assertEqual(result.status, 400)
        self.assertIn("error", result.payload)

    def test_heartbeat_returns_active_seconds(self):
        handler = self.open_session()
        session_id = handler.payload["session_id"]
        result = self.post("/api/companion/sessions/%s/heartbeat" % session_id,
                           {"instance_id": "win-a"})
        self.assertEqual(result.status, 200, result.payload)
        self.assertIn("active_seconds", result.payload)

    def test_memory_settings_update(self):
        result = self.post("/api/companion/memory/settings", {"outbound_enabled": True})
        self.assertEqual(result.status, 200, result.payload)
        self.assertTrue(result.payload["outbound_enabled"])

    def test_memory_clear_requires_explicit_scope(self):
        # 不猜范围：静默默认清空会让用户丢数据。
        result = self.post("/api/companion/memory/clear", {})
        self.assertEqual(result.status, 400)
        self.assertEqual(result.payload["code"], "invalid")

    def test_memory_clear_account_requires_confirm(self):
        result = self.post("/api/companion/memory/clear", {"scope": "account"})
        self.assertEqual(result.status, 400)
        self.assertEqual(result.payload["code"], "confirm_required")
        confirmed = self.post("/api/companion/memory/clear",
                             {"scope": "account", "confirm": True})
        self.assertEqual(confirmed.status, 200, confirmed.payload)

    def test_memory_clear_role(self):
        result = self.post("/api/companion/memory/clear",
                           {"scope": "role", "role_id": "role-a"})
        self.assertEqual(result.status, 200, result.payload)

    def test_browser_upload_is_refused(self):
        result = self.post("/api/role-packages/uploads", {})
        # 浏览器受限上传在本版本不提供：必须明确拒绝而不是静默失败。
        self.assertIn(result.status, (400, 410, 501))

    def test_inspect_requires_source(self):
        result = self.post("/api/role-packages/inspect", {})
        self.assertEqual(result.status, 400)


class EpochBarrierTests(Base):
    def test_client_epoch_mismatch_returns_stale(self):
        """数据重置后旧会话查不到时，必须给出可区分的 409 而不是空结果。"""
        handler, parsed = make_handler("/api/companion/sessions",
                                       body={"study_day": "2026-11-16", "task_key": "k",
                                             "goal_kind": "session_goal", "target_count": 3,
                                             "role_id": "role-a"},
                                       headers=self.headers())
        handler._companion_post(parsed.path, parsed)
        self.assertEqual(handler.status, 200)
        session_id = handler.payload["session_id"]

        db.companion_bump_data_epoch(self.pk)
        handler, _ = self.get("/api/companion/sessions/%s?data_epoch=%d"
                              % (session_id, self.epoch))
        self.assertEqual(handler.status, 409)
        self.assertEqual(handler.payload["code"], "stale")
        self.assertFalse(handler.payload["retryable"],
                         "数据重置后旧会话不可重试")

    def test_matching_epoch_is_accepted(self):
        handler, parsed = make_handler("/api/companion/sessions",
                                       body={"study_day": "2026-11-16", "task_key": "k",
                                             "goal_kind": "session_goal", "target_count": 3,
                                             "role_id": "role-a"},
                                       headers=self.headers())
        handler._companion_post(parsed.path, parsed)
        session_id = handler.payload["session_id"]
        handler, _ = self.get("/api/companion/sessions/%s?data_epoch=%d"
                              % (session_id, self.epoch))
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.payload["session_id"], session_id)


if __name__ == "__main__":
    unittest.main()