# -*- coding: utf-8 -*-
"""陪伴学习会话：持久会话、事件证据、有效时间与完成事务。

三条不能退让的规则：

1. **只有最后可信证据才结算。** 页面点击、DOM 消失、AI 回复、``finish`` 事件都不
   决定完成；只有「完整官方计划 + matched 身份 + 基线后的 false→true 转变」可以。
2. **一次完成只发一次奖励。** 结算、纪念卡、首次徽章、记忆队列各有唯一约束，
   重复提交/刷新/双窗返回同一份结算。
3. **有效时间按区间并集统计。** 多窗累加客户端秒数会被重复计时，因此只存租约
   区间，服务端算并集并排除暂停/失联/闲置。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional, Sequence

import db

MAX_EVENTS_PER_REQUEST = 100
MAX_EVENT_PAYLOAD = 256 * 1024
LEASE_HEARTBEAT_SECONDS = 15
LEASE_STALE_SECONDS = 45
TERMINAL_STATES = ("completed", "abandoned")
VALID_ACTIONS = ("pause", "resume", "abandon", "set_goal")
VALID_GOAL_KINDS = ("session_goal", "today_plan")

SETTLEMENT_KIND = "session_settlement"


class SessionError(RuntimeError):
    """会话请求非法（4xx 语义）。"""


class ConflictError(SessionError):
    """版本冲突：客户端拿着过期 revision 提交（409 + 可重试）。"""


class StaleEpochError(SessionError):
    """账号数据已被重置，旧会话/结算不可再用（409 不可重试）。"""


# --------------------------------------------------------------------------- #
# 时间与序列化辅助
# --------------------------------------------------------------------------- #

def _now() -> str:
    return db._utc_now()


def _parse(value: Any) -> Optional[datetime]:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _json_loads(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if not value:
        return {}
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return {}


def _dumps(value: Any) -> str:
    return json.dumps(value if value is not None else {}, ensure_ascii=False, sort_keys=True)


def _role(value: Any) -> str:
    return str(value or "").strip()


# --------------------------------------------------------------------------- #
# 代次与账号归属
# --------------------------------------------------------------------------- #

def _current_epochs(profile_pk: int, role_id: str) -> dict[str, int]:
    """读取三道代次。会确保控制行存在，因此**只能**在事务外调用。"""
    return db.companion_ensure_epochs(int(profile_pk), _role(role_id))


def _epochs_readonly(profile_pk: int, role_id: str) -> dict[str, int]:
    """事务内使用的只读代次读取，绝不触发写事务。"""
    return db.companion_epochs_readonly(int(profile_pk), _role(role_id))


def _assert_epoch(profile_pk: int, data_epoch: int) -> None:
    # 只读比较：这条断言会出现在每次读写入口，绝不能顺手创建控制行。
    current = db.companion_epochs_readonly(int(profile_pk), "")
    if int(data_epoch) != current["data_epoch"]:
        raise StaleEpochError("学习数据已重置，请重新进入陪伴模式")


# --------------------------------------------------------------------------- #
# 会话读取
# --------------------------------------------------------------------------- #

_SESSION_COLUMNS = (
    "session_id,profile_pk,data_epoch,study_day,canonical_task_key,run_generation,state,"
    "goal_kind,target_count,goal_revision,revision,baseline_completed,baseline_snapshot_id,"
    "plan_fingerprint,completion_role_id,active_seconds,confirmed_count,created_at,"
    "updated_at,completed_at"
)


def _session_row(profile_pk: int, data_epoch: int, session_id: str) -> Optional[dict[str, Any]]:
    rows = db.companion_query(
        "SELECT " + _SESSION_COLUMNS + " FROM companion_sessions "
        "WHERE session_id=? AND profile_pk=? AND data_epoch=?",
        (str(session_id), int(profile_pk), int(data_epoch)),
    )
    return rows[0] if rows else None


def _open_row(profile_pk: int, data_epoch: int, study_day: str,
              task_key: str) -> Optional[dict[str, Any]]:
    rows = db.companion_query(
        "SELECT " + _SESSION_COLUMNS + " FROM companion_sessions "
        "WHERE profile_pk=? AND data_epoch=? AND study_day=? AND canonical_task_key=? "
        "AND state IN ('active','paused') ORDER BY run_generation DESC LIMIT 1",
        (int(profile_pk), int(data_epoch), str(study_day), str(task_key)),
    )
    return rows[0] if rows else None


def _segment_row(session_id: str) -> Optional[dict[str, Any]]:
    rows = db.companion_query(
        "SELECT segment_id,session_id,profile_pk,data_epoch,role_id,role_name,role_epoch,"
        "seq,started_at,sealed_at FROM companion_role_segments "
        "WHERE session_id=? AND sealed_at IS NULL ORDER BY seq DESC LIMIT 1",
        (str(session_id),),
    )
    return rows[0] if rows else None


# --------------------------------------------------------------------------- #
# 打开/恢复会话
# --------------------------------------------------------------------------- #

def open_session(*, profile_pk: int, data_epoch: int, study_day: str, task_key: str,
                 goal_kind: str, target_count: Optional[int], role_id: str,
                 role_name: str = "", binding: Optional[Mapping[str, Any]] = None,
                 baseline_snapshot: Optional[Mapping[str, Any]] = None,
                 new_round: bool = False, operation_id: str = "",
                 instance_id: str = "") -> dict[str, Any]:
    """按基键打开或恢复唯一活动会话。

    同一学习日同一角色的两个窗口必须落到同一会话；否则双窗各自结算会重复领奖。
    终态之后要开新的一轮必须显式 ``new_round=True``，服务端才推进
    ``run_generation``，客户端无法自行指定。
    """
    import companion_runtime

    profile_pk = int(profile_pk)
    _assert_epoch(profile_pk, data_epoch)
    goal_kind = str(goal_kind or "session_goal")
    if goal_kind not in VALID_GOAL_KINDS:
        raise SessionError("目标类型无效")
    target = None if target_count is None else max(0, _int(target_count, 0))
    if goal_kind == "session_goal" and not target:
        raise SessionError("本轮目标必须是正整数")

    existing = _open_row(profile_pk, data_epoch, study_day, task_key)
    if existing and not new_round:
        session = _merge_goal(existing, goal_kind, target)
        _ensure_segment(session, role_id, role_name)
        if instance_id:
            _upsert_lease(session["session_id"], profile_pk, instance_id)
        return _public_session(session, binding)

    with db.companion_transaction() as conn:
        # 事务内重查：两个窗口可能同时到达。
        row = db.companion_query_with(
            conn,
            "SELECT " + _SESSION_COLUMNS + " FROM companion_sessions "
            "WHERE profile_pk=? AND data_epoch=? AND study_day=? AND canonical_task_key=? "
            "AND state IN ('active','paused') ORDER BY run_generation DESC LIMIT 1",
            (profile_pk, int(data_epoch), str(study_day), str(task_key)),
        )
        if row and not new_round:
            session = row[0]
        else:
            generation = 1
            if row:
                generation = _int(row[0].get("run_generation"), 1) + 1
            prior = db.companion_query_with(
                conn,
                "SELECT MAX(run_generation) AS g FROM companion_sessions "
                "WHERE profile_pk=? AND data_epoch=? AND study_day=? AND canonical_task_key=?",
                (profile_pk, int(data_epoch), str(study_day), str(task_key)),
            )
            generation = max(generation, _int((prior[0] or {}).get("g"), 0) + 1)
            now = _now()
            baseline = _baseline_view(baseline_snapshot)
            session_id = companion_runtime.new_id("ses")
            db.companion_execute_with(
                conn,
                "INSERT INTO companion_sessions(session_id,profile_pk,data_epoch,study_day,"
                "canonical_task_key,run_generation,state,goal_kind,target_count,goal_revision,"
                "revision,baseline_completed,baseline_snapshot_id,plan_fingerprint,"
                "completion_role_id,active_seconds,confirmed_count,created_at,updated_at,"
                "completed_at) VALUES(?,?,?,?,?,?,'active',?,?,1,1,?,?,?,NULL,0,0,?,?,NULL)",
                (session_id, profile_pk, int(data_epoch), str(study_day), str(task_key),
                 generation, goal_kind, target, baseline["completed"],
                 baseline["snapshot_id"], baseline["plan_fingerprint"], now, now),
            )
            session = _session_row(profile_pk, data_epoch, session_id) or {
                "session_id": session_id, "profile_pk": profile_pk,
                "data_epoch": int(data_epoch), "state": "active", "goal_kind": goal_kind,
                "target_count": target, "goal_revision": 1, "revision": 1,
                "baseline_completed": baseline["completed"],
                "baseline_snapshot_id": baseline["snapshot_id"],
                "plan_fingerprint": baseline["plan_fingerprint"],
                "active_seconds": 0, "confirmed_count": 0,
                "run_generation": generation, "study_day": study_day,
                "canonical_task_key": task_key, "completion_role_id": None,
                "created_at": now, "updated_at": now, "completed_at": None,
            }
        _ensure_segment(session, role_id, role_name, conn=conn)
        if instance_id:
            _upsert_lease(session["session_id"], profile_pk, instance_id, conn=conn)
    # 事务外重读，拿到最终 revision
    fresh = _session_row(profile_pk, data_epoch, session["session_id"])
    return _public_session(fresh or session, binding)


def _baseline_view(snapshot: Optional[Mapping[str, Any]]) -> dict[str, Any]:
    """进入会话那一刻的已完成基线。进入前就完成的词不计本轮新增。"""
    if not snapshot:
        return {"completed": 0, "snapshot_id": None, "plan_fingerprint": None}
    import companion_progress_sources
    items = snapshot.get("items") if isinstance(snapshot.get("items"), list) else []
    completed = len([item for item in items if item.get("is_finished") is True])
    return {
        "completed": completed,
        "snapshot_id": snapshot.get("snapshot_id"),
        "plan_fingerprint": snapshot.get("plan_fingerprint"),
    }


def _merge_goal(session: Mapping[str, Any], goal_kind: str, target: Optional[int]) -> dict[str, Any]:
    """恢复会话：只在目标真的变化时推进 goal_revision。"""
    current_kind = str(session.get("goal_kind") or "")
    current_target = session.get("target_count")
    if current_kind == goal_kind and current_target == target:
        return dict(session)
    with db.companion_transaction() as conn:
        db.companion_execute_with(
            conn,
            "UPDATE companion_sessions SET goal_kind=?,target_count=?,"
            "goal_revision=goal_revision+1,revision=revision+1,updated_at=? WHERE session_id=?",
            (goal_kind, target, _now(), session["session_id"]),
        )
    return _session_row(int(session["profile_pk"]), int(session["data_epoch"]),
                        str(session["session_id"])) or dict(session)


def _ensure_segment(session: Mapping[str, Any], role_id: str, role_name: str,
                    *, conn=None) -> dict[str, Any]:
    """当前角色未变就复用片段；换角色则封存旧片段并新建。

    换服装不换 role_id，因此这里不会因为 Live2D 模型变化而切断记忆归属。
    """
    import companion_runtime
    role_id = _role(role_id)
    segment = _segment_row(str(session["session_id"]))
    if segment and str(segment.get("role_id") or "") == role_id:
        return segment
    now = _now()
    profile_pk = int(session["profile_pk"])
    data_epoch = int(session["data_epoch"])
    epoch = _epochs_readonly(profile_pk, role_id)

    def _write(work):
        nonlocal seq, segment_id
        seq_row = db.companion_query_with(
            work, "SELECT COALESCE(MAX(seq),0) AS m FROM companion_role_segments WHERE session_id=?",
            (str(session["session_id"]),))
        seq = _int((seq_row[0] or {}).get("m"), 0) + 1
        if segment:
            db.companion_execute_with(
                work, "UPDATE companion_role_segments SET sealed_at=? WHERE segment_id=?",
                (now, str(segment["segment_id"])))
        segment_id = companion_runtime.new_id("seg")
        db.companion_execute_with(
            work,
            "INSERT INTO companion_role_segments(segment_id,session_id,profile_pk,data_epoch,"
            "role_id,role_name,role_epoch,seq,started_at,sealed_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,NULL)",
            (segment_id, str(session["session_id"]), profile_pk, data_epoch, role_id,
             str(role_name or ""), epoch["role_epoch"], seq, now))

    seq, segment_id = 0, ""
    if conn is not None:
        # 调用方已经在写事务里：绝不能再开一个 BEGIN IMMEDIATE。
        _write(conn)
    else:
        with db.companion_transaction() as owned:
            _write(owned)
    return {
        "segment_id": segment_id, "session_id": str(session["session_id"]),
        "role_id": role_id, "role_name": str(role_name or ""),
        "role_epoch": epoch["role_epoch"], "seq": seq, "started_at": now, "sealed_at": None,
    }


# --------------------------------------------------------------------------- #
# 状态机
# --------------------------------------------------------------------------- #

def set_state(*, profile_pk: int, data_epoch: int, session_id: str, action: str,
              expected_revision: Any = None, target_count: Any = None) -> dict[str, Any]:
    """暂停/恢复/放弃/调整目标。调目标只推进 goal_revision。"""
    profile_pk = int(profile_pk)
    _assert_epoch(profile_pk, data_epoch)
    action = str(action or "")
    if action not in VALID_ACTIONS:
        raise SessionError("不支持的操作")
    session = _session_row(profile_pk, data_epoch, session_id)
    if not session:
        raise SessionError("学习会话不存在")
    if expected_revision is not None and _int(expected_revision, -1) != _int(session["revision"], -2):
        raise ConflictError("学习会话已被其他窗口更新，请刷新后重试")
    if str(session["state"]) in TERMINAL_STATES:
        raise ConflictError("本轮学习已经结束")

    # 暂停/放弃前先算好已累计的有效时间：active_seconds() 会自己开连接，
    # 不能放进下面的写事务里（SQLite 不允许嵌套 BEGIN IMMEDIATE）。
    closing_seconds = None
    if action in ("pause", "abandon") and str(session["state"]) not in TERMINAL_STATES:
        closing_seconds = active_seconds(session_id=session_id)

    with db.companion_transaction() as conn:
        if action == "pause":
            if str(session["state"]) == "paused":
                return _public_session(session, None)
            # 暂停时封存当前租约：这样"暂停之后"的时间段根本不存在区间，
            # 而不用在读取时猜「暂停了多久」。恢复时会开新租约。
            db.companion_execute_with(
                conn, "UPDATE companion_activity_leases SET ended_at=? "
                "WHERE session_id=? AND ended_at IS NULL", (_now(), session_id))
            db.companion_execute_with(
                conn, "UPDATE companion_sessions SET state='paused',revision=revision+1,"
                "updated_at=?,active_seconds=? WHERE session_id=?",
                (_now(), int(closing_seconds or 0), session_id))
        elif action == "resume":
            if str(session["state"]) == "active":
                return _public_session(session, None)
            db.companion_execute_with(
                conn, "UPDATE companion_sessions SET state='active',revision=revision+1,"
                "updated_at=? WHERE session_id=?", (_now(), session_id))
        elif action == "abandon":
            # 放弃也要封存租约，否则这段会被后续的并集统计继续算进去。
            db.companion_execute_with(
                conn, "UPDATE companion_activity_leases SET ended_at=? "
                "WHERE session_id=? AND ended_at IS NULL", (_now(), session_id))
            db.companion_execute_with(
                conn, "UPDATE companion_sessions SET state='abandoned',revision=revision+1,"
                "updated_at=?,active_seconds=? WHERE session_id=?",
                (_now(), int(closing_seconds or 0), session_id))
        else:  # set_goal
            target = None if target_count is None else max(0, _int(target_count, 0))
            if target is None:
                raise SessionError("缺少目标数量")
            # 只在真正变化时推进 goal_revision；调目标本身绝不触发结算。
            if target != session.get("target_count"):
                db.companion_execute_with(
                    conn, "UPDATE companion_sessions SET target_count=?,"
                    "goal_revision=goal_revision+1,revision=revision+1,updated_at=? "
                    "WHERE session_id=?", (target, _now(), session_id))
    return _public_session(_session_row(profile_pk, data_epoch, session_id) or session, None)


# --------------------------------------------------------------------------- #
# 事件
# --------------------------------------------------------------------------- #

def _next_seq(session_id: str, instance_id: str) -> int:
    rows = db.companion_query(
        "SELECT COALESCE(MAX(seq),0) AS m FROM companion_events "
        "WHERE session_id=? AND source_instance_id=?",
        (str(session_id), str(instance_id or "")))
    return _int((rows[0] or {}).get("m"), 0) + 1


def record_events(*, profile_pk: int, data_epoch: int, session_id: str,
                  events: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """记录一批页面事件。幂等、有界、来源可信才接收。"""
    import companion_runtime

    profile_pk = int(profile_pk)
    _assert_epoch(profile_pk, data_epoch)
    session = _session_row(profile_pk, data_epoch, session_id)
    if not session:
        raise SessionError("学习会话不存在")
    if str(session["state"]) in TERMINAL_STATES:
        raise ConflictError("本轮学习已经结束")
    if not isinstance(events, (list, tuple)):
        raise SessionError("events 必须是数组")
    if len(events) > MAX_EVENTS_PER_REQUEST:
        raise SessionError("单次最多提交 %d 条学习事件" % MAX_EVENTS_PER_REQUEST)
    encoded = json.dumps(list(events), ensure_ascii=False)
    if len(encoded.encode("utf-8")) > MAX_EVENT_PAYLOAD:
        raise SessionError("学习事件正文过大")

    segment = _segment_row(session_id)
    role_id = str((segment or {}).get("role_id") or "")
    accepted, duplicates, rejected = 0, 0, []
    now = _now()
    with db.companion_transaction() as conn:
        for raw in events:
            if not isinstance(raw, Mapping):
                rejected.append({"reason": "invalid_shape"})
                continue
            event_id = str(raw.get("event_id") or "").strip()
            if not event_id or len(event_id) > 120:
                rejected.append({"reason": "invalid_event_id"})
                continue
            source = str(raw.get("source") or "intent")
            if source not in ("intent", "observed_ack", "official_snapshot"):
                rejected.append({"event_id": event_id, "reason": "invalid_source"})
                continue
            existing = db.companion_query_with(
                conn, "SELECT event_id FROM companion_events WHERE event_id=?", (event_id,))
            if existing:
                duplicates += 1
                continue
            instance_id = str(raw.get("source_instance_id") or "")[:120]
            seq = _int(raw.get("seq"), 0)
            if seq <= 0:
                seq = _next_seq(session_id, instance_id)
            db.companion_execute_with(
                conn,
                "INSERT INTO companion_events(event_id,session_id,profile_pk,data_epoch,role_id,"
                "segment_id,source_instance_id,seq,frame_generation,binding_revision,"
                "goal_revision,type,source,task_key,item_key,round_key,action,observed_at,"
                "created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (event_id, str(session_id), profile_pk, int(data_epoch), role_id,
                 str((segment or {}).get("segment_id") or ""), instance_id, seq,
                 _int(raw.get("frame_generation"), 0), _int(raw.get("binding_revision"), 1),
                 _int(session.get("goal_revision"), 1), str(raw.get("type") or "intent")[:60],
                 source, str(raw.get("task_key") or session.get("canonical_task_key") or ""),
                 str(raw.get("item_key") or "")[:200] or None,
                 str(raw.get("round_key") or "")[:200] or None,
                 str(raw.get("action") or "")[:60] or None,
                 str(raw.get("observed_at") or now), now))
            accepted += 1
    fresh = _session_row(profile_pk, data_epoch, session_id) or session
    return {"accepted": accepted, "duplicate": duplicates, "rejected": rejected,
            "revision": _int(fresh.get("revision"), 1),
            "session": _public_session(fresh, None)}


# --------------------------------------------------------------------------- #
# 有效时间租约
# --------------------------------------------------------------------------- #

def _upsert_lease(session_id: str, profile_pk: int, instance_id: str, *, conn=None) -> None:
    instance_id = str(instance_id or "").strip()
    if not instance_id:
        return
    now = _now()
    sql_select = ("SELECT lease_id FROM companion_activity_leases "
                  "WHERE session_id=? AND instance_id=? AND ended_at IS NULL")
    params = (str(session_id), instance_id)
    rows = (db.companion_query_with(conn, sql_select, params) if conn is not None
            else db.companion_query(sql_select, params))
    if rows:
        sql = "UPDATE companion_activity_leases SET last_seen_at=? WHERE lease_id=?"
        args = (now, str(rows[0]["lease_id"]))
    else:
        import companion_runtime
        sql = ("INSERT INTO companion_activity_leases(lease_id,session_id,profile_pk,"
               "instance_id,started_at,last_seen_at,ended_at) VALUES(?,?,?,?,?,?,NULL)")
        args = (companion_runtime.new_id("lease"), str(session_id), int(profile_pk),
                instance_id, now, now)
    if conn is not None:
        db.companion_execute_with(conn, sql, args)
    else:
        db.companion_execute(sql, args)


def touch_lease(*, profile_pk: int, data_epoch: int, session_id: str,
                instance_id: str, observed_at: Any = None) -> dict[str, Any]:
    profile_pk = int(profile_pk)
    _assert_epoch(profile_pk, data_epoch)
    session = _session_row(profile_pk, data_epoch, session_id)
    if not session:
        raise SessionError("学习会话不存在")
    _upsert_lease(session_id, profile_pk, instance_id)
    return {"ok": True, "active_seconds": active_seconds(session_id=session_id),
            "state": session["state"], "revision": _int(session.get("revision"), 1)}


def active_seconds(*, session_id: str, now: Any = None) -> int:
    """按租约区间**并集**统计有效时间，排除暂停、失联与长闲置。

    不用客户端上报的累计秒数：两个窗口会各自计时，累加即双倍。
    """
    session_rows = db.companion_query(
        "SELECT state,created_at,completed_at FROM companion_sessions WHERE session_id=?",
        (str(session_id),))
    if not session_rows:
        return 0
    session = session_rows[0]
    leases = db.companion_query(
        "SELECT started_at,last_seen_at,ended_at FROM companion_activity_leases "
        "WHERE session_id=? ORDER BY started_at", (str(session_id),))
    current = _parse(now) if now else datetime.now(timezone.utc)
    intervals: list[tuple[datetime, datetime]] = []
    for lease in leases:
        start = _parse(lease.get("started_at"))
        if start is None:
            continue
        last = _parse(lease.get("last_seen_at")) or start
        end = _parse(lease.get("ended_at"))
        if end is None:
            # 没有显式结束的租约只能证明「到 last_seen 为止在场」。心跳停止超过
            # 失联阈值后，这段时间无法再被核验，整段不计——宁可少算也不虚增。
            if (current - last).total_seconds() > LEASE_STALE_SECONDS:
                continue
            end = last
        end = min(end, current)
        if end > start:
            intervals.append((start, end))
    if not intervals:
        return 0
    intervals.sort()
    total = timedelta(0)
    merged_start, merged_end = intervals[0]
    for start, end in intervals[1:]:
        if start <= merged_end:
            merged_end = max(merged_end, end)
        else:
            total += merged_end - merged_start
            merged_start, merged_end = start, end
    total += merged_end - merged_start
    return max(0, int(total.total_seconds()))


# --------------------------------------------------------------------------- #
# 证据与完成判定（纯函数，便于单测）
# --------------------------------------------------------------------------- #

def evaluate_completion(session: Mapping[str, Any], snapshot: Mapping[str, Any],
                        evidence: Mapping[str, Any], binding: Mapping[str, Any]) -> dict[str, Any]:
    """冻结的完成公式。返回结构固定，调用方不需要再判一次。"""
    import companion_runtime

    result = {
        "can_complete": False, "reason": "", "confirmed_new": 0, "confirmed_review": 0,
        "confirmed_total": 0, "weak_words": [], "plan_total": None, "finished": 0,
    }
    if not companion_runtime.binding_allows_credit(binding):
        result["reason"] = "当前无法核验这个账号在本轮的学习记录"
        return result
    completeness = str((snapshot or {}).get("completeness") or "plan_unknown")
    if completeness != "complete":
        result["reason"] = "今日计划尚不完整，暂不能结算"
        return result
    items = snapshot.get("items") if isinstance(snapshot.get("items"), list) else []
    plan_ids = {str(item.get("voc_id")) for item in items}
    if not plan_ids:
        result["reason"] = "今日没有可结算的计划"
        return result
    finished = {str(item.get("voc_id")) for item in items if item.get("is_finished") is True}
    result["plan_total"] = len(plan_ids)
    result["finished"] = len(finished)
    # S：基线后发生 false→true 且具有本轮参与证据的条目，按业务三元组去重。
    confirmed = {str(key) for key in (evidence or {}).get("confirmed_keys") or []}
    confirmed_items = {key.split("|")[1] for key in confirmed if "|" in key}
    confirmed_items &= finished
    new_keys = [key for key in confirmed if "|" in key]
    result["confirmed_total"] = len(confirmed_items)
    result["confirmed_new"] = _int((evidence or {}).get("confirmed_new"), 0)
    result["confirmed_review"] = _int((evidence or {}).get("confirmed_review"), 0)
    result["weak_words"] = [str(word) for word in (evidence or {}).get("weak_words") or []][:10]

    goal_kind = str(session.get("goal_kind") or "session_goal")
    target = session.get("target_count")
    if goal_kind == "session_goal":
        target_value = _int(target, 0)
        if target_value <= 0:
            result["reason"] = "本轮目标尚未设置"
            return result
        if result["confirmed_total"] >= target_value:
            result["can_complete"] = True
            return result
        result["reason"] = "完成 %d/%d 词" % (result["confirmed_total"], target_value)
        return result

    # today_plan：全部计划完成，并且本轮确有新增参与。
    if not plan_ids <= finished:
        result["reason"] = "今日计划还剩 %d 词" % len(plan_ids - finished)
        return result
    if not new_keys:
        result["reason"] = "今日计划在进入本轮前就已经完成"
        return result
    if result["confirmed_total"] <= 0:
        result["reason"] = "本轮没有可确认的新增学习记录"
        return result
    result["can_complete"] = True
    return result


def reconcile(*, profile_pk: int, data_epoch: int, session_id: str,
              snapshot: Optional[Mapping[str, Any]] = None,
              binding: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    """合并最新快照得到真实证据与进度。写回 session.confirmed_count。"""
    import companion_runtime

    profile_pk = int(profile_pk)
    _assert_epoch(profile_pk, data_epoch)
    session = _session_row(profile_pk, data_epoch, session_id)
    if not session:
        raise SessionError("学习会话不存在")
    snapshot = snapshot or {}
    evidence = _evidence_view(session, snapshot, profile_pk)
    binding = binding or companion_runtime.identity_binding("")
    evaluation = evaluate_completion(session, snapshot, evidence, binding)
    if _int(evaluation["confirmed_total"], 0) != _int(session.get("confirmed_count"), 0):
        db.companion_execute(
            "UPDATE companion_sessions SET confirmed_count=?,updated_at=? WHERE session_id=?",
            (_int(evaluation["confirmed_total"], 0), _now(), session_id))
    fresh = _session_row(profile_pk, data_epoch, session_id) or session
    return {
        "session": _public_session(fresh, binding),
        "evidence": {"confirmed_total": evaluation["confirmed_total"],
                     "confirmed_new": evaluation["confirmed_new"],
                     "confirmed_review": evaluation["confirmed_review"],
                     "weak_words": evaluation["weak_words"]},
        "completion": {k: evaluation[k] for k in
                       ("can_complete", "reason", "plan_total", "finished", "confirmed_total")},
    }


def _evidence_view(session: Mapping[str, Any], snapshot: Mapping[str, Any],
                   profile_pk: int) -> dict[str, Any]:
    """从快照与事件推导本轮参与证据。

    ``S`` 的判定要求「基线时未完成、现在完成」，并且该条目上存在 matched 级别的
    本轮证据（``observed_ack`` 或计划由会话后拉取）。同词多轮靠 ``round_key`` 去重，
    不会把同一词重复计数。
    """
    items = snapshot.get("items") if isinstance(snapshot.get("items"), list) else []
    baseline_ids: set[str] = set()
    if session.get("baseline_snapshot_id"):
        # 按 ID 读基线：换角色后 canonical_task_key 会变，按任务键找会取不到，
        # 从而把「进入前就已完成」的词误算成本轮新增。
        import companion_progress_sources
        prior = companion_progress_sources.get_snapshot(
            profile_pk, int(session["data_epoch"]), str(session["baseline_snapshot_id"]))
        if prior:
            baseline_ids = {str(item.get("voc_id")) for item in prior.get("items") or []
                            if item.get("is_finished") is True}

    acknowledged: set[str] = set()
    rows = db.companion_query(
        "SELECT item_key FROM companion_events WHERE session_id=? "
        "AND source IN ('observed_ack','official_snapshot') AND item_key IS NOT NULL",
        (str(session["session_id"]),))
    for row in rows:
        acknowledged.add(str(row.get("item_key")))

    confirmed_keys: list[str] = []
    new_count, review_count = 0, 0
    weak: list[str] = []
    for item in items:
        voc_id = str(item.get("voc_id"))
        if item.get("is_finished") is not True:
            continue
        if voc_id in baseline_ids:
            continue  # 进入本轮前已完成的词属于今日，不属于本轮新增
        if voc_id not in acknowledged:
            continue
        confirmed_keys.append("0|%s|" % voc_id)
        if item.get("is_new") is True:
            new_count += 1
        else:
            review_count += 1
        if item.get("is_new") is not True and len(weak) < 10:
            weak.append(voc_id)
    return {"confirmed_keys": confirmed_keys, "confirmed_new": new_count,
            "confirmed_review": review_count, "weak_words": weak}


# --------------------------------------------------------------------------- #
# 完成事务
# --------------------------------------------------------------------------- #

def _local_congrats(role_name: str, evaluation: Mapping[str, Any],
                    active: int) -> str:
    """本地确定性祝贺。没有 AI/语音/动作时这段文字就是完整体验。"""
    name = str(role_name or "陪伴角色").strip() or "陪伴角色"
    total = _int(evaluation.get("confirmed_total"), 0)
    minutes = max(0, int(round(_int(active, 0) / 60.0)))
    if total <= 0:
        return "今天的学习记录已经确认，%s 把这一轮留在这里等你回来。" % name
    tail = "，用了 %d 分钟" % minutes if minutes else ""
    return "这一轮完成 %d 词%s。%s 记下了今天的认真，明天继续。" % (total, tail, name)


def complete_session(*, profile_pk: int, data_epoch: int, session_id: str,
                     expected_revision: Any = None,
                     evidence_refs: Optional[Mapping[str, Any]] = None,
                     snapshot: Optional[Mapping[str, Any]] = None,
                     binding: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    """完成事务：结算 + 纪念卡 + 首次徽章 + 记忆队列，全部唯一且同事务。"""
    import companion_runtime

    profile_pk = int(profile_pk)
    _assert_epoch(profile_pk, data_epoch)
    session = _session_row(profile_pk, data_epoch, session_id)
    if not session:
        raise SessionError("学习会话不存在")
    if str(session["state"]) == "completed":
        # 重复提交 / 刷新 / 双窗：返回同一份结算，不重复领奖。
        return get_settlement(profile_pk, data_epoch, session_id) or {"available": False}
    if str(session["state"]) == "abandoned":
        raise ConflictError("本轮学习已结束，不能结算")
    if expected_revision is not None and _int(expected_revision, -1) != _int(session["revision"], -2):
        raise ConflictError("学习会话已被其他窗口更新，请刷新后重试")

    snapshot = snapshot or {}
    evidence = _evidence_view(session, snapshot, profile_pk)
    binding = binding or companion_runtime.identity_binding("")
    evaluation = evaluate_completion(session, snapshot, evidence, binding)
    if not evaluation["can_complete"]:
        raise SessionError(evaluation["reason"] or "本轮学习尚未完成")

    active = active_seconds(session_id=session_id)
    segment = _segment_row(session_id)
    role_id = str((segment or {}).get("role_id") or session.get("completion_role_id") or "")
    role_name = str((segment or {}).get("role_name") or "")
    study_day = str(session["study_day"])
    now = _now()
    local_message = _local_congrats(role_name, evaluation, active)
    epochs = _current_epochs(profile_pk, role_id)

    settlement_id = companion_runtime.new_id("set")
    goal_snapshot = {
        "goal_kind": session.get("goal_kind"),
        "target_count": session.get("target_count"),
        "goal_revision": session.get("goal_revision"),
        "plan_fingerprint": snapshot.get("plan_fingerprint") or session.get("plan_fingerprint"),
        "plan_total": evaluation["plan_total"],
        "finished": evaluation["finished"],
        "baseline_completed": session.get("baseline_completed"),
    }
    refs = dict(evidence_refs or {})
    refs.setdefault("snapshot_id", snapshot.get("snapshot_id"))
    refs.setdefault("plan_fingerprint", snapshot.get("plan_fingerprint"))

    with db.companion_transaction() as conn:
        _write_settlement(conn, profile_pk, data_epoch, session_id, session, segment,
                          role_id, role_name, study_day, evaluation, active, local_message,
                          goal_snapshot, refs, now)
    if segment:
        db.companion_execute(
            "UPDATE companion_role_segments SET sealed_at=? WHERE segment_id=?",
            (now, str(segment["segment_id"])))
    return get_settlement(profile_pk, data_epoch, session_id) or {"available": False}


def _write_settlement(conn, profile_pk, data_epoch, session_id, session, segment,
                      role_id, role_name, study_day, evaluation, active, local_message,
                      goal_snapshot, refs, now) -> None:
    """结算事务的全部写入。调用方已持有写连接，因此只用 conn 版本。

    奖励、结算、队列必须同一事务：分开提交会出现「发了奖励但没结算」或
    「结算两次」的窗口。
    """
    import companion_runtime

    settlement_id = companion_runtime.new_id("set")
    existing = db.companion_query_with(
        conn, "SELECT settlement_id FROM companion_settlements WHERE profile_pk=? AND session_id=?",
        (profile_pk, session_id))
    if existing:
        return
    epoch = _epochs_readonly(profile_pk, role_id)
    db.companion_execute_with(
        conn,
        "INSERT INTO companion_settlements(settlement_id,session_id,profile_pk,data_epoch,"
        "completion_role_id,completion_role_name,confirmed_new,confirmed_review,"
        "confirmed_total,active_seconds,verified_weak_words_json,evidence_refs_json,"
        "goal_snapshot_json,local_message,ai_state,ai_message,reward_ids_json,created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'idle',NULL,?,?)",
        (settlement_id, session_id, profile_pk, int(data_epoch),
         role_id or None, role_name or None,
         _int(evaluation["confirmed_new"]), _int(evaluation["confirmed_review"]),
         _int(evaluation["confirmed_total"]), active,
         _dumps(evaluation["weak_words"]), _dumps(refs), _dumps(goal_snapshot),
         local_message, "[]", now))
    db.companion_execute_with(
        conn,
        "UPDATE companion_sessions SET state='completed',revision=revision+1,"
        "updated_at=?,completed_at=?,confirmed_count=?,active_seconds=?,"
        "completion_role_id=? WHERE session_id=?",
        (now, now, _int(evaluation["confirmed_total"]), active, role_id or None, session_id))
    reward_ids = _grant_rewards(conn, profile_pk, int(data_epoch), session_id, study_day,
                                role_name, evaluation, now)
    db.companion_execute_with(
        conn, "UPDATE companion_settlements SET reward_ids_json=? WHERE settlement_id=?",
        (_dumps(reward_ids), settlement_id))
    _enqueue_memory(conn, profile_pk, epoch, session, segment, role_id, role_name,
                    study_day, evaluation, active, now)


def _grant_rewards(conn, profile_pk: int, data_epoch: int, session_id: str, study_day: str,
                   role_name: str, evaluation: Mapping[str, Any], now: str) -> list[str]:
    """纪念卡与首次徽章：各自唯一约束，重试不会多发。"""
    import companion_runtime

    reward_ids: list[str] = []
    cards = [("memorial_card", study_day,
              {"study_day": study_day, "role_name": role_name,
               "confirmed_total": _int(evaluation.get("confirmed_total")),
               "weak_words": list(evaluation.get("weak_words") or [])[:10]})]
    first_row = db.companion_query_with(
        conn, "SELECT reward_id FROM companion_rewards WHERE profile_pk=? AND data_epoch=? "
              "AND reward_type='first_completion'", (profile_pk, int(data_epoch)))
    if not first_row:
        cards.append(("first_completion", "first",
                      {"study_day": study_day, "role_name": role_name}))
    for reward_type, period_key, payload in cards:
        rows = db.companion_query_with(
            conn, "SELECT reward_id FROM companion_rewards WHERE profile_pk=? AND data_epoch=? "
                  "AND reward_type=? AND (session_id=? OR period_key=?)",
            (profile_pk, int(data_epoch), reward_type, session_id, period_key))
        if rows:
            reward_ids.append(str(rows[0]["reward_id"]))
            continue
        reward_id = companion_runtime.new_id("rwd")
        try:
            db.companion_execute_with(
                conn,
                "INSERT INTO companion_rewards(reward_id,profile_pk,data_epoch,session_id,"
                "reward_type,period_key,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
                (reward_id, profile_pk, int(data_epoch), session_id, reward_type,
                 period_key, _dumps(payload), now))
        except Exception:
            # 唯一约束竞态：回退为读取既有奖励，绝不重复发放。
            rows = db.companion_query_with(
                conn, "SELECT reward_id FROM companion_rewards WHERE profile_pk=? "
                      "AND data_epoch=? AND reward_type=? AND period_key=?",
                (profile_pk, int(data_epoch), reward_type, period_key))
            if not rows:
                raise
            reward_id = str(rows[0]["reward_id"])
        reward_ids.append(reward_id)
    return reward_ids


def _enqueue_memory(conn, profile_pk: int, epochs: Mapping[str, int],
                    session: Mapping[str, Any], segment: Optional[Mapping[str, Any]],
                    role_id: str, role_name: str, study_day: str,
                    evaluation: Mapping[str, Any], active: int, now: str) -> None:
    """记忆派生队列与奖励同事务入队；消费失败只重试本队列。"""
    payload = {
        "session_id": str(session["session_id"]),
        "segment_id": (segment or {}).get("segment_id"),
        "role_id": role_id,
        "completion_role_name": role_name,
        "study_day": study_day,
        "occurred_at": now,
        "confirmed_new": _int(evaluation.get("confirmed_new")),
        "confirmed_review": _int(evaluation.get("confirmed_review")),
        "active_seconds": int(active),
        "weak_words": list(evaluation.get("weak_words") or [])[:10],
    }
    try:
        db.companion_execute_with(
            conn,
            "INSERT INTO companion_outbox(profile_pk,data_epoch,account_epoch,"
            "role_epoch,session_id,segment_id,role_id,event_type,payload_json,status,attempts,"
            "created_at,consumed_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',0,?,NULL)",
            (int(profile_pk), epochs["data_epoch"], epochs["account_epoch"],
             epochs["role_epoch"], str(session["session_id"]),
             (segment or {}).get("segment_id"), role_id, SETTLEMENT_KIND, _dumps(payload), now))
    except Exception:
        # 唯一约束重入是幂等的；其他错误必须抛出——``INSERT OR IGNORE`` 会把
        # NOT NULL 之类的真实缺陷一起吞掉，让结算看起来成功却没留下记忆事件。
        if not db.companion_query_with(
                conn, "SELECT outbox_id FROM companion_outbox WHERE profile_pk=? AND "
                      "data_epoch=? AND session_id=? AND COALESCE(segment_id,'')=? AND event_type=?",
                (int(profile_pk), epochs["data_epoch"], str(session["session_id"]),
                 str((segment or {}).get("segment_id") or ""), SETTLEMENT_KIND)):
            raise


# --------------------------------------------------------------------------- #
# 结算读取
# --------------------------------------------------------------------------- #

def get_settlement(profile_pk: int, data_epoch: int, session_id: str) -> Optional[dict[str, Any]]:
    rows = db.companion_query(
        "SELECT settlement_id,session_id,profile_pk,data_epoch,completion_role_id,"
        "completion_role_name,confirmed_new,confirmed_review,confirmed_total,active_seconds,"
        "verified_weak_words_json,evidence_refs_json,goal_snapshot_json,local_message,"
        "ai_state,ai_message,reward_ids_json,created_at "
        "FROM companion_settlements WHERE profile_pk=? AND data_epoch=? AND session_id=?",
        (int(profile_pk), int(data_epoch), str(session_id)),
    )
    if not rows:
        return None
    row = rows[0]
    rewards = db.companion_query(
        "SELECT reward_id,reward_type,period_key,payload_json,created_at "
        "FROM companion_rewards WHERE profile_pk=? AND data_epoch=? AND session_id=? "
        "ORDER BY created_at",
        (int(profile_pk), int(data_epoch), str(session_id)),
    )
    return {
        "available": True,
        "settlement_id": row["settlement_id"],
        "session_id": row["session_id"],
        "role_id": row["completion_role_id"] or "",
        "role_name": row["completion_role_name"] or "",
        "confirmed_new": _int(row["confirmed_new"]),
        "confirmed_review": _int(row["confirmed_review"]),
        "confirmed_total": _int(row["confirmed_total"]),
        "active_seconds": _int(row["active_seconds"]),
        "weak_words": _json_loads(row["verified_weak_words_json"]) or [],
        "evidence_refs": _json_loads(row["evidence_refs_json"]) or {},
        "goal": _json_loads(row["goal_snapshot_json"]) or {},
        "message": str(row["local_message"] or ""),
        "ai_state": str(row["ai_state"] or "idle"),
        "ai_message": row["ai_message"],
        "rewards": [{"reward_id": item["reward_id"], "type": item["reward_type"],
                     "period_key": item["period_key"],
                     "payload": _json_loads(item["payload_json"]),
                     "created_at": item["created_at"]} for item in rewards],
        "created_at": row["created_at"],
    }


def list_settlements(profile_pk: int, data_epoch: int, *, limit: int = 20) -> list[dict[str, Any]]:
    rows = db.companion_query(
        "SELECT session_id FROM companion_settlements WHERE profile_pk=? AND data_epoch=? "
        "ORDER BY created_at DESC LIMIT ?",
        (int(profile_pk), int(data_epoch), max(1, min(_int(limit, 20), 100))),
    )
    out = []
    for row in rows:
        item = get_settlement(profile_pk, data_epoch, str(row["session_id"]))
        if item:
            out.append(item)
    return out


def get_session(profile_pk: int, data_epoch: int, session_id: str) -> Optional[dict[str, Any]]:
    _assert_epoch(int(profile_pk), int(data_epoch))
    session = _session_row(int(profile_pk), int(data_epoch), str(session_id))
    if not session:
        return None
    return _public_session(session, None)


def _public_session(session: Mapping[str, Any], binding: Optional[Mapping[str, Any]]) -> dict[str, Any]:
    """对前端公开的会话视图。不暴露 revision/outbox/epoch 之外的实现名词。"""
    segment = _segment_row(str(session.get("session_id"))) if session.get("session_id") else None
    target = session.get("target_count")
    confirmed = _int(session.get("confirmed_count"), 0)
    total = _int(target, 0) if str(session.get("goal_kind")) == "session_goal" else None
    view = {
        "session_id": str(session.get("session_id") or ""),
        "state": str(session.get("state") or "active"),
        "goal_kind": str(session.get("goal_kind") or "session_goal"),
        "target_count": target,
        "confirmed_count": confirmed,
        "progress": {
            "done": confirmed,
            "total": total,
            # 目标未知时前端必须显示「待确认」，不能自己编一个分母。
            "known": total is not None,
        },
        "role_id": str((segment or {}).get("role_id") or session.get("completion_role_id") or ""),
        "role_name": str((segment or {}).get("role_name") or ""),
        "active_seconds": _int(session.get("active_seconds"), 0),
        "study_day": str(session.get("study_day") or ""),
        "revision": _int(session.get("revision"), 1),
        "goal_revision": _int(session.get("goal_revision"), 1),
        "can_settle": str(session.get("state") or "") == "completed",
    }
    if binding is not None:
        view["identity"] = {
            "status": str((binding or {}).get("status") or "unknown"),
            "credit_allowed": bool((binding or {}).get("status") == "matched"),
        }
    return view


def purge_account(profile_pk: int) -> dict[str, int]:
    """清空陪伴派生学习数据并推进代次（旧会话/结算不可再用）。"""
    return db.companion_purge_learning_data(int(profile_pk))


def drain_memory_queue(profile_pk: int, *, limit: int = 50) -> dict[str, Any]:
    """完成结算后把记忆派生队列消费掉；失败只影响记忆，不影响奖励。"""
    import companion_memory
    return companion_memory.consume_outbox(int(profile_pk), limit=limit)