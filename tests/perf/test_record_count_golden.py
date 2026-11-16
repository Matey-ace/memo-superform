"""records_count 热点优化的黄金样本（永久回归测试）。

被保护的改动
------------
主协调者计划把 ``app_api.py:609`` 的 ``len(db.get_records(pid))`` 换成
``db.get_record_count(pid)``。这条替换只在**所有会被观测到的场景下两者的
数量完全一致**时才允许落地。本文件把那些场景固化为黄金样本，后续任何改动
只要让计数偏离记录集合的真实大小，本文件就会立即失败。

与 ``test_record_count_equivalence.py`` 的分工
----------------------------------------------
那份文件是探索式的等价性证明（含缓存列、整数主键别名等内部路径）。
本文件是**验收闸门**：只用业务可观测路径，规模固定为 1k / 10k / 50k，
多账号 A/B 共用同一个库文件，并把黄金计数矩阵写成 JSON 供人工比对。
两者互补，不能替代对方。

安全约束（硬性）
----------------
* 真实库 ``D:\\MeMo1\\data\\memo-superform.db`` 绝不被打开或写入。
  每个用例断言当前库路径落在本文件独占的隔离目录内，并断言它不是真实库。
* ``MEMO_DATA_DIR`` 在 **import db 之前**指向
  ``_verification/perfvocab/A/record-count-golden/<唯一运行名>``。
* 父目录用 ``os.makedirs(parent, exist_ok=True)`` 建立。
* 只用合成数据（伪造音节词 + ``golden-voc-*`` 主键），不读任何真实词库。

运行
----
    python -m unittest tests.perf.test_record_count_golden -v
或（不依赖命名空间包解析，最稳）：
    python tests/perf/test_record_count_golden.py

注意：``tests/perf`` 不是 Python 包，``python -m unittest discover -s tests``
**不会**收集到本文件；必须用上面两条命令之一显式运行，或接入 run.ps1。
"""

import json
import os
import pathlib
import random
import sys
import unittest
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ---------------------------------------------------------------------------
# 数据目录隔离：必须在 import db 之前完成，db 在 import 期读 MEMO_DATA_DIR。
# ---------------------------------------------------------------------------
RUN_NAME = "record-count-golden-" + uuid.uuid4().hex[:10]
RUN_DIR = ROOT / "_verification" / "perfvocab" / "A" / "record-count-golden" / RUN_NAME
os.makedirs(RUN_DIR.parent, exist_ok=True)
os.makedirs(RUN_DIR, exist_ok=True)
os.environ["MEMO_DATA_DIR"] = str(RUN_DIR)

import db  # noqa: E402  (import 顺序由上面的隔离要求决定)

REAL_DB = (ROOT / "data" / "memo-superform.db").resolve()

# 固定种子：黄金样本必须可重复。
GOLDEN_SEED = 20261116

# 伪造音节，与任何真实词库无关。
_SYLLABLES = ["ab", "ac", "ad", "ef", "ig", "op", "um", "en", "it", "ar",
              "or", "us", "is", "at", "an", "er", "on", "in", "pre", "pro"]
_RESPONSES = ["FAMILIAR", "WELL_FAMILIAR", "VAGUE", "FORGET"]

# 黄金计数矩阵：改这里必须同时解释原因，否则视为放宽基线。
GOLDEN_SCALE = {1000: 1000, 10000: 10000, 50000: 50000}


def synthetic_records(count, prefix, seed=GOLDEN_SEED):
    """确定性合成记录；prefix 让不同账号的数据互相可区分。"""
    rng = random.Random("%s:%s" % (seed, prefix))
    out = []
    for index in range(1, count + 1):
        word = "".join(rng.choice(_SYLLABLES) for _ in range(3)) + str(index)
        if index % 17 == 0:
            # 混入大写，覆盖 ORDER BY voc_spelling COLLATE NOCASE 排序分支。
            word = word[:1].upper() + word[1:]
        out.append({
            "voc_id": "%s-voc-%07d" % (prefix, index),
            "voc_spelling": word,
            "definition": "合成释义 %d" % index,
            "add_date": "2024-%02d-%02d" % (1 + index % 12, 1 + index % 28),
            "first_study_date": "2024-%02d-%02d" % (1 + index % 12, 1 + index % 28),
            "last_study_date": "2026-%02d-%02d" % (1 + index % 12, 1 + index % 28),
            "next_study_date": "2026-%02d-%02d" % (1 + index % 12, 1 + index % 28),
            "last_response": _RESPONSES[index % 4],
            "study_count": 1 + index % 38,
            "tags": "" if index % 4 else "合成标签%d" % (index % 7),
        })
    return out


