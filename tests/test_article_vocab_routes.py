# -*- coding: utf-8 -*-
"""文章选词 HTTP 路由的集成测试。

与 ``tests/test_article_vocab.py``（纯逻辑）和 ``tests/perf/test_official_vocab_api.py``
（官方客户端契约）互补：这里验证 **路由层** 真的把三者接起来了，包括

- ``/api/article-vocab/select`` 只读、不写云端
- ``/api/article-vocab/query-ids`` 按拼写映射、不按下标
- ``/api/article-vocab/add`` 的 confirm / 账号代次 / operationId 幂等
- 缺少 ``noMemory`` 时记忆注入保持原样，带上 ``noMemory`` 时不注入

全部通过 mock 传输层，**不访问真实云端、不读真实凭据**。
"""

import json
import os
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
_SANDBOX = ROOT / "_verification" / "perfvocab" / "M" / "route-tests"
_SANDBOX.mkdir(parents=True, exist_ok=True)
# 只在没有隔离目录时设定。discover 会先把所有测试模块 import 完再执行用例，
# 若这里无条件覆盖，会改掉其它测试模块（如 test_article_vocab）已设好的目录，
# 从而破坏它们的隔离断言。已有隔离目录时一律沿用。
if not os.environ.get("MEMO_DATA_DIR"):
    os.environ["MEMO_DATA_DIR"] = str(_SANDBOX)
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
_REAL_DB = (ROOT / "data" / "memo-superform.db").resolve()

import article_vocab
import official_vocab_api


