#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""契约测试：墨墨官方批量查词 / 添加单词（E 子智能体）。

被测模块是仓库里**实际存在**的 `official_vocab_api`（真实接口，非假设）。
全部 HTTP 由注入的 fake transport 替代：**不联网、不读真实凭据、不写真实数据库**。

契约来源：`https://open.maimemo.com/api_bundle.yaml`（2026-11-16 实测核对），
逐字片段见 `_verification/perfvocab/E/api_bundle_excerpt.txt`，
结论见 `_verification/perfvocab/E/api-contract-verified.md`。

覆盖：
  1. vocabulary/query：乱序按 spelling 映射、缺词不抛错不伪造、大小写重复、空 voc
  2. 1000 上限拆批：2500 → 1000/1000/500（`api.chunk`），并验证每批可直接提交
  3. add_words：added_count=0 / 部分 / 全部；断言**无**逐词成功状态
  4. 错误码 401/403/429(Retry-After)/500/超时；超时区分"可能已送达"与"确定未送达"；
     写请求**不自动重试**
  5. advance 默认 false
  6. 代理白名单（server.py）对两条路径的放行/拒绝矩阵

运行：
    $env:MEMO_DATA_DIR = "D:\\MeMo1\\_verification\\perfvocab\\E\\_test_data"
    python -m unittest tests.perf.test_official_vocab_api -v
