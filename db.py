#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Memo Superform SQLite 数据中心。

从 v0.70 起 SQLite 是唯一运行时数据库。旧 SQL Server 数据库绝不以写入方式
打开；可选的惰性导入器能够复制其中稳定的统计/设置，且启动不依赖 pyodbc。
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from typing import Any, Mapping, Optional, Sequence

BJ_TZ = timezone(timedelta(hours=8))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SQLITE_SCHEMA_PATH = os.path.join(BASE_DIR, "sqlite_schema.sql")
LEGACY_SCHEMA_PATH = os.path.join(BASE_DIR, "schema.sql")
DEFAULT_PROFILE_HASH = hashlib.sha256(b"memo-superform-legacy-default").hexdigest()
_DATA_DIR = os.environ.get("MEMO_DATA_DIR") or os.path.join(BASE_DIR, "data")
_DB_PATH = os.path.join(_DATA_DIR, "memo-superform.db")
_INIT_LOCK = threading.RLock()
_INITIALISED = False


def beijing_today() -> date:
    return datetime.now(timezone.utc).astimezone(BJ_TZ).date()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def database_path() -> str:
    return _DB_PATH


def _connect(*, autocommit: bool = True) -> sqlite3.Connection:
    conn = sqlite3.connect(_DB_PATH, timeout=5.0,
                           isolation_level=None if autocommit else "DEFERRED",
                           check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def get_connection(autocommit: bool = True) -> sqlite3.Connection:
    if not _INITIALISED:
        init_db()
    return _connect(autocommit=autocommit)


def init_db(data_dir: Optional[str] = None) -> str:
    """初始化或迁移可写 SQLite 数据库，并返回其路径。"""
    global _DATA_DIR, _DB_PATH, _INITIALISED
    with _INIT_LOCK:
        if data_dir:
            resolved = os.path.abspath(data_dir)
            if resolved != os.path.abspath(_DATA_DIR):
                _DATA_DIR = resolved
                _DB_PATH = os.path.join(_DATA_DIR, "memo-superform.db")
                _INITIALISED = False
        os.makedirs(_DATA_DIR, exist_ok=True)
        with open(SQLITE_SCHEMA_PATH, "r", encoding="utf-8") as handle:
            schema = handle.read()
        conn = _connect(autocommit=True)
        try:
            conn.executescript(schema)
            now = _utc_now()
            conn.execute("INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES(1,?,?)",
                         ("v0.70 sqlite data centre", now))
            conn.execute("INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES(2,?,?)",
                         ("v0.72 Live2D companion registry", now))
            conn.execute("INSERT OR IGNORE INTO profiles(token_hash,display_name,created_at,updated_at) VALUES(?,?,?,?)",
                         (DEFAULT_PROFILE_HASH, "legacy-default", now, now))
            check = conn.execute("PRAGMA quick_check").fetchone()[0]
            if str(check).lower() != "ok":
                raise RuntimeError("SQLite quick_check failed: %s" % check)
            _INITIALISED = True
            return _DB_PATH
        finally:
            conn.close()


@contextmanager
def _write_connection():
    conn = get_connection(autocommit=True)
    try:
        conn.execute("BEGIN IMMEDIATE")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _normalise_profile_hash(value: Any) -> str:
    if value is None or value == "":
        return DEFAULT_PROFILE_HASH
    if isinstance(value, int):
        conn = get_connection()
        try:
            row = conn.execute("SELECT token_hash FROM profiles WHERE profile_id=?", (value,)).fetchone()
            if not row:
                raise KeyError("unknown profile")
            return str(row[0])
        finally:
            conn.close()
    text = str(value).strip().lower()
    if len(text) == 64 and all(ch in "0123456789abcdef" for ch in text):
        return text
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def ensure_sync_profile(profile_id: Any) -> int:
    token_hash, now = _normalise_profile_hash(profile_id), _utc_now()
    with _write_connection() as conn:
        conn.execute("INSERT OR IGNORE INTO profiles(token_hash,created_at,updated_at) VALUES(?,?,?)",
                     (token_hash, now, now))
        conn.execute("UPDATE profiles SET updated_at=? WHERE token_hash=?", (now, token_hash))
        pk = int(conn.execute("SELECT profile_id FROM profiles WHERE token_hash=?", (token_hash,)).fetchone()[0])
        conn.execute("INSERT OR IGNORE INTO sync_state(profile_id,updated_at) VALUES(?,?)", (pk, now))
    return pk


def get_or_create_profile(token: str) -> str:
    token_hash = hashlib.sha256((token or "").strip().encode("utf-8")).hexdigest()
    ensure_sync_profile(token_hash)
    return token_hash


def delete_profile_learning_data(profile_id: Any = None) -> dict[str, int]:
    """删除一个本机档案的学习数据和同步派生结果。

    保留 ``profiles`` 行及 Live2D 偏好：断开账号或重建学习库不应丢失用户本机
    的角色/陪伴设置。下次同步时 ``ensure_sync_profile`` 会重新创建 sync_state。
    """
    profile_hash = _normalise_profile_hash(profile_id)
    tables = (
        "study_records", "study_record_snapshots", "snapshot_runs", "daily_stats",
        "recommendations", "sync_runs", "sync_segments", "sync_today_items", "sync_state",
    )
    deleted: dict[str, int] = {}
    with _write_connection() as conn:
        row = conn.execute("SELECT profile_id FROM profiles WHERE token_hash=?", (profile_hash,)).fetchone()
        if not row:
            return {name: 0 for name in tables}
        pk = int(row[0])
        # 所有表名均来自上方固定白名单，不接受外部路径或字符串。
        for table in tables:
            cursor = conn.execute("DELETE FROM " + table + " WHERE profile_id=?", (pk,))
            deleted[table] = max(0, int(cursor.rowcount or 0))
        conn.execute("UPDATE profiles SET updated_at=? WHERE profile_id=?", (_utc_now(), pk))
    return deleted


def _profile_pk(profile_id: Any = None) -> int:
    return ensure_sync_profile(profile_id)


def _json_safe(value: Any) -> Any:
    return value.isoformat() if isinstance(value, (datetime, date)) else value


def rows_to_dicts(cursor) -> list[dict[str, Any]]:
    rows = cursor.fetchall()
    if not rows:
        return []
    if isinstance(rows[0], sqlite3.Row):
        return [{key: _json_safe(row[key]) for key in row.keys()} for row in rows]
    cols = [desc[0] for desc in cursor.description]
    return [{key: _json_safe(value) for key, value in zip(cols, row)} for row in rows]


def _date_text(value: Any) -> Optional[str]:
    parsed = _parse_date(value)
    return parsed.isoformat() if parsed else None


def _tags_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value if value is not None else "", ensure_ascii=False,
                      sort_keys=True, separators=(",", ":"))


