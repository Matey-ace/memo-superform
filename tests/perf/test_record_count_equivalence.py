"""get_record_count() 与 len(get_records()) 的语义等价性断言。

目的
----
主协调者计划把 ``app_api.py:609`` 的
``len(db.get_records(profile_id))`` 换成 ``db.get_record_count(profile_id)``。
该替换只有在两条路径**在任何会被观测到的场景下返回同一个数量**时才安全。
本文件用合成数据把这些场景逐条断言，避免"看起来等价"代替证明。

安全约束
--------
* 真实库 ``D:\\MeMo1\\data\\memo-superform.db`` 绝不被打开或写入。
* ``MEMO_DATA_DIR`` 在 **import db 之前** 设为本文件独占的
  ``_verification/perfvocab/C/<唯一名>`` 目录；``db`` 在 import 时读取该变量。
* 每个用例再用 ``db.init_db()`` 切到自己的子目录，互不共享状态。
* 只用合成数据（``voc_id`` = ``equiv-voc-*``，拼写是伪造音节词），不读词库。

运行
----
    python -m unittest tests.perf.test_record_count_equivalence -v
或（更稳，避免包导入路径差异）：
    python tests/perf/test_record_count_equivalence.py
"""

import os
import pathlib
import random
import sqlite3
import sys
import unittest
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ---------------------------------------------------------------------------
# 数据目录隔离：必须在 import db 之前完成。
# ---------------------------------------------------------------------------
VERIFICATION_BASE = ROOT / "_verification" / "perfvocab" / "C"
RUN_DIR = VERIFICATION_BASE / ("equiv-%s" % uuid.uuid4().hex)
os.makedirs(RUN_DIR, exist_ok=True)
os.environ["MEMO_DATA_DIR"] = str(RUN_DIR)

import db  # noqa: E402  (import 顺序由上面的隔离要求决定)

# 拼写用伪造音节，与任何真实词库无关。
_SYLLABLES = ["ab", "ac", "ad", "ef", "ig", "op", "um", "en", "it", "ar",
              "or", "us", "is", "at", "an", "er", "on", "in", "pre", "pro"]


def synthetic_records(count, prefix, seed=20261116):
    """确定性合成记录；prefix 让不同档案的数据可区分。"""
    rng = random.Random("%s:%s" % (seed, prefix))
    out = []
    for index in range(1, count + 1):
        word = "".join(rng.choice(_SYLLABLES) for _ in range(3)) + str(index)
        if index % 11 == 0:
            # 混入大写，覆盖 ORDER BY voc_spelling COLLATE NOCASE 的排序分支。
            word = word[:1].upper() + word[1:]
        out.append({
            "voc_id": "%s-voc-%07d" % (prefix, index),
            "voc_spelling": word,
            "definition": "合成释义 %d" % index,
            "add_date": "2024-%02d-%02d" % (1 + index % 12, 1 + index % 28),
            "first_study_date": "2024-%02d-%02d" % (1 + index % 12, 1 + index % 28),
            "last_study_date": "2026-%02d-%02d" % (1 + index % 12, 1 + index % 28),
            "next_study_date": "2026-%02d-%02d" % (1 + index % 12, 1 + index % 28),
            "last_response": ["FAMILIAR", "WELL_FAMILIAR", "VAGUE", "FORGET"][index % 4],
            "study_count": 1 + index % 38,
            "tags": "" if index % 4 else "合成标签%d" % (index % 7),
        })
    return out


def bulk_upsert(profile_key, records, chunk=2000):
    """分批调用真实写入路径，避免单个巨事务。"""
    for start in range(0, len(records), chunk):
        db.upsert_study_records(profile_key, records[start:start + chunk])


class _IsolatedCase(unittest.TestCase):
    """每个用例独占一个数据目录，并校验没有摸到真实库。"""

    _counter = 0

    def setUp(self):
        type(self)._counter += 1
        self.data_dir = RUN_DIR / ("case-%02d-%s" % (type(self)._counter, uuid.uuid4().hex[:8]))
        os.makedirs(self.data_dir, exist_ok=True)
        db.init_db(str(self.data_dir))
        # 硬保险：当前库路径必须落在本文件的隔离目录内。
        active = pathlib.Path(db.database_path()).resolve()
        self.assertTrue(
            str(active).startswith(str(RUN_DIR.resolve())),
            "db.database_path() 越出隔离目录：%s" % active,
        )
        self.assertNotEqual(
            active, (ROOT / "data" / "memo-superform.db").resolve(),
            "拒绝在真实库上运行",
        )

    def assertCountsAgree(self, profile_key, *, include_inactive=False, expected=None):
        """核心断言：两条路径数量相等（可选再校验具体数值）。"""
        records = db.get_records(profile_key, include_inactive=include_inactive)
        count = db.get_record_count(profile_key, include_inactive=include_inactive)
        self.assertEqual(
            len(records), count,
            "len(get_records)=%d 与 get_record_count=%d 不一致（include_inactive=%s）"
            % (len(records), count, include_inactive),
        )
        if expected is not None:
            self.assertEqual(expected, count, "计数与预期不符")
        return count


