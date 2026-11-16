# -*- coding: utf-8 -*-
"""陪伴升级共享适配层（契约 v1，M 主代理所有）。

本模块是 A/B/C/D/E 五个子模块与现有宿主之间的**唯一**接缝：

* 账号身份解析（``account_key`` → ``profile_pk`` + 持久代次）
* 网页 iframe 与开放 API 的身份绑定结论（matched/mismatch/unknown）
* 当前已启用角色解析（role_id / 人设 / Live2D 模型 / 完整性）
* 受控数据目录与角色包 registry 路径
* 官方墨墨接口的共用限流客户端

业务模块不得自己 ``import server``、不得自建限流器、不得猜测 role_id。
"""
from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from typing import Any, Mapping, Optional

import db

# 网页 iframe 身份与开放 API 身份的映射在本版本没有任何已核验证据
# （见 _verification/companion-upgrade/p0-baseline.md §2.1）。冻结为 unknown：
# 官方今日进度仍可展示，但网页观察不会归入某个账号的“本轮共同经历”。
UNVERIFIED_BINDING_SOURCE = "web-iframe-unverified"

_IDENTITY_CACHE_TTL_SECONDS = 5.0
_identity_cache: dict[str, tuple[float, dict[str, Any]]] = {}
# 测试/未来适配器注入点：值为 binding 覆盖。仅当显式注入时生效，
# 生产路径永远不会写入它（没有已核验映射就恒为 unknown）。
_identity_override: Optional[dict[str, Any]] = None


def data_paths() -> dict[str, str]:
    """返回陪伴功能使用的受控目录（全部由实际 data_dir 派生）。"""
    data_dir = os.path.abspath(db._DATA_DIR)
    packages_root = os.path.join(data_dir, "role_packages")
    return {
        "data_dir": data_dir,
        "tts_pack_dir": os.path.join(data_dir, "tts_pack"),
        "live2d_models_root": os.path.join(data_dir, "live2d", "models"),
        "packages_root": packages_root,
        "incoming": os.path.join(packages_root, "incoming"),
        "staging": os.path.join(packages_root, "staging"),
        "jobs": os.path.join(packages_root, "jobs"),
        "journals": os.path.join(packages_root, "journals"),
        "registry": os.path.join(packages_root, "registry.json"),
    }


def ensure_data_paths() -> dict[str, str]:
    paths = data_paths()
    for key in ("packages_root", "incoming", "staging", "jobs", "journals"):
        os.makedirs(paths[key], exist_ok=True)
    return paths


# ===================== 账号身份 =====================

def account_context(access_token: str, account_key: str) -> dict[str, Any]:
    """把 ``(token, account_key)`` 解析为带持久代次的内部上下文。

    ``account_key`` 是服务端 ``_memo_identity()`` 给出的稳定哈希，绝不接受客户端
    传入的可信账号。返回的 ``profile_pk`` 用于所有 companion_* 表归属。
    """
    key = str(account_key or "").strip()
    if not key:
        raise ValueError("缺少账号身份")
    profile_pk = db.ensure_sync_profile(key)
    state = db.companion_account_state(profile_pk)
    return {
        "account_key": key,
        "profile_pk": int(profile_pk),
        "data_epoch": int(state["data_epoch"]),
        # 必须一起传出去：调用方（文章选词的写路径）要用它判断"账号是否已切换"。
        # 只传 data_epoch 时 `context["account_epoch"]` 会直接 KeyError，
        # 而 data_epoch 的语义是"学习数据被重置"，不能替代账号身份代次。
        "account_epoch": int(state["account_epoch"]),
        "has_token": bool(access_token),
    }


def identity_binding(account_key: str, *, iframe_origin: str = "", iframe_logged_in: bool = False) -> dict[str, Any]:
    """返回网页 iframe 与开放 API 账号的绑定结论。

    本版本没有已核验的映射，因此除“两边都没登录”这种明确的 mismatch 外一律
    ``unknown``。``matched`` 分支保留给后续取得真实映射时的适配器实现。
    """
    key = str(account_key or "")
    now = time.time()
    cached = _identity_cache.get(key)
    if cached and now - cached[0] < _IDENTITY_CACHE_TTL_SECONDS:
        binding = dict(cached[1])
    else:
        binding = {
            "status": "unknown",
            "binding_revision": 1,
            "verified_at": None,
            "source": UNVERIFIED_BINDING_SOURCE,
        }
        _identity_cache[key] = (now, dict(binding))
    if _identity_override:
        binding = dict(binding, **_identity_override)
    if iframe_logged_in and not key:
        binding = dict(binding, status="unknown", source="iframe-login-without-api-account")
    elif not iframe_logged_in and not key:
        binding = dict(binding, status="unknown", source="no-login-on-either-side")
    result = dict(binding)
    if iframe_origin:
        result["iframe_origin"] = str(iframe_origin)[:200]
    result["iframe_logged_in"] = bool(iframe_logged_in)
    return result


