"""陪伴升级：记忆服务（受控事实、摘要、检索、出站票据）。

契约 v1。本模块只调用 ``db.py`` 的共享数据访问层与 ``companion_runtime.py`` 的
基础工具，不自建连接、不改表结构、不直接对外暴露实现名词。

设计要点：

* 记忆分三类：用户主动偏好（无来源片段）、每次结算的学习记录、每角色一条滚动摘要。
* 派生事实的幂等键是 ``ux_companion_memory_source``（账号/代次/角色/来源/类型）。
* 删除屏障：清空会推进代次；代次已过期的 outbox 只能被丢弃，不能复活记忆。
* 对外输出（提示词块 / 票据）只给事实文本与不透明票据，不泄漏内部结构。
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Optional, Sequence

import db
import companion_runtime

__all__ = [
    "MemoryStoreError",
    "MemoryConflictError",
    "DEFAULT_RETENTION_DAYS",
    "MAX_CONTEXT_ITEMS",
    "MAX_CONTEXT_CHARS",
    "MAX_SUMMARY_CHARS",
    "PREFERENCE_KINDS",
    "SUMMARY_KIND",
    "SESSION_KIND",
    "ensure_settings",
    "get_settings",
    "update_settings",
    "set_preference",
    "list_memories",
    "delete_memory",
    "clear_role",
    "clear_account",
    "consume_outbox",
    "rebuild_summary",
    "retrieve",
    "build_prompt_block",
    "issue_context_ticket",
    "resolve_context_ticket",
    "prune",
]

DEFAULT_RETENTION_DAYS = 90
MAX_CONTEXT_ITEMS = 5
MAX_CONTEXT_CHARS = 1200
MAX_SUMMARY_CHARS = 400

PREFERENCE_KINDS = ("preference_name", "preference_goal", "preference_encouragement")
SUMMARY_KIND = "role_summary"
SESSION_KIND = "study_session"

#: 偏好类型 -> 对外称呼（提示词块里使用，本身不是实现名词）。
PREFERENCE_LABELS = {
    "preference_name": "称呼",
    "preference_goal": "目标",
    "preference_encouragement": "鼓励方式",
}

#: 提示词块中必须清理掉的内部名词。
_FORBIDDEN_TERMS = ("revision", "outbox", "epoch", "segment", "memory_id")

_MAX_SETTINGS_RETENTION = 3650
_MAX_TICKET_TTL_SECONDS = 300
_MAX_SUMMARY_SESSIONS = 60


class MemoryStoreError(Exception):
    """记忆服务的通用错误（参数非法、目标不存在等）。"""


class MemoryConflictError(MemoryStoreError):
    """乐观并发冲突：调用方持有的版本已过期。"""


# --------------------------------------------------------------------------- #
# 内部工具
# --------------------------------------------------------------------------- #

def _pk(profile_pk: Any) -> int:
    try:
        value = int(profile_pk)
    except (TypeError, ValueError):
        raise MemoryStoreError("账号标识无效")
    if value <= 0:
        raise MemoryStoreError("账号标识无效")
    return value


def _role(role_id: Any) -> str:
    return str(role_id or "")


def _resolve_role(role_id: Any) -> str:
    """角色为空时回退到当前角色；回退失败不抛错。"""
    text = _role(role_id)
    if text:
        return text
    try:
        return _role(companion_runtime.active_role().get("role_id"))
    except Exception:
        return ""


def _now(now: Optional[Any] = None) -> datetime:
    if now is None:
        return datetime.now(timezone.utc)
    if isinstance(now, datetime):
        return now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    if hasattr(now, "isoformat") and not isinstance(now, str):
        return datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
    text = str(now).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _parse_iso(text: Any) -> Optional[datetime]:
    raw = str(text or "").strip()
    if not raw:
        return None
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _json_loads(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return dict(raw)
    try:
        loaded = json.loads(str(raw or "{}"))
    except (TypeError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _clip(text: str, limit: int) -> str:
    text = str(text or "").strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def _sanitize(text: str) -> str:
    """兜底清理内部名词，保证对外文本不含实现细节。"""
    out = str(text or "")
    for term in _FORBIDDEN_TERMS:
        if term in out:
            out = out.replace(term, "")
    return out


def _epochs(profile_pk: int, role_id: str) -> dict[str, int]:
    state = db.companion_account_state(profile_pk)
    role = db.companion_role_epoch(profile_pk, role_id)
    data_epoch = max(1, _int(state.get("data_epoch"), 1))
    return {
        # 账号代次与数据代次同源：db 里只有一个账号级计数器。
        "data_epoch": data_epoch,
        "account_epoch": data_epoch,
        "role_epoch": max(1, _int(role.get("role_epoch"), 1)),
    }


def _format_time_text(occurred_at: Any) -> str:
    parsed = _parse_iso(occurred_at)
    if parsed is None:
        return str(occurred_at or "")[:16]
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M")


def _format_source_clock(occurred_at: Any) -> str:
    parsed = _parse_iso(occurred_at)
    if parsed is None:
        return _format_time_text(occurred_at)
    local = parsed.astimezone(timezone(timedelta(hours=8)))
    return "%d月%d日 %02d:%02d 的结算" % (local.month, local.day, local.hour, local.minute)


def _source_label(row: Mapping[str, Any]) -> str:
    kind = str(row.get("kind") or "")
    if kind in PREFERENCE_LABELS:
        return "你明确告诉我的偏好"
    if kind == SESSION_KIND:
        return _format_source_clock(row.get("occurred_at"))
    if kind == SUMMARY_KIND:
        return "近期学习总结"
    return "本地学习记录"


def _memory_public(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "memory_id": str(row.get("memory_id") or ""),
        "kind": str(row.get("kind") or ""),
        "role_id": _role(row.get("role_id")),
        "text": str(row.get("local_text") or ""),
        "occurred_at": str(row.get("occurred_at") or ""),
        "revision": _int(row.get("revision"), 1),
        "valid": bool(_int(row.get("valid"), 1)),
        "source_session_id": row.get("source_session_id"),
        "source_segment_id": row.get("source_segment_id"),
        "fact": _json_loads(row.get("fact_json")),
        "created_at": str(row.get("created_at") or ""),
        "updated_at": str(row.get("updated_at") or ""),
    }


def _summary_public(row: Mapping[str, Any]) -> dict[str, Any]:
    fact = _json_loads(row.get("fact_json"))
    return {
        "memory_id": str(row.get("memory_id") or ""),
        "kind": SUMMARY_KIND,
        "role_id": _role(row.get("role_id")),
        "text": str(row.get("local_text") or ""),
        "occurred_at": str(row.get("occurred_at") or ""),
        "revision": _int(row.get("revision"), 1),
        "fact": fact,
        "covered_session_ids": list(fact.get("covered_session_ids") or []),
        "covered_until": fact.get("covered_until") or "",
        "sessions": _int(fact.get("sessions"), 0),
        "truncated": bool(fact.get("truncated")),
        "created_at": str(row.get("created_at") or ""),
        "updated_at": str(row.get("updated_at") or ""),
    }


_SELECT_COLUMNS = (
    "memory_id,profile_pk,data_epoch,role_id,kind,source_session_id,source_segment_id,"
    "source_revision,revision,account_epoch,role_epoch,fact_json,local_text,occurred_at,"
    "valid,created_at,updated_at"
)


def _find_memory_by_source(profile_pk: int, data_epoch: int, role_id: str,
                           session_id: Optional[str], segment_id: Optional[str],
                           kind: str, conn=None) -> Optional[dict[str, Any]]:
    sql = ("SELECT " + _SELECT_COLUMNS + " FROM companion_memories "
           "WHERE profile_pk=? AND data_epoch=? AND role_id=? AND kind=? "
           "AND COALESCE(source_session_id,'')=? AND COALESCE(source_segment_id,'')=?")
    params = (int(profile_pk), int(data_epoch), _role(role_id), str(kind),
              str(session_id or ""), str(segment_id or ""))
    rows = db.companion_query_with(conn, sql, params) if conn is not None else db.companion_query(sql, params)
    return rows[0] if rows else None


def _exec(conn, sql: str, params) -> dict[str, Any]:
    """有事务连接时复用它，否则独立提交。"""
    if conn is not None:
        return db.companion_execute_with(conn, sql, params)
    return db.companion_execute(sql, params)


def _upsert_memory(*, profile_pk: int, data_epoch: int, role_id: str, kind: str,
                   session_id: Optional[str], segment_id: Optional[str],
                   text: str, fact: Mapping[str, Any], occurred_at: str,
                   account_epoch: int, role_epoch: int, conn=None) -> tuple[str, bool]:
    """按来源幂等写入一条记忆。返回 (memory_id, 是否新建)。

    ``conn`` 非空时所有写入自动归属调用方事务，使「写记忆 + 改 outbox 状态」
    要么一起提交，要么一起回滚。
    """
    profile_pk, data_epoch, role_id = int(profile_pk), int(data_epoch), _role(role_id)
    text = str(text or "")
    fact_json = json.dumps(dict(fact or {}), ensure_ascii=False, sort_keys=True)
    occurred_at = str(occurred_at or "")
    now = db._utc_now()
    existing = _find_memory_by_source(profile_pk, data_epoch, role_id,
                                      session_id, segment_id, kind, conn=conn)
    if existing is not None:
        _exec(conn,
              "UPDATE companion_memories SET local_text=?,fact_json=?,occurred_at=?,"
              "revision=revision+1,valid=1,account_epoch=?,role_epoch=?,updated_at=? "
              "WHERE memory_id=?",
              (text, fact_json, occurred_at, int(account_epoch), int(role_epoch), now,
               str(existing["memory_id"])))
        return str(existing["memory_id"]), False

    memory_id = companion_runtime.new_id("mem")
    try:
        _exec(conn,
              "INSERT INTO companion_memories(memory_id,profile_pk,data_epoch,role_id,kind,"
              "source_session_id,source_segment_id,source_revision,revision,account_epoch,"
              "role_epoch,fact_json,local_text,occurred_at,valid,created_at,updated_at) "
              "VALUES(?,?,?,?,?,?,?,1,1,?,?,?,?,?,1,?,?)",
              (memory_id, profile_pk, data_epoch, role_id, str(kind),
               None if session_id in (None, "") else str(session_id),
               None if segment_id in (None, "") else str(segment_id),
               int(account_epoch), int(role_epoch), fact_json, text, occurred_at, now, now))
    except sqlite3.IntegrityError:
        # 并发写入同一来源：退化为更新，绝不多出一行。
        existing = _find_memory_by_source(profile_pk, data_epoch, role_id,
                                          session_id, segment_id, kind, conn=conn)
        if existing is None:
            raise
        _exec(conn,
              "UPDATE companion_memories SET local_text=?,fact_json=?,occurred_at=?,"
              "revision=revision+1,valid=1,account_epoch=?,role_epoch=?,updated_at=? "
              "WHERE memory_id=?",
              (text, fact_json, occurred_at, int(account_epoch), int(role_epoch), now,
               str(existing["memory_id"])))
        return str(existing["memory_id"]), False
    return memory_id, True


def _settings_row(profile_pk: int) -> dict[str, Any]:
    rows = db.companion_query(
        "SELECT profile_pk,data_epoch,account_epoch,settings_revision,use_enabled,"
        "outbound_enabled,retention_days,updated_at FROM companion_memory_settings "
        "WHERE profile_pk=?",
        (int(profile_pk),),
    )
    if not rows:
        return {}
    row = dict(rows[0])
    return {
        "profile_pk": int(row["profile_pk"]),
        "data_epoch": _int(row["data_epoch"], 1),
        "account_epoch": _int(row["account_epoch"], 1),
        "settings_revision": _int(row["settings_revision"], 1),
        "use_enabled": bool(_int(row["use_enabled"], 1)),
        "outbound_enabled": bool(_int(row["outbound_enabled"], 0)),
        "retention_days": _int(row["retention_days"], DEFAULT_RETENTION_DAYS),
        "updated_at": str(row["updated_at"] or ""),
    }


def _write_deletion_log(profile_pk: int, scope: str, role_id: str, account_epoch: int,
                        role_epoch: int, deleted_count: int) -> str:
    deletion_id = companion_runtime.new_id("mdel")
    db.companion_execute(
        "INSERT INTO companion_memory_deletion_log(deletion_id,profile_pk,scope,role_id,"
        "account_epoch,role_epoch,deleted_count,created_at) VALUES(?,?,?,?,?,?,?,?)",
        (deletion_id, int(profile_pk), str(scope), _role(role_id), int(account_epoch),
         int(role_epoch), max(0, int(deleted_count)), db._utc_now()),
    )
    return deletion_id


# --------------------------------------------------------------------------- #
# 设置
# --------------------------------------------------------------------------- #

def ensure_settings(profile_pk: Any) -> dict[str, Any]:
    """确保设置行存在（并同步代次），返回设置字典。"""
    pk = _pk(profile_pk)
    state = db.companion_account_state(pk)
    data_epoch = max(1, _int(state.get("data_epoch"), 1))
    # 先尝试读取；不存在则建行。两条路径都不改动 settings_revision。
    if not _settings_row(pk):
        try:
            db.companion_execute(
                "INSERT OR IGNORE INTO companion_memory_settings(profile_pk,data_epoch,"
                "account_epoch,settings_revision,use_enabled,outbound_enabled,"
                "retention_days,updated_at) VALUES(?,?,?,1,1,0,?,?)",
                (pk, data_epoch, data_epoch, DEFAULT_RETENTION_DAYS, db._utc_now()),
            )
        except sqlite3.IntegrityError:
            pass
    row = _settings_row(pk)
    if not row:
        raise MemoryStoreError("记忆设置初始化失败")
    if row["data_epoch"] != data_epoch or row["account_epoch"] != data_epoch:
        db.companion_execute(
            "UPDATE companion_memory_settings SET data_epoch=?,account_epoch=? "
            "WHERE profile_pk=?",
            (data_epoch, data_epoch, pk),
        )
        row = _settings_row(pk)
    return row


def get_settings(profile_pk: Any) -> dict[str, Any]:
    """读取设置；缺行时自动创建（与 ensure_settings 等价）。"""
    return ensure_settings(profile_pk)


def update_settings(profile_pk: Any, *, use_enabled: Optional[bool] = None,
                    outbound_enabled: Optional[bool] = None,
                    retention_days: Optional[int] = None,
                    expected_settings_revision: Optional[int] = None) -> dict[str, Any]:
    """更新设置。``expected_settings_revision`` 不符时抛 MemoryConflictError。"""
    pk = _pk(profile_pk)
    current = ensure_settings(pk)
    if expected_settings_revision is not None:
        if _int(expected_settings_revision, -1) != int(current["settings_revision"]):
            raise MemoryConflictError("记忆设置已被修改，请刷新后重试")

    fields: list[tuple[str, Any]] = []
    if use_enabled is not None:
        fields.append(("use_enabled", 1 if use_enabled else 0))
    if outbound_enabled is not None:
        fields.append(("outbound_enabled", 1 if outbound_enabled else 0))
    if retention_days is not None:
        days = _int(retention_days, DEFAULT_RETENTION_DAYS)
        if days < 1:
            raise MemoryStoreError("保留天数必须为正整数")
        fields.append(("retention_days", min(days, _MAX_SETTINGS_RETENTION)))
    if not fields:
        return current

    assignments = ", ".join("%s=?" % name for name, _ in fields)
    params = [value for _, value in fields]
    params.extend([db._utc_now(), pk])
    try:
        db.companion_execute(
            "UPDATE companion_memory_settings SET " + assignments +
            ",settings_revision=settings_revision+1,updated_at=? WHERE profile_pk=?",
            tuple(params),
        )
    except sqlite3.IntegrityError as exc:  # pragma: no cover - 防御路径
        raise MemoryStoreError("记忆设置保存失败: %s" % exc)
    updated = _settings_row(pk)
    if int(updated["settings_revision"]) == int(current["settings_revision"]):
        updated["settings_revision"] = int(current["settings_revision"]) + 1
    return updated


# --------------------------------------------------------------------------- #
# 偏好与记忆条目
# --------------------------------------------------------------------------- #

def set_preference(profile_pk: Any, role_id: Any, kind: str, text: str, *,
                   expected_revision: Optional[int] = None) -> dict[str, Any]:
    """写入/更新一条用户主动偏好（每角色每类型一条）。"""
    pk = _pk(profile_pk)
    rid = _role(role_id)
    kind = str(kind or "")
    if kind not in PREFERENCE_KINDS:
        raise MemoryStoreError("不支持的偏好类型: %s" % kind)
    body = _clip(str(text or ""), MAX_SUMMARY_CHARS)
    if not body:
        raise MemoryStoreError("偏好内容不能为空")

    epochs = _epochs(pk, rid)
    existing = _find_memory_by_source(pk, epochs["data_epoch"], rid, None, None, kind)
    if existing is not None:
        if expected_revision is not None and _int(expected_revision, -1) != _int(
                existing.get("revision"), 1):
            raise MemoryConflictError("这条偏好已被修改，请刷新后重试")
    elif expected_revision is not None and _int(expected_revision, 0) > 0:
        raise MemoryConflictError("这条偏好已不存在，请刷新后重试")

    # 主动偏好变化不改动“已确认结算事实”的代次：否则会误伤尚未消费的事件。
    # 旧票据由 settings_revision 核验兜底，见 resolve_context_ticket。
    fact = {"kind": kind, "label": PREFERENCE_LABELS.get(kind, kind)}
    memory_id, created = _upsert_memory(
        profile_pk=pk,
        data_epoch=epochs["data_epoch"],
        role_id=rid,
        kind=kind,
        session_id=None,
        segment_id=None,
        text=body,
        fact=fact,
        occurred_at=existing.get("occurred_at") if existing else db._utc_now(),
        account_epoch=epochs["account_epoch"],
        role_epoch=epochs["role_epoch"],
    )
    row = _find_memory_by_source(pk, epochs["data_epoch"], rid, None, None, kind)
    public = _memory_public(row or {"memory_id": memory_id, "kind": kind,
                                    "local_text": body, "role_id": rid})
    public["created"] = bool(created)
    public["label"] = PREFERENCE_LABELS.get(kind, kind)
    return public


def list_memories(profile_pk: Any, role_id: Any, *, include_invalid: bool = False,
                  limit: int = 200) -> list[dict[str, Any]]:
    """列出当前代次下该角色的记忆条目。"""
    pk = _pk(profile_pk)
    rid = _role(role_id)
    data_epoch = _epochs(pk, rid)["data_epoch"]
    limit = max(1, min(_int(limit, 200), 500))
    sql = ("SELECT " + _SELECT_COLUMNS + " FROM companion_memories "
           "WHERE profile_pk=? AND data_epoch=? AND role_id=?")
    params: list[Any] = [pk, data_epoch, rid]
    if not include_invalid:
        sql += " AND valid=1"
    sql += " ORDER BY occurred_at DESC, memory_id LIMIT ?"
    params.append(limit)
    rows = db.companion_query(sql, tuple(params))
    return [_memory_public(row) for row in rows]


def delete_memory(profile_pk: Any, role_id: Any, memory_id: str, *,
                  expected_revision: Optional[int] = None) -> dict[str, Any]:
    """软删除一条记忆并推进角色代次（旧上下文票据随之失效）。"""
    pk = _pk(profile_pk)
    rid = _role(role_id)
    memory_id = str(memory_id or "")
    if not memory_id:
        raise MemoryStoreError("缺少记忆标识")
    rows = db.companion_query(
        "SELECT " + _SELECT_COLUMNS + " FROM companion_memories "
        "WHERE memory_id=? AND profile_pk=? AND role_id=?",
        (memory_id, pk, rid),
    )
    if not rows:
        raise MemoryStoreError("记忆不存在")
    row = dict(rows[0])
    if expected_revision is not None and _int(expected_revision, -1) != _int(
            row.get("revision"), 1):
        raise MemoryConflictError("这条记忆已被修改，请刷新后重试")
    if not _int(row.get("valid"), 1):
        new_role_epoch = db.companion_role_epoch(pk, rid)["role_epoch"]
        return {"memory_id": memory_id, "deleted": False, "already_deleted": True,
                "role_epoch": int(new_role_epoch)}
    new_role_epoch = db.companion_bump_role_epoch(pk, rid)
    db.companion_execute(
        "UPDATE companion_memories SET valid=0,revision=revision+1,role_epoch=?,updated_at=? "
        "WHERE memory_id=?",
        (int(new_role_epoch), db._utc_now(), memory_id),
    )
    return {"memory_id": memory_id, "deleted": True, "already_deleted": False,
            "role_epoch": int(new_role_epoch), "kind": str(row.get("kind") or "")}


# --------------------------------------------------------------------------- #
# 清空（删除屏障由代次推进实现）
# --------------------------------------------------------------------------- #

def clear_role(profile_pk: Any, role_id: Any) -> dict[str, Any]:
    """清空某角色：删除记忆、推进角色代次、丢弃迟到事件、写删除日志。"""
    pk = _pk(profile_pk)
    rid = _role(role_id)
    data_epoch = _epochs(pk, rid)["data_epoch"]
    rows = db.companion_query(
        "SELECT COUNT(*) AS n FROM companion_memories "
        "WHERE profile_pk=? AND data_epoch=? AND role_id=?",
        (pk, data_epoch, rid),
    )
    deleted = _int(rows[0]["n"], 0) if rows else 0
    db.companion_execute(
        "DELETE FROM companion_memories WHERE profile_pk=? AND data_epoch=? AND role_id=?",
        (pk, data_epoch, rid),
    )
    new_role_epoch = db.companion_bump_role_epoch(pk, rid)
    # 迟到事件在这里就被判定过期，无需等消费时再拦。
    db.companion_execute(
        "UPDATE companion_outbox SET status='dropped',consumed_at=?,attempts=attempts+1 "
        "WHERE profile_pk=? AND role_id=? AND status='pending'",
        (db._utc_now(), pk, rid),
    )
    deletion_id = _write_deletion_log(pk, "role", rid, data_epoch, new_role_epoch, deleted)
    return {
        "scope": "role",
        "role_id": rid,
        "deleted_count": deleted,
        "role_epoch": int(new_role_epoch),
        "data_epoch": int(data_epoch),
        "deletion_id": deletion_id,
    }


def clear_account(profile_pk: Any) -> dict[str, Any]:
    """跨角色清空该账号的全部记忆，并推进账号代次。"""
    pk = _pk(profile_pk)
    pref_epoch = _epochs(pk, "")
    rows = db.companion_query(
        "SELECT COUNT(*) AS n FROM companion_memories WHERE profile_pk=?",
        (pk,),
    )
    deleted = _int(rows[0]["n"], 0) if rows else 0
    db.companion_execute("DELETE FROM companion_memories WHERE profile_pk=?", (pk,))
    new_data_epoch = db.companion_bump_data_epoch(pk)
    db.companion_execute(
        "UPDATE companion_outbox SET status='dropped',consumed_at=?,attempts=attempts+1 "
        "WHERE profile_pk=? AND status='pending'",
        (db._utc_now(), pk),
    )
    db.companion_execute(
        "UPDATE companion_context_tickets SET used=1 WHERE profile_pk=? AND used=0",
        (pk,),
    )
    deletion_id = _write_deletion_log(pk, "account", "", new_data_epoch,
                                      pref_epoch["role_epoch"], deleted)
    return {
        "scope": "account",
        "role_id": "",
        "deleted_count": deleted,
        "data_epoch": int(new_data_epoch),
        "account_epoch": int(new_data_epoch),
        "deletion_id": deletion_id,
    }


# --------------------------------------------------------------------------- #
# 结算事实的消费
# --------------------------------------------------------------------------- #

def _render_session_text(payload: Mapping[str, Any]) -> str:
    new_words = max(0, _int(payload.get("confirmed_new"), 0))
    review_words = max(0, _int(payload.get("confirmed_review"), 0))
    active_seconds = max(0, _int(payload.get("active_seconds"), 0))
    minutes = int(round(active_seconds / 60.0))
    parts = ["完成新学 %d 词、复习 %d 词" % (new_words, review_words)]
    if minutes > 0:
        parts.append("用时 %d 分钟" % minutes)
    return "，".join(parts)


def _settlement_payload(row: Mapping[str, Any]) -> dict[str, Any]:
    payload = _json_loads(row.get("payload_json"))
    payload.setdefault("session_id", row.get("session_id") or "")
    payload.setdefault("segment_id", row.get("segment_id"))
    payload.setdefault("role_id", row.get("role_id") or "")
    weak = payload.get("weak_words")
    if not isinstance(weak, list):
        payload["weak_words"] = []
    return payload


def _outbox_is_stale(row: Mapping[str, Any], current: Mapping[str, int]) -> bool:
    """事件代次早于当前代次即视为已越过删除屏障。"""
    for column, key in (("data_epoch", "data_epoch"),
                        ("account_epoch", "account_epoch"),
                        ("role_epoch", "role_epoch")):
        value = row.get(column)
        if value in (None, ""):
            continue
        if _int(value, 0) < int(current[key]):
            return True
    return False


def _consume_one(profile_pk: int, row: Mapping[str, Any], current: Mapping[str, int],
                 *, conn=None) -> dict[str, Any]:
    pk = int(profile_pk)
    rid = _role(row.get("role_id") or _json_loads(row.get("payload_json")).get("role_id"))
    now = db._utc_now()
    outbox_id = _int(row.get("outbox_id"), 0)

    if _outbox_is_stale(row, current):
        _exec(conn,
              "UPDATE companion_outbox SET status='dropped',consumed_at=?,"
              "attempts=attempts+1 WHERE outbox_id=?",
              (now, outbox_id))
        return {"outbox_id": outbox_id, "status": "dropped", "role_id": rid}

    payload = _settlement_payload(row)
    data_epoch = current["data_epoch"]
    occurred_at = str(payload.get("occurred_at") or row.get("created_at") or now)
    fact = {
        "session_id": str(payload.get("session_id") or row.get("session_id") or ""),
        "segment_id": payload.get("segment_id"),
        "study_day": str(payload.get("study_day") or ""),
        "confirmed_new": max(0, _int(payload.get("confirmed_new"), 0)),
        "confirmed_review": max(0, _int(payload.get("confirmed_review"), 0)),
        "active_seconds": max(0, _int(payload.get("active_seconds"), 0)),
        "weak_words": [str(word) for word in (payload.get("weak_words") or [])][:20],
        "completion_role_name": str(payload.get("completion_role_name") or ""),
    }
    memory_id, created = _upsert_memory(
        profile_pk=pk,
        data_epoch=data_epoch,
        role_id=rid,
        kind=SESSION_KIND,
        session_id=row.get("session_id"),
        segment_id=row.get("segment_id"),
        text=_render_session_text(payload),
        fact=fact,
        occurred_at=occurred_at,
        account_epoch=current["account_epoch"],
        role_epoch=current["role_epoch"],
        conn=conn,
    )
    _exec(conn,
          "UPDATE companion_outbox SET status='consumed',consumed_at=?,attempts=attempts+1 "
          "WHERE outbox_id=?",
          (now, outbox_id))
    return {"outbox_id": outbox_id, "status": "consumed", "role_id": rid,
            "memory_id": memory_id, "created": bool(created)}


def consume_outbox(profile_pk: Any, *, limit: int = 50) -> dict[str, Any]:
    """消费 pending 结算事件，幂等生成学习记录，并重建相关角色摘要。"""
    pk = _pk(profile_pk)
    limit = max(1, min(_int(limit, 50), 200))
    rows = db.companion_query(
        "SELECT outbox_id,profile_pk,data_epoch,account_epoch,role_epoch,session_id,"
        "segment_id,role_id,event_type,payload_json,status,attempts,created_at "
        "FROM companion_outbox WHERE profile_pk=? AND status='pending' "
        "ORDER BY outbox_id LIMIT ?",
        (pk, limit),
    )
    consumed: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    summary_roles: list[str] = []

    for row in rows:
        # 代次读取放在事务外：_epochs 会创建控制行（自身要写），在 BEGIN IMMEDIATE
        # 内部再开写事务会嵌套失败。代次只作删除屏障比较，读取后立即比较即可。
        rid = _role(row.get("role_id") or _json_loads(row.get("payload_json")).get("role_id"))
        try:
            current = _epochs(pk, rid)
        except Exception as exc:
            failed.append({"outbox_id": _int(row.get("outbox_id"), 0), "error": str(exc)})
            continue
        try:
            # 写记忆与标记 consumed 必须同事务：否则崩溃会丢事件或重复计数。
            with db.companion_transaction() as conn:
                result = _consume_one(pk, row, current, conn=conn)
        except Exception as exc:  # 单条失败不影响队列其它事件
            db.companion_execute(
                "UPDATE companion_outbox SET attempts=attempts+1 WHERE outbox_id=?",
                (_int(row.get("outbox_id"), 0),),
            )
            failed.append({"outbox_id": _int(row.get("outbox_id"), 0),
                           "error": str(exc)})
            continue
        if result["status"] == "consumed":
            consumed.append(result)
            if result["role_id"] not in summary_roles:
                summary_roles.append(result["role_id"])
        else:
            dropped.append(result)

    summaries: list[dict[str, Any]] = []
    for rid in summary_roles:
        try:
            summaries.append(rebuild_summary(pk, rid))
        except Exception as exc:  # 摘要失败不影响事实落库
            summaries.append({"role_id": rid, "ok": False, "reason": str(exc)})

    return {
        "profile_pk": pk,
        "scanned": len(rows),
        "consumed": consumed,
        "consumed_count": len(consumed),
        "dropped": dropped,
        "dropped_count": len(dropped),
        "failed": failed,
        "failed_count": len(failed),
        "summaries": summaries,
    }


# --------------------------------------------------------------------------- #
# 摘要
# --------------------------------------------------------------------------- #

def _render_summary(fact: Mapping[str, Any]) -> str:
    """把摘要事实渲染成一段 ≤400 字符的中文文本（测试会替换此函数）。"""
    sessions = max(0, _int(fact.get("sessions"), 0))
    new_words = max(0, _int(fact.get("new_words"), 0))
    review_words = max(0, _int(fact.get("review_words"), 0))
    minutes = max(0, _int(fact.get("active_minutes"), 0))
    weak = [str(word) for word in (fact.get("weak_words") or [])][:3]
    head = "最近 %d 次结算：" % sessions if sessions else "暂时还没有结算记录"
    if sessions:
        head += "累计新学 %d 词、复习 %d 词" % (new_words, review_words)
        if minutes:
            head += "，共 %d 分钟" % minutes
        head += "。"
    if weak:
        head += "还需巩固：" + "、".join(weak) + "。"
    return _clip(head, MAX_SUMMARY_CHARS)


def _summary_candidates(profile_pk: int, role_id: str) -> list[dict[str, Any]]:
    epochs = _epochs(profile_pk, role_id)
    return db.companion_query(
        "SELECT " + _SELECT_COLUMNS + " FROM companion_memories "
        "WHERE profile_pk=? AND data_epoch=? AND role_id=? AND kind=? AND valid=1 "
        "ORDER BY occurred_at ASC, memory_id",
        (int(profile_pk), epochs["data_epoch"], _role(role_id), SESSION_KIND),
    )


def rebuild_summary(profile_pk: Any, role_id: Any) -> dict[str, Any]:
    """按当前有效学习记录重建该角色的滚动摘要；渲染失败时保留旧行。"""
    pk = _pk(profile_pk)
    rid = _resolve_role(role_id)
    rows = _summary_candidates(pk, rid)

    session_ids: list[str] = []
    total_new = total_review = total_seconds = 0
    weak_counter: dict[str, int] = {}
    covered_until = ""
    for row in rows:
        fact = _json_loads(row.get("fact_json"))
        session_id = str(fact.get("session_id") or row.get("source_session_id") or "")
        if session_id and session_id not in session_ids:
            session_ids.append(session_id)
        total_new += max(0, _int(fact.get("confirmed_new"), 0))
        total_review += max(0, _int(fact.get("confirmed_review"), 0))
        total_seconds += max(0, _int(fact.get("active_seconds"), 0))
        for word in fact.get("weak_words") or []:
            key = str(word)
            if key:
                weak_counter[key] = weak_counter.get(key, 0) + 1
        occurred_at = str(row.get("occurred_at") or "")
        if occurred_at > covered_until:
            covered_until = occurred_at

    truncated = len(session_ids) > _MAX_SUMMARY_SESSIONS
    covered_ids = session_ids[-_MAX_SUMMARY_SESSIONS:]
    weak_sorted = [word for word, _count in sorted(
        weak_counter.items(), key=lambda pair: (-pair[1], pair[0]))][:8]
    fact = {
        "covered_session_ids": covered_ids,
        "covered_until": covered_until,
        "sessions": len(covered_ids),
        "new_words": total_new,
        "review_words": total_review,
        "active_minutes": int(round(total_seconds / 60.0)),
        "truncated": bool(truncated),
        "weak_words": weak_sorted,
    }

    try:
        text = _render_summary(fact)
    except Exception as exc:  # 保存旧行不变
        return {"role_id": rid, "ok": False, "reason": str(exc), "updated": False}
    if not text:
        return {"role_id": rid, "ok": False, "reason": "摘要文本为空", "updated": False}
    if len(text) > MAX_SUMMARY_CHARS:
        text = _clip(text, MAX_SUMMARY_CHARS)
        fact["truncated"] = True

    epochs = _epochs(pk, rid)
    memory_id, created = _upsert_memory(
        profile_pk=pk,
        data_epoch=epochs["data_epoch"],
        role_id=rid,
        kind=SUMMARY_KIND,
        session_id=None,
        segment_id=None,
        text=text,
        fact=fact,
        occurred_at=covered_until or db._utc_now(),
        account_epoch=epochs["account_epoch"],
        role_epoch=epochs["role_epoch"],
    )
    row = _find_memory_by_source(pk, epochs["data_epoch"], rid, None, None, SUMMARY_KIND)
    result = _summary_public(row or {
        "memory_id": memory_id, "kind": SUMMARY_KIND, "role_id": rid,
        "local_text": text, "fact_json": json.dumps(fact, ensure_ascii=False),
    })
    result["ok"] = True
    result["updated"] = True
    result["created"] = bool(created)
    return result


# --------------------------------------------------------------------------- #
# 检索
# --------------------------------------------------------------------------- #

def _query_tokens(query_text: str) -> list[str]:
    text = str(query_text or "").strip()
    if not text:
        return []
    tokens: list[str] = []
    for chunk in text.replace("，", " ").replace("。", " ").replace("、", " ").split():
        chunk = chunk.strip()
        if chunk and chunk not in tokens:
            tokens.append(chunk)
    if not tokens:
        tokens = [text] if len(text) <= 24 else []
    return tokens[:8]


def _retrieval_candidates(profile_pk: int, role_id: str) -> list[dict[str, Any]]:
    epochs = _epochs(profile_pk, role_id)
    rows = db.companion_query(
        "SELECT " + _SELECT_COLUMNS + " FROM companion_memories "
        "WHERE profile_pk=? AND data_epoch=? AND role_id=? AND valid=1 "
        "ORDER BY occurred_at DESC, memory_id",
        (int(profile_pk), epochs["data_epoch"], _role(role_id)),
    )
    # 摘要不重复进入检索：它是滚动汇总，不是一条可用的事实条目。
    return [row for row in rows if str(row.get("kind") or "") != SUMMARY_KIND]


def _order_candidates(rows: Sequence[Mapping[str, Any]],
                      tokens: Sequence[str]) -> list[dict[str, Any]]:
    hits = [str(token) for token in tokens if token]

    def keyword_hit(row: Mapping[str, Any]) -> bool:
        text = str(row.get("local_text") or "")
        return any(token in text for token in hits)

    preference_rank = {kind: index for index, kind in enumerate(PREFERENCE_KINDS)}

    # occurred_at 倒序：先按分组，再在组内用降序。
    grouped: dict[int, list[dict[str, Any]]] = {0: [], 1: [], 2: []}
    for row in rows:
        kind = str(row.get("kind") or "")
        if kind in preference_rank:
            grouped[0].append(dict(row))
        elif keyword_hit(row):
            grouped[1].append(dict(row))
        else:
            grouped[2].append(dict(row))
    for bucket in grouped.values():
        bucket.sort(key=lambda item: (str(item.get("occurred_at") or ""),
                                      str(item.get("memory_id") or "")), reverse=True)
    grouped[0].sort(key=lambda item: preference_rank.get(str(item.get("kind") or ""), 99))
    return grouped[0] + grouped[1] + grouped[2]


def retrieve(profile_pk: Any, role_id: Any, query_text: str = "", *,
             now: Optional[Any] = None) -> dict[str, Any]:
    """受控检索：偏好优先、关键词命中次之、最后按时间倒序；硬上限 5 条/1200 字符。"""
    pk = _pk(profile_pk)
    rid = _resolve_role(role_id)
    tokens = _query_tokens(query_text)
    rows = _order_candidates(_retrieval_candidates(pk, rid), tokens)

    items: list[dict[str, Any]] = []
    used = 0
    truncated = False
    seen_text: set[str] = set()
    for row in rows:
        if len(items) >= MAX_CONTEXT_ITEMS:
            truncated = True
            break
        text = str(row.get("local_text") or "")
        if not text or text in seen_text:
            continue
        label = _source_label(row)
        time_text = _format_time_text(row.get("occurred_at"))
        cost = len(text) + len(label) + len(time_text)
        if used + cost > MAX_CONTEXT_CHARS:
            truncated = True
            break
        seen_text.add(text)
        used += cost
        items.append({
            "memory_id": str(row.get("memory_id") or ""),
            "kind": str(row.get("kind") or ""),
            "text": text,
            "occurred_at": str(row.get("occurred_at") or ""),
            "source_label": label,
        })
    if len(items) < len(rows):
        truncated = True
    return {"items": items, "chars": used, "truncated": bool(truncated)}


def build_prompt_block(profile_pk: Any, role_id: Any, query_text: str = "") -> str:
    """生成给 AI 的受控数据块；关闭记忆或关闭出站时返回空串。"""
    pk = _pk(profile_pk)
    settings = get_settings(pk)
    if not settings["use_enabled"] or not settings["outbound_enabled"]:
        return ""
    rid = _resolve_role(role_id)
    result = retrieve(pk, rid, query_text)
    pref_lines: list[str] = []
    session_lines: list[str] = []
    for item in result["items"]:
        kind = item["kind"]
        text = _sanitize(item["text"])
        if kind in PREFERENCE_LABELS:
            pref_lines.append("- %s：%s" % (PREFERENCE_LABELS[kind], text))
        elif kind == SESSION_KIND:
            day = item["occurred_at"][:10]
            session_lines.append("- %s %s（来源：%s）" % (day, text, item["source_label"]))
        else:
            session_lines.append("- %s" % text)

    blocks: list[str] = []
    if session_lines:
        blocks.append("【共同学习记录（本地记忆，来自已确认的学习事实）】\n" +
                      "\n".join(session_lines))
    if pref_lines:
        blocks.append("【用户明确告诉你的偏好】\n" + "\n".join(pref_lines))
    if not blocks:
        return ""
    return _sanitize("\n".join(blocks))


# --------------------------------------------------------------------------- #
# 出站票据
# --------------------------------------------------------------------------- #

def issue_context_ticket(profile_pk: Any, role_id: Any, *,
                         ttl_seconds: int = 60) -> dict[str, Any]:
    """签发一次性的上下文授权票据（仅在记忆与出站都开启时）。"""
    pk = _pk(profile_pk)
    rid = _resolve_role(role_id)
    settings = get_settings(pk)
    if not settings["use_enabled"]:
        raise MemoryStoreError("记忆功能已关闭，无法签发上下文授权")
    if not settings["outbound_enabled"]:
        raise MemoryStoreError("出站授权已关闭，无法签发上下文授权")

    ttl = _int(ttl_seconds, 60)
    ttl = max(1, min(ttl, _MAX_TICKET_TTL_SECONDS))
    epochs = _epochs(pk, rid)
    created = datetime.now(timezone.utc)
    expires = created + timedelta(seconds=ttl)
    ticket_id = companion_runtime.new_id("mtk")
    db.companion_execute(
        "INSERT INTO companion_context_tickets(ticket_id,profile_pk,role_id,data_epoch,"
        "account_epoch,role_epoch,settings_revision,created_at,expires_at,used) "
        "VALUES(?,?,?,?,?,?,?,?,?,0)",
        (ticket_id, pk, rid, epochs["data_epoch"], epochs["account_epoch"],
         epochs["role_epoch"], int(settings["settings_revision"]),
         created.isoformat(), expires.isoformat()),
    )
    return {
        "ok": True,
        "ticket_id": ticket_id,
        "role_id": rid,
        "created_at": created.isoformat(),
        "expires_at": expires.isoformat(),
        "ttl_seconds": ttl,
        "settings_revision": int(settings["settings_revision"]),
    }


def resolve_context_ticket(profile_pk: Any, ticket_id: str) -> dict[str, Any]:
    """核验票据归属/代次/授权状态。失败只回原因，绝不回任何记忆文本。"""
    pk = _pk(profile_pk)
    ticket_id = str(ticket_id or "")
    if not ticket_id:
        return {"ok": False, "reason": "缺少上下文票据"}
    rows = db.companion_query(
        "SELECT ticket_id,profile_pk,role_id,data_epoch,account_epoch,role_epoch,"
        "settings_revision,created_at,expires_at,used FROM companion_context_tickets "
        "WHERE ticket_id=?",
        (ticket_id,),
    )
    if not rows:
        return {"ok": False, "reason": "上下文票据不存在"}
    row = dict(rows[0])
    if _int(row.get("profile_pk"), 0) != pk:
        return {"ok": False, "reason": "上下文票据不属于当前账号"}
    if _int(row.get("used"), 0):
        return {"ok": False, "reason": "上下文票据已被使用"}
    expires = _parse_iso(row.get("expires_at"))
    if expires is None or expires <= datetime.now(timezone.utc):
        return {"ok": False, "reason": "上下文票据已过期"}

    rid = _role(row.get("role_id"))
    epochs = _epochs(pk, rid)
    if _int(row.get("data_epoch"), 0) != epochs["data_epoch"] or \
            _int(row.get("account_epoch"), 0) != epochs["account_epoch"]:
        return {"ok": False, "reason": "记忆数据已被清空或重建，请重新授权"}
    if _int(row.get("role_epoch"), 0) != epochs["role_epoch"]:
        return {"ok": False, "reason": "该角色的记忆已变更，请重新授权"}

    settings = get_settings(pk)
    if not settings["use_enabled"]:
        return {"ok": False, "reason": "记忆功能已关闭"}
    if not settings["outbound_enabled"]:
        return {"ok": False, "reason": "出站授权已关闭"}
    if _int(row.get("settings_revision"), 0) != int(settings["settings_revision"]):
        return {"ok": False, "reason": "记忆设置已变更，请重新授权"}

    result = db.companion_execute(
        "UPDATE companion_context_tickets SET used=1 WHERE ticket_id=? AND used=0",
        (ticket_id,),
    )
    if _int(result.get("rowcount"), 0) <= 0:
        return {"ok": False, "reason": "上下文票据已被使用"}
    return {"ok": True, "ticket_id": ticket_id, "role_id": rid,
            "expires_at": str(row.get("expires_at") or "")}


# --------------------------------------------------------------------------- #
# 保留期清理
# --------------------------------------------------------------------------- #

def prune(profile_pk: Any, *, now: Optional[Any] = None) -> dict[str, Any]:
    """按 retention_days 清理学习记录；摘要与偏好保留，不写删除日志。"""
    pk = _pk(profile_pk)
    settings = get_settings(pk)
    days = _int(settings.get("retention_days"), DEFAULT_RETENTION_DAYS)
    if days <= 0:
        days = DEFAULT_RETENTION_DAYS
    reference = _now(now)
    cutoff = reference - timedelta(days=days)
    cutoff_iso = cutoff.astimezone(timezone.utc).isoformat()

    rows = db.companion_query(
        "SELECT COUNT(*) AS n FROM companion_memories "
        "WHERE profile_pk=? AND kind=? AND occurred_at < ?",
        (pk, SESSION_KIND, cutoff_iso),
    )
    candidates = _int(rows[0]["n"], 0) if rows else 0
    result = db.companion_execute(
        "DELETE FROM companion_memories WHERE profile_pk=? AND kind=? AND occurred_at < ?",
        (pk, SESSION_KIND, cutoff_iso),
    )
    deleted = max(0, min(candidates, _int(result.get("rowcount"), candidates)))
    return {
        "profile_pk": pk,
        "retention_days": days,
        "cutoff": cutoff_iso,
        "deleted_count": int(deleted),
        "kept_kinds": list(PREFERENCE_KINDS) + [SUMMARY_KIND],
    }
