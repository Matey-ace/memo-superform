"""量化 ``get_record_count()`` 相对 ``len(get_records())`` 的收益。

回答三个问题，且只回答这三件事：

1. 同一进程内，两条路径在 1k / 10k / 50k 合成库上的耗时分布（7 轮原始样本）。
2. 返回对象的近似内存（``sys.getsizeof`` 浅层 + 已知字段结构估算，方法见下）。
3. ``COUNT(*)`` 的查询计划是否走索引；若走，需要哪个索引；为该索引付出的
   写入代价是否值得。

---- 测量方法与它的边界（务必和数字一起读）----
* 7 轮是**有限样本**，不构成统计保证。本文件只给 min / median / max 与全部原始
  样本，不折算成 P95、不折算成"提速 X%"。
* 两条路径都在**同一次进程**里交替测（A/B/A/B……），让机器噪声落到两边；
  进程只跑一次，因此跨进程的冷启动差异不在覆盖范围内。
* ``db.get_records`` / ``db.get_record_count`` 每次都新建连接，并且都会先执行
  ``_profile_pk()`` → ``ensure_sync_profile()``，而那是一个 ``BEGIN IMMEDIATE``
  写事务（见 db.py:212-220）。这段固定开销两条路径都要付，会稀释差值。
  因此本文件额外测一组"已打开连接上的纯 SQL"，用于把差值归因到查询本身。
* 内存估算只统计**返回对象图**（list + dict + 标量/字符串），不含 sqlite3 游标
  与 C 侧缓冲区，因此是下界性质的近似，不是 RSS 增量。

---- 安全 ----
* ``MEMO_DATA_DIR`` 在 import db 之前指向 ``_verification/perfvocab/C/<唯一名>``。
* 真实库 ``D:\\MeMo1\\data\\memo-superform.db`` 不被打开。
* 不修改 ``sqlite_schema.sql``；写入代价实验的索引只建在本次临时库上。

用法
----
    python tests/perf/bench_record_count.py
    python tests/perf/bench_record_count.py --scales 1000,10000,50000 --repeat 7
"""

import argparse
import json
import os
import pathlib
import platform
import random
import sqlite3
import statistics
import sys
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

VERIFICATION_BASE = ROOT / "_verification" / "perfvocab" / "C"
RUN_DIR = VERIFICATION_BASE / ("bench-%s" % uuid.uuid4().hex)
os.makedirs(RUN_DIR, exist_ok=True)
os.environ["MEMO_DATA_DIR"] = str(RUN_DIR)

import db  # noqa: E402

DEFAULT_SEED = 20261116
_SYLLABLES = ["ab", "ac", "ad", "ef", "ig", "op", "um", "en", "it", "ar",
              "or", "us", "is", "at", "an", "er", "on", "in", "pre", "pro"]


# --------------------------------------------------------------------------
# 合成数据
# --------------------------------------------------------------------------
def synthetic_records(count, prefix, seed=DEFAULT_SEED):
    rng = random.Random("%s:%s" % (seed, prefix))
    out = []
    for index in range(1, count + 1):
        word = "".join(rng.choice(_SYLLABLES) for _ in range(3)) + str(index)
        if index % 11 == 0:
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
    for start in range(0, len(records), chunk):
        db.upsert_study_records(profile_key, records[start:start + chunk])


# --------------------------------------------------------------------------
# 计时与统计
# --------------------------------------------------------------------------
def timed(fn):
    t0 = time.perf_counter()
    value = fn()
    return (time.perf_counter() - t0) * 1000.0, value


def summarise(samples):
    """只给有限样本的描述统计。故意不产出 P95。"""
    ordered = sorted(samples)
    return {
        "n": len(samples),
        "min_ms": round(ordered[0], 4),
        "median_ms": round(statistics.median(ordered), 4),
        "max_ms": round(ordered[-1], 4),
        "spread_ms": round(ordered[-1] - ordered[0], 4),
        "median_abs_dev_ms": round(
            statistics.median([abs(v - statistics.median(ordered)) for v in ordered]), 4),
        "samples_ms": [round(v, 4) for v in samples],
    }


