# -*- coding: utf-8 -*-
"""把长期记忆注入 AI 请求的**唯一**入口。

集中在这里而不是散落在 ``server.py`` 与前端，原因有三：

1. **白名单**：只有 ``system`` 消息可以被追加记忆块。用户消息、助手历史与
   ``tool`` 结果绝不改写，否则模型会把注入内容当成用户说的话。
2. **上限**：记忆块有字符与条数上限（``companion_memory.MAX_CONTEXT_CHARS`` /
   ``MAX_CONTEXT_ITEMS``）；本模块再兜一层，避免上下文膨胀到把真正的学习内容挤出窗口。
3. **可关闭**：任何异常都退化为「不注入」，绝不能因为记忆故障让 AI 请求失败。
   记忆是增强，不是依赖。
"""
from __future__ import annotations

from typing import Any, Mapping, Optional

MEMORY_BLOCK_HEADER = "以下是这个角色记得的、关于这位学习者的长期背景。"
MEMORY_BLOCK_FOOTER = "把它当作背景语气，不要逐条复述，也不要说“根据记忆”。"
MAX_INJECT_CHARS = 1600

# 只有这些角色允许被改写。顺序也重要：system 永远在最前。
_MUTABLE_ROLES = ("system",)


def _normalise_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, Mapping) and isinstance(item.get("text"), str):
                parts.append(str(item["text"]))
        return "\n".join(part for part in parts if part)
    return ""


def inject_memory(messages: Any, block: Optional[str]) -> dict[str, Any]:
    """把记忆块追加到第一条 system 消息。

    返回 ``{"messages": [...], "injected": bool, "reason": str}``，绝不就地修改
    调用方传进来的列表——上游请求失败时还需要原样重试。
    """
    if not isinstance(messages, list):
        return {"messages": messages, "injected": False, "reason": "messages_not_list"}
    text = (block or "").strip()
    if not text:
        return {"messages": messages, "injected": False, "reason": "empty_block"}
    if len(text) > MAX_INJECT_CHARS:
        # 截断到上限而不是整体丢弃：前半部分通常含角色摘要，信息密度最高。
        text = text[:MAX_INJECT_CHARS].rstrip()
    payload = "%s\n%s\n%s" % (MEMORY_BLOCK_HEADER, text, MEMORY_BLOCK_FOOTER)

    copied = [dict(item) if isinstance(item, Mapping) else item for item in messages]
    for index, item in enumerate(copied):
        if not isinstance(item, Mapping):
            continue
        if str(item.get("role") or "") not in _MUTABLE_ROLES:
            continue
        existing = _normalise_content(item.get("content"))
        updated = dict(item)
        if isinstance(item.get("content"), list):
            # 多段 system 内容：在末尾追加一段文本，保留原有结构。
            content = list(item.get("content") or [])
            content.append({"type": "text", "text": payload})
            updated["content"] = content
        else:
            updated["content"] = (existing + "\n\n" + payload) if existing else payload
        copied[index] = updated
        return {"messages": copied, "injected": True, "reason": ""}
    return {"messages": messages, "injected": False, "reason": "no_system_message"}


def build_block(profile_pk: Optional[int], *, role_id: str = "",
                limit_items: Optional[int] = None) -> str:
    """读取记忆并渲染成提示块。任何失败都返回空串（=不注入）。

    ``limit_items`` 只是本模块的软提示：真正的条数与字符上限由
    ``companion_memory`` 的 ``MAX_CONTEXT_ITEMS`` / ``MAX_CONTEXT_CHARS`` 决定，
    这里不重复实现第二套截断规则。
    """
    if profile_pk is None:
        return ""
    try:
        import companion_memory
        return companion_memory.build_prompt_block(
            int(profile_pk), role_id or "", "") or ""
    except Exception:
        # 记忆故障绝不能让 AI 请求失败。
        return ""


def current_profile_pk() -> Optional[int]:
    """当前登录账号对应的档案主键；未登录返回 ``None``（=不注入）。"""
    try:
        import companion_runtime
        context = companion_runtime.account_context("", "")
        return int(context.get("profile_pk") or 0) or None
    except Exception:
        return None


def prepare_request(messages: Any, profile_pk: Optional[int], *,
                    role_id: str = "") -> dict[str, Any]:
    """一步完成「读记忆 → 注入」。供 ``server.py`` 直接调用。"""
    block = build_block(profile_pk, role_id=role_id)
    return inject_memory(messages, block)