#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""基于 SQLite 的复习推荐引擎，评分与 v0.69 兼容。"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Optional

import db


def _as_date(value: Any) -> Optional[date]:
    return db._parse_date(value)


def _risk_row(row, today: date) -> dict[str, Any]:
    next_day, last_day = _as_date(row["next_study_date"]), _as_date(row["last_study_date"])
    overdue_days = (today - next_day).days if next_day else 0
    gap_days = (today - last_day).days if last_day else 0
    if next_day is None:
        overdue_score = 0
    elif next_day < today:
        overdue_score = min(50, max(0, overdue_days) * 5)
    elif next_day == today:
        overdue_score = 25
    else:
        overdue_score = 0
    response_score = {"FORGET": 30, "VAGUE": 20, "FAMILIAR": 10, "WELL_FAMILIAR": 5}.get(
        row["last_response"], 15)
    gap_score = 10 if last_day is None else min(20, max(0, gap_days))
    return {
        "voc_id": row["voc_id"], "word": row["voc_spelling"], "definition": row["definition"],
        "risk_score": overdue_score + response_score + gap_score,
        "overdue_days": overdue_days, "gap_days": gap_days,
        "last_response": row["last_response"], "next_study_date": row["next_study_date"],
        "_null_next": 1 if next_day is None else 0,
    }


def generate_recommendations(top_n: int = 30, profile_id: Any = None) -> int:
    """原子生成今日前 N 条推荐，并保留已复习状态。"""
    pk, today = db._profile_pk(profile_id), db.beijing_today()
    today_text, horizon = today.isoformat(), (today + timedelta(days=7)).isoformat()
    conn = db.get_connection()
    try:
        rows = conn.execute("""SELECT voc_id,voc_spelling,definition,last_study_date,next_study_date,last_response
            FROM study_records WHERE profile_id=? AND is_active=1
              AND (next_study_date IS NULL OR substr(next_study_date,1,10)<=?)""", (pk, horizon)).fetchall()
    finally:
        conn.close()
    candidates = [_risk_row(row, today) for row in rows]
    candidates.sort(key=lambda item: (-item["risk_score"], item["_null_next"], -item["overdue_days"], item["word"].lower()))
    selected = candidates[:max(0, int(top_n))]
    selected_ids = {item["voc_id"] for item in selected}
    now = datetime.now(db.BJ_TZ).isoformat()
    with db._write_connection() as conn:
        existing = {row["voc_id"]: row for row in conn.execute(
            "SELECT voc_id,status,reviewed_at FROM recommendations WHERE profile_id=? AND recommend_date=?",
            (pk, today_text)).fetchall()}
        for item in selected:
            old = existing.get(item["voc_id"])
            status, reviewed_at = (old["status"], old["reviewed_at"]) if old else ("pending", None)
            conn.execute("""INSERT INTO recommendations(profile_id,recommend_date,voc_id,word,definition,risk_score,
                overdue_days,gap_days,last_response,next_study_date,status,reviewed_at,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id,recommend_date,voc_id) DO UPDATE SET
                word=excluded.word,definition=excluded.definition,risk_score=excluded.risk_score,
                overdue_days=excluded.overdue_days,gap_days=excluded.gap_days,last_response=excluded.last_response,
                next_study_date=excluded.next_study_date,status=excluded.status,reviewed_at=excluded.reviewed_at,
                updated_at=excluded.updated_at""",
                         (pk, today_text, item["voc_id"], item["word"], item["definition"], item["risk_score"],
                          item["overdue_days"], item["gap_days"], item["last_response"], item["next_study_date"],
                          status, reviewed_at, now, now))
        # 过期待处理行属于派生数据；已复习行保留作为审计轨迹。
        if selected_ids:
            marks = ",".join("?" for _ in selected_ids)
            conn.execute("DELETE FROM recommendations WHERE profile_id=? AND recommend_date=? AND status='pending' AND voc_id NOT IN (%s)" % marks,
                         [pk, today_text] + sorted(selected_ids))
        else:
            conn.execute("DELETE FROM recommendations WHERE profile_id=? AND recommend_date=? AND status='pending'", (pk, today_text))
    return len(selected)


def get_today_recommendations(profile_id: Any = None) -> list[dict[str, Any]]:
    pk, today, conn = db._profile_pk(profile_id), db.beijing_today().isoformat(), db.get_connection()
    try:
        rows = db.rows_to_dicts(conn.execute("""SELECT id,word,definition,risk_score,overdue_days,gap_days,
            last_response,next_study_date,status FROM recommendations
            WHERE profile_id=? AND recommend_date=? ORDER BY risk_score DESC,id""", (pk, today)))
    finally:
        conn.close()
    for item in rows:
        score = int(item.get("risk_score") or 0)
        if score >= 60:
            item.update(level="high", level_label="紧急复习", level_color="#e74c3c")
        elif score >= 30:
            item.update(level="mid", level_label="建议复习", level_color="#f39c12")
        else:
            item.update(level="low", level_label="状态稳定", level_color="#27ae60")
        item["last_response_label"] = _response_label(item.get("last_response"))
    return rows


def get_recommendation_summary(profile_id: Any = None) -> dict[str, int]:
    pk, today, conn = db._profile_pk(profile_id), db.beijing_today().isoformat(), db.get_connection()
    try:
        row = conn.execute("""SELECT COUNT(*),
            COALESCE(SUM(CASE WHEN risk_score>=60 THEN 1 ELSE 0 END),0),
            COALESCE(SUM(CASE WHEN risk_score>=30 AND risk_score<60 THEN 1 ELSE 0 END),0),
            COALESCE(SUM(CASE WHEN risk_score<30 THEN 1 ELSE 0 END),0),
            COALESCE(SUM(CASE WHEN status='reviewed' THEN 1 ELSE 0 END),0)
            FROM recommendations WHERE profile_id=? AND recommend_date=?""", (pk, today)).fetchone()
        return dict(zip(("total", "high", "mid", "low", "reviewed"), [int(value or 0) for value in row]))
    finally:
        conn.close()


def mark_reviewed(rec_id: int, profile_id: Any = None) -> int:
    now = datetime.now(db.BJ_TZ).isoformat()
    pk = db._profile_pk(profile_id) if profile_id is not None else None
    with db._write_connection() as conn:
        if profile_id is None:
            cur = conn.execute("UPDATE recommendations SET status='reviewed',reviewed_at=?,updated_at=? WHERE id=?",
                               (now, now, int(rec_id)))
        else:
            cur = conn.execute("UPDATE recommendations SET status='reviewed',reviewed_at=?,updated_at=? WHERE id=? AND profile_id=?",
                               (now, now, int(rec_id), pk))
        return int(cur.rowcount or 0)


def _response_label(code: Any) -> str:
    return {"FORGET": "忘记", "VAGUE": "模糊", "FAMILIAR": "熟悉", "WELL_FAMILIAR": "熟知"}.get(code, code or "未知")


if __name__ == "__main__":
    db.init_db()
    print("OK:", generate_recommendations(), get_recommendation_summary())
