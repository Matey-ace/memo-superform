# -*- coding: utf-8 -*-
"""official_vocab_api 的契约测试（unittest，全部 mock，不连网）。

重点保护三条不能退让的行为：

1. **绝不按下标映射** —— 官方返回顺序不保证，也不保证全部命中。
2. **写请求超时不自动重试，标为 uncertain** —— 否则可能重复添加，且无法对账。
3. **不编造逐词成败** —— 上游只给 added_count。
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import official_vocab_api as api


class FakeTransport:
    """记录调用并按脚本返回。"""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, path, body):
        self.calls.append((path, dict(body)))
        if not self.responses:
            raise AssertionError("transport 被调用次数超出预期")
        item = self.responses.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


class QueryTests(unittest.TestCase):
    def test_shuffled_result_mapped_by_spelling_not_index(self):
        """官方返回乱序时必须按拼写匹配，不能按下标取。"""
        transport = FakeTransport({"status": 200, "body": {"voc": [
            {"id": "id-subtle", "spelling": "subtle"},
            {"id": "id-resilient", "spelling": "resilient"},
        ]}})
        result = api.query_vocabulary(transport=transport,
                                      spellings=["resilient", "subtle"])
        mapped = api.map_voc_ids(["resilient", "subtle"], result["voc"])
        self.assertEqual(mapped["matched"]["resilient"]["id"], "id-resilient")
        self.assertEqual(mapped["matched"]["subtle"]["id"], "id-subtle")

    def test_partial_miss_is_reported_not_fabricated(self):
        transport = FakeTransport({"status": 200, "body": {"voc": [
            {"id": "id-a", "spelling": "alpha"},
        ]}})
        result = api.query_vocabulary(transport=transport,
                                      spellings=["alpha", "beta"])
        mapped = api.map_voc_ids(["alpha", "beta"], result["voc"])
        self.assertEqual(mapped["requested"], 2)
        self.assertIn("beta", mapped["missing"])
        self.assertNotIn("beta", mapped["matched"])
        # 缺词绝不能凭空造出一个 id。
        self.assertEqual(mapped["matched"]["alpha"]["id"], "id-a")

    def test_case_insensitive_matching(self):
        mapped = api.map_voc_ids(["Resilient"], [{"id": "x", "spelling": "resilient"}])
        self.assertEqual(mapped["matched"]["resilient"]["id"], "x")
        self.assertEqual(mapped["missing"], [])

    def test_same_spelling_multiple_ids_is_ambiguous(self):
        """同一拼写返回多个 ID 时禁止任选一个。"""
        mapped = api.map_voc_ids(["lead"], [
            {"id": "id-lead-metal", "spelling": "lead"},
            {"id": "id-lead-verb", "spelling": "lead"},
        ])
        self.assertNotIn("lead", mapped["matched"])
        self.assertIn("lead", mapped["ambiguous"])
        self.assertEqual(len(mapped["ambiguous"]["lead"]), 2)

    def test_empty_voc_array(self):
        transport = FakeTransport({"status": 200, "body": {"voc": []}})
        result = api.query_vocabulary(transport=transport, spellings=["zzzz"])
        self.assertEqual(result["voc"], [])

    def test_extra_words_from_upstream_are_dropped(self):
        mapped = api.map_voc_ids(["alpha"], [
            {"id": "id-a", "spelling": "alpha"},
            {"id": "id-b", "spelling": "unrelated"},
        ])
        self.assertEqual(list(mapped["matched"]), ["alpha"])

    def test_spellings_and_ids_are_mutually_exclusive(self):
        transport = FakeTransport()
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.query_vocabulary(transport=transport, spellings=["a"], ids=["1"])
        self.assertEqual(ctx.exception.code, "invalid_request")
        self.assertEqual(transport.calls, [])

    def test_neither_given_is_rejected(self):
        with self.assertRaises(api.OfficialVocabError):
            api.query_vocabulary(transport=FakeTransport())

    def test_query_batch_limit_is_1000(self):
        self.assertEqual(api.QUERY_BATCH, 1000)
        with self.assertRaises(api.OfficialVocabError):
            api.query_vocabulary(transport=FakeTransport(),
                                 spellings=["w%d" % i for i in range(1001)])

    def test_missing_voc_array_is_an_error(self):
        transport = FakeTransport({"status": 200, "body": {"unexpected": 1}})
        with self.assertRaises(api.OfficialVocabError):
            api.query_vocabulary(transport=transport, spellings=["a"])


class ChunkTests(unittest.TestCase):
    def test_2500_splits_into_1000_1000_500(self):
        batches = api.chunk(["w%d" % i for i in range(2500)], api.QUERY_BATCH)
        self.assertEqual([len(b) for b in batches], [1000, 1000, 500])

    def test_chunk_dedupes_and_preserves_order(self):
        batches = api.chunk(["Beta", "alpha", "beta", "", "Gamma"], 1000)
        self.assertEqual(batches, [["Beta", "alpha", "Gamma"]])

    def test_add_batch_limit(self):
        self.assertEqual(api.ADD_BATCH, 1000)


class AddWordsTests(unittest.TestCase):
    def test_advance_defaults_to_false_and_is_sent(self):
        transport = FakeTransport({"status": 200, "body": {"added_count": 2}})
        api.add_words(["id-a", "id-b"], transport=transport)
        path, body = transport.calls[0]
        self.assertEqual(path, "study/add_words")
        self.assertIs(body["advance"], False)
        self.assertEqual(body["words"], [{"id": "id-a"}, {"id": "id-b"}])

    def test_advance_true_is_rejected_not_silently_ignored(self):
        transport = FakeTransport()
        with self.assertRaises(api.OfficialVocabError):
            api.add_words(["id-a"], transport=transport, advance=True)
        self.assertEqual(transport.calls, [])

    def test_zero_added_count(self):
        transport = FakeTransport({"status": 200, "body": {"added_count": 0}})
        result = api.add_words(["id-a", "id-b"], transport=transport)
        self.assertEqual(result["added_count"], 0)
        self.assertEqual(result["submitted"], 2)

    def test_partial_and_full_are_reported_without_per_word_status(self):
        for added in (1, 2):
            transport = FakeTransport({"status": 200, "body": {"added_count": added}})
            result = api.add_words(["id-a", "id-b"], transport=transport)
            self.assertEqual(result["added_count"], added)
            # 关键断言：绝不产生逐词成功/失败状态。
            self.assertNotIn("results", result)
            self.assertNotIn("words", result)
            for key in result:
                self.assertNotIn("success", key.lower())

    def test_empty_ids_rejected_before_network(self):
        transport = FakeTransport()
        with self.assertRaises(api.OfficialVocabError):
            api.add_words([], transport=transport)
        self.assertEqual(transport.calls, [])

    def test_missing_added_count_is_uncertain(self):
        transport = FakeTransport({"status": 200, "body": {}})
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.add_words(["id-a"], transport=transport)
        self.assertTrue(ctx.exception.uncertain)


class ErrorMappingTests(unittest.TestCase):
    def test_401_unauthorized(self):
        transport = FakeTransport({"status": 401, "body": {"error": "bad token"}})
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.query_vocabulary(transport=transport, spellings=["a"])
        self.assertEqual(ctx.exception.code, "unauthorized")
        self.assertFalse(ctx.exception.retryable)

    def test_403_forbidden(self):
        transport = FakeTransport({"status": 403, "body": {"error": "no scope"}})
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.query_vocabulary(transport=transport, spellings=["a"])
        self.assertEqual(ctx.exception.code, "forbidden")
        self.assertFalse(ctx.exception.retryable)

    def test_429_rate_limited_read_is_retryable(self):
        transport = FakeTransport({"status": 429, "body": {"retry_after": 2}})
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.query_vocabulary(transport=transport, spellings=["a"])
        self.assertEqual(ctx.exception.code, "rate_limited")
        self.assertTrue(ctx.exception.retryable)
        self.assertEqual(ctx.exception.retry_after, 2.0)

    def test_read_timeout_is_retryable_and_not_uncertain(self):
        transport = FakeTransport(TimeoutError("read timed out"))
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.query_vocabulary(transport=transport, spellings=["a"])
        self.assertTrue(ctx.exception.retryable)
        self.assertFalse(ctx.exception.uncertain)

    def test_write_timeout_is_uncertain_and_not_retryable(self):
        """写请求超时可能已送达：必须标 uncertain 且不可自动重试。"""
        transport = FakeTransport(TimeoutError("write timed out"))
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.add_words(["id-a"], transport=transport)
        self.assertTrue(ctx.exception.uncertain)
        self.assertFalse(ctx.exception.retryable)
        self.assertEqual(ctx.exception.code, "uncertain")

    def test_write_5xx_is_uncertain(self):
        transport = FakeTransport({"status": 500, "body": {}})
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.add_words(["id-a"], transport=transport)
        self.assertTrue(ctx.exception.uncertain)
        self.assertFalse(ctx.exception.retryable)

    def test_error_dict_exposes_actionable_fields(self):
        err = api.OfficialVocabError("x", code="uncertain", uncertain=True)
        data = err.as_dict()
        for key in ("error", "code", "retryable", "uncertain", "status"):
            self.assertIn(key, data)


if __name__ == "__main__":
    unittest.main()