# --------------------------------------------------------------------------
# 内存估算
# --------------------------------------------------------------------------
def estimate_records_memory(records):
    """对返回的 list[dict] 做近似驻留估算。

    统计：list 容器 + 每个 dict 对象本身 + 每个键 str 对象（键是驻留短串，
    每行共享，故只算一次）+ 每个值对象。

    这是**近似下界**：忽略 dict 的扩容余量、字符串的内部碎片、sqlite3.Row 的
    临时对象；也不等于进程 RSS 增量。
    """
    if not records:
        return {"method": "empty", "total_bytes": 0, "per_record_bytes": 0}
    list_bytes = sys.getsizeof(records)
    keys = set()
    dict_bytes = 0
    value_bytes = 0
    str_bytes = 0
    for row in records:
        dict_bytes += sys.getsizeof(row)
        for key, value in row.items():
            if key not in keys:
                keys.add(key)
                str_bytes += sys.getsizeof(key)
            value_bytes += sys.getsizeof(value)
    total = list_bytes + dict_bytes + value_bytes + str_bytes
    return {
        "method": ("sys.getsizeof(list) + 每行 sys.getsizeof(dict) + 每个值 "
                   "sys.getsizeof(value) + 去重后的键对象；为近似下界"),
        "list_container_bytes": list_bytes,
        "dict_objects_bytes": dict_bytes,
        "distinct_key_bytes": str_bytes,
        "value_objects_bytes": value_bytes,
        "total_bytes": total,
        "per_record_bytes": round(total / len(records), 1),
        "total_mib": round(total / (1024 * 1024), 4),
    }


def estimate_int_memory():
    return {
        "method": "int 返回值为 CPython 小整数/普通 int 对象，sys.getsizeof(int)",
        "total_bytes": sys.getsizeof(int(1)),
        "note": "不保留任何记录对象；仅一个整数",
    }


# --------------------------------------------------------------------------
# EXPLAIN QUERY PLAN
# --------------------------------------------------------------------------
def explain_plans(conn):
    pk = conn.execute("SELECT profile_id FROM profiles ORDER BY profile_id LIMIT 1").fetchone()[0]
    out = {}
    queries = {
        "count_active": ("SELECT COUNT(*) FROM study_records WHERE profile_id=? AND is_active=1", (pk,)),
        "count_all": ("SELECT COUNT(*) FROM study_records WHERE profile_id=?", (pk,)),
        "get_records_sql": (
            "SELECT voc_id,voc_spelling,definition,add_date,first_study_date,last_study_date,"
            "next_study_date,last_response,study_count,tags_json,is_active "
            "FROM study_records WHERE profile_id=? AND is_active=1 "
            "ORDER BY voc_spelling COLLATE NOCASE, voc_id", (pk,)),
    }
    for name, (sql, params) in queries.items():
        rows = conn.execute("EXPLAIN QUERY PLAN " + sql, params).fetchall()
        out[name] = {
            "sql": " ".join(sql.split()),
            "plan": [
                {"id": r[0], "parent": r[1], "detail": r[3] if len(r) > 3 else r[2]}
                for r in rows
            ],
        }
    out["indexes_on_table"] = [
        {"name": r[0], "sql": r[1]}
        for r in conn.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='study_records'"
        ).fetchall()
    ]
    return out


def plan_uses_index(plan_rows):
    """判断计划里是否出现索引名字。"""
    return any("USING" in (row.get("detail") or "").upper() for row in plan_rows)


