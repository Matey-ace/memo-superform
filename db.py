#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
db.py - MemoSuperform 数据库访问层 (SQL Server + T-SQL)
提供快照保存、每日统计、设置读写等基础能力。
所有日期均按北京时间(UTC+8)解释。
"""

import os
import pyodbc
from datetime import datetime, date, timezone, timedelta

def beijing_today():
    """\u8fd4\u56de\u5317\u4eac\u65f6\u95f4(UTC+8)\u7684\u5f53\u5929\u65e5\u671f\uff0c\u4f5c\u4e3a\u5168\u9879\u76ee\u7edf\u4e00\u7684\u201c\u4eca\u5929\u201d\u6765\u6e90\u3002"""
    return (datetime.now(timezone.utc) + timedelta(hours=8)).date()


DB_NAME = "MemoSuperform"
SERVER = r".\SQLEXPRESS"
DRIVER = "ODBC Driver 17 for SQL Server"
BJ_TZ = timezone(timedelta(hours=8))

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SCHEMA_PATH = os.path.join(BASE_DIR, "schema.sql")


def _master_conn_str():
    return f"Driver={{{DRIVER}}};Server={SERVER};Database=master;Trusted_Connection=yes;"


def _db_conn_str():
    return f"Driver={{{DRIVER}}};Server={SERVER};Database={DB_NAME};Trusted_Connection=yes;"


def get_connection(autocommit=True):
    """连接到 MemoSuperform 数据库。"""
    return pyodbc.connect(_db_conn_str(), autocommit=autocommit, timeout=15)


def init_db():
    """创建数据库与所有表（幂等）。"""
    master = pyodbc.connect(_master_conn_str(), autocommit=True, timeout=15)
    try:
        cur = master.cursor()
        cur.execute(
            "IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = ?) "
            "CREATE DATABASE " + DB_NAME,
            DB_NAME,
        )
    finally:
        master.close()

    conn = get_connection(autocommit=True)
    try:
        cur = conn.cursor()
        with open(SCHEMA_PATH, encoding="utf-8") as f:
            sql = f.read()
        for stmt in sql.split(";"):
            stmt = stmt.strip()
            if stmt:
                cur.execute(stmt)
    finally:
        conn.close()


# ---------- JSON 安全转换 ----------

def _json_safe(v):
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    return v


def rows_to_dicts(cursor):
    """把 pyodbc 游标结果转为 JSON 可序列化的 dict 列表。"""
    cols = [d[0] for d in cursor.description]
    return [{c: _json_safe(v) for c, v in zip(cols, row)} for row in cursor.fetchall()]


# ---------- study_records 快照 ----------

def save_snapshot(records):
    """保存当日快照：先删当日记录再批量插入。返回写入条数。
    records 为墨墨 API 原始记录(dict 列表)，字段 voc_spelling/next_study_date 等。"""
    today = beijing_today()
    rows = []
    for r in records:
        word = (r.get("voc_spelling") or r.get("word") or "").strip()
        if not word:
            continue
        rows.append((
            today,
            word,
            r.get("definition"),
            _parse_date(r.get("add_date")),
            _parse_date(r.get("last_study_date")),
            _parse_date(r.get("next_study_date")),
            r.get("last_response"),
        ))
    if not rows:
        return 0
    conn = get_connection(autocommit=False)
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM study_records WHERE snapshot_date = ?", today)
        sql = (
            "INSERT INTO study_records "
            "(snapshot_date, word, definition, add_date, last_study_date, next_study_date, last_response) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        cur.fast_executemany = True
        cur.executemany(sql, rows)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return len(rows)


def has_today_snapshot():
    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(1) FROM study_records WHERE snapshot_date = ?", beijing_today())
        return cur.fetchone()[0] > 0
    finally:
        conn.close()


def has_today_recommendations():
    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(1) FROM recommendations WHERE recommend_date = ?", beijing_today())
        return cur.fetchone()[0] > 0
    finally:
        conn.close()


# ---------- daily_stats 每日统计 ----------

def compute_and_save_daily_stats(stat_date=None):
    """从当日快照聚合统计并 upsert(MERGE)。"""
    if stat_date is None:
        stat_date = beijing_today()
    conn = get_connection(autocommit=True)
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT
                COUNT(1),
                ISNULL(SUM(CASE WHEN add_date = ? THEN 1 ELSE 0 END), 0),
                ISNULL(SUM(CASE WHEN last_study_date = ? THEN 1 ELSE 0 END), 0),
                ISNULL(SUM(CASE WHEN last_response IN ('WELL_FAMILIAR','FAMILIAR') THEN 1 ELSE 0 END), 0),
                ISNULL(SUM(CASE WHEN last_response = 'VAGUE' THEN 1 ELSE 0 END), 0),
                ISNULL(SUM(CASE WHEN last_response = 'FORGET' THEN 1 ELSE 0 END), 0),
                ISNULL(SUM(CASE WHEN next_study_date IS NOT NULL AND next_study_date < ? THEN 1 ELSE 0 END), 0)
            FROM study_records
            WHERE snapshot_date = ?
            """,
            (stat_date, stat_date, stat_date, stat_date),
        )
        row = cur.fetchone()
        total, new_w, reviewed, fam, vague, forget, overdue = [int(r or 0) for r in row]
        cur.execute(
            """
            MERGE daily_stats AS t
            USING (SELECT ? AS stat_date) AS s ON (t.stat_date = s.stat_date)
            WHEN MATCHED THEN UPDATE SET
                total_words = ?, new_words = ?, reviewed_words = ?,
                familiar_count = ?, vague_count = ?, forget_count = ?, overdue_count = ?
            WHEN NOT MATCHED THEN INSERT
                (stat_date, total_words, new_words, reviewed_words, familiar_count, vague_count, forget_count, overdue_count)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?);
            """,
            (stat_date, total, new_w, reviewed, fam, vague, forget, overdue,
             stat_date, total, new_w, reviewed, fam, vague, forget, overdue),
        )
        return {
            "stat_date": str(stat_date),
            "total_words": total, "new_words": new_w, "reviewed_words": reviewed,
            "familiar_count": fam, "vague_count": vague, "forget_count": forget,
            "overdue_count": overdue,
        }
    finally:
        conn.close()