class EmptyDatabaseEquivalence(_IsolatedCase):
    def test_empty_database_both_paths_report_zero(self):
        profile = "empty-" + uuid.uuid4().hex
        self.assertEqual(0, self.assertCountsAgree(profile))
        self.assertEqual(0, self.assertCountsAgree(profile, include_inactive=True))
        self.assertEqual([], db.get_records(profile))

    def test_profile_with_no_rows_but_existing_sync_state(self):
        # ensure_sync_profile 会建 profiles/sync_state 行，但 study_records 为空。
        profile = "empty-state-" + uuid.uuid4().hex
        db.ensure_sync_profile(profile)
        self.assertEqual(0, self.assertCountsAgree(profile))


class ScaleEquivalence(_IsolatedCase):
    """1k / 10k / 50k 三种规模。"""

    def _run_scale(self, count):
        profile = "scale%d-%s" % (count, uuid.uuid4().hex)
        bulk_upsert(profile, synthetic_records(count, "s%d" % count))
        self.assertEqual(count, self.assertCountsAgree(profile))
        # include_inactive=True 在全活跃数据上必须等于同一个数。
        self.assertEqual(count, self.assertCountsAgree(profile, include_inactive=True))

    def test_scale_1k(self):
        self._run_scale(1000)

    def test_scale_10k(self):
        self._run_scale(10000)

    def test_scale_50k(self):
        self._run_scale(50000)


class InactiveRecordEquivalence(_IsolatedCase):
    def test_soft_deleted_records_excluded_by_both_paths(self):
        profile = "inactive-" + uuid.uuid4().hex
        records = synthetic_records(200, "ina")
        bulk_upsert(profile, records)
        self.assertEqual(200, self.assertCountsAgree(profile))

        # 走真实业务路径停用：两次"未见"核验后标记失活。
        for _ in range(2):
            db.mark_reconcile_seen(profile, [])
            db.mark_absent_after_two_reconciles(profile)

        # 默认视图两边都必须排除失活记录。
        self.assertEqual(0, self.assertCountsAgree(profile))
        # 含失活视图两边都必须包含。
        self.assertEqual(200, self.assertCountsAgree(profile, include_inactive=True))

    def test_partial_soft_delete_is_reflected_identically(self):
        profile = "partial-" + uuid.uuid4().hex
        bulk_upsert(profile, synthetic_records(300, "par"))
        # 先解析主键，避免在外层写事务内再开一个写连接导致自锁。
        pk = db._profile_pk(profile)
        # 直接置位属于测试夹具（不改业务代码），用于构造部分失活的中间态。
        with db._write_connection() as conn:
            conn.execute(
                "UPDATE study_records SET is_active=0 WHERE profile_id=? AND voc_id LIKE ?",
                (pk, "%-voc-00001%"),
            )
            conn.execute(
                "UPDATE study_records SET is_active=0 WHERE profile_id=? AND voc_id IN (?,?,?)",
                (pk, "par-voc-0000002", "par-voc-0000003", "par-voc-0000004"),
            )
        inactive = db.get_record_count(profile, include_inactive=True) - db.get_record_count(profile)
        self.assertGreater(inactive, 0, "夹具未真正制造失活记录")

        active_only = self.assertCountsAgree(profile)
        with_inactive = self.assertCountsAgree(profile, include_inactive=True)
        self.assertEqual(active_only + inactive, with_inactive)

    def test_fully_inactive_profile_counts_as_zero_active(self):
        profile = "allgone-" + uuid.uuid4().hex
        bulk_upsert(profile, synthetic_records(50, "gone"))
        pk = db._profile_pk(profile)
        with db._write_connection() as conn:
            conn.execute("UPDATE study_records SET is_active=0 WHERE profile_id=?", (pk,))
        self.assertEqual(0, self.assertCountsAgree(profile))
        self.assertEqual(50, self.assertCountsAgree(profile, include_inactive=True))