def bulk_upsert(profile_key, records, chunk=2000):
    """分批走真实写入路径，避免单个巨事务拖慢 50k 场景。"""
    for start in range(0, len(records), chunk):
        db.upsert_study_records(profile_key, records[start:start + chunk])


def deactivate(profile_key, voc_ids):
    """通过真实列语义制造失活记录（夹具，不改业务代码）。"""
    ids = [str(item) for item in voc_ids]
    if not ids:
        return 0
    # 先解析主键：_profile_pk 可能自己开写事务，放进写事务里会自锁。
    pk = db._profile_pk(profile_key)
    with db._write_connection() as conn:
        for offset in range(0, len(ids), 500):
            part = ids[offset:offset + 500]
            marks = ",".join("?" for _ in part)
            cur = conn.execute(
                "UPDATE study_records SET is_active=0 WHERE profile_id=? AND voc_id IN (%s)" % marks,
                [pk] + part,
            )
            assert cur.rowcount == len(part), (
                "夹具未按预期停用记录：期望 %d 实际 %d" % (len(part), cur.rowcount))
    return len(ids)


class _GoldenCase(unittest.TestCase):
    """每个用例独占子目录，并硬校验没有摸到真实库。"""

    _counter = 0

    def setUp(self):
        type(self)._counter += 1
        self.data_dir = RUN_DIR / ("case-%03d-%s" % (type(self)._counter, uuid.uuid4().hex[:8]))
        os.makedirs(self.data_dir, exist_ok=True)
        db.init_db(str(self.data_dir))

        active = pathlib.Path(db.database_path()).resolve()
        self.assertTrue(
            str(active).startswith(str(RUN_DIR.resolve())),
            "db.database_path() 越出隔离目录：%s" % active,
        )
        self.assertNotEqual(active, REAL_DB, "拒绝在真实库上运行")

    def counts(self, profile_key):
        """返回 (默认视图计数, 含失活计数, 默认记录数, 含失活记录数)。"""
        records = db.get_records(profile_key)
        records_all = db.get_records(profile_key, include_inactive=True)
        return (
            db.get_record_count(profile_key),
            db.get_record_count(profile_key, include_inactive=True),
            len(records),
            len(records_all),
        )

    def assertGolden(self, profile_key, active, total):
        """核心闸门：两个方向都必须 count == len(records)，且等于黄金值。"""
        count_active, count_total, len_active, len_total = self.counts(profile_key)
        self.assertEqual(
            len_active, count_active,
            "include_inactive=False 不等价：len(get_records)=%d get_record_count=%d（profile=%s）"
            % (len_active, count_active, profile_key),
        )
        self.assertEqual(
            len_total, count_total,
            "include_inactive=True 不等价：len(get_records)=%d get_record_count=%d（profile=%s）"
            % (len_total, count_total, profile_key),
        )
        self.assertEqual(active, count_active, "默认视图计数偏离黄金值")
        self.assertEqual(total, count_total, "含失活计数偏离黄金值")
        self.assertLessEqual(count_active, count_total, "默认计数不应大于含失活计数")
        return count_active, count_total