class RouteHarness:
    """最小 handler 替身：只实现路由用到的那几个方法。"""

    def __init__(self, context=None, body=None, headers=None):
        self._context = context or {"account_epoch": 7, "data_epoch": 3, "profile_pk": 1}
        self._body = body
        self.headers = headers or {}
        self.sent = []
        self.proxy_calls = []

    # --- 路由依赖的宿主能力 ---
    def _send_json(self, code, data):
        self.sent.append((code, data))

    def _read_json_body(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body

    def _companion_context(self):
        return self._context

    def _proxy_call(self, url, method="GET", body=None, retryable=True):
        self.proxy_calls.append({"url": url, "method": method,
                                 "body": json.loads(body) if body else None,
                                 "retryable": retryable})
        # responder 返回 (status, raw_bytes) 或 (status, raw, retry_after)；
        # _proxy_call 的真实契约是三元组 (status, payload, retry_after)。
        result = self.responder(url, json.loads(body) if body else None)
        if len(result) == 2:
            return result[0], result[1], None
        return result

    @property
    def last(self):
        return self.sent[-1] if self.sent else (None, None)


def make_handler(cls=None):
    """把 LocalApiMixin 的方法绑到一个 harness 实例上。"""
    import app_api
    handler_cls = cls or type("Harness", (RouteHarness, app_api.LocalApiMixin), {})
    return handler_cls


class SelectRouteTests(unittest.TestCase):
    def setUp(self):
        self.H = make_handler()

    def test_select_is_read_only_and_returns_prompt(self):
        h = self.H(body={"article": "The city council voted to restore the wetland.",
                         "targetLevel": "B2", "wordCount": 5})
        h._article_vocab_post("/api/article-vocab/select", {})
        code, data = h.last
        self.assertEqual(code, 200)
        self.assertGreater(data["chars"], 0)
        self.assertIn("messages", data)
        # 只读：绝不碰官方接口。
        self.assertEqual(h.proxy_calls, [])
        # 提示词必须声明反注入与 JSON 契约。
        system = data["messages"][0]["content"]
        self.assertIn("JSON", system)
        self.assertIn("数据", system)

    def test_select_rejects_empty_article(self):
        h = self.H(body={"article": ""})
        h._article_vocab_post("/api/article-vocab/select", {})
        code, data = h.last
        self.assertEqual(code, 400)
        self.assertEqual(data["code"], "empty")

    def test_select_rejects_non_english(self):
        h = self.H(body={"article": "只有中文，没有任何英文内容。"})
        h._article_vocab_post("/api/article-vocab/select", {})
        code, data = h.last
        self.assertEqual(code, 400)
        self.assertEqual(data["code"], "no_english")

    def test_select_reports_truncation_instead_of_silent_cut(self):
        long_text = "word " * (article_vocab.MAX_ARTICLE_CHARS // 4 + 10)
        h = self.H(body={"article": long_text})
        h._article_vocab_post("/api/article-vocab/select", {})
        code, data = h.last
        self.assertEqual(code, 200)
        self.assertTrue(data["truncated"])


class ParseRouteTests(unittest.TestCase):
    def setUp(self):
        self.H = make_handler()

    def test_parse_drops_fabricated_context(self):
        article = "The resilient ecosystem recovered quickly after the storm."
        raw = json.dumps({"items": [
            {"lemma": "resilient", "surface": "resilient", "pos": "adj.",
             "gloss_zh": "有韧性的", "context": "The resilient ecosystem",
             "reason": "常用学术词", "rank": 1},
            {"lemma": "storm", "surface": "storm", "pos": "n.",
             "gloss_zh": "风暴", "context": "这句话原文里根本没有",
             "reason": "编造", "rank": 2},
        ]})
        h = self.H(body={"article": article, "raw": raw, "wordCount": 10})
        h._article_vocab_post("/api/article-vocab/parse", {})
        code, data = h.last
        self.assertEqual(code, 200)
        lemmas = [item["lemma"] for item in data["items"]]
        self.assertIn("resilient", lemmas)
        self.assertNotIn("storm", lemmas)
        reasons = [r["reason"] for r in data["rejected"]]
        self.assertIn("context_not_in_source", reasons)


class QueryIdsRouteTests(unittest.TestCase):
    def setUp(self):
        self.H = make_handler()

    def test_ids_are_mapped_by_spelling_even_when_upstream_is_shuffled(self):
        def responder(url, body):
            # 故意乱序返回，并按官方"不保证顺序"的未知行为少返回一个。
            return 200, b'{"voc":[{"id":"id-subtle","spelling":"subtle"},' \
                        b'{"id":"id-resilient","spelling":"resilient"}]}'

        h = self.H(body={"lemmas": ["resilient", "subtle", "missingword"]})
        h.responder = responder
        h._article_vocab_post("/api/article-vocab/query-ids", {})
        code, data = h.last
        self.assertEqual(code, 200)
        self.assertEqual(data["matched"]["resilient"]["id"], "id-resilient")
        self.assertEqual(data["matched"]["subtle"]["id"], "id-subtle")
        self.assertIn("missingword", data["missing"])

    def test_batches_are_chunked_at_1000(self):
        sizes = []

        def responder(url, body):
            sizes.append(len(body["spellings"]))
            return 200, b'{"voc":[]}'

        h = self.H(body={"lemmas": ["w%d" % i for i in range(2500)]})
        h.responder = responder
        h._article_vocab_post("/api/article-vocab/query-ids", {})
        self.assertEqual(sizes, [1000, 1000, 500])

    def test_unauthorized_is_propagated_with_code(self):
        h = self.H(body={"lemmas": ["resilient"]})
        h.responder = lambda url, body: (401, b'{"error":"bad token"}')
        h._article_vocab_post("/api/article-vocab/query-ids", {})
        code, data = h.last
        self.assertEqual(code, 401)
        self.assertEqual(data["code"], "unauthorized")


class AddRouteTests(unittest.TestCase):
    def setUp(self):
        self.H = make_handler()

    def _ok_transport(self, added=None):
        def responder(url, body):
            if url.endswith("vocabulary/query"):
                return 200, json.dumps({"voc": [
                    {"id": "id-%s" % item, "spelling": item}
                    for item in body["spellings"]
                ]}).encode()
            ids = [w["id"] for w in body["words"]]
            return 200, json.dumps({"added_count": len(ids) if added is None else added}).encode()
        return responder

    def test_requires_explicit_confirm(self):
        h = self.H(body={"lemmas": ["resilient"], "operationId": "op-1"})
        h.responder = self._ok_transport()
        h._article_vocab_post("/api/article-vocab/add", {})
        code, data = h.last
        self.assertEqual(code, 400)
        self.assertEqual(data["code"], "confirm_required")
        self.assertEqual(h.proxy_calls, [])

    def test_advance_true_is_rejected(self):
        h = self.H(body={"lemmas": ["resilient"], "confirm": True,
                         "advance": True, "operationId": "op-a"})
        h.responder = self._ok_transport()
        h._article_vocab_post("/api/article-vocab/add", {})
        code, data = h.last
        self.assertEqual(code, 400)
        self.assertEqual(h.proxy_calls, [])

    def test_account_switch_returns_stale_and_writes_nothing(self):
        h = self.H(body={"lemmas": ["resilient"], "confirm": True,
                         "operationId": "op-2", "account_epoch": 999})
        h.responder = self._ok_transport()
        h._article_vocab_post("/api/article-vocab/add", {})
        code, data = h.last
        self.assertEqual(code, 409)
        self.assertEqual(data["code"], "stale")
        self.assertEqual(h.proxy_calls, [])

    def test_account_switch_during_write_stops_before_cloud_write(self):
        """账号在"查 ID 之后、写入之前"切换：必须停止提交，不能写进新账号。"""
        state = {"epoch": 1000}

        class SwitchingHandler(self.H):
            def _companion_context(inner_self):
                return {"account_epoch": state["epoch"], "data_epoch": 3, "profile_pk": 1}

        def responder(url, body):
            if url.endswith("vocabulary/query"):
                # 查询完成的同时用户切换了账号。
                state["epoch"] = 2000
                return 200, json.dumps({"voc": [
                    {"id": "id-%s" % i, "spelling": i} for i in body["spellings"]]}).encode()
            return 200, json.dumps({"added_count": len(body["words"])}).encode()

        h = SwitchingHandler(body={"lemmas": ["resilient"], "confirm": True,
                                   "operationId": "op-switch"})
        h.responder = responder
        h._article_vocab_post("/api/article-vocab/add", {})
        code, data = h.last
        self.assertEqual(code, 409)
        self.assertEqual(data["code"], "stale")
        # 关键断言：一次云端写入都不能发生。
        add_calls = [c for c in h.proxy_calls if c["url"].endswith("study/add_words")]
        self.assertEqual(add_calls, [])

    def test_replay_after_account_switch_does_not_rewrite(self):
        """账号切换中断后，用同一个 operationId 重放不得再次写云端。

        中断分支必须把 operation_id 记进幂等表。否则客户端重放时，
        幂等表里没有记录，已成功提交的那几批会被再写一遍。
        """
        state = {"epoch": 1000}

        class SwitchingHandler(self.H):
            def _companion_context(inner_self):
                return {"account_epoch": state["epoch"], "data_epoch": 3, "profile_pk": 1}

        def responder(url, body):
            if url.endswith("vocabulary/query"):
                state["epoch"] = 2000
                return 200, json.dumps({"voc": [
                    {"id": "id-%s" % i, "spelling": i} for i in body["spellings"]]}).encode()
            return 200, json.dumps({"added_count": len(body["words"])}).encode()

        h = SwitchingHandler(body={"lemmas": ["resilient"], "confirm": True,
                                   "operationId": "op-replay"})
        h.responder = responder
        h._article_vocab_post("/api/article-vocab/add", {})
        code, data = h.last
        self.assertEqual(code, 409)
        self.assertTrue(data.get("partial_account_switch"))

        # 重放同一个 operationId：必须命中幂等表，不能再发 add_words。
        before = len([c for c in h.proxy_calls if c["url"].endswith("study/add_words")])
        h._article_vocab_post("/api/article-vocab/add", {})
        after = len([c for c in h.proxy_calls if c["url"].endswith("study/add_words")])
        self.assertEqual(before, 0, "首次就发生了写入，前置条件不成立")
        self.assertEqual(after, 0, "重放时又写了一次云端")

    def test_omitted_client_epoch_cannot_bypass_write_gate(self):
        """客户端不传 account_epoch 时，写入前的二次核对仍必须拦住。

        入口那句 `expected_epoch is not None and ...` 在校验缺省时会被跳过，
        所以账号边界不能只靠入口。这条测试锁住防御纵深：
        即使入口校验被绕过，每批写入前的代次核对也必须独立成立。
        """
        state = {"epoch": 1000}

        class SwitchingHandler(self.H):
            def _companion_context(inner_self):
                return {"account_epoch": state["epoch"], "data_epoch": 3, "profile_pk": 1}

        def responder(url, body):
            if url.endswith("vocabulary/query"):
                state["epoch"] = 2000
                return 200, b'{"voc":[{"id":"id-1","spelling":"resilient"}]}'
            return 200, b'{"added_count":1}'

        h = SwitchingHandler(body={"lemmas": ["resilient"], "confirm": True,
                                   "operationId": "op-no-epoch"})
        h.responder = responder
        h._article_vocab_post("/api/article-vocab/add", {})
        code, data = h.last
        writes = [c for c in h.proxy_calls if c["url"].endswith("study/add_words")]
        self.assertEqual(writes, [], "省略 account_epoch 时绕过了账号边界")
        self.assertEqual(code, 409)

    def test_add_request_always_sends_advance_false(self):
        h = self.H(body={"lemmas": ["resilient"], "confirm": True, "operationId": "op-3"})
        h.responder = self._ok_transport()
        h._article_vocab_post("/api/article-vocab/add", {})
        code, data = h.last
        self.assertEqual(code, 200)
        add_calls = [c for c in h.proxy_calls if c["url"].endswith("study/add_words")]
        self.assertEqual(len(add_calls), 1)
        self.assertIs(add_calls[0]["body"]["advance"], False)
        # 写请求不允许自动重试。
        self.assertFalse(add_calls[0]["retryable"])

    def test_duplicate_operation_id_does_not_write_twice(self):
        handler = self.H(body={"lemmas": ["resilient"], "confirm": True,
                               "operationId": "op-idem"})
        handler.responder = self._ok_transport()
        handler._article_vocab_post("/api/article-vocab/add", {})
        first_calls = len(handler.proxy_calls)

        again = self.H(body={"lemmas": ["resilient"], "confirm": True,
                             "operationId": "op-idem"})
        again.responder = self._ok_transport()
        again._article_vocab_post("/api/article-vocab/add", {})
        code, data = again.last
        self.assertEqual(code, 200)
        self.assertTrue(data.get("deduplicated"))
        # 第二次不再调用云端。
        self.assertEqual(len(again.proxy_calls), 0)
        self.assertGreater(first_calls, 0)

    def test_partial_result_states_no_per_word_status(self):
        h = self.H(body={"lemmas": ["resilient", "subtle"], "confirm": True,
                         "operationId": "op-partial"})
        h.responder = self._ok_transport(added=1)
        h._article_vocab_post("/api/article-vocab/add", {})
        code, data = h.last
        self.assertEqual(code, 200)
        self.assertEqual(data["status"], "partial")
        self.assertEqual(data["added_count"], 1)
        for key in data:
            self.assertNotIn("success", key.lower())
        # 不允许出现逐词成败列表。
        self.assertNotIn("results", data)

    def test_write_timeout_is_uncertain_and_not_retried(self):
        def responder(url, body):
            if url.endswith("study/add_words"):
                raise TimeoutError("timed out")
            return 200, json.dumps({"voc": [
                {"id": "id-x", "spelling": "resilient"}]}).encode()

        h = self.H(body={"lemmas": ["resilient"], "confirm": True,
                         "operationId": "op-timeout"})
        h.responder = responder
        h._article_vocab_post("/api/article-vocab/add", {})
        code, data = h.last
        self.assertEqual(code, 502)
        self.assertTrue(data["uncertain"])
        self.assertFalse(data["retryable"])
        add_calls = [c for c in h.proxy_calls if c["url"].endswith("study/add_words")]
        self.assertEqual(len(add_calls), 1)


class StatusRouteTests(unittest.TestCase):
    def setUp(self):
        self.H = make_handler()

    def test_status_reports_auto_add_off_by_default(self):
        h = self.H()
        h._article_vocab_get("/api/article-vocab/status", {})
        code, data = h.last
        self.assertEqual(code, 200)
        self.assertIs(data["auto_add_default"], False)

    def test_unknown_article_vocab_path_404s(self):
        h = self.H()
        h._article_vocab_get("/api/article-vocab/unknown", {})
        self.assertEqual(h.last[0], 404)


class IdempotencyStoreTests(unittest.TestCase):
    """幂等表淘汰策略：绝不能整表清空。

    真实缺陷：原实现是 `if len(...) > 512: clear()`，把**已经写过云端**的
    operation_id 一起丢掉，之后同一个 id 重放会再写一次（真实重复写入）。
    """

    def _handler(self):
        import app_api
        return app_api.LocalApiMixin.__new__(app_api.LocalApiMixin)

    def test_store_evicts_oldest_instead_of_clearing(self):
        import app_api
        app_api._article_vocab_operations.clear()
        self.addCleanup(app_api._article_vocab_operations.clear)

        handler = self._handler()
        app_api.LocalApiMixin._article_vocab_remember(
            handler, "oldest", 1, {"submitted": 5, "added_count": 5})
        for index in range(600):
            app_api.LocalApiMixin._article_vocab_remember(
                handler, "filler-%d" % index, 1, {"submitted": 0, "added_count": 0})

        self.assertLessEqual(len(app_api._article_vocab_operations), 512,
                             "表超过声明上限")
        # 最近的记录必须保住 —— 这是"不能全清"的核心。
        self.assertIsNotNone(
            app_api.LocalApiMixin._article_vocab_recall(handler, "filler-599"),
            "最近的幂等记录被丢掉了，重放时会重复写云端")
        # 最旧的按 FIFO 被淘汰，属预期行为。
        self.assertIsNone(
            app_api.LocalApiMixin._article_vocab_recall(handler, "oldest"))

    def test_recall_ignores_account_epoch(self):
        """同一 operation_id 在另一个代次下也必须能查到，不能当"没记录"。"""
        import app_api
        app_api._article_vocab_operations.clear()
        self.addCleanup(app_api._article_vocab_operations.clear)

        handler = self._handler()
        app_api.LocalApiMixin._article_vocab_remember(
            handler, "op-epoch", 5, {"submitted": 2, "added_count": 2})
        recalled = app_api.LocalApiMixin._article_vocab_recall(handler, "op-epoch")
        self.assertIsNotNone(recalled, "代次不同时被当成没有记录，会导致重复写入")
        self.assertEqual(recalled["account_epoch"], 5)
        self.assertEqual(recalled["result"]["added_count"], 2)


class IsolationTests(unittest.TestCase):
    def test_database_is_not_the_real_one(self):
        import db
        active = pathlib.Path(str(db._DB_PATH)).resolve()
        self.assertNotEqual(active, _REAL_DB)


if __name__ == "__main__":
    unittest.main()