class MultiProfileEquivalence(_IsolatedCase):
    def test_two_profiles_count_independently(self):
        profile_a = "alpha-" + uuid.uuid4().hex
        profile_b = "beta-" + uuid.uuid4().hex
        bulk_upsert(profile_a, synthetic_records(500, "a"))
        bulk_upsert(profile_b, synthetic_records(120, "b"))

        self.assertEqual(500, self.assertCountsAgree(profile_a))
        self.assertEqual(120, self.assertCountsAgree(profile_b))
        # 交叉复测：前一次调用不能污染后一次。
        self.assertEqual(120, self.assertCountsAgree(profile_b))
        self.assertEqual(500, self.assertCountsAgree(profile_a))

    def test_inactive_in_one_profile_does_not_affect_other(self):
        profile_a = "mix-a-" + uuid.uuid4().hex
        profile_b = "mix-b-" + uuid.uuid4().hex
        bulk_upsert(profile_a, synthetic_records(80, "ma"))
        bulk_upsert(profile_b, synthetic_records(80, "mb"))
        pk_a = db._profile_pk(profile_a)
        with db._write_connection() as conn:
            conn.execute("UPDATE study_records SET is_active=0 WHERE profile_id=?", (pk_a,))
        self.assertEqual(0, self.assertCountsAgree(profile_a))
        self.assertEqual(80, self.assertCountsAgree(profile_b))
        self.assertEqual(80, self.assertCountsAgree(profile_a, include_inactive=True))
        self.assertEqual(80, self.assertCountsAgree(profile_b, include_inactive=True))

    def test_default_profile_none_is_also_equivalent(self):
        # profile_id=None 走 DEFAULT_PROFILE_HASH 分支，两条路径须一致。
        bulk_upsert(None, synthetic_records(40, "dflt"))
        self.assertCountsAgree(None)

    def test_integer_profile_pk_matches_hashed_profile_key(self):
        profile = "intpk-" + uuid.uuid4().hex
        bulk_upsert(profile, synthetic_records(60, "ipk"))
        pk = db._profile_pk(profile)
        # 整数主键与哈希字符串必须解析到同一条档案。
        self.assertEqual(
            db.get_record_count(pk),
            db.get_record_count(profile),
        )
        self.assertEqual(len(db.get_records(pk)), len(db.get_records(profile)))


class CountIsNotDerivedFromStaleCache(_IsolatedCase):
    """计数必须反映已提交状态，而不是 sync_state 里的缓存列。"""

    def test_count_tracks_writes_and_deletes(self):
        profile = "fresh-" + uuid.uuid4().hex
        bulk_upsert(profile, synthetic_records(25, "fr"))
        self.assertEqual(25, self.assertCountsAgree(profile))
        bulk_upsert(profile, synthetic_records(25, "fr"))  # 同 voc_id 再写 => 不变
        self.assertEqual(25, self.assertCountsAgree(profile))
        bulk_upsert(profile, synthetic_records(40, "fr"))
        self.assertEqual(40, self.assertCountsAgree(profile))

        pk = db._profile_pk(profile)
        with db._write_connection() as conn:
            conn.execute("DELETE FROM study_records WHERE profile_id=? AND voc_id=?",
                         (pk, "fr-voc-0000001"))
        self.assertEqual(39, self.assertCountsAgree(profile))

        # sync_state.local_record_count 只由 upsert 更新，故意与真实行数不同步，
        # 用于证明 get_record_count 读的是表而不是缓存列。
        with db._write_connection() as conn:
            conn.execute("UPDATE sync_state SET local_record_count=999 WHERE profile_id=?", (pk,))
        self.assertEqual(39, self.assertCountsAgree(profile))
        connection = db.get_connection()
        try:
            cached = connection.execute(
                "SELECT local_record_count FROM sync_state WHERE profile_id=?",
                (db._profile_pk(profile),)).fetchone()[0]
        finally:
            connection.close()
        self.assertEqual(999, cached, "缓存列未按预期被改写，本用例前提失效")


class RecordShapeContract(_IsolatedCase):
    """记录调用方依赖的返回形状，替换计数时不得改动它。"""

    def test_get_records_shape_is_unchanged_by_this_work(self):
        profile = "shape-" + uuid.uuid4().hex
        bulk_upsert(profile, synthetic_records(3, "sh"))
        rows = db.get_records(profile)
        self.assertEqual(3, len(rows))
        self.assertEqual(
            sorted(["voc_id", "voc_spelling", "definition", "add_date", "first_study_date",
                    "last_study_date", "next_study_date", "last_response", "study_count", "tags"]),
            sorted(rows[0].keys()),
        )
        # 10 个键；SQL 里 SELECT 的是 11 列（多出 is_active，仅用于过滤，未投影）。
        self.assertEqual(10, len(rows[0]))
        self.assertNotIn("is_active", rows[0])
        self.assertIsInstance(rows[0]["study_count"], int)
        # NOCASE 排序：小写化后应单调不减。
        lowered = [row["voc_spelling"].lower() for row in rows]
        self.assertEqual(sorted(lowered), lowered)


if __name__ == "__main__":
    unittest.main(verbosity=2)