class EmptyDatabaseGolden(_GoldenCase):
    """空库必须两边都是 0，而不是 None 或异常。"""

    def test_empty_database_is_zero_in_both_directions(self):
        profile = "empty-" + uuid.uuid4().hex
        count_active, count_total, len_active, len_total = self.counts(profile)
        self.assertEqual(0, count_active)
        self.assertEqual(0, count_total)
        self.assertEqual(0, len_active)
        self.assertEqual(0, len_total)
        self.assertEqual([], db.get_records(profile))
        self.assertEqual([], db.get_records(profile, include_inactive=True))

    def test_profile_created_but_no_records_is_zero(self):
        # ensure_sync_profile 会建 profiles/sync_state 行，但 study_records 为空。
        profile = "empty-sync-" + uuid.uuid4().hex
        db.ensure_sync_profile(profile)
        self.assertGolden(profile, 0, 0)

    def test_default_profile_on_empty_database_is_zero(self):
        # profile_id=None 走默认档案分支，空库同样必须是 0。
        self.assertEqual(0, db.get_record_count(None))
        self.assertEqual(0, db.get_record_count(None, include_inactive=True))
        self.assertEqual(0, len(db.get_records(None)))


class ScaleGolden(_GoldenCase):
    """1k / 10k / 50k 三种规模，全部活跃。"""

    def _run_scale(self, count, prefix):
        profile = "scale%d-%s" % (count, uuid.uuid4().hex)
        records = synthetic_records(count, prefix)
        self.assertEqual(count, len(records), "合成数据生成数量不符")
        bulk_upsert(profile, records)
        self.assertGolden(profile, count, count)

    def test_scale_1k(self):
        self._run_scale(1000, "g1k")

    def test_scale_10k(self):
        self._run_scale(10000, "g10k")

    def test_scale_50k(self):
        self._run_scale(50000, "g50k")


class InactiveGolden(_GoldenCase):
    """``is_active=0`` 的记录必须两个方向都被正确区分。"""

    def test_ten_percent_inactive_at_scale(self):
        for count, prefix, ratio in ((1000, "i1k", 10), (10000, "i10k", 10)):
            with self.subTest(count=count):
                profile = "inactive%d-%s" % (count, uuid.uuid4().hex)
                records = synthetic_records(count, prefix)
                bulk_upsert(profile, records)
                # 每 10 条停用 1 条（确定性）。
                victims = [r["voc_id"] for r in records if int(r["voc_id"].rsplit("-", 1)[1]) % ratio == 0]
                dead = deactivate(profile, victims)
                self.assertEqual(dead, len(victims))
                self.assertGreater(dead, 0, "夹具未真正制造失活记录")
                self.assertGolden(profile, count - dead, count)

    def test_all_inactive_profile_is_zero_active(self):
        profile = "allgone-" + uuid.uuid4().hex
        records = synthetic_records(200, "gone")
        bulk_upsert(profile, records)
        deactivate(profile, [r["voc_id"] for r in records])
        self.assertGolden(profile, 0, 200)

    def test_reactivation_restores_active_count(self):
        profile = "revive-" + uuid.uuid4().hex
        records = synthetic_records(120, "rv")
        bulk_upsert(profile, records)
        deactivate(profile, [r["voc_id"] for r in records])
        self.assertGolden(profile, 0, 120)
        # 重新 upsert 同批记录 = 真实业务里的"重新出现"，必须复活为活跃。
        bulk_upsert(profile, records)
        self.assertGolden(profile, 120, 120)

    def test_business_soft_delete_path_agrees(self):
        # 走真实核验路径（两次未见）而不是直接改列，验证业务语义下也等价。
        profile = "reconcile-" + uuid.uuid4().hex
        bulk_upsert(profile, synthetic_records(150, "rc"))
        self.assertGolden(profile, 150, 150)
        for _ in range(2):
            db.mark_reconcile_seen(profile, [])
            db.mark_absent_after_two_reconciles(profile)
        self.assertGolden(profile, 0, 150)