"""

from __future__ import annotations

import os
import pathlib
import sys
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# `server` 在 import 时就会初始化数据库。若这里不先隔离，任何跑这个文件的人
# 都会写到真实用户库 `data/memo-superform.db`。隔离必须发生在 import server 之前，
# 因此放在模块顶层，并钉死为一个本文件专属的临时目录。
_ISOLATED_DATA_DIR = ROOT / "_verification" / "perfvocab" / "E" / "_test_data"
_ISOLATED_DATA_DIR.mkdir(parents=True, exist_ok=True)
os.environ["MEMO_DATA_DIR"] = str(_ISOLATED_DATA_DIR)
_REAL_DB = (ROOT / "data" / "memo-superform.db").resolve()

try:
    import official_vocab_api as api
except Exception as exc:  # noqa: BLE001 - 记录真实原因，便于报告
    api = None
    _IMPORT_ERROR = "%s: %s" % (type(exc).__name__, exc)
else:
    _IMPORT_ERROR = ""

# 官方契约常量（spec 实测：两个接口的数组字段都是 maxItems 1000）
QUERY_PATH = "vocabulary/query"
ADD_PATH = "study/add_words"
MAX_ITEMS = 1000


def requires_module(cls):
    """模块意外缺失时 skip（并说明原因），而不是把用例删掉或改成假绿。"""
    return unittest.skipUnless(
        api is not None, "无法导入 official_vocab_api（%s）" % _IMPORT_ERROR
    )(cls)


# --------------------------------------------------------------------------- #
# 假传输层：按脚本返回，记录每次 (path, body)。绝不联网。
# --------------------------------------------------------------------------- #
class FakeTransport:
    """模拟 `transport(path, body)`。

    每个预置项可以是：
      - dict            → 原样作为传输层返回值（形如 {"status":200,"body":{...}}）
      - BaseException   → 抛出（超时、连接错误等）
    """

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []  # [(path, body), ...]

    def __call__(self, path, body):
        self.calls.append((path, dict(body)))
        if not self.responses:
            raise AssertionError("fake transport 被调用次数超出预置响应数")
        item = self.responses.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item

    @property
    def paths(self):
        return [path for path, _ in self.calls]

    @property
    def bodies(self):
        return [body for _, body in self.calls]

    def batch_sizes(self, key):
        return [len(body.get(key) or []) for body in self.bodies]


def ok(body):
    return {"status": 200, "body": body}


def err(status, body=None, headers=None):
    payload = {"status": status, "body": body if body is not None else {}}
    if headers:
        payload["headers"] = headers
    return payload


class _NoNetworkMixin:
    """用例期间禁止真实网络与 socket 建连。"""

    def setUp(self):
        super().setUp()
        guard = mock.patch(
            "urllib.request.urlopen",
            side_effect=AssertionError("测试禁止真实网络访问"),
        )
        guard.start()
        self.addCleanup(guard.stop)

        sock = mock.patch(
            "socket.create_connection",
            side_effect=AssertionError("测试禁止真实 socket 建连"),
        )
        sock.start()
        self.addCleanup(sock.stop)


# ===========================================================================
# 1. vocabulary/query 响应解析
# ===========================================================================
@requires_module
class VocabularyQueryParsingTests(_NoNetworkMixin, unittest.TestCase):
    def test_out_of_order_results_map_by_spelling_not_index(self):
        transport = FakeTransport(ok({"voc": [
            {"id": "id-cat", "spelling": "cat"},
            {"id": "id-apple", "spelling": "apple"},
            {"id": "id-banana", "spelling": "banana"},
        ]}))
        result = api.query_vocabulary(transport=transport,
                                      spellings=["apple", "banana", "cat"])
        mapped = api.map_voc_ids(["apple", "banana", "cat"], result["voc"])

        self.assertEqual("id-apple", mapped["matched"]["apple"]["id"])
        self.assertEqual("id-banana", mapped["matched"]["banana"]["id"])
        self.assertEqual("id-cat", mapped["matched"]["cat"]["id"])
        self.assertEqual([], mapped["missing"])
        # 若实现按下标对齐，apple 会拿到 id-cat —— 显式反向断言。
        self.assertNotEqual("id-cat", mapped["matched"]["apple"]["id"])

    def test_partial_hit_does_not_raise_and_does_not_fabricate(self):
        transport = FakeTransport(ok({"voc": [
            {"id": "id-apple", "spelling": "apple"},
        ]}))
        result = api.query_vocabulary(
            transport=transport, spellings=["apple", "zzz-not-a-word", "qqq"])
        mapped = api.map_voc_ids(["apple", "zzz-not-a-word", "qqq"], result["voc"])

        self.assertEqual(["apple"], sorted(mapped["matched"]))
        self.assertEqual(["qqq", "zzz-not-a-word"], sorted(mapped["missing"]))
        self.assertEqual(3, mapped["requested"])
        # 缺词既不在 matched，也不得带任何伪造 id。
        for spelling in ("zzz-not-a-word", "qqq"):
            self.assertNotIn(spelling, mapped["matched"])
        for item in mapped["matched"].values():
            self.assertTrue(str(item["id"]).strip(), "matched 项不得为空 id")

    def test_case_differences_collapse_to_one_entry(self):
        transport = FakeTransport(ok({"voc": [
            {"id": "id-apple", "spelling": "apple"},
        ]}))
        result = api.query_vocabulary(
            transport=transport, spellings=["Apple", "apple", "APPLE"])
        mapped = api.map_voc_ids(["Apple", "apple", "APPLE"], result["voc"])

        self.assertEqual(1, len(mapped["matched"]), "大小写变体只算 1 个已命中项")
        self.assertIn("apple", mapped["matched"])
        self.assertEqual("id-apple", mapped["matched"]["apple"]["id"])
        self.assertEqual([], mapped["missing"], "大小写变体不得被算成缺词")
        self.assertEqual(1, mapped["requested"])
        for key in mapped["matched"]:
            self.assertEqual(key.lower(), key, "matched 的键必须是归一后的小写")

    def test_empty_voc_array_yields_empty_result_without_error(self):
        transport = FakeTransport(ok({"voc": []}))
        result = api.query_vocabulary(transport=transport,
                                      spellings=["apple", "banana"])

        self.assertEqual([], result["voc"])
        mapped = api.map_voc_ids(["apple", "banana"], result["voc"])
        self.assertEqual({}, mapped["matched"])
        self.assertEqual(["apple", "banana"], sorted(mapped["missing"]))

    def test_ids_mode_sends_ids_and_not_spellings(self):
        transport = FakeTransport(ok({"voc": [{"id": "id-1", "spelling": "apple"}]}))
        api.query_vocabulary(transport=transport, ids=["id-1"])

        body = transport.bodies[0]
        self.assertEqual([QUERY_PATH], transport.paths)
        self.assertIn("ids", body)
        self.assertNotIn("spellings", body, "官方要求 spellings/ids 互斥，只能发一个")

    def test_spellings_and_ids_are_mutually_exclusive_before_any_request(self):
        transport = FakeTransport()
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.query_vocabulary(transport=transport, spellings=["apple"], ids=["id-1"])
        self.assertEqual([], transport.calls, "互斥校验必须在发出任何请求之前完成")
        self.assertEqual("invalid_request", ctx.exception.code)

    def test_upstream_extra_words_are_dropped(self):
        mapped = api.map_voc_ids(["alpha"], [
            {"id": "id-a", "spelling": "alpha"},
            {"id": "id-b", "spelling": "unrelated"},
        ])
        self.assertEqual(["alpha"], list(mapped["matched"]))


# ===========================================================================
# 2. 1000 上限拆批
# ===========================================================================
@requires_module
class BatchingTests(_NoNetworkMixin, unittest.TestCase):
    def _spellings(self, count):
        return ["word%05d" % index for index in range(count)]

    def test_2500_spellings_split_into_1000_1000_500(self):
        batches = api.chunk(self._spellings(2500), api.QUERY_BATCH)

        self.assertEqual(3, len(batches), "2500 项必须拆成 3 批")
        self.assertEqual([1000, 1000, 500], [len(batch) for batch in batches])
        for batch in batches:
            self.assertLessEqual(len(batch), MAX_ITEMS,
                                 "任何一批都不得超过官方 maxItems=1000")

    def test_exactly_1000_is_one_batch_and_1001_is_two(self):
        self.assertEqual([1000], [len(b) for b in api.chunk(self._spellings(1000), 1000)])
        self.assertEqual([1000, 1], [len(b) for b in api.chunk(self._spellings(1001), 1000)])

    def test_batches_are_directly_submittable_and_bodies_stay_under_limit(self):
        """每个拆出的批都能原样提交，且实际发出的 body 不超过 1000。"""
        batches = api.chunk(self._spellings(2500), api.QUERY_BATCH)
        transport = FakeTransport(
            ok({"voc": []}), ok({"voc": []}), ok({"voc": []})
        )
        for batch in batches:
            api.query_vocabulary(transport=transport, spellings=batch)

        self.assertEqual(3, len(transport.calls))
        self.assertEqual([1000, 1000, 500], transport.batch_sizes("spellings"))
        self.assertEqual([QUERY_PATH] * 3, transport.paths)

    def test_single_request_over_limit_is_rejected_not_silently_truncated(self):
        transport = FakeTransport()
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.query_vocabulary(transport=transport, spellings=self._spellings(1001))
        self.assertEqual("invalid_request", ctx.exception.code)
        self.assertEqual([], transport.calls, "超限必须在发请求前拒绝，不能静默截断")

    def test_results_from_all_batches_merge(self):
        spellings = self._spellings(2500)
        transport = FakeTransport(
            ok({"voc": [{"id": "id-0", "spelling": spellings[0]}]}),
            ok({"voc": [{"id": "id-1", "spelling": spellings[1000]}]}),
            ok({"voc": [{"id": "id-2", "spelling": spellings[2000]}]}),
        )
        rows = []
        for batch in api.chunk(spellings, api.QUERY_BATCH):
            rows.extend(api.query_vocabulary(transport=transport, spellings=batch)["voc"])
        mapped = api.map_voc_ids(spellings, rows)

        self.assertEqual(3, len(mapped["matched"]), "跨批结果必须合并")
        self.assertEqual("id-0", mapped["matched"][spellings[0]]["id"])
        self.assertEqual("id-1", mapped["matched"][spellings[1000]]["id"])
        self.assertEqual("id-2", mapped["matched"][spellings[2000]]["id"])
        self.assertEqual(2497, len(mapped["missing"]))

    def test_chunk_dedupes_case_insensitively_at_batch_boundary(self):
        # 999 个唯一项 + 1 组大小写变体（占满第 1 批）+ 500 个全新项（第 2 批）。
        values = (["word%05d" % index for index in range(999)]
                  + ["dup-word", "DUP-WORD"]
                  + ["tail%05d" % index for index in range(500)])
        self.assertEqual(1501, len(values))
        batches = api.chunk(values, 1000)

        self.assertEqual([1000, 500], [len(b) for b in batches])
        flat = [item for batch in batches for item in batch]
        self.assertEqual(1500, len(flat), "大小写变体必须折叠成 1 项")
        self.assertEqual(1, sum(1 for item in flat if item.lower() == "dup-word"),
                         "跨批重复的拼写只能保留一次")
        self.assertEqual("dup-word", flat[999], "去重保留首次出现的大小写")

    def test_add_words_enforces_limit_and_chunks_drive_valid_calls(self):
        """add_words 单次上限 1000；2500 个 id 需由调用方按 chunk 分 3 批提交。"""
        ids = ["id-%05d" % index for index in range(2500)]

        # 单次超限 → 发请求前拒绝
        over = FakeTransport()
        with self.assertRaises(api.OfficialVocabError):
            api.add_words(ids, transport=over)
        self.assertEqual([], over.calls)

        # 按 chunk 分批 → 3 批，每批 body ≤ 1000
        transport = FakeTransport(ok({"added_count": 500}), ok({"added_count": 500}),
                                  ok({"added_count": 500}))
        total = 0
        for batch in api.chunk(ids, api.ADD_BATCH):
            total += api.add_words(batch, transport=transport)["added_count"]

        self.assertEqual(3, len(transport.calls))
        self.assertEqual([1000, 1000, 500], transport.batch_sizes("words"))
        for size in transport.batch_sizes("words"):
            self.assertLessEqual(size, MAX_ITEMS)
        self.assertEqual([ADD_PATH] * 3, transport.paths)
        self.assertEqual(1500, total)


# ===========================================================================
# 3. add_words 结果语义（只有 added_count，无逐词状态）
# ===========================================================================
@requires_module
class AddWordsResultTests(_NoNetworkMixin, unittest.TestCase):
    def test_zero_added_count_is_reported_not_raised(self):
        transport = FakeTransport(ok({"added_count": 0}))
        result = api.add_words(["id-1", "id-2"], transport=transport)

        self.assertEqual(0, result["added_count"])
        self.assertEqual(2, result["submitted"])

    def test_partial_added_count_is_reported_as_is(self):
        transport = FakeTransport(ok({"added_count": 2}))
        result = api.add_words(["id-1", "id-2", "id-3", "id-4"], transport=transport)

        self.assertEqual(2, result["added_count"])
        self.assertEqual(4, result["submitted"])
        self.assertLess(result["added_count"], result["submitted"])

    def test_full_success(self):
        transport = FakeTransport(ok({"added_count": 3}))
        result = api.add_words(["id-1", "id-2", "id-3"], transport=transport)

        self.assertEqual(3, result["added_count"])
        self.assertEqual(3, result["submitted"])

    def test_no_per_word_success_state_is_exposed(self):
        """官方 200 只有 added_count；任何逐词成功状态都是编造。"""
        transport = FakeTransport(ok({"added_count": 1}))
        result = api.add_words(["id-1", "id-2"], transport=transport)

        for forbidden in ("results", "per_word", "succeeded_ids", "failed_ids",
                          "words", "items", "success"):
            self.assertNotIn(forbidden, result,
                             "返回体不得含逐词字段 %r：官方只有 added_count" % forbidden)
        for key, value in result.items():
            self.assertNotIn("success", key.lower(), "键名不得暗示逐词成败")
            self.assertNotIsInstance(
                value, (list, set, tuple),
                "字段 %r 是序列，疑似逐词结果；官方只有 added_count" % key,
            )

    def test_missing_added_count_is_uncertain_not_silent_zero(self):
        transport = FakeTransport(ok({}))
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.add_words(["id-1"], transport=transport)
        self.assertTrue(ctx.exception.uncertain,
                        "缺少 added_count 时必须标为结果未知，不能当成 0")

    def test_non_integer_added_count_is_uncertain(self):
        transport = FakeTransport(ok({"added_count": "many"}))
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.add_words(["id-1"], transport=transport)
        self.assertTrue(ctx.exception.uncertain)


# ===========================================================================
# 4. advance 默认 false
# ===========================================================================
@requires_module
class AdvanceDefaultTests(_NoNetworkMixin, unittest.TestCase):
    def test_advance_defaults_to_false_and_is_sent_explicitly(self):
        transport = FakeTransport(ok({"added_count": 1}))
        api.add_words(["id-1"], transport=transport)

        body = transport.bodies[0]
        self.assertIn("advance", body, "advance 是官方 required 字段，必须显式发送")
        self.assertIs(False, body["advance"])

    def test_advance_true_is_rejected_not_silently_ignored(self):
        transport = FakeTransport()
        with self.assertRaises(api.OfficialVocabError):
            api.add_words(["id-1"], transport=transport, advance=True)
        self.assertEqual([], transport.calls,
                         "不支持的 advance 必须在发请求前拒绝，不能静默改成 False")

    def test_words_payload_shape_matches_spec(self):
        transport = FakeTransport(ok({"added_count": 2}))
        api.add_words(["id-1", "id-2"], transport=transport)

        body = transport.bodies[0]
        self.assertEqual({"words", "advance"}, set(body), "请求体只允许 words + advance")
        self.assertIsInstance(body["words"], list)
        self.assertEqual([{"id": "id-1"}, {"id": "id-2"}], body["words"])
        for item in body["words"]:
            self.assertEqual({"id"}, set(item), "words 每项只允许 id")

    def test_empty_ids_rejected_before_network(self):
        transport = FakeTransport()
        with self.assertRaises(api.OfficialVocabError):
            api.add_words([], transport=transport)
        self.assertEqual([], transport.calls, "空词表不得发请求")


# ===========================================================================
# 5. 错误码：401 / 403 / 429(+Retry-After) / 500 / 超时
# ===========================================================================
@requires_module
class ErrorHandlingTests(_NoNetworkMixin, unittest.TestCase):
    def test_401_surfaces_status_and_is_not_retryable(self):
        transport = FakeTransport(err(401, {"error": "bad token"}))
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.query_vocabulary(transport=transport, spellings=["apple"])
        self.assertEqual(401, ctx.exception.status)
        self.assertFalse(ctx.exception.retryable)

    def test_403_surfaces_status_and_is_not_retryable(self):
        transport = FakeTransport(err(403, {"error": "no scope"}))
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.add_words(["id-1"], transport=transport)
        self.assertEqual(403, ctx.exception.status)
        self.assertFalse(ctx.exception.retryable)

    def test_429_exposes_retry_after_from_body(self):
        transport = FakeTransport(err(429, {"retry_after": 17}))
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.query_vocabulary(transport=transport, spellings=["apple"])
        self.assertEqual(429, ctx.exception.status)
        self.assertEqual(17.0, ctx.exception.retry_after)

    def test_429_exposes_retry_after_from_header(self):
        transport = FakeTransport(err(429, {}, {"Retry-After": "23"}))
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.query_vocabulary(transport=transport, spellings=["apple"])
        self.assertEqual(23.0, ctx.exception.retry_after,
                         "Retry-After 头必须被解析成 retry_after")

    def test_429_on_write_is_not_retried(self):
        transport = FakeTransport(err(429, {"retry_after": 3}))
        with self.assertRaises(api.OfficialVocabError):
            api.add_words(["id-1"], transport=transport)
        self.assertEqual(1, len(transport.calls), "429 不得对写请求自动重试")

    def test_500_on_read_is_retryable_but_not_uncertain(self):
        transport = FakeTransport(err(500, {}))
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.query_vocabulary(transport=transport, spellings=["apple"])
        self.assertTrue(ctx.exception.retryable)
        self.assertFalse(ctx.exception.uncertain,
                         "读请求的 5xx 不涉及写入，不能声称结果未知")

    def test_500_on_write_is_uncertain_and_not_retryable(self):
        transport = FakeTransport(err(500, {}))
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.add_words(["id-1"], transport=transport)
        self.assertTrue(ctx.exception.uncertain,
                        "写请求 5xx 可能已被上游处理，必须标为不确定")
        self.assertFalse(ctx.exception.retryable,
                         "写请求不得自动重试")

    def test_write_timeout_is_uncertain_and_not_retried(self):
        """超时必须区分"可能已送达"与"确定未送达"；写请求绝不自动重试。"""
        transport = FakeTransport(TimeoutError("timed out"))
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.add_words(["id-1", "id-2"], transport=transport)

        exc = ctx.exception
        self.assertEqual(1, len(transport.calls), "写请求超时绝不可自动重试")
        self.assertTrue(exc.uncertain, "写请求超时必须标记为可能已送达")
        self.assertFalse(exc.retryable, "不确定是否送达时不得声称可安全重试")

    def test_read_timeout_is_retryable_and_definitely_not_delivered(self):
        """查询超时（幂等读）必须与写超时可区分：不得声称写入可能落地。"""
        transport = FakeTransport(TimeoutError("timed out"))
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.query_vocabulary(transport=transport, spellings=["apple"])

        exc = ctx.exception
        self.assertTrue(exc.retryable, "读超时可安全重试")
        self.assertFalse(exc.uncertain, "读请求超时不得声称写入可能已落地")

    def test_write_timeout_mid_batch_stops_further_batches(self):
        """第 1 批成功后第 2 批超时：不得继续发第 3 批，也不得重发第 2 批。"""
        ids = ["id-%05d" % index for index in range(2500)]
        transport = FakeTransport(ok({"added_count": 1000}), TimeoutError("timed out"))

        submitted = []
        with self.assertRaises(api.OfficialVocabError):
            for batch in api.chunk(ids, api.ADD_BATCH):
                submitted.append(api.add_words(batch, transport=transport))
                if submitted[-1]["added_count"] < len(batch):
                    break

        self.assertEqual(2, len(transport.calls), "超时后不得再发后续批次")
        self.assertEqual([1000, 1000], transport.batch_sizes("words"))

    def test_connection_error_on_write_is_not_retried(self):
        transport = FakeTransport(OSError("connection refused"))
        with self.assertRaises(api.OfficialVocabError) as ctx:
            api.add_words(["id-1"], transport=transport)
        self.assertEqual(1, len(transport.calls))
        self.assertTrue(ctx.exception.uncertain)


# ===========================================================================
# 6. 代理白名单契约（直接测 server.py，不依赖网络）
# ===========================================================================
class ProxyAllowlistContractTests(_NoNetworkMixin, unittest.TestCase):
    """两条新路径的放行/拒绝矩阵（对应 api-contract-verified.md §7 P1）。"""

    @classmethod
    def setUpClass(cls):
        try:
            from server import MemoProxyHandler
        except Exception as exc:  # noqa: BLE001
            raise unittest.SkipTest("无法导入 server.MemoProxyHandler: %s" % exc)
        # 硬断言：导入 server 之后，实际生效的库绝不能是真实用户库。
        # 否则这个测试文件会静默污染用户数据。
        import db as _db
        active = pathlib.Path(str(_db._DB_PATH)).resolve()
        if active == _REAL_DB:
            raise AssertionError(
                "测试隔离失效：数据库指向真实用户库 %s" % active)
        cls.allowed = staticmethod(MemoProxyHandler._official_api_allowed)

    def test_new_post_paths_are_allowed_without_query(self):
        self.assertTrue(self.allowed(QUERY_PATH, "POST"))
        self.assertTrue(self.allowed(ADD_PATH, "POST"))

    def test_new_post_paths_reject_any_query_parameter(self):
        for query in ("spelling=apple", "limit=10", "x=1", "a="):
            self.assertFalse(self.allowed(QUERY_PATH, "POST", query), query)
            self.assertFalse(self.allowed(ADD_PATH, "POST", query), query)

    def test_new_paths_are_not_reachable_by_other_methods(self):
        for method in ("GET", "DELETE", "PUT", "PATCH"):
            self.assertFalse(self.allowed(QUERY_PATH, method), method)
            self.assertFalse(self.allowed(ADD_PATH, method), method)

    def test_allowlist_stays_narrow_around_the_new_paths(self):
        denied = (
            "study/add_words/extra",
            "study/add_words_evil",
            "study/advance_study",
            "vocabulary/query/all",
            "vocabulary",
            "vocabulary/queryevil",
            "study/add_words/../other",
        )
        for path in denied:
            self.assertFalse(self.allowed(path, "POST"), path)

    def test_existing_routes_still_behave(self):
        self.assertTrue(self.allowed("study/get_study_progress", "POST"))
        self.assertTrue(self.allowed("interpretations", "POST"))
        self.assertTrue(self.allowed("notes/n_1", "POST"))
        self.assertTrue(self.allowed("vocabulary", "GET", "spelling=apple"))
        self.assertFalse(self.allowed("study/get_study_progress", "POST", "extra=1"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