def binding_allows_credit(binding: Mapping[str, Any]) -> bool:
    """只有 matched 才允许把本轮证据升级为确认完成量。"""
    return str((binding or {}).get("status") or "") == "matched"


def _reset_identity_cache() -> None:
    """测试钩子：切换账号或注入映射后清空缓存。"""
    _identity_cache.clear()


def set_identity_override(binding: Optional[Mapping[str, Any]]) -> None:
    """测试/未来适配器注入点。

    生产代码从不调用它；没有已核验的 iframe↔OIDC 映射时绑定恒为 ``unknown``。
    传 ``None`` 恢复默认。注入 ``{"status": "matched"}`` 用于验证奖励路径。
    """
    global _identity_override
    _identity_override = dict(binding) if binding else None
    _reset_identity_cache()


# ===================== 当前角色 =====================

def active_role() -> dict[str, Any]:
    """解析当前已启用角色。任何异常都降级为空角色，绝不抛出到调用方。"""
    result = {
        "role_id": "",
        "role_name": "",
        "persona": {},
        "live2d_model_id": "",
        "complete": False,
        "missing": [],
        "reason": "尚未启用资料完整的角色",
    }
    try:
        import tts
        library = tts.list_roles(data_paths()["tts_pack_dir"])
    except Exception as exc:
        result["reason"] = "角色库不可用：%s" % exc
        return result
    role_id = str(library.get("active_role_id") or "")
    result["role_id"] = role_id
    if not role_id:
        return result
    role = next((item for item in library.get("roles") or [] if item.get("role_id") == role_id), None)
    if not role:
        result["reason"] = "当前角色已不在角色库中"
        return result
    result["role_name"] = str(role.get("name") or role_id)
    result["persona"] = role.get("persona") if isinstance(role.get("persona"), dict) else {}
    result["live2d_model_id"] = str(role.get("live2d_model_id") or "")
    result["complete"] = bool(role.get("complete"))
    result["missing"] = list(role.get("missing") or [])
    if result["complete"]:
        result["reason"] = ""
    else:
        missing = "、".join(result["missing"])
        result["reason"] = "当前角色资料未配齐" + ("：" + missing if missing else "")
    return result


def personality_baseline() -> dict[str, Any]:
    """当前角色的稳定身份标记：完成结算与记忆归属都以此为准。"""
    role = active_role()
    return {
        "role_id": role["role_id"],
        "role_name": role["role_name"],
        "persona_fingerprint": hashlib.sha256(
            json.dumps(role["persona"], ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()[:16] if role["persona"] else "",
        "live2d_model_id": role["live2d_model_id"],
        "complete": role["complete"],
    }


# ===================== 官方快照客户端 =====================

_official_client = None


def configure_official_client(client: Any) -> None:
    """由 server.py 注入共用限流客户端，保持与网页代理同一配额窗口。"""
    global _official_client
    _official_client = client


def official_client() -> Any:
    """返回官方墨墨学习客户端；未注入时按需创建（测试/独立调用路径）。"""
    global _official_client
    if _official_client is None:
        import study_sync
        _official_client = study_sync.MaimemoStudyClient()
    return _official_client


def study_day() -> str:
    """学习日口径沿用 study_sync 的北京时间实现。"""
    import study_sync
    return study_sync.beijing_today().isoformat()


def canonical_task_key(study_day_value: Optional[str] = None, role_id: str = "") -> str:
    """服务端生成的稳定任务键。

    不使用窗口随机值：同一学习日同一角色的所有窗口必须落到同一个活动会话基键，
    否则双窗会各自创建会话并重复结算。
    """
    day = study_day_value or study_day()
    role = str(role_id or active_role()["role_id"] or "no-role")
    return "study-day:%s:%s" % (day, role)


def new_id(prefix: str) -> str:
    """不透明服务端 ID。"""
    return "%s-%s" % (prefix, uuid.uuid4().hex)


def utc_now_iso() -> str:
    return db._utc_now()


def role_packages_dir() -> str:
    return data_paths()["packages_root"]