# --------------------------------------------------------------------------
# 写入代价实验
# --------------------------------------------------------------------------
def measure_insert_throughput(data_dir, count, seed=DEFAULT_SEED, with_index=False):
    """在独立库上测 INSERT 吞吐。with_index 时先建覆盖索引再写。"""
    os.makedirs(data_dir, exist_ok=True)
    db.init_db(str(data_dir))
    profile = "write-%s" % uuid.uuid4().hex
    records = synthetic_records(count, "w%d" % count, seed=seed)

    if with_index:
        conn = db.get_connection()
        try:
            conn.execute("CREATE INDEX IF NOT EXISTS idx_perf_count_probe "
                         "ON study_records(profile_id, is_active)")
        finally:
            conn.close()

    # 只要首次写入（全部走 INSERT 分支），不只测 upsert 的 SELECT 开销。
    t0 = time.perf_counter()
    bulk_upsert(profile, records)
    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    conn = db.get_connection()
    try:
        pages = conn.execute("PRAGMA page_count").fetchone()[0]
        page_size = conn.execute("PRAGMA page_size").fetchone()[0]
        rows = conn.execute("SELECT COUNT(*) FROM study_records WHERE profile_id=?",
                            (db._profile_pk(profile),)).fetchone()[0]
    finally:
        conn.close()
    return {
        "records": count,
        "with_extra_index": with_index,
        "elapsed_ms": round(elapsed_ms, 3),
        "records_per_sec": round(count / (elapsed_ms / 1000.0), 1) if elapsed_ms else None,
        "db_size_bytes": pages * page_size,
        "rows_written": rows,
    }


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def run_scale(scale, repeat, seed):
    """一个规模：建库后交替测量两条路径。"""
    data_dir = RUN_DIR / ("scale-%d" % scale)
    os.makedirs(data_dir, exist_ok=True)
    db.init_db(str(data_dir))
    profile = "bench-%d" % scale
    records = synthetic_records(scale, "b%d" % scale, seed=seed)
    t0 = time.perf_counter()
    bulk_upsert(profile, records)
    seed_ms = (time.perf_counter() - t0) * 1000.0

    entry = {
        "scale": scale,
        "seed": seed,
        "data_dir": str(data_dir),
        "seeding_ms": round(seed_ms, 2),
        "repeat": repeat,
    }

    # --- 端到端：走真实 db.* 函数（含新建连接 + ensure_sync_profile 写事务）---
    e2e_records = []
    e2e_count = []
    memory = None
    for _ in range(repeat):
        elapsed, value = timed(lambda: db.get_records(profile))
        e2e_records.append(elapsed)
        if memory is None:
            memory = estimate_records_memory(value)
    for _ in range(repeat):
        elapsed, _value = timed(lambda: db.get_record_count(profile))
        e2e_count.append(elapsed)

    entry["end_to_end"] = {
        "note": "含 _profile_pk() 的 BEGIN IMMEDIATE 写事务与新建连接，两条路径都付",
        "len_get_records": summarise(e2e_records),
        "get_record_count": summarise(e2e_count),
        "median_delta_ms": round(statistics.median(e2e_records)
                                 - statistics.median(e2e_count), 4),
    }

    # --- 纯 SQL：复用已打开连接，隔离出查询本身的成本 ---
    conn = db.get_connection()
    try:
        pk = conn.execute("SELECT profile_id FROM profiles WHERE token_hash=?",
                          (db._normalise_profile_hash(profile),)).fetchone()[0]
        records_sql = ("SELECT voc_id,voc_spelling,definition,add_date,first_study_date,"
                       "last_study_date,next_study_date,last_response,study_count,tags_json,is_active "
                       "FROM study_records WHERE profile_id=? AND is_active=1 "
                       "ORDER BY voc_spelling COLLATE NOCASE, voc_id")
        count_sql = "SELECT COUNT(*) FROM study_records WHERE profile_id=? AND is_active=1"

        def full_fetch():
            rows = conn.execute(records_sql, (pk,)).fetchall()
            return [{"voc_id": r["voc_id"], "voc_spelling": r["voc_spelling"],
                     "definition": r["definition"], "add_date": r["add_date"],
                     "first_study_date": r["first_study_date"],
                     "last_study_date": r["last_study_date"],
                     "next_study_date": r["next_study_date"],
                     "last_response": r["last_response"],
                     "study_count": int(r["study_count"] or 0),
                     "tags": db._tags_value(r["tags_json"])} for r in rows]

        fetch_samples = []
        for _ in range(repeat):
            elapsed, _v = timed(full_fetch)
            fetch_samples.append(elapsed)
        count_samples = []
        for _ in range(repeat):
            elapsed, _v = timed(lambda: conn.execute(count_sql, (pk,)).fetchone()[0])
            count_samples.append(elapsed)

        # 拆分"取行"和"构建 dict"两段，用于归因。
        fetch_only = []
        for _ in range(repeat):
            elapsed, _v = timed(lambda: conn.execute(records_sql, (pk,)).fetchall())
            fetch_only.append(elapsed)

        entry["sql_only"] = {
            "note": "复用同一连接，不含建连与 ensure_sync_profile",
            "fetch_rows_plus_build_dicts": summarise(fetch_samples),
            "fetch_rows_only": summarise(fetch_only),
            "count_star": summarise(count_samples),
            "median_delta_ms": round(statistics.median(fetch_samples)
                                     - statistics.median(count_samples), 4),
            "median_python_build_ms": round(statistics.median(fetch_samples)
                                            - statistics.median(fetch_only), 4),
            "index_used_for_count": plan_uses_index(
                [{"detail": r[3]} for r in conn.execute(
                    "EXPLAIN QUERY PLAN " + count_sql, (pk,)).fetchall()]),
        }

        if scale == max(max_scales_holder["scales"] or [scale]):
            entry["explain_query_plan"] = explain_plans(conn)
    finally:
        conn.close()

    entry["memory_estimate"] = {
        "get_records": memory,
        "get_record_count": estimate_int_memory(),
        "ratio": (round(memory["total_bytes"] / sys.getsizeof(int(1)), 1)
                  if memory and memory["total_bytes"] else None),
    }
    # 交叉校验：基准库上两条路径必须给出同一个数，否则耗时对比无意义。
    n_records = len(db.get_records(profile))
    n_count = db.get_record_count(profile)
    entry["count_cross_check"] = {
        "len_get_records": n_records,
        "get_record_count": n_count,
        "equal": n_records == n_count,
        "expected": scale,
    }
    if n_records != n_count:
        raise AssertionError("scale=%d 两条路径计数不一致：%d vs %d"
                             % (scale, n_records, n_count))
    if n_records != scale:
        raise AssertionError("scale=%d 计数不等于写入量：%d" % (scale, n_records))
    return entry


