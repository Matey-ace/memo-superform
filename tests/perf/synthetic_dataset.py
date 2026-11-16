"""确定性合成学习记录数据集。

本轮优化验证只使用合成数据：不读取、不上传、不改写用户词库与 `data/`。
字段形状参照本机真实库的**结构统计**（日期为 `YYYY-MM-DD`、last_response 取值
FAMILIAR/FORGET/VAGUE/WELL_FAMILIAR/STUDY_RESPONSE_UNSPECIFIED、study_count 1..38），
单词拼写为伪造音节词，与用户真实词汇无关。

生成参数固定种子，可重复；保存的是生成参数而非任何用户词库。
"""

import argparse
import hashlib
import json
import os
import random
import sys
from datetime import date, timedelta

# 与真实库一致的状态取值与分布（只读统计得到：FAMILIAR 2430 / WELL_FAMILIAR 671 /
# VAGUE 42 / FORGET 3 / UNSPECIFIED 2）。
RESPONSES = [
    ("FAMILIAR", 77),
    ("WELL_FAMILIAR", 21),
    ("VAGUE", 1),
    ("FORGET", 1),
]

SYLLABLES = [
    "ab", "ac", "ad", "ef", "ig", "op", "um", "en", "it", "ar",
    "or", "us", "is", "at", "an", "er", "on", "in", "un", "ex",
    "pre", "pro", "con", "com", "sub", "sur", "trans", "inter", "anti", "semi",
]
SUFFIXES = ["", "s", "ed", "ing", "er", "ly", "tion", "ment", "able", "ive"]

DEFAULT_SEED = 20261008
# 历史跨度：真实库 last_study_date 约 3.5 年；add_date 与之同范围。
HISTORY_DAYS = 1280
# 近期窗口：让热力图/趋势/增长图有可观的近期数据。
RECENT_DAYS = 400


def _pick_response(rng):
    total = sum(weight for _, weight in RESPONSES)
    roll = rng.randrange(total)
    acc = 0
    for name, weight in RESPONSES:
        acc += weight
        if roll < acc:
            return name
    return RESPONSES[0][0]


def _spelling(rng, index):
    """伪造音节词，避免与真实词汇和用户数据相关。首字母大小写混合以覆盖 NOCASE 排序。"""
    parts = [rng.choice(SYLLABLES) for _ in range(rng.randint(2, 3))]
    word = "".join(parts) + rng.choice(SUFFIXES)
    if index % 7 == 0:
        word = word[:1].upper() + word[1:]
    return word + str(index)


def generate_records(count, seed=DEFAULT_SEED, today=None):
    """生成 count 条确定性合成记录。"""
    rng = random.Random(seed)
    today = today or date.today()
    records = []
    seen = set()
    index = 0
    while len(records) < count:
        index += 1
        spelling = _spelling(rng, index)
        if spelling.lower() in seen:
            continue
        seen.add(spelling.lower())
        # add_date：过去 HISTORY_DAYS 天内均匀铺开。
        add_offset = rng.randrange(HISTORY_DAYS)
        add_date = today - timedelta(days=add_offset)
        # last_study_date：偏向近期（RECENT_DAYS），保证热力图/趋势有数据。
        span = min(RECENT_DAYS, add_offset + 1)
        last_offset = rng.randrange(span)
        last_date = today - timedelta(days=last_offset)
        if last_date < add_date:
            last_date = add_date
        study_count = rng.randint(1, 38)
        interval = rng.choice([1, 2, 3, 5, 7, 10, 14, 21, 30])
        next_date = last_date + timedelta(days=interval)
        records.append({
            "voc_id": "bench-voc-%06d" % index,
            "voc_spelling": spelling,
            "definition": "合成释义 %d（仅用于性能基准）" % index,
            "add_date": add_date.isoformat(),
            "first_study_date": add_date.isoformat(),
            "last_study_date": last_date.isoformat(),
            "next_study_date": next_date.isoformat(),
            "last_response": _pick_response(rng),
            "study_count": study_count,
            "tags": "" if index % 5 else "合成标签%d" % (index % 13),
        })
    return records


def seed_database(data_dir, records, token="bench-token", seed=DEFAULT_SEED):
    """把合成记录写入独立数据目录的 SQLite，返回 profile 键。"""
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    if root not in sys.path:
        sys.path.insert(0, root)
    os.environ["MEMO_DATA_DIR"] = data_dir
    os.makedirs(data_dir, exist_ok=True)

    import db
    import study_sync

    db.init_db(data_dir)
    profile_key = study_sync.token_profile_id(token)
    import time
    stats = None
    for attempt in range(3):
        try:
            stats = db.upsert_study_records(profile_key, records)
            break
        except Exception:
            if attempt == 2:
                raise
            time.sleep(0.4)
    # 先解析主键，避免在外层写事务内再开一个写连接导致自锁。
    pk = db._profile_pk(profile_key)
    now = db._utc_now()
    with db._write_connection() as conn:
        conn.execute(
            "INSERT INTO sync_state(profile_id,bootstrap_complete,local_record_count,"
            "last_status,last_success_at,updated_at) VALUES(?,1,?,'idle',?,?) "
            "ON CONFLICT(profile_id) DO UPDATE SET bootstrap_complete=1,"
            "local_record_count=excluded.local_record_count,last_status='idle',updated_at=excluded.updated_at",
            (pk, len(records), now, now),
        )
    return {
        "profile_key": profile_key,
        "token": token,
        "count": len(records),
        "upsert": stats,
        "db_path": os.path.join(data_dir, "memo-superform.db"),
    }


def main():
    parser = argparse.ArgumentParser(description="生成确定性合成学习记录数据集")
    parser.add_argument("--count", type=int, required=True)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--token", default="bench-token")
    parser.add_argument("--json-out", default=None)
    args = parser.parse_args()

    records = generate_records(args.count, seed=args.seed)
    info = seed_database(args.data_dir, records, token=args.token, seed=args.seed)
    fingerprint = hashlib.sha256(
        json.dumps(records, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    info["seed"] = args.seed
    info["fingerprint"] = fingerprint
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as handle:
            json.dump(info, handle, ensure_ascii=False, indent=2)
    print(json.dumps(info, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