class MultiAccountGolden(_GoldenCase):
    """多账号 A/B 共用同一库文件，计数绝不能串号。"""

    def test_account_a_and_b_do_not_leak(self):
        account_a = "acct-A-" + uuid.uuid4().hex
        account_b = "acct-B-" + uuid.uuid4().hex
        records_a = synthetic_records(1000, "aa")
        records_b = synthetic_records(1000, "bb")
        bulk_upsert(account_a, records_a)
        bulk_upsert(account_b, records_b)

        self.assertGolden(account_a, 1000, 1000)
        self.assertGolden(account_b, 1000, 1000)

        # 交叉复测：前一次查询不能污染后一次。
        self.assertGolden(account_b, 1000, 1000)
        self.assertGolden(account_a, 1000, 1000)

    def test_unequal_accounts_keep_their_own_totals(self):
        account_a = "big-A-" + uuid.uuid4().hex
        account_b = "small-B-" + uuid.uuid4().hex
        bulk_upsert(account_a, synthetic_records(2000, "big"))
        bulk_upsert(account_b, synthetic_records(300, "sml"))
        self.assertGolden(account_a, 2000, 2000)
        self.assertGolden(account_b, 300, 300)

    def test_inactive_in_one_account_does_not_affect_the_other(self):
        account_a = "mix-A-" + uuid.uuid4().hex
        account_b = "mix-B-" + uuid.uuid4().hex
        records_a = synthetic_records(400, "ma")
        records_b = synthetic_records(400, "mb")
        bulk_upsert(account_a, records_a)
        bulk_upsert(account_b, records_b)
        deactivate(account_a, [r["voc_id"] for r in records_a])

        self.assertGolden(account_a, 0, 400)
        self.assertGolden(account_b, 400, 400)

    def test_account_switch_sequence_is_stable(self):
        # 模拟前端切换账号：A→B→A→B，每次计数都与该账号自身一致。
        account_a = "sw-A-" + uuid.uuid4().hex
        account_b = "sw-B-" + uuid.uuid4().hex
        records_a = synthetic_records(600, "swa")
        records_b = synthetic_records(250, "swb")
        bulk_upsert(account_a, records_a)
        bulk_upsert(account_b, records_b)
        deactivate(account_b, [r["voc_id"] for r in records_b if int(r["voc_id"].rsplit("-", 1)[1]) % 2 == 0])

        expected = {account_a: (600, 600), account_b: (125, 250)}
        for _ in range(3):
            for key in (account_a, account_b, account_a, account_b):
                active, total = expected[key]
                self.assertGolden(key, active, total)

    def test_distinct_voc_ids_across_accounts_are_not_merged(self):
        # 两账号用**相同** voc_id 前缀也不能合并成一份。
        shared = uuid.uuid4().hex
        account_a = "shared-A-" + shared
        account_b = "shared-B-" + shared
        same = synthetic_records(50, "dup")
        bulk_upsert(account_a, same)
        bulk_upsert(account_b, same)
        self.assertGolden(account_a, 50, 50)
        self.assertGolden(account_b, 50, 50)
        self.assertEqual(50, len(db.get_records(account_a)))
        self.assertEqual(50, len(db.get_records(account_b)))


class AnomalousDataGolden(_GoldenCase):
    """异常/边界数据不得让两条路径分叉。"""

    def test_rows_skipped_by_upsert_are_absent_from_both_paths(self):
        profile = "skip-" + uuid.uuid4().hex
        bad = [
            {"voc_id": "", "voc_spelling": "noword"},
            {"voc_id": "x1", "voc_spelling": ""},
            {"voc_id": "   ", "voc_spelling": "spaces"},
        ]
        db.upsert_study_records(profile, bad)
        self.assertGolden(profile, 0, 0)

    def test_rows_with_nullable_columns_are_counted(self):
        profile = "nulls-" + uuid.uuid4().hex
        rows = synthetic_records(60, "nl")
        for index, row in enumerate(rows):
            if index % 3 == 0:
                row["definition"] = ""
            if index % 5 == 0:
                row["tags"] = ""
            if index % 7 == 0:
                row["last_response"] = "STUDY_RESPONSE_UNSPECIFIED"
            if index % 11 == 0:
                row["next_study_date"] = ""
        bulk_upsert(profile, rows)
        self.assertGolden(profile, 60, 60)

    def test_count_follows_deletes_and_reinserts(self):
        profile = "churn-" + uuid.uuid4().hex
        records = synthetic_records(80, "ch")
        bulk_upsert(profile, records)
        self.assertGolden(profile, 80, 80)

        pk = db._profile_pk(profile)
        with db._write_connection() as conn:
            conn.execute("DELETE FROM study_records WHERE profile_id=? AND voc_id=?", (pk, "ch-voc-0000001"))
        self.assertGolden(profile, 79, 79)

        bulk_upsert(profile, records[:5], chunk=5)
        self.assertGolden(profile, 80, 80)

    def test_duplicate_upsert_does_not_double_count(self):
        profile = "dupe-" + uuid.uuid4().hex
        records = synthetic_records(40, "dp")
        bulk_upsert(profile, records)
        bulk_upsert(profile, records)
        bulk_upsert(profile, records)
        self.assertGolden(profile, 40, 40)


