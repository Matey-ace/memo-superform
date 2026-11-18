# -*- coding: utf-8 -*-
"""陪伴升级：严格官方计划快照（任务 A，契约 v1）。

本模块只做一件事：把墨墨上游的“今日计划”原始响应转成**严格类型的三态快照**，
并负责它的持久化与比较。它不提供 HTTP 路由（路由由 M 在 ``server.py`` 接线）。

为什么必须在这里重新实现一遍字段校验，而不是复用
``study_sync.normalise_today_item()``：

* 现有函数用 ``bool()`` 强制转换，``{"is_finished": 0}``、缺少 ``is_finished``、
  以及 ``is_finished: false`` 三种情况在转换后完全一样。而本次要区分
  “这次复习还没做完”和“上游没告诉我们做没做完”——后者绝不能当成 False
  去计算完成进度，否则会出现“字段缺失 → 视为未完成 → 永不结算”或更糟的
  “字段缺失 → 视为已完成 → 误发奖励”。
* 现有函数还会直接抛 ``DataIncompleteError`` 中断整次同步；快照层需要保留
  部分信息（哪些字段能信、哪些不能）供 UI 显示“待同步”。

因此三态是：``present``（存在且类型正确）、``invalid``（存在但类型不对）、
``absent``（上游没有给）。缺失与 False 严格分开。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Iterable, Mapping, Optional, Sequence

import db
import companion_runtime

__all__ = [
    "STRICT_ITEM_FIELDS",
    "FIELD_STATES",
    "COMPLETENESS_VALUES",
    "DEFAULT_LIMIT",
    "SOURCE_OFFICIAL_TODAY_ITEMS",
    "ProgressSourceError",
    "SnapshotFormatError",
    "StaleEpochError",
    "normalise_strict_item",
    "classify_completeness",
    "build_snapshot",
    "persist_snapshot",
    "insert_snapshot_row",
    "latest_snapshot",
    "plan_fingerprint",
    "compare_plans",
    "snapshot_items",
    "plan_item_ids",
    "finished_item_ids",
    "snapshot_is_complete",
]

#: 关键字段：任何一项不是 present，快照就不能自称完整计划。
STRICT_ITEM_FIELDS = ("voc_id", "is_new", "is_finished")
FIELD_STATES = ("present", "invalid", "absent")
COMPLETENESS_VALUES = ("complete", "truncated", "missing_fields", "plan_unknown", "limit_reached")

#: 与 ``study_sync.MAX_QUERY_RECORDS`` 对齐：达到该条数时上游自身也承认结果不可信。
DEFAULT_LIMIT = 1000

SOURCE_OFFICIAL_TODAY_ITEMS = "official_today_items"


class ProgressSourceError(Exception):
    """快照层的通用错误。"""


class SnapshotFormatError(ProgressSourceError):
    """输入结构本身不可接受（不是数组、条目不是对象、成员重复等）。

    这类问题无法用“降级为不完整”表达：重复成员会让计划身份自相矛盾，
    无法决定该按哪一个算完成，因此直接拒绝写入，由调用方记录并重试。
    """


class StaleEpochError(ProgressSourceError):
    """账号代次已推进（用户清空过学习数据）：旧代次写入必须被拒。"""


# --------------------------------------------------------------------------- #
# 字段三态
# --------------------------------------------------------------------------- #

def _voc_id_state(raw: Mapping[str, Any]) -> tuple[Optional[str], str]:
    if "voc_id" not in raw:
        return None, "absent"
    value = raw["voc_id"]
    # 严格：只接受非空字符串。数字 ID 会被上游序列化成数字，但那是类型错误，
    # 若替上游做转换就会把 “1” 和 “01” 两种拼写混为一个词条。
    if isinstance(value, str):
        text = value.strip()
        if text:
            return text, "present"
        return None, "invalid"
    return None, "invalid"


def _bool_state(raw: Mapping[str, Any], name: str) -> tuple[Optional[bool], str]:
    if name not in raw:
        return None, "absent"
    value = raw[name]
    # ``isinstance(1, bool) is False``：1/0 不算合法的布尔字段，
    # 因为上游改成数字枚举时我们需要知道语义变了，而不是猜。
    if isinstance(value, bool):
        return value, "present"
    return None, "invalid"


def normalise_strict_item(raw: Mapping[str, Any]) -> dict[str, Any]:
    """把一条原始计划条目转成严格三态条目。

    返回 ``{"voc_id", "is_new", "is_finished", "field_state", ...}``；
    类型不对 → ``None`` + ``"invalid"``，缺失 → ``None`` + ``"absent"``，
    **绝不**把缺失当成 ``False``。
    """
    if not isinstance(raw, Mapping):
        raise SnapshotFormatError("计划条目不是对象")
    voc_id, voc_state = _voc_id_state(raw)
    is_new, new_state = _bool_state(raw, "is_new")
    is_finished, finished_state = _bool_state(raw, "is_finished")
    item: dict[str, Any] = {
        "voc_id": voc_id,
        "is_new": is_new,
        "is_finished": is_finished,
        "field_state": {
            "voc_id": voc_state,
            "is_new": new_state,
            "is_finished": finished_state,
        },
        # 条目是否可用于任何派生（指纹、完成集合）。voc_id 不可用即整体不可用。
        "usable": voc_state == "present",
    }
    # 真实可得的展示字段：只保留类型明确、且不随答题变化的那些。
    spelling = raw.get("voc_spelling")
    if isinstance(spelling, str):
        item["voc_spelling"] = spelling.strip()
    order = raw.get("order")
    if isinstance(order, int) and not isinstance(order, bool):
        item["order"] = order
    first_response = raw.get("first_response")
    if isinstance(first_response, str):
        item["first_response"] = first_response
    return item


def _as_normalised(item: Any) -> dict[str, Any]:
    """接受原始条目或已归一化条目，统一成归一化形状。"""
    if isinstance(item, Mapping) and isinstance(item.get("field_state"), Mapping):
        return dict(item)  # type: ignore[return-value]
    return normalise_strict_item(item)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# 完整性判定
# --------------------------------------------------------------------------- #

def _duplicate_ids(items: Sequence[Mapping[str, Any]]) -> list[str]:
    seen: set[str] = set()
    duplicates: list[str] = []
    for item in items:
        voc_id = item.get("voc_id")
        if not isinstance(voc_id, str) or not voc_id:
            continue
        if voc_id in seen and voc_id not in duplicates:
            duplicates.append(voc_id)
        seen.add(voc_id)
    return duplicates


def classify_completeness(items: list, *, raw_count: Optional[int] = None, limit: int = DEFAULT_LIMIT,
                          upstream_plan_known: bool = False) -> str:
    """判定快照可信度。

    返回 ``complete | truncated | missing_fields | plan_unknown | limit_reached``。

    判定顺序刻意如此：先看“上游是否已到自身上限”（最不可信），再看
    “这一次响应是否只给了第一页”，然后才是字段质量，最后才是“我们是否有
    已核验的计划身份”。任何一步不满足都不会返回 ``complete``，
    ``build_snapshot`` 也就不会给出 ``total``。
    """
    if not isinstance(items, list):
        raise SnapshotFormatError("items 必须是数组")
    normalised = [_as_normalised(item) for item in items]
    limit = int(limit or DEFAULT_LIMIT)
    if raw_count is None:
        raw_count = len(normalised)
    raw_count = int(raw_count)
    if raw_count < len(normalised):
        raise SnapshotFormatError("raw_count 小于返回条目数")
    if limit > 0 and raw_count >= limit:
        return "limit_reached"
    if raw_count > len(normalised):
        # 上游按分页返回，本次只拿到第一页：计划身份不完整。
        return "truncated"
    for item in normalised:
        states = item.get("field_state") or {}
        if any(states.get(name) != "present" for name in STRICT_ITEM_FIELDS):
            return "missing_fields"
    if _duplicate_ids(normalised):
        # 成员重复同样让计划身份自相矛盾：宁可先判不完整，也不猜哪条有效。
        return "missing_fields"
    if not upstream_plan_known:
        return "plan_unknown"
    return "complete"


# --------------------------------------------------------------------------- #
# 计划指纹与比较
# --------------------------------------------------------------------------- #

def plan_fingerprint(items: list, *, study_day: str = "", task_key: str = "",
                     task_kind: str = SOURCE_OFFICIAL_TODAY_ITEMS) -> str:
    """计划身份指纹：只含计划身份/成员/任务类型，**不含** ``is_finished``。

    为什么必须排除 ``is_finished``：它是随答题变化的量。若进入指纹，
    每答一个词计划就被判定为“变了”，对账会把基线不断重置，本轮增量永远
    攒不起来，也无法发现真正的计划增删。
    """
    members: list[list[Any]] = []
    for item in items or []:
        if not isinstance(item, Mapping):
            continue
        normalised = _as_normalised(item)
        voc_id = normalised.get("voc_id")
        if not isinstance(voc_id, str) or not voc_id:
            continue
        # ``is_new`` 属于计划身份的一部分（新词/复习词由学习计划决定，
        # 不随作答翻转）；缺失用 "?" 表达“不知道”，不与 False 混同。
        is_new = normalised.get("is_new")
        marker = "?" if is_new is None else ("1" if is_new else "0")
        members.append([voc_id, marker])
    members.sort()
    payload = {
        "kind": str(task_kind or ""),
        "day": str(study_day or ""),
        "task": str(task_key or ""),
        "members": members,
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _member_map(snapshot: Optional[Mapping[str, Any]]) -> dict[str, Mapping[str, Any]]:
    if not snapshot:
        return {}
    result: dict[str, Mapping[str, Any]] = {}
    for item in snapshot_items(snapshot):
        voc_id = item.get("voc_id")
        if isinstance(voc_id, str) and voc_id and voc_id not in result:
            result[voc_id] = item
    return result


def compare_plans(previous: Optional[dict], current: dict) -> dict:
    """比较两次计划快照。

    返回 ``{"plan_changed", "added", "removed", "reset", ...}``：

    * ``added`` / ``removed`` 是成员差集（词条 ID）。
    * ``reset`` 表示成员没变、但已完成的条目整体退回未完成——这是计划重置，
      不是学习者“取消完成”，需要重新建立基线而不是把已完成量算成负数。
    """
    if current is None:
        raise SnapshotFormatError("缺少当前计划")
    current_members = _member_map(current)
    if previous is None:
        return {
            "plan_changed": True,
            "first_seen": True,
            "fingerprint_changed": True,
            "added": [],
            "removed": [],
            "reset": False,
            "previous_count": 0,
            "current_count": len(current_members),
        }
    previous_members = _member_map(previous)
    added = sorted(set(current_members) - set(previous_members))
    removed = sorted(set(previous_members) - set(current_members))
    fingerprint_changed = str(previous.get("plan_fingerprint") or "") != str(current.get("plan_fingerprint") or "")
    previous_finished = {voc_id for voc_id, item in previous_members.items() if item.get("is_finished") is True}
    current_finished = {voc_id for voc_id, item in current_members.items() if item.get("is_finished") is True}
    reset = bool(previous_finished - current_finished) and not added and not removed
    return {
        "plan_changed": bool(added or removed or fingerprint_changed),
        "first_seen": False,
        "fingerprint_changed": fingerprint_changed,
        "added": added,
        "removed": removed,
        "reset": reset,
        "previous_count": len(previous_members),
        "current_count": len(current_members),
    }


# --------------------------------------------------------------------------- #
# 快照读写辅助
# --------------------------------------------------------------------------- #

def snapshot_items(snapshot: Optional[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """取出快照条目（已归一化），容错处理缺失/损坏的 items_json。"""
    if not snapshot:
        return []
    items = snapshot.get("items")
    if items is None:
        raw = snapshot.get("items_json")
        if isinstance(raw, str) and raw:
            try:
                items = json.loads(raw)
            except (TypeError, ValueError):
                items = []
        else:
            items = []
    if not isinstance(items, list):
        return []
    result = []
    for item in items:
        if isinstance(item, Mapping):
            result.append(dict(item))
    return result


def plan_item_ids(snapshot: Optional[Mapping[str, Any]]) -> list[str]:
    ids = []
    for item in snapshot_items(snapshot):
        voc_id = item.get("voc_id")
        if isinstance(voc_id, str) and voc_id:
            ids.append(voc_id)
    return ids


def finished_item_ids(snapshot: Optional[Mapping[str, Any]]) -> list[str]:
    """只有 ``is_finished is True`` 才计入完成；None（未知）与 False 都不算。"""
    ids = []
    for item in snapshot_items(snapshot):
        voc_id = item.get("voc_id")
        if isinstance(voc_id, str) and voc_id and item.get("is_finished") is True:
            ids.append(voc_id)
    return ids


def snapshot_is_complete(snapshot: Optional[Mapping[str, Any]]) -> bool:
    return bool(snapshot) and str((snapshot or {}).get("completeness") or "") == "complete"


def _one(conn: Any, sql: str, params: Sequence[Any] = ()) -> Optional[dict[str, Any]]:
    cursor = conn.execute(sql, tuple(params))
    row = cursor.fetchone()
    if row is None:
        return None
    return {key: row[key] for key in row.keys()}


def _account_epoch(conn: Any, profile_pk: int) -> int:
    """在调用方事务内读取账号代次。

    这里刻意不调用 ``db.companion_account_state()``：它内部会开启自己的写事务，
    在 ``db.companion_transaction()`` 里再开一个会直接报错。
    """
    row = _one(conn, "SELECT data_epoch FROM companion_account_state WHERE profile_pk=?", (int(profile_pk),))
    if row is None:
        # 控制行尚未建立时语义上就是初始代次 1（db 侧同样以 1 初始化）。
        return 1
    try:
        return int(row["data_epoch"])
    except (TypeError, ValueError):
        return 1


def _row_with_items(row: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    if row is None:
        return None
    result = dict(row)
    result["items"] = snapshot_items(result)
    try:
        result["total"] = None if result.get("total") in (None, "") else int(result["total"])
    except (TypeError, ValueError):
        result["total"] = None
    for name in ("item_count", "fetch_seq", "plan_version", "binding_revision", "data_epoch", "profile_pk"):
        try:
            result[name] = int(result[name])
        except (KeyError, TypeError, ValueError):
            pass
    return result


# --------------------------------------------------------------------------- #
# 组装
# --------------------------------------------------------------------------- #

def build_snapshot(profile_pk: int, data_epoch: int, study_day: str, task_key: str,
                   raw_items: list, *, raw_count: Optional[int] = None,
                   upstream_plan_known: bool = False, fetch_seq: int = 0,
                   source: str = SOURCE_OFFICIAL_TODAY_ITEMS, binding_revision: int = 1,
                   limit: int = DEFAULT_LIMIT, plan_version: int = 1,
                   requested_at: Optional[str] = None, observed_at: Optional[str] = None,
                   task_kind: str = SOURCE_OFFICIAL_TODAY_ITEMS) -> dict:
    """组装可写入 ``companion_plan_snapshots`` 的行字典。

    ``completeness != "complete"`` 时 ``total`` 一律为 ``None``：宁可让界面显示
    “目标待同步”，也不要在分母不可信时造一个百分比。
    """
    if not isinstance(raw_items, list):
        raise SnapshotFormatError("items 必须是数组")
    items = []
    for raw in raw_items:
        if not isinstance(raw, Mapping):
            raise SnapshotFormatError("计划条目不是对象")
        items.append(normalise_strict_item(raw))
    duplicates = _duplicate_ids(items)
    if duplicates:
        # 成员重复时“谁是同一个词”无法确定，写入会让后续对账自相矛盾。
        raise SnapshotFormatError("计划成员重复：%s" % ",".join(duplicates[:5]))
    completeness = classify_completeness(items, raw_count=raw_count, limit=limit,
                                          upstream_plan_known=upstream_plan_known)
    now = companion_runtime.utc_now_iso()
    item_count = len(items)
    total = item_count if completeness == "complete" else None
    fingerprint = plan_fingerprint(items, study_day=str(study_day or ""), task_key=str(task_key or ""),
                                   task_kind=str(task_kind or ""))
    snapshot = {
        "snapshot_id": companion_runtime.new_id("snap"),
        "profile_pk": int(profile_pk),
        "data_epoch": int(data_epoch),
        "study_day": str(study_day or ""),
        "task_key": str(task_key or ""),
        "plan_version": int(plan_version),
        "plan_fingerprint": fingerprint,
        "fetch_seq": int(fetch_seq),
        "requested_at": str(requested_at or now),
        "observed_at": str(observed_at or now),
        "completeness": completeness,
        "total": total,
        "item_count": item_count,
        "items": items,
        "items_json": json.dumps(items, ensure_ascii=False, sort_keys=True),
        "source": str(source or SOURCE_OFFICIAL_TODAY_ITEMS),
        "binding_revision": int(binding_revision),
        "created_at": now,
        # 便于调用方/界面直接使用的派生量，不写库。
        "finished_count": len(finished_item_ids({"items": items})),
        "plan_size": len(plan_item_ids({"items": items})),
    }
    return snapshot


def _coerce_row(snapshot: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(snapshot, Mapping):
        raise SnapshotFormatError("快照必须是对象")
    items = snapshot_items(snapshot)
    completeness = str(snapshot.get("completeness") or "")
    if completeness not in COMPLETENESS_VALUES:
        raise SnapshotFormatError("未知的完整性状态：%s" % completeness)
    now = companion_runtime.utc_now_iso()
    profile_pk = int(snapshot.get("profile_pk") or 0)
    if profile_pk <= 0:
        raise SnapshotFormatError("快照缺少账号归属")
    total = snapshot.get("total")
    if completeness != "complete":
        total = None
    elif total is None:
        total = len(items)
    fingerprint = str(snapshot.get("plan_fingerprint") or "") or plan_fingerprint(
        items, study_day=str(snapshot.get("study_day") or ""), task_key=str(snapshot.get("task_key") or ""))
    row = {
        "snapshot_id": str(snapshot.get("snapshot_id") or companion_runtime.new_id("snap")),
        "profile_pk": profile_pk,
        "data_epoch": int(snapshot.get("data_epoch") or 0),
        "study_day": str(snapshot.get("study_day") or ""),
        "task_key": str(snapshot.get("task_key") or ""),
        "plan_version": int(snapshot.get("plan_version") or 1),
        "plan_fingerprint": fingerprint,
        "fetch_seq": int(snapshot.get("fetch_seq") or 0),
        "requested_at": str(snapshot.get("requested_at") or now),
        "observed_at": str(snapshot.get("observed_at") or now),
        "completeness": completeness,
        "total": None if total is None else int(total),
        "item_count": len(items),
        "items": items,
        "items_json": json.dumps(items, ensure_ascii=False, sort_keys=True),
        "source": str(snapshot.get("source") or SOURCE_OFFICIAL_TODAY_ITEMS),
        "binding_revision": int(snapshot.get("binding_revision") or 1),
        "created_at": str(snapshot.get("created_at") or now),
    }
    if row["data_epoch"] <= 0:
        raise SnapshotFormatError("快照缺少代次")
    return row


def insert_snapshot_row(conn: Any, snapshot: Mapping[str, Any]) -> dict[str, Any]:
    """在**调用方已开启的事务**内写入快照，并按 ``fetch_seq`` 拒绝旧响应。

    返回 ``{"persisted", "reason", "fetch_seq", "current_fetch_seq", "snapshot_id"}``。
    低序号写入被拒时返回明确结果而不抛错：一次乱序响应属于正常网络现象，
    调用方需要的是“没写进去”这一事实，而不是异常。
    """
    row = _coerce_row(snapshot)
    current_epoch = _account_epoch(conn, row["profile_pk"])
    if int(row["data_epoch"]) != int(current_epoch):
        raise StaleEpochError("账号数据已清理，拒收旧计划快照")
    existing = _one(conn, "SELECT snapshot_id FROM companion_plan_snapshots WHERE snapshot_id=?",
                    (row["snapshot_id"],))
    if existing is not None:
        return {"persisted": False, "reason": "duplicate_snapshot", "snapshot_id": row["snapshot_id"],
                "fetch_seq": row["fetch_seq"], "current_fetch_seq": row["fetch_seq"]}
    latest = _one(conn,
                  "SELECT snapshot_id,fetch_seq,plan_fingerprint FROM companion_plan_snapshots "
                  "WHERE profile_pk=? AND data_epoch=? AND study_day=? AND task_key=? "
                  "ORDER BY fetch_seq DESC, created_at DESC LIMIT 1",
                  (row["profile_pk"], row["data_epoch"], row["study_day"], row["task_key"]))
    current_seq = -1 if latest is None else int(latest["fetch_seq"] or 0)
    if latest is not None and row["fetch_seq"] < current_seq:
        # 旧请求晚到：绝不覆盖更新的计划结论。
        return {"persisted": False, "reason": "stale_fetch_seq", "snapshot_id": row["snapshot_id"],
                "fetch_seq": row["fetch_seq"], "current_fetch_seq": current_seq}
    if latest is not None and row["fetch_seq"] == current_seq:
        return {"persisted": False, "reason": "fetch_seq_conflict", "snapshot_id": row["snapshot_id"],
                "fetch_seq": row["fetch_seq"], "current_fetch_seq": current_seq}
    conn.execute(
        "INSERT INTO companion_plan_snapshots(snapshot_id,profile_pk,data_epoch,study_day,task_key,"
        "plan_version,plan_fingerprint,fetch_seq,requested_at,observed_at,completeness,total,"
        "item_count,items_json,source,binding_revision,created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (row["snapshot_id"], row["profile_pk"], row["data_epoch"], row["study_day"], row["task_key"],
         row["plan_version"], row["plan_fingerprint"], row["fetch_seq"], row["requested_at"],
         row["observed_at"], row["completeness"], row["total"], row["item_count"], row["items_json"],
         row["source"], row["binding_revision"], row["created_at"]),
    )
    return {"persisted": True, "reason": "", "snapshot_id": row["snapshot_id"],
            "fetch_seq": row["fetch_seq"], "current_fetch_seq": row["fetch_seq"]}


def persist_snapshot(snapshot: dict) -> dict[str, Any]:
    """写库（自带事务）。返回写入结果；旧序号/重复快照返回 ``persisted=False``。"""
    with db.companion_transaction() as conn:
        return insert_snapshot_row(conn, snapshot)


def get_snapshot(profile_pk: int, data_epoch: int, snapshot_id: str) -> Optional[dict[str, Any]]:
    """按 ID 读取本人某代次的快照（供对账读取进入基线）。"""
    if not snapshot_id:
        return None
    rows = db.companion_query(
        "SELECT * FROM companion_plan_snapshots WHERE snapshot_id=? AND profile_pk=? AND data_epoch=?",
        (str(snapshot_id), int(profile_pk), int(data_epoch)),
    )
    return _row_with_items(rows[0]) if rows else None


def latest_snapshot(profile_pk: int, data_epoch: int, study_day: str, task_key: str) -> Optional[dict[str, Any]]:
    """返回该基键下 ``fetch_seq`` 最大的快照。

    代次已过期时返回 ``None``：删除屏障之后旧快照不能再参与任何判断。
    """
    state = db.companion_account_state(int(profile_pk))
    if int(state["data_epoch"]) != int(data_epoch):
        return None
    rows = db.companion_query(
        "SELECT * FROM companion_plan_snapshots WHERE profile_pk=? AND data_epoch=? AND study_day=? "
        "AND task_key=? ORDER BY fetch_seq DESC, created_at DESC LIMIT 1",
        (int(profile_pk), int(data_epoch), str(study_day or ""), str(task_key or "")),
    )
    return _row_with_items(rows[0]) if rows else None


def list_snapshots(profile_pk: int, data_epoch: int, *, limit: int = 20) -> list[dict[str, Any]]:
    rows = db.companion_query(
        "SELECT * FROM companion_plan_snapshots WHERE profile_pk=? AND data_epoch=? "
        "ORDER BY created_at DESC LIMIT ?",
        (int(profile_pk), int(data_epoch), max(1, min(int(limit or 20), 200))),
    )
    return [_row_with_items(row) for row in rows]  # type: ignore[misc]