#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
recommender.py - 智能复习推荐引擎
基于当日学习快照计算每个单词的遗忘风险分(0-100)，生成每日 TOP-N 推荐。

风险分构成：
  逾期 (最高 50) : next_study_date 早于今天越多分越高；今天到期给 25 基础分
  回应状态 (最高 30): FORGET=30 / VAGUE=20 / FAMILIAR=10 / WELL_FAMILIAR=5 / 未知=15
  间隔天数 (最高 20): 距上次复习天数越久分越高，超过 20 天封顶
"""

from datetime import date
import db


def generate_recommendations(top_n=30):
    """根据当日快照生成推荐：先清空当日再插入 TOP-N。返回生成条数。"""
    conn = db.get_connection(autocommit=True)
    try:
        cur = conn.cursor()
        cur.execute("DECLARE @today DATE = ?; DELETE FROM recommendations WHERE recommend_date = @today", db.beijing_today())
        sql = "DECLARE @today DATE = ?; " + """
        INSERT INTO recommendations
            (recommend_date, word, definition, risk_score, overdue_days, gap_days, last_response, next_study_date)
        SELECT TOP (?)
            @today, word, definition, risk_score, overdue_days, gap_days, last_response, next_study_date
        FROM (
            SELECT
                word, definition, last_response, next_study_date,
                (overdue_score + response_score + gap_score) AS risk_score,
                overdue_days, gap_days
            FROM (
                SELECT
                    word, definition, last_response, next_study_date,
                    CASE
                        WHEN next_study_date IS NULL THEN 0
                        ELSE DATEDIFF(DAY, next_study_date, @today)
                    END AS overdue_days,
                    CASE
                        WHEN last_study_date IS NULL THEN 0
                        ELSE DATEDIFF(DAY, last_study_date, @today)
                    END AS gap_days,
                    CASE
                        WHEN next_study_date IS NULL THEN 0
                        WHEN next_study_date < @today THEN
                            CASE WHEN DATEDIFF(DAY, next_study_date, @today) * 5 > 50 THEN 50
                                 ELSE DATEDIFF(DAY, next_study_date, @today) * 5 END
                        WHEN next_study_date = @today THEN 25
                        ELSE 0
                    END AS overdue_score,
                    CASE
                        WHEN last_response = 'FORGET' THEN 30
                        WHEN last_response = 'VAGUE' THEN 20
                        WHEN last_response = 'FAMILIAR' THEN 10
                        WHEN last_response = 'WELL_FAMILIAR' THEN 5
                        ELSE 15
                    END AS response_score,
                    CASE
                        WHEN last_study_date IS NULL THEN 10
                        WHEN DATEDIFF(DAY, last_study_date, @today) > 20 THEN 20
                        ELSE DATEDIFF(DAY, last_study_date, @today)
                    END AS gap_score
                FROM study_records
                WHERE snapshot_date = @today
                  AND (next_study_date IS NULL OR next_study_date <= DATEADD(DAY, 7, @today))
            ) AS s
        ) AS t
        ORDER BY
            risk_score DESC,
            -- 无复习日期(overdue_days=NULL)的词显式排最后，不依赖数据库方言的隐式 NULL 排序
            CASE WHEN overdue_days IS NULL THEN 1 ELSE 0 END,
            overdue_days DESC
        """
        cur.execute(sql, (db.beijing_today(), top_n))
        cur.execute("DECLARE @today DATE = ?; SELECT COUNT(1) FROM recommendations WHERE recommend_date = @today", db.beijing_today())
        return cur.fetchone()[0]
    finally:
        conn.close()


def get_today_recommendations():
    """返回当日推荐列表，按风险分降序，附带分级标签。"""
    conn = db.get_connection()
    try:
        cur = conn.cursor()
        cur.execute("DECLARE @today DATE = ?; " + """
            SELECT id, word, definition, risk_score, overdue_days, gap_days,
                   last_response, next_study_date, status
            FROM recommendations
            WHERE recommend_date = @today
            ORDER BY risk_score DESC
        """, db.beijing_today())
        rows = db.rows_to_dicts(cur)
        for r in rows:
            score = r.get("risk_score") or 0
            if score >= 60:
                r["level"] = "high"
                r["level_label"] = "紧急复习"
                r["level_color"] = "#e74c3c"
            elif score >= 30:
                r["level"] = "mid"
                r["level_label"] = "建议复习"
                r["level_color"] = "#f39c12"
            else:
                r["level"] = "low"
                r["level_label"] = "状态稳定"
                r["level_color"] = "#27ae60"
            r["last_response_label"] = _response_label(r.get("last_response"))
        return rows
    finally:
        conn.close()


def get_recommendation_summary():
    """返回当日推荐的汇总统计。"""
    conn = db.get_connection()
    try:
        cur = conn.cursor()
        cur.execute("DECLARE @today DATE = ?; " + """
            SELECT
                COUNT(1) AS total,
                SUM(CASE WHEN risk_score >= 60 THEN 1 ELSE 0 END) AS high,
                SUM(CASE WHEN risk_score >= 30 AND risk_score < 60 THEN 1 ELSE 0 END) AS mid,
                SUM(CASE WHEN risk_score < 30 THEN 1 ELSE 0 END) AS low,
                SUM(CASE WHEN status = 'reviewed' THEN 1 ELSE 0 END) AS reviewed
            FROM recommendations
            WHERE recommend_date = @today
        """, db.beijing_today())
        row = cur.fetchone()
        return {
            "total": int(row[0] or 0),
            "high": int(row[1] or 0),
            "mid": int(row[2] or 0),
            "low": int(row[3] or 0),
            "reviewed": int(row[4] or 0),
        }
    finally:
        conn.close()


def mark_reviewed(rec_id):
    """标记某条推荐为已复习。返回受影响行数。"""
    conn = db.get_connection(autocommit=True)
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE recommendations SET status='reviewed', reviewed_at=GETDATE() WHERE id=?",
            rec_id,
        )
        return cur.rowcount
    finally:
        conn.close()


def _response_label(code):
    return {
        "FORGET": "忘记",
        "VAGUE": "模糊",
        "FAMILIAR": "熟悉",
        "WELL_FAMILIAR": "熟知",
    }.get(code, code or "未知")


if __name__ == "__main__":
    print("生成推荐 ...")
    n = generate_recommendations()
    print("OK: 生成", n, "条推荐")
    print(get_recommendation_summary())