class OrderingAndShapeGolden(_GoldenCase):
    """计数替换不得改动 ``get_records`` 的顺序与字段形状。"""

    def test_ordering_is_nocase_spelling_then_voc_id(self):
        profile = "order-" + uuid.uuid4().hex
        bulk_upsert(profile, synthetic_records(500, "od"))
        rows = db.get_records(profile)
        keys = [(row["voc_spelling"].lower(), row["voc_id"]) for row in rows]
        self.assertEqual(sorted(keys), keys, "get_records 排序不再是 NOCASE 拼写 + voc_id")

    def test_shape_is_ten_projected_keys(self):
        profile = "shape-" + uuid.uuid4().hex
        bulk_upsert(profile, synthetic_records(3, "gp"))
        rows = db.get_records(profile)
        self.assertEqual(3, len(rows))
        self.assertEqual(
            sorted(["voc_id", "voc_spelling", "definition", "add_date", "first_study_date",
                    "last_study_date", "next_study_date", "last_response", "study_count", "tags"]),
            sorted(rows[0].keys()),
        )
        # SQL 投影 11 列（多出 is_active 仅用于过滤），对外仍是 10 个键。
        self.assertEqual(10, len(rows[0]))
        self.assertNotIn("is_active", rows[0])
        self.assertIsInstance(rows[0]["study_count"], int)


class GoldenMatrixReport(_GoldenCase):
    """把本次实际计数矩阵写成 JSON 证据，便于人工比对与跨轮对照。"""

    def test_write_golden_count_matrix(self):
        matrix = {"seed": GOLDEN_SEED, "run": RUN_NAME, "scenarios": {}}
        for count, prefix in ((1000, "m1k"), (10000, "m10k"), (50000, "m50k")):
            profile = "matrix%d-%s" % (count, uuid.uuid4().hex)
            bulk_upsert(profile, synthetic_records(count, prefix))
            victims = [r["voc_id"] for r in synthetic_records(count, prefix)
                       if int(r["voc_id"].rsplit("-", 1)[1]) % 10 == 0]
            deactivate(profile, victims)
            count_active, count_total, len_active, len_total = self.counts(profile)
            matrix["scenarios"]["scale_%d" % count] = {
                "expected_active": count - len(victims),
                "expected_total": count,
                "get_record_count_active": count_active,
                "get_record_count_total": count_total,
                "len_get_records_active": len_active,
                "len_get_records_total": len_total,
                "equivalent": count_active == len_active and count_total == len_total,
                "golden_matches": (count_active == count - len(victims) and count_total == count),
            }
            self.assertGolden(profile, count - len(victims), count)

        out = RUN_DIR / "golden-count-matrix.json"
        out.write_text(json.dumps(matrix, ensure_ascii=False, indent=2), encoding="utf-8")
        self.assertTrue(out.is_file(), "黄金矩阵未写出")
        for name, row in matrix["scenarios"].items():
            self.assertTrue(row["equivalent"], "%s 不等价" % name)
            self.assertTrue(row["golden_matches"], "%s 偏离黄金值" % name)


if __name__ == "__main__":
    unittest.main(verbosity=2)
