"""``/api/study-sync/status`` 的 records_count 端到端契约。

主协调者已把 ``app_api.py:613`` 的
``len(db.get_records(profile_id))`` 改成 ``db.get_record_count(profile_id)``。
本文件在**真实 handler** 上验证该响应字段的取值，避免只测 db 层就下结论。

做法
----
不启动 HTTP 监听端口。直接构造 ``MemoProxyHandler`` 的实例方法所依赖的最小
对象，调用 ``_handle_api_get``，并把 ``_send_json`` 换成累积器。
这样既走真实路由与真实 SQLite 读取，又不需要绑定端口或伪造网络。

安全
----
* ``MEMO_DATA_DIR`` 在 import 前指向 ``_verification/perfvocab/C/<唯一名>``。
* 真实库 ``D:\\MeMo1\\data\\memo-superform.db`` 不被打开或写入。
* 只用合成数据。
"""

import os
import pathlib
import sys
import unittest
import uuid
from types import SimpleNamespace
from urllib.parse import urlparse

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

VERIFICATION_BASE = ROOT / "_verification" / "perfvocab" / "C"
RUN_DIR = VERIFICATION_BASE / ("api-%s" % uuid.uuid4().hex)
os.makedirs(RUN_DIR, exist_ok=True)
os.environ["MEMO_DATA_DIR"] = str(RUN_DIR)

import db  # noqa: E402
import app_api  # noqa: E402

_SYLLABLES = ["ab", "ac", "ad", "ef", "ig", "op", "um", "en", "it", "ar"]


def synthetic_records(count, prefix, seed=20261116):
    import random
    rng = random.Random("%s:%s" % (seed, prefix))
    out = []
    for index in range(1, count + 1):
        word = "".join(rng.choice(_SYLLABLES) for _ in range(3)) + str(index)
        out.append({
            "voc_id": "%s-voc-%07d" % (prefix, index),
            "voc_spelling": word,
            "definition": "合成释义 %d" % index,
            "add_date": "2025-01-01",
            "first_study_date": "2025-01-01",
            "last_study_date": "2026-01-01",
            "next_study_date": "2026-02-01",
            "last_response": "FAMILIAR",
            "study_count": 1 + index % 38,
            "tags": "",
        })
    return out


def bulk_upsert(profile_key, records, chunk=2000):
    for start in range(0, len(records), chunk):
        db.upsert_study_records(profile_key, records[start:start + chunk])


class _HandlerProbe(app_api.LocalApiMixin):
    """把 LocalApiMixin 的 GET 路由当普通方法调用，捕获 JSON 响应。

    继承真实 mixin，使 ``_companion_get``、``_profile_id`` 等路由分支保持真实；
    只替换三处与本用例无关的外设：响应发送、账号身份、陪伴子系统。
    """

    def __init__(self, profile_key):
        self._profile_key = profile_key
        self.captured = None
        self.headers = {}

    # --- 被替换的边界 ---
    def _send_json(self, status, payload=None, headers=None):
        self.captured = (status, payload)
        return True

    def _memo_identity(self, required=True):  # noqa: ARG002
        return "stub-token", self._profile_key

    def _companion_get(self, path, parsed):  # noqa: ARG002
        # 陪伴子路由与本用例无关；返回 None 让它落到后面的数据库状态分支。
        return None

    def get(self, path):
        parsed = urlparse(path)
        handler = app_api.LocalApiMixin.__dict__["_handle_api_get"]
        return handler(self, parsed.path, parsed)


class SyncStatusRecordsCountTests(unittest.TestCase):
    def setUp(self):
        self.data_dir = RUN_DIR / ("case-" + uuid.uuid4().hex[:8])
        os.makedirs(self.data_dir, exist_ok=True)
        db.init_db(str(self.data_dir))
        active = pathlib.Path(db.database_path()).resolve()
        self.assertTrue(str(active).startswith(str(RUN_DIR.resolve())))
        self.assertNotEqual(active, (ROOT / "data" / "memo-superform.db").resolve())
        # handler 读的是 app_api 模块级 db 引用（生产由 server.py 注入）。
        app_api.configure_local_api(db=db, DB_READY=True, recommender=None,
                                    STUDY_SYNC_MANAGER=None)

    def _status_for(self, profile_key):
        probe = _HandlerProbe(profile_key)
        probe.get("/api/study-sync/status")
        self.assertIsNotNone(probe.captured, "handler 未产生响应")
        status, payload = probe.captured
        self.assertEqual(200, status, "响应状态异常：%s" % (payload,))
        return payload

    def test_records_count_matches_row_count_like_get_records(self):
        profile = "api-" + uuid.uuid4().hex
        bulk_upsert(profile, synthetic_records(37, "api"))
        payload = self._status_for(profile)
        self.assertIn("records_count", payload)
        self.assertEqual(37, payload["records_count"])
        # 与旧路径的读数一致，这是替换的安全性依据。
        self.assertEqual(len(db.get_records(profile)), payload["records_count"])

    def test_records_count_is_zero_for_empty_profile(self):
        profile = "api-empty-" + uuid.uuid4().hex
        payload = self._status_for(profile)
        self.assertEqual(0, payload["records_count"])

    def test_records_count_excludes_inactive_records(self):
        profile = "api-ina-" + uuid.uuid4().hex
        bulk_upsert(profile, synthetic_records(20, "iapi"))
        for _ in range(2):
            db.mark_reconcile_seen(profile, [])
            db.mark_absent_after_two_reconciles(profile)
        payload = self._status_for(profile)
        self.assertEqual(0, payload["records_count"])
        self.assertEqual(0, len(db.get_records(profile)))

    def test_records_count_does_not_leak_between_profiles(self):
        profile_a = "api-a-" + uuid.uuid4().hex
        profile_b = "api-b-" + uuid.uuid4().hex
        bulk_upsert(profile_a, synthetic_records(31, "apa"))
        bulk_upsert(profile_b, synthetic_records(9, "apb"))
        self.assertEqual(31, self._status_for(profile_a)["records_count"])
        self.assertEqual(9, self._status_for(profile_b)["records_count"])
        # 交叉复测，确认没有进程级缓存串号。
        self.assertEqual(31, self._status_for(profile_a)["records_count"])

    def test_records_count_reflects_committed_writes_after_change(self):
        profile = "api-fresh-" + uuid.uuid4().hex
        bulk_upsert(profile, synthetic_records(5, "afr"))
        self.assertEqual(5, self._status_for(profile)["records_count"])
        bulk_upsert(profile, synthetic_records(12, "afr"))
        self.assertEqual(12, self._status_for(profile)["records_count"])

    def test_response_still_carries_other_status_fields(self):
        profile = "api-fields-" + uuid.uuid4().hex
        bulk_upsert(profile, synthetic_records(3, "afd"))
        payload = self._status_for(profile)
        # 保留字段不能因为改成 COUNT 而丢失。
        for key in ("records_count", "bootstrap_complete", "needs_reconcile"):
            self.assertIn(key, payload, "缺少字段 %s" % key)


if __name__ == "__main__":
    unittest.main(verbosity=2)