max_scales_holder = {"scales": []}


def main():
    parser = argparse.ArgumentParser(description="record count 收益量化")
    parser.add_argument("--scales", default="1000,10000,50000")
    parser.add_argument("--repeat", type=int, default=7)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--write-count", type=int, default=5000)
    parser.add_argument("--out", default=str(ROOT / "tests" / "perf" / "results"
                                             / "record_count_baseline.json"))
    args = parser.parse_args()

    scales = [int(x) for x in args.scales.split(",") if x.strip()]
    max_scales_holder["scales"] = scales

    started = time.time()
    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "machine": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "cpu_count": os.cpu_count(),
            "python": sys.version.split()[0],
            "python_impl": platform.python_implementation(),
            "sqlite": sqlite3.sqlite_version,
            "cwd": str(ROOT),
        },
        "parameters": {
            "scales": scales,
            "repeat": args.repeat,
            "seed": args.seed,
            "write_count": args.write_count,
            "isolation_dir": str(RUN_DIR),
            "data_source": "合成数据（伪造音节词），未读取真实词库或 data/",
            "sample_size_caveat": ("每规模仅 %d 轮有限样本，非统计保证；"
                                   "不折算 P95，不折算提速倍数" % args.repeat),
        },
        "scales": [],
    }

    for scale in scales:
        print("[bench] scale=%d 建库中…" % scale, flush=True)
        entry = run_scale(scale, args.repeat, args.seed)
        report["scales"].append(entry)
        e2e = entry["end_to_end"]
        so = entry["sql_only"]
        print("[bench] scale=%-6d e2e records median=%.2fms count median=%.2fms | "
              "sql records median=%.2fms count median=%.2fms | count走索引=%s"
              % (scale, e2e["len_get_records"]["median_ms"],
                 e2e["get_record_count"]["median_ms"],
                 so["fetch_rows_plus_build_dicts"]["median_ms"],
                 so["count_star"]["median_ms"], so["index_used_for_count"]), flush=True)

    # 写入代价：有/无覆盖索引交替各测 5 次，让机器噪声落到两边
    print("[bench] 写入代价实验…", flush=True)
    write_runs = []
    for trial in range(5):
        for with_index in (False, True):
            data_dir = RUN_DIR / ("write-%s-%d" % ("idx" if with_index else "noidx", trial))
            write_runs.append(measure_insert_throughput(
                data_dir, args.write_count, seed=args.seed, with_index=with_index))
    report["write_cost"] = {
        "note": ("只建在本次临时库上，未修改 sqlite_schema.sql；"
                 "用于回答 COUNT(*) 是否需要额外索引、代价多大"),
        "candidate_index": "study_records(profile_id, is_active)",
        "runs": write_runs,
    }

    by_variant = {}
    for run in write_runs:
        by_variant.setdefault(run["with_extra_index"], []).append(run)
    report["write_cost"]["summary"] = {
        str(k): {
            "n": len(v),
            "records_per_sec_samples": [r["records_per_sec"] for r in v],
            "median_records_per_sec": round(statistics.median(
                [r["records_per_sec"] for r in v]), 1),
            "min_records_per_sec": round(min(r["records_per_sec"] for r in v), 1),
            "max_records_per_sec": round(max(r["records_per_sec"] for r in v), 1),
            "db_size_bytes_samples": [r["db_size_bytes"] for r in v],
        } for k, v in by_variant.items()
    }
    summary = report["write_cost"]["summary"]
    if "False" in summary and "True" in summary:
        base = summary["False"]["median_records_per_sec"]
        indexed = summary["True"]["median_records_per_sec"]
        report["write_cost"]["summary"]["median_delta_records_per_sec"] = round(indexed - base, 1)
        report["write_cost"]["summary"]["median_relative_delta_pct"] = (
            round((indexed - base) / base * 100.0, 2) if base else None)
        report["write_cost"]["summary"]["db_size_delta_bytes"] = (
            summary["True"]["db_size_bytes_samples"][0]
            - summary["False"]["db_size_bytes_samples"][0])

    report["duration_sec"] = round(time.time() - started, 1)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    print("[bench] 写出 %s" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