def _tags_value(value: Optional[str]) -> Any:
    text = "" if value is None else str(value)
    if text.startswith(("[", "{", '"')):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass
    return text


def _record_hash(record: Mapping[str, Any]) -> str:
    payload = {
        "voc_id": str(record.get("voc_id") or ""),
        "voc_spelling": str(record.get("voc_spelling") or record.get("word") or ""),
        "add_date": _date_text(record.get("add_date")),
        "first_study_date": _date_text(record.get("first_study_date")),
        "last_study_date": _date_text(record.get("last_study_date")),
        "next_study_date": _date_text(record.get("next_study_date")),
        "last_response": record.get("last_response"),
        "study_count": int(record.get("study_count") or 0),
        "tags": record.get("tags", ""),
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                           separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def get_records(profile_id: Any = None, *, include_inactive: bool = False) -> list[dict[str, Any]]:
    pk, conn = _profile_pk(profile_id), get_connection()
    try:
        sql = """SELECT voc_id,voc_spelling,definition,add_date,first_study_date,last_study_date,
                        next_study_date,last_response,study_count,tags_json,is_active
                 FROM study_records WHERE profile_id=?"""
        if not include_inactive:
            sql += " AND is_active=1"
        sql += " ORDER BY voc_spelling COLLATE NOCASE, voc_id"
        rows = conn.execute(sql, (pk,)).fetchall()
        return [{"voc_id": row["voc_id"], "voc_spelling": row["voc_spelling"],
                 "definition": row["definition"], "add_date": row["add_date"],
                 "first_study_date": row["first_study_date"],
                 "last_study_date": row["last_study_date"],
                 "next_study_date": row["next_study_date"],
                 "last_response": row["last_response"],
                 "study_count": int(row["study_count"] or 0),
                 "tags": _tags_value(row["tags_json"])} for row in rows]
    finally:
        conn.close()


def get_record_count(profile_id: Any = None, *, include_inactive: bool = False) -> int:
    pk, conn = _profile_pk(profile_id), get_connection()
    try:
        sql = "SELECT COUNT(*) FROM study_records WHERE profile_id=?"
        if not include_inactive:
            sql += " AND is_active=1"
        return int(conn.execute(sql, (pk,)).fetchone()[0])
    finally:
        conn.close()


def get_study_record_hashes(profile_id: Any, voc_ids: Sequence[str]) -> dict[str, str]:
    pk, result, conn = _profile_pk(profile_id), {}, get_connection()
    try:
        values = [str(item) for item in voc_ids if str(item)]
        for offset in range(0, len(values), 800):
            part = values[offset:offset + 800]
            if not part:
                continue
            marks = ",".join("?" for _ in part)
            rows = conn.execute("SELECT voc_id,record_hash FROM study_records WHERE profile_id=? AND voc_id IN (%s)" % marks,
                                [pk] + part).fetchall()
            result.update({str(row[0]): str(row[1]) for row in rows})
        return result
    finally:
        conn.close()


def upsert_study_records(profile_id: Any, records: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    pk, now = _profile_pk(profile_id), _utc_now()
    added = updated = unchanged = 0
    with _write_connection() as conn:
        for raw in records:
            voc_id = str(raw.get("voc_id") or "").strip()
            spelling = str(raw.get("voc_spelling") or raw.get("word") or "").strip()
            if not voc_id or not spelling:
                continue
            digest = str(raw.get("content_hash") or _record_hash(raw))
            existing = conn.execute("SELECT record_hash FROM study_records WHERE profile_id=? AND voc_id=?",
                                    (pk, voc_id)).fetchone()
            if existing and existing[0] == digest:
                unchanged += 1
                continue
            common = (spelling, raw.get("definition"), _date_text(raw.get("add_date")),
                      _date_text(raw.get("first_study_date")), _date_text(raw.get("last_study_date")),
                      _date_text(raw.get("next_study_date")), raw.get("last_response"),
                      int(raw.get("study_count") or 0), _tags_text(raw.get("tags", "")), digest)
            if existing:
                conn.execute("""UPDATE study_records SET voc_spelling=?,definition=?,add_date=?,first_study_date=?,
                    last_study_date=?,next_study_date=?,last_response=?,study_count=?,tags_json=?,record_hash=?,
                    is_active=1,missing_reconcile_count=0,updated_at=?,last_seen_at=?
                    WHERE profile_id=? AND voc_id=?""", common + (now, now, pk, voc_id))
                updated += 1
            else:
                conn.execute("""INSERT INTO study_records(profile_id,voc_id,voc_spelling,definition,add_date,
                    first_study_date,last_study_date,next_study_date,last_response,study_count,tags_json,record_hash,
                    is_active,missing_reconcile_count,created_at,updated_at,last_seen_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,0,?,?,?)""", (pk, voc_id) + common + (now, now, now))
                added += 1
        count = int(conn.execute("SELECT COUNT(*) FROM study_records WHERE profile_id=? AND is_active=1", (pk,)).fetchone()[0])
        conn.execute("UPDATE sync_state SET local_record_count=?,updated_at=? WHERE profile_id=?", (count, now, pk))
    return {"added": added, "updated": updated, "unchanged": unchanged}


def get_due_candidate_voc_ids(profile_id: Any, start_date: date, end_date: date) -> list[str]:
    pk, conn = _profile_pk(profile_id), get_connection()
    try:
        rows = conn.execute("""SELECT voc_id FROM study_records WHERE profile_id=? AND is_active=1
            AND next_study_date IS NOT NULL AND substr(next_study_date,1,10)>=?
            AND substr(next_study_date,1,10)<=?""", (pk, str(start_date), str(end_date))).fetchall()
        return [str(row[0]) for row in rows]
    finally:
        conn.close()


_SYNC_COLUMNS = {"bootstrap_complete", "last_remote_count", "last_incremental_at",
                 "last_incremental_date", "last_reconcile_at", "last_today_probe_at",
                 "last_success_at", "last_status", "needs_reconcile", "last_error",
                 "local_record_count", "coverage_start", "coverage_end"}


def get_sync_state(profile_id: Any) -> dict[str, Any]:
    pk, conn = _profile_pk(profile_id), get_connection()
    try:
        row = conn.execute("SELECT * FROM sync_state WHERE profile_id=?", (pk,)).fetchone()
        if not row:
            return {}
        result = dict(row)
        result.pop("profile_id", None)
        extra = result.pop("extra_json", None)
        if extra:
            try:
                result.update(json.loads(extra))
            except (TypeError, json.JSONDecodeError):
                pass
        result["bootstrap_complete"] = bool(result.get("bootstrap_complete"))
        result["needs_reconcile"] = bool(result.get("needs_reconcile"))
        result["records_count"] = int(result.get("local_record_count") or 0)
        if result.get("coverage_start") or result.get("coverage_end"):
            result["coverage"] = {"start": result.get("coverage_start"), "end": result.get("coverage_end")}
        return result
    finally:
        conn.close()


def set_sync_state(profile_id: Any, **values: Any) -> None:
    pk, now = _profile_pk(profile_id), _utc_now()
    with _write_connection() as conn:
        row = conn.execute("SELECT extra_json FROM sync_state WHERE profile_id=?", (pk,)).fetchone()
        try:
            extra = json.loads(row[0] or "{}") if row else {}
        except (TypeError, json.JSONDecodeError):
            extra = {}
        known = {key: value for key, value in values.items() if key in _SYNC_COLUMNS}
        for key in ("bootstrap_complete", "needs_reconcile"):
            if key in known:
                known[key] = 1 if known[key] else 0
        for key, value in values.items():
            if key not in _SYNC_COLUMNS:
                extra[key] = _json_safe(value)
        known["extra_json"], known["updated_at"] = json.dumps(extra, ensure_ascii=False, sort_keys=True, default=str), now
        assignments = ",".join("%s=?" % key for key in known)
        conn.execute("UPDATE sync_state SET %s WHERE profile_id=?" % assignments, list(known.values()) + [pk])


def mark_needs_reconcile(profile_id: Any, reason: str) -> None:
    set_sync_state(profile_id, needs_reconcile=True, last_error=str(reason), last_status="needs_reconcile")


def get_today_item_hashes(profile_id: Any, item_date: date, voc_ids: Sequence[str]) -> dict[str, str]:
    pk, values, result, conn = _profile_pk(profile_id), [str(v) for v in voc_ids if str(v)], {}, get_connection()
    try:
        for offset in range(0, len(values), 800):
            part = values[offset:offset + 800]
            if not part:
                continue
            marks = ",".join("?" for _ in part)
            rows = conn.execute("SELECT voc_id,record_hash FROM sync_today_items WHERE profile_id=? AND sync_date=? AND voc_id IN (%s)" % marks,
                                [pk, str(item_date)] + part).fetchall()
            result.update({str(row[0]): str(row[1]) for row in rows})
        return result
    finally:
        conn.close()


def upsert_today_items(profile_id: Any, item_date: date, items: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    pk, now = _profile_pk(profile_id), _utc_now()
    added = updated = unchanged = 0
    with _write_connection() as conn:
        for item in items:
            voc_id, digest = str(item.get("voc_id") or "").strip(), str(item.get("content_hash") or "")
            if voc_id and digest:
                previous = conn.execute(
                    "SELECT record_hash FROM sync_today_items WHERE profile_id=? AND sync_date=? AND voc_id=?",
                    (pk, str(item_date), voc_id),
                ).fetchone()
                if previous and previous[0] == digest:
                    unchanged += 1
                    continue
                conn.execute("""INSERT INTO sync_today_items(profile_id,sync_date,voc_id,record_hash,observed_at)
                    VALUES(?,?,?,?,?) ON CONFLICT(profile_id,sync_date,voc_id)
                    DO UPDATE SET record_hash=excluded.record_hash,observed_at=excluded.observed_at""",
                             (pk, str(item_date), voc_id, digest, now))
                if previous:
                    updated += 1
                else:
                    added += 1
        conn.execute("DELETE FROM sync_today_items WHERE profile_id=? AND sync_date<?",
                     (pk, (beijing_today() - timedelta(days=14)).isoformat()))
    return {"added": added, "updated": updated, "unchanged": unchanged}


def is_sync_interval_complete(profile_id: Any, start_date: date, end_date: date) -> bool:
    pk = _profile_pk(profile_id)
    start, end, conn = date.fromisoformat(str(start_date)[:10]), date.fromisoformat(str(end_date)[:10]), get_connection()
    try:
        rows = conn.execute("""SELECT start_date,end_date FROM sync_segments WHERE profile_id=?
            AND source='bootstrap' AND complete=1 AND end_date>=? AND start_date<=?
            ORDER BY start_date,end_date""", (pk, start.isoformat(), end.isoformat())).fetchall()
        cursor = start
        for row in rows:
            left, right = date.fromisoformat(row[0]), date.fromisoformat(row[1])
            if left > cursor:
                return False
            if right >= cursor:
                cursor = right + timedelta(days=1)
            if cursor > end:
                return True
        return cursor > end
    finally:
        conn.close()


def record_sync_interval(profile_id: Any, start_date: date, end_date: date, *, complete: bool, source: str) -> None:
    pk, now = _profile_pk(profile_id), _utc_now()
    with _write_connection() as conn:
        conn.execute("""INSERT INTO sync_segments(profile_id,start_date,end_date,source,complete,updated_at)
            VALUES(?,?,?,?,?,?) ON CONFLICT(profile_id,start_date,end_date,source)
            DO UPDATE SET complete=excluded.complete,updated_at=excluded.updated_at""",
                     (pk, str(start_date), str(end_date), str(source), 1 if complete else 0, now))
        if complete:
            state = conn.execute("SELECT coverage_start,coverage_end FROM sync_state WHERE profile_id=?", (pk,)).fetchone()
            cov_start = min(state[0], str(start_date)) if state and state[0] else str(start_date)
            cov_end = max(state[1], str(end_date)) if state and state[1] else str(end_date)
            conn.execute("UPDATE sync_state SET coverage_start=?,coverage_end=?,updated_at=? WHERE profile_id=?",
                         (cov_start, cov_end, now, pk))


def begin_sync_run(profile_id: Any, mode: str, reason: str) -> int:
    pk = _profile_pk(profile_id)
    with _write_connection() as conn:
        return int(conn.execute("INSERT INTO sync_runs(profile_id,mode,reason,status,started_at) VALUES(?,?,?,?,?)",
                                (pk, mode, reason, "running", _utc_now())).lastrowid)


def finish_sync_run(run_id: int, status: str, details: Mapping[str, Any]) -> None:
    now = _utc_now()
    with _write_connection() as conn:
        conn.execute("""UPDATE sync_runs SET status=?,finished_at=?,fetched_count=?,inserted_count=?,
            updated_count=?,unchanged_count=?,error_text=?,details_json=? WHERE run_id=?""",
                     (status, now, int(details.get("records_count") or 0), int(details.get("added") or 0),
                      int(details.get("updated") or 0), int(details.get("unchanged") or 0),
                      details.get("error"), json.dumps(dict(details), ensure_ascii=False, default=str), int(run_id)))
        row = conn.execute("SELECT profile_id FROM sync_runs WHERE run_id=?", (int(run_id),)).fetchone()
        if row:
            conn.execute("""UPDATE sync_state SET last_status=?,
                last_success_at=CASE WHEN ?='completed' THEN ? ELSE last_success_at END,
                last_error=?,updated_at=? WHERE profile_id=?""",
                         (status, status, now, details.get("error"), now, int(row[0])))


def mark_reconcile_seen(profile_id: Any, voc_ids: Sequence[str]) -> None:
    pk = _profile_pk(profile_id)
    with _write_connection() as conn:
        conn.execute("UPDATE study_records SET missing_reconcile_count=missing_reconcile_count+1 WHERE profile_id=? AND is_active=1", (pk,))
        values = [str(v) for v in voc_ids if str(v)]
        for offset in range(0, len(values), 800):
            part = values[offset:offset + 800]
            marks = ",".join("?" for _ in part)
            conn.execute("UPDATE study_records SET missing_reconcile_count=0,is_active=1 WHERE profile_id=? AND voc_id IN (%s)" % marks,
                         [pk] + part)


def mark_absent_after_two_reconciles(profile_id: Any) -> int:
    pk = _profile_pk(profile_id)
    with _write_connection() as conn:
        cur = conn.execute("UPDATE study_records SET is_active=0,updated_at=? WHERE profile_id=? AND is_active=1 AND missing_reconcile_count>=2",
                           (_utc_now(), pk))
        return int(cur.rowcount or 0)


def save_snapshot(records: Sequence[Mapping[str, Any]], profile_id: Any = None) -> int:
    pk, today, now = _profile_pk(profile_id), beijing_today().isoformat(), _utc_now()
    inserted = 0
    with _write_connection() as conn:
        conn.execute("INSERT OR IGNORE INTO snapshot_runs(profile_id,snapshot_date,created_at) VALUES(?,?,?)", (pk, today, now))
        for raw in records:
            voc_id = str(raw.get("voc_id") or "").strip()
            spelling = str(raw.get("voc_spelling") or raw.get("word") or "").strip()
            if not voc_id or not spelling:
                continue
            cur = conn.execute("""INSERT OR IGNORE INTO study_record_snapshots(profile_id,snapshot_date,voc_id,
                voc_spelling,definition,add_date,first_study_date,last_study_date,next_study_date,last_response,
                study_count,tags_json,record_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                               (pk, today, voc_id, spelling, raw.get("definition"), _date_text(raw.get("add_date")),
                                _date_text(raw.get("first_study_date")), _date_text(raw.get("last_study_date")),
                                _date_text(raw.get("next_study_date")), raw.get("last_response"), int(raw.get("study_count") or 0),
                                _tags_text(raw.get("tags", "")), str(raw.get("content_hash") or _record_hash(raw)), now))
            inserted += max(0, int(cur.rowcount or 0))
    return inserted


def has_today_snapshot(profile_id: Any = None) -> bool:
    pk, conn = _profile_pk(profile_id), get_connection()
    try:
        return conn.execute("SELECT 1 FROM snapshot_runs WHERE profile_id=? AND snapshot_date=?",
                            (pk, beijing_today().isoformat())).fetchone() is not None
    finally:
        conn.close()


def has_today_recommendations(profile_id: Any = None) -> bool:
    pk, conn = _profile_pk(profile_id), get_connection()
    try:
        return conn.execute("SELECT 1 FROM recommendations WHERE profile_id=? AND recommend_date=? LIMIT 1",
                            (pk, beijing_today().isoformat())).fetchone() is not None
    finally:
        conn.close()


def compute_and_save_daily_stats(stat_date: Optional[date] = None, profile_id: Any = None) -> dict[str, Any]:
    target, pk = stat_date or beijing_today(), _profile_pk(profile_id)
    target_text, conn = str(target)[:10], get_connection()
    try:
        if target < beijing_today():
            old = conn.execute("SELECT * FROM daily_stats WHERE profile_id=? AND stat_date=?", (pk, target_text)).fetchone()
            if old:
                return {key: old[key] for key in old.keys() if key not in {"profile_id", "created_at", "updated_at"}}
        row = conn.execute("""SELECT COUNT(*),
            COALESCE(SUM(CASE WHEN substr(add_date,1,10)=? THEN 1 ELSE 0 END),0),
            COALESCE(SUM(CASE WHEN substr(last_study_date,1,10)=? THEN 1 ELSE 0 END),0),
            COALESCE(SUM(CASE WHEN last_response IN ('WELL_FAMILIAR','FAMILIAR') THEN 1 ELSE 0 END),0),
            COALESCE(SUM(CASE WHEN last_response='VAGUE' THEN 1 ELSE 0 END),0),
            COALESCE(SUM(CASE WHEN last_response='FORGET' THEN 1 ELSE 0 END),0),
            COALESCE(SUM(CASE WHEN next_study_date IS NOT NULL AND substr(next_study_date,1,10)<? THEN 1 ELSE 0 END),0)
            FROM study_record_snapshots WHERE profile_id=? AND snapshot_date=?""",
                           (target_text, target_text, target_text, pk, target_text)).fetchone()
    finally:
        conn.close()
    values = [int(item or 0) for item in row]
    keys = ("total_words", "new_words", "reviewed_words", "familiar_count", "vague_count", "forget_count", "overdue_count")
    now = _utc_now()
    with _write_connection() as conn:
        conn.execute("""INSERT INTO daily_stats(profile_id,stat_date,total_words,new_words,reviewed_words,familiar_count,
            vague_count,forget_count,overdue_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(profile_id,stat_date) DO UPDATE SET total_words=excluded.total_words,
            new_words=excluded.new_words,reviewed_words=excluded.reviewed_words,familiar_count=excluded.familiar_count,
            vague_count=excluded.vague_count,forget_count=excluded.forget_count,overdue_count=excluded.overdue_count,
            updated_at=excluded.updated_at""", (pk, target_text, *values, now, now))
    return {"stat_date": target_text, **dict(zip(keys, values))}


def get_history_stats(days: int = 30, profile_id: Any = None) -> list[dict[str, Any]]:
    pk, start, conn = _profile_pk(profile_id), (beijing_today() - timedelta(days=int(days) - 1)).isoformat(), get_connection()
    try:
        return rows_to_dicts(conn.execute("""SELECT stat_date,total_words,new_words,reviewed_words,familiar_count,
            vague_count,forget_count,overdue_count FROM daily_stats WHERE profile_id=? AND stat_date>=? ORDER BY stat_date""",
                                          (pk, start)))
    finally:
        conn.close()


def get_setting(key: str, default: Any = None) -> Any:
    conn = get_connection()
    try:
        row = conn.execute("SELECT value_text FROM settings WHERE key_name=?", (str(key),)).fetchone()
        return row[0] if row else default
    finally:
        conn.close()


def set_setting(key: str, value: Any) -> None:
    now = _utc_now()
    with _write_connection() as conn:
        conn.execute("""INSERT INTO settings(key_name,value_text,updated_at) VALUES(?,?,?)
            ON CONFLICT(key_name) DO UPDATE SET value_text=excluded.value_text,updated_at=excluded.updated_at""",
                     (str(key), str(value), now))


# ===================== Live2D 陪伴模型注册表 =====================

def upsert_live2d_model(metadata: Mapping[str, Any]) -> None:
    """注册已校验的本地模型，模型文件继续保存在磁盘。"""
    now = _utc_now()
    fields = {
        "model_id": str(metadata["model_id"]),
        "source": str(metadata.get("source") or "import"),
        "character_id": str(metadata.get("character_id") or ""),
        "display_name": str(metadata.get("display_name") or metadata["model_id"]),
        "catalog_name": str(metadata.get("catalog_name") or ""),
        "model_format": str(metadata.get("model_format") or "cubism2"),
        "relative_path": str(metadata["relative_path"]),
        "entry_file": str(metadata["entry_file"]),
        "manifest_json": json.dumps(metadata.get("manifest") or {}, ensure_ascii=False, sort_keys=True),
        "byte_size": int(metadata.get("byte_size") or 0),
        "complete": 1 if metadata.get("complete", True) else 0,
    }
    with _write_connection() as conn:
        conn.execute(
            "INSERT INTO live2d_models(model_id,source,character_id,display_name,catalog_name,model_format,relative_path,entry_file,manifest_json,byte_size,complete,created_at,updated_at) "
            "VALUES(:model_id,:source,:character_id,:display_name,:catalog_name,:model_format,:relative_path,:entry_file,:manifest_json,:byte_size,:complete,:now,:now) "
            "ON CONFLICT(model_id) DO UPDATE SET source=excluded.source,character_id=excluded.character_id,display_name=excluded.display_name,catalog_name=excluded.catalog_name,model_format=excluded.model_format,relative_path=excluded.relative_path,entry_file=excluded.entry_file,manifest_json=excluded.manifest_json,byte_size=excluded.byte_size,complete=excluded.complete,updated_at=excluded.updated_at",
            dict(fields, now=now),
        )


def _live2d_row(row: Any) -> Optional[dict[str, Any]]:
    if not row:
        return None
    item = {key: _json_safe(row[key]) for key in row.keys()}
    try:
        item["manifest"] = json.loads(item.pop("manifest_json") or "{}")
    except json.JSONDecodeError:
        item["manifest"] = {}
    item["complete"] = bool(item.get("complete"))
    return item


def list_live2d_models() -> list[dict[str, Any]]:
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM live2d_models ORDER BY updated_at DESC, display_name COLLATE NOCASE").fetchall()
        return [_live2d_row(row) for row in rows]
    finally:
        conn.close()


def get_live2d_model(model_id: str) -> Optional[dict[str, Any]]:
    conn = get_connection()
    try:
        return _live2d_row(conn.execute("SELECT * FROM live2d_models WHERE model_id=?", (str(model_id),)).fetchone())
    finally:
        conn.close()


def remove_live2d_model(model_id: str) -> bool:
    with _write_connection() as conn:
        result = conn.execute("DELETE FROM live2d_models WHERE model_id=?", (str(model_id),))
        conn.execute("UPDATE live2d_preferences SET active_model_id=NULL, updated_at=? WHERE active_model_id=?", (_utc_now(), str(model_id)))
        return result.rowcount > 0


def set_live2d_preference(profile_id: Any, *, active_model_id: Optional[str] = None,
                          companion_enabled: Optional[bool] = None) -> dict[str, Any]:
    profile_pk, now = _profile_pk(profile_id), _utc_now()
    with _write_connection() as conn:
        conn.execute("INSERT OR IGNORE INTO live2d_preferences(profile_id,updated_at) VALUES(?,?)", (profile_pk, now))
        changes, values = [], []
        if active_model_id is not None:
            changes.append("active_model_id=?")
            values.append(str(active_model_id) if active_model_id else None)
        if companion_enabled is not None:
            changes.append("companion_enabled=?")
            values.append(1 if companion_enabled else 0)
        if changes:
            values.extend([now, profile_pk])
            conn.execute("UPDATE live2d_preferences SET " + ", ".join(changes) + ", updated_at=? WHERE profile_id=?", values)
    return get_live2d_preference(profile_id)


def get_live2d_preference(profile_id: Any = None) -> dict[str, Any]:
    profile_pk = _profile_pk(profile_id)
    conn = get_connection()
    try:
        row = conn.execute("SELECT active_model_id,companion_enabled,updated_at FROM live2d_preferences WHERE profile_id=?", (profile_pk,)).fetchone()
        if not row:
            return {"active_model_id": None, "companion_enabled": False}
        return {"active_model_id": row["active_model_id"], "companion_enabled": bool(row["companion_enabled"]), "updated_at": row["updated_at"]}
    finally:
        conn.close()


def try_import_legacy_sqlserver(profile_id: Any = None) -> dict[str, Any]:
    """只读且幂等的旧库导入；缺少 pyodbc/SQL 时正常跳过。"""
    pk = _profile_pk(profile_id)
    import_key = "sqlserver:%s" % _normalise_profile_hash(profile_id)
    conn = get_connection()
    try:
        prior = conn.execute("SELECT status,details_json FROM legacy_imports WHERE import_key=?", (import_key,)).fetchone()
        if prior and prior[0] == "completed":
            return {"status": "completed", "skipped": True, "details": json.loads(prior[1] or "{}")}
    finally:
        conn.close()
    try:
        import pyodbc  # type: ignore
        server = os.environ.get("MEMO_DB_SERVER") or (r".\SQLEXPRESS" if os.name == "nt" else "localhost")
        driver = os.environ.get("MEMO_DB_DRIVER") or ("ODBC Driver 17 for SQL Server" if os.name == "nt" else "ODBC Driver 18 for SQL Server")
        user = os.environ.get("MEMO_DB_USER")
        auth = "UID=%s;PWD=%s;" % (user, os.environ.get("MEMO_DB_PASSWORD", "")) if user else "Trusted_Connection=yes;"
        source = pyodbc.connect("Driver={%s};Server=%s;Database=MemoSuperform;%sApplicationIntent=ReadOnly;" %
                                (driver, server, auth), autocommit=True, timeout=3)
        copied = {"daily_stats": 0, "recommendations": 0, "settings": 0}
        try:
            stats = source.cursor().execute("SELECT stat_date,total_words,new_words,reviewed_words,familiar_count,vague_count,forget_count,overdue_count FROM daily_stats").fetchall()
            settings = source.cursor().execute("SELECT key_name,value_text FROM settings").fetchall()
            recs = source.cursor().execute("SELECT recommend_date,word,definition,risk_score,overdue_days,gap_days,last_response,next_study_date,status,reviewed_at FROM recommendations").fetchall()
            now = _utc_now()
            with _write_connection() as target:
                for row in stats:
                    target.execute("""INSERT OR IGNORE INTO daily_stats(profile_id,stat_date,total_words,new_words,
                        reviewed_words,familiar_count,vague_count,forget_count,overdue_count,created_at,updated_at)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?)""", (pk, str(row[0])[:10], *[int(v or 0) for v in row[1:]], now, now))
                    copied["daily_stats"] += 1
                for row in settings:
                    target.execute("INSERT OR IGNORE INTO settings(key_name,value_text,updated_at) VALUES(?,?,?)", (str(row[0]), row[1], now))
                    copied["settings"] += 1
                for index, row in enumerate(recs):
                    legacy_voc = "legacy:%s:%s" % (str(row[0])[:10], hashlib.sha1((str(row[1]) + str(index)).encode()).hexdigest()[:16])
                    target.execute("""INSERT OR IGNORE INTO recommendations(profile_id,recommend_date,voc_id,word,
                        definition,risk_score,overdue_days,gap_days,last_response,next_study_date,status,reviewed_at,
                        created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                                   (pk, str(row[0])[:10], legacy_voc, row[1], row[2], int(row[3] or 0), int(row[4] or 0),
                                    int(row[5] or 0), row[6], _date_text(row[7]), row[8] or "pending", _json_safe(row[9]), now, now))
                    copied["recommendations"] += 1
                target.execute("""INSERT INTO legacy_imports(import_key,source_name,status,imported_at,details_json,error_text)
                    VALUES(?,?,?,?,?,NULL) ON CONFLICT(import_key) DO UPDATE SET status=excluded.status,
                    imported_at=excluded.imported_at,details_json=excluded.details_json,error_text=NULL""",
                               (import_key, "SQL Server MemoSuperform (read-only)", "completed", now, json.dumps(copied)))
            return {"status": "completed", "skipped": False, "details": copied}
        finally:
            source.close()
    except Exception as exc:
        return {"status": "unavailable", "error": str(exc)}


def _parse_date(value: Any) -> Optional[date]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value.astimezone(BJ_TZ).date() if value.tzinfo else value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    if not text or text.lower() in {"none", "null"}:
        return None
    if text.isdigit():
        number = int(text)
        if number > 10 ** 12:
            number //= 1000
        try:
            return datetime.fromtimestamp(number, tz=timezone.utc).astimezone(BJ_TZ).date()
        except (ValueError, OSError, OverflowError):
            return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed.astimezone(BJ_TZ).date() if parsed.tzinfo else parsed.date()
    except ValueError:
        clean = text.replace("/", "-").split("T")[0].split(" ")[0]
        for fmt in ("%Y-%m-%d", "%Y%m%d"):
            try:
                return datetime.strptime(clean, fmt).date()
            except ValueError:
                continue
    return None


if __name__ == "__main__":
    print(init_db())