def get_history_stats(days=30):
    conn = get_connection()
    try:
        cur = conn.cursor()
        start = beijing_today() - timedelta(days=days)
        cur.execute(
            """
            SELECT stat_date, total_words, new_words, reviewed_words,
                   familiar_count, vague_count, forget_count, overdue_count
            FROM daily_stats
            WHERE stat_date >= ?
            ORDER BY stat_date
            """,
            (start,),
        )
        return rows_to_dicts(cur)
    finally:
        conn.close()


# ---------- settings 设置 ----------

def get_setting(key, default=None):
    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT value_text FROM settings WHERE key_name = ?", key)
        row = cur.fetchone()
        return row[0] if row else default
    finally:
        conn.close()


def set_setting(key, value):
    conn = get_connection(autocommit=True)
    try:
        cur = conn.cursor()
        cur.execute(
            """
            MERGE settings AS t
            USING (SELECT ? AS k) AS s ON (t.key_name = s.k)
            WHEN MATCHED THEN UPDATE SET value_text = ?, updated_at = GETDATE()
            WHEN NOT MATCHED THEN INSERT (key_name, value_text) VALUES (?, ?);
            """,
            (key, str(value), key, str(value)),
        )
    finally:
        conn.close()


# ---------- helpers ----------

def _parse_date(v):
    """把墨墨返回的日期(UTC ISO 字符串/时间戳)转为北京时间的 date。"""
    if not v:
        return None
    if isinstance(v, datetime):
        return v.astimezone(BJ_TZ).date() if v.tzinfo else v.date()
    if isinstance(v, date):
        return v
    s = str(v).strip()
    if not s or s.lower() in ("none", "null"):
        return None
    if s.isdigit():
        n = int(s)
        if n > 10 ** 12:
            n //= 1000
        try:
            return datetime.utcfromtimestamp(n).replace(tzinfo=timezone.utc).astimezone(BJ_TZ).date()
        except Exception:
            return None
    iso = s.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(iso)
    except ValueError:
        s2 = s.replace("/", "-").split("T")[0].split(" ")[0]
        for fmt in ("%Y-%m-%d", "%Y%m%d"):
            try:
                return datetime.strptime(s2, fmt).date()
            except ValueError:
                continue
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(BJ_TZ)
    return dt.date()


if __name__ == "__main__":
    print("init db ...")
    init_db()
    print("OK: db ready")