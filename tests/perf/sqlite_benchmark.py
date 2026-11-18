"""SQLite 热查询基准：在独立数据目录 + 合成数据上测量读取路径并给出查询计划。

只回答“真实查询计划和合成库耗时是否表明扫描/重复查询是瓶颈”，不据此臆造结论。
"""

import argparse
import json
import os
import shutil
import sqlite3
import pathlib
import statistics
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

REPEAT = 7


def percentile(values, p):
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, int(round(p * (len(ordered) - 1)))))
    return ordered[idx]


def summarise(values):
    return {
        "n": len(values),
        "min": min(values) if values else None,
        "median": statistics.median(values) if values else None,
        "p95": percentile(values, 0.95),
        "max": max(values) if values else None,
        "samples": [round(v, 4) for v in values],
    }


def bench(fn, repeat=REPEAT):
    samples = []
    for _ in range(repeat):
        t0 = time.perf_counter()
        result = fn()
        samples.append((time.perf_counter() - t0) * 1000)
        if result is not None and isinstance(result, list) and len(result) == 0:
            pass
    return summarise(samples)


def main():
    parser = argparse.ArgumentParser(description="SQLite 热查询基准")
    parser.add_argument("--scales", default="1000,10000,50000")
    parser.add_argument("--seed", type=int, default=20261008)
    parser.add_argument("--out", default=None)
    parser.add_argument("--keep-dir", default=None)
    args = parser.parse_args()

    import synthetic_dataset
    import db

    report = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "seed": args.seed, "repeat": REPEAT, "scales": []}
    for count in [int(s) for s in args.scales.split(",") if s.strip()]:
        data_dir = args.keep_dir or tempfile.mkdtemp(prefix="sqlite-bench-", dir=str(ROOT / "_verification"))
        data_dir = os.path.abspath(data_dir)
        os.environ["MEMO_DATA_DIR"] = data_dir
        records = synthetic_dataset.generate_records(count, seed=args.seed)
        info = synthetic_dataset.seed_database(data_dir, records, seed=args.seed)
        key = info["profile_key"]

        entry = {"count": count, "dataDir": data_dir}

        # 一次 /api/study-records 实际走过的本地读取链路（app_api.py）：
        # _profile_id -> ensure_sync_profile(写连接) + db.get_records(读连接) + db.get_sync_state(读连接)
        def request_path_fresh():
            pk = db._profile_pk(key)
            rows = db.get_records(key)
            db.get_sync_state(key)
            return len(rows), pk

        def request_path_reused():
            conn = db.get_connection()
            try:
                pk = conn.execute("SELECT profile_id FROM profiles WHERE token_hash=?",
                                  (db._normalise_profile_hash(key),)).fetchone()[0]
                rows = conn.execute(
                    "SELECT voc_id,voc_spelling,definition,add_date,first_study_date,last_study_date,"
                    "next_study_date,last_response,study_count,tags_json,is_active "
                    "FROM study_records WHERE profile_id=? AND is_active=1 "
                    "ORDER BY voc_spelling COLLATE NOCASE, voc_id", (pk,)).fetchall()
                conn.execute("SELECT * FROM sync_state WHERE profile_id=?", (pk,)).fetchone()
                return len(rows)
            finally:
                conn.close()

        # 关闭保活（默认状态）测量现状，再开启保活测量同一条链路。
        db.close_warm()
        entry["request_path_fresh_connections"] = bench(request_path_fresh)
        db.keep_warm(True)
        entry["request_path_fresh_with_keep_warm"] = bench(request_path_fresh)
        db.close_warm()
        entry["request_path_reused_connection"] = bench(request_path_reused)
        # 仅“新建连接 + 首次查询 + 关闭”的固定成本，用于判断上面差额的来源。
        def new_conn_first_query():
            conn = db.get_connection()
            try:
                conn.execute("SELECT 1").fetchone()
            finally:
                conn.close()

        pk_cached = db._profile_pk(key)

        def new_conn_count():
            conn = db.get_connection()
            try:
                conn.execute("SELECT COUNT(*) FROM study_records WHERE profile_id=? AND is_active=1",
                             (pk_cached,)).fetchone()
            finally:
                conn.close()

        entry["new_connection_first_query"] = bench(new_conn_first_query)
        entry["new_connection_count"] = bench(new_conn_count)

        # 根因对照：把同一份库复制为非 WAL 后测量新连接首次查询。
        # 用于区分“WAL 文件重建成本”与“库体积/目录/环境成本”。
        delete_copy = os.path.join(data_dir, "_bench_delete_mode.db")
        try:

            shutil.copy2(os.path.join(data_dir, "memo-superform.db"), delete_copy)
            conn = sqlite3.connect(delete_copy)
            conn.execute("PRAGMA journal_mode=DELETE")
            conn.close()

            def delete_mode_probe():
                c = sqlite3.connect(delete_copy, timeout=5.0, isolation_level=None, check_same_thread=False)
                try:
                    c.execute("SELECT 1").fetchone()
                finally:
                    c.close()

            entry["new_connection_first_query_delete_mode"] = bench(delete_mode_probe)
        finally:
            if os.path.exists(delete_copy):
                try:
                    os.remove(delete_copy)
                except OSError:
                    pass
        entry["get_records"] = bench(lambda: db.get_records(key))
        entry["get_record_count"] = bench(lambda: db.get_record_count(key))
        # 同数据不带排序读取，用于判断 ORDER BY COLLATE NOCASE 的代价占比。
        entry["select_no_order"] = bench(lambda: db.get_connection().execute(
            "SELECT voc_id,voc_spelling,definition,add_date,first_study_date,last_study_date,"
            "next_study_date,last_response,study_count,tags_json,is_active "
            "FROM study_records WHERE profile_id=? AND is_active=1",
            (db._profile_pk(key),)).fetchall())
        conn = db.get_connection()
        plan_order = conn.execute(
            "EXPLAIN QUERY PLAN SELECT voc_id,voc_spelling FROM study_records "
            "WHERE profile_id=? AND is_active=1 ORDER BY voc_spelling COLLATE NOCASE, voc_id",
            (db._profile_pk(key),)).fetchall()
        entry["plan_with_order"] = [str(row[-1]) for row in plan_order]
        entry["indexes"] = [dict(r) for r in conn.execute(
            "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")]
        conn.close()
        report["scales"].append(entry)
        print("sqlite scale %d: get_records median=%.2fms" % (count, entry["get_records"]["median"]))

    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2)
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
