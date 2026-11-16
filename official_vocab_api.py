# -*- coding: utf-8 -*-
"""墨墨官方词汇接口的唯一后端入口。

两个接口：

- ``POST /api/v1/memo/vocabulary/query`` —— 批量查真实词 ID（只读）
- ``POST /api/v1/memo/study/add_words`` —— 加入学习列表（**唯一的云端写入**）

集中在这里的理由：

1. **绝不按下标映射**。官方文档**没有**承诺返回顺序与输入一致（需注意：
   是"未承诺"，不是"官方说明会乱序"），也没有声明缺词行为。按 ``spellings``
   索引返回、按下标取 ``voc[i]`` 都可能把 A 词的 ID 贴到 B 词上。
2. **写请求不自动重试**。``add_words`` 只返回一个 ``added_count``、没有逐词结果；
   超时后重试可能在第一次已成功时重复写入，而无法对账。因此超时一律标记
   ``uncertain``，由用户核实后决定，不自动重发。
3. **不编造逐词成败**。上游只给总数，任何"哪个词成功/失败"的说法都是编造。

``transport`` 由调用方注入：生产用本地代理通道，测试用 mock。这样本模块
不持有网络细节，也不直接读写凭据。
"""
from __future__ import annotations

from typing import Any, Callable, Mapping, Optional, Sequence

# 官方上限：两个接口的数组字段都是 maxItems 1000。
QUERY_BATCH = 1000
ADD_BATCH = 1000

QUERY_PATH = "vocabulary/query"
ADD_PATH = "study/add_words"


class OfficialVocabError(RuntimeError):
    """官方接口失败。

    属性含义（前端据此显示准确状态，而不是笼统的"失败"）：

    - ``status``：上游 HTTP 状态；无响应时为 ``None``。
    - ``code``：稳定的机器可读原因。
    - ``retryable``：调用方**可以**安全重试（仅限读请求，或明确未送达）。
    - ``uncertain``：请求**可能已送达并生效**。写请求超时时为 True，
      此时不得自动重试，必须由用户核实。
    - ``retry_after``：上游给的等待秒数（如果有）。
    """

    def __init__(self, message: str, *, status: Optional[int] = None,
                 code: str = "upstream_error", retryable: bool = False,
                 uncertain: bool = False,
                 retry_after: Optional[float] = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.retryable = retryable
        self.uncertain = uncertain
        self.retry_after = retry_after

    def as_dict(self) -> dict[str, Any]:
        return {"error": str(self), "code": self.code,
                "retryable": bool(self.retryable),
                "uncertain": bool(self.uncertain),
                "status": self.status,
                "retry_after": self.retry_after}


# --------------------------------------------------------------------------- #
# 错误归类
# --------------------------------------------------------------------------- #

def _raise_for(status: int, payload: Any, *, write: bool) -> None:
    """把上游非 2xx 响应翻成带准确语义的异常。

    注意：官方 spec 只声明了 ``200`` 响应，``401/403/429/5xx`` 属于
    HTTP 通用约定与本仓库既有经验，**不是**墨墨官方契约。这里的映射是
    客户端防御性约定，前端文案不应宣称"官方规定"。
    """
    message = ""
    if isinstance(payload, Mapping):
        message = str(payload.get("error") or payload.get("message") or "")
    message = message or ("上游返回 HTTP %s" % status)

    retry_after = None
    if isinstance(payload, Mapping):
        try:
            raw = payload.get("retry_after")
            retry_after = float(raw) if raw is not None else None
        except (TypeError, ValueError):
            retry_after = None

    if status == 401:
        raise OfficialVocabError(message, status=status, code="unauthorized")
    if status == 403:
        raise OfficialVocabError(message, status=status, code="forbidden")
    if status == 429:
        # 429 明确表示**未**生效，所以写请求重试也是安全的；但本模块不替
        # 调用方决定，只如实标注可重试。
        raise OfficialVocabError(message, status=status, code="rate_limited",
                                 retryable=True, retry_after=retry_after)
    if 400 <= status < 500:
        raise OfficialVocabError(message, status=status, code="invalid_request")
    # 5xx：写请求可能已被上游处理，不能断言失败。
    raise OfficialVocabError(message, status=status, code="upstream_error",
                             retryable=not write, uncertain=write)


def _transport_error(exc: BaseException, *, write: bool) -> OfficialVocabError:
    text = str(exc) or exc.__class__.__name__
    if write:
        # 超时 / 连接中断对写请求意味着"结果未知"。
        return OfficialVocabError("请求结果待核实：%s" % text,
                                  code="uncertain", uncertain=True)
    return OfficialVocabError("上游读取超时：%s" % text,
                              code="timeout", retryable=True)


def _call(transport: Callable[..., Any], path: str, body: Mapping[str, Any], *,
          write: bool) -> Any:
    try:
        result = transport(path, dict(body))
    except OfficialVocabError:
        raise
    except Exception as exc:             # 超时、连接错误、JSON 解析失败
        raise _transport_error(exc, write=write)

    if not isinstance(result, Mapping):
        raise OfficialVocabError("上游响应格式异常", code="upstream_error",
                                 retryable=not write, uncertain=write)

    status = result.get("status")
    payload = result.get("body")
    if isinstance(status, int) and not (200 <= status < 300):
        if isinstance(payload, Mapping) and payload.get("retry_after") is not None:
            pass
        elif isinstance(result.get("headers", {}), Mapping):
            header = (result.get("headers") or {}).get("Retry-After")
            if header is not None:
                payload = dict(payload or {})
                payload.setdefault("retry_after", header)
        _raise_for(status, payload, write=write)
    return payload


# --------------------------------------------------------------------------- #
# 批量查词
# --------------------------------------------------------------------------- #

def query_vocabulary(*, transport: Callable[..., Any],
                     spellings: Optional[Sequence[str]] = None,
                     ids: Optional[Sequence[str]] = None) -> dict[str, Any]:
    """查询词汇。``spellings`` 与 ``ids`` **互斥**（官方：只能生效一个）。"""
    has_spellings = spellings is not None
    has_ids = ids is not None
    if has_spellings == has_ids:
        raise OfficialVocabError("查询条件互斥且必须给一个", code="invalid_request")

    if has_spellings:
        values = [str(item) for item in spellings or []]
        if len(values) > QUERY_BATCH:
            raise OfficialVocabError("单次查询最多 %d 条" % QUERY_BATCH,
                                     code="invalid_request")
        body: dict[str, Any] = {"spellings": values}
    else:
        values = [str(item) for item in ids or []]
        if len(values) > QUERY_BATCH:
            raise OfficialVocabError("单次查询最多 %d 条" % QUERY_BATCH,
                                     code="invalid_request")
        body = {"ids": values}

    payload = _call(transport, QUERY_PATH, body, write=False)
    if not isinstance(payload, Mapping) or not isinstance(payload.get("voc"), list):
        raise OfficialVocabError("上游未返回 voc 数组", code="upstream_error",
                                 retryable=True)
    rows = []
    for item in payload["voc"]:
        if not isinstance(item, Mapping):
            continue
        voc_id = str(item.get("id") or "").strip()
        spelling = str(item.get("spelling") or "").strip()
        if voc_id and spelling:
            rows.append({"id": voc_id, "spelling": spelling})
    return {"voc": rows}


def add_words(word_ids: Sequence[str], *, transport: Callable[..., Any],
              advance: bool = False) -> dict[str, Any]:
    """加入学习列表。``advance`` 默认 False —— 不擅自改变用户复习时间。"""
    ids = [str(item).strip() for item in word_ids or []]
    ids = [item for item in ids if item]
    if not ids:
        raise OfficialVocabError("没有可提交的单词", code="invalid_request")
    if len(ids) > ADD_BATCH:
        raise OfficialVocabError("单次最多添加 %d 个单词" % ADD_BATCH,
                                 code="invalid_request")
    if advance is not False:
        # 目前产品不需要提前复习；这里显式拒绝而不是静默改成 False，
        # 免得调用方以为自己打开了某个行为。
        raise OfficialVocabError("本版本固定 advance=false", code="invalid_request")

    payload = _call(transport, ADD_PATH,
                    {"words": [{"id": item} for item in ids], "advance": False},
                    write=True)
    if not isinstance(payload, Mapping) or "added_count" not in payload:
        raise OfficialVocabError("上游未返回 added_count", code="upstream_error",
                                 uncertain=True)
    try:
        added = int(payload["added_count"])
    except (TypeError, ValueError):
        raise OfficialVocabError("added_count 不是整数", code="upstream_error",
                                 uncertain=True)
    return {"added_count": added, "submitted": len(ids)}


# --------------------------------------------------------------------------- #
# 跨请求的拼写 → ID 映射
# --------------------------------------------------------------------------- #

def chunk(values: Sequence[str], size: int) -> list[list[str]]:
    """按上限拆批，保持顺序并去重（去重按小写，保留首次出现的大小写）。"""
    seen: set[str] = set()
    ordered: list[str] = []
    for raw in values:
        text = str(raw or "").strip()
        if not text:
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        ordered.append(text)
    return [ordered[offset:offset + size] for offset in range(0, len(ordered), size)]


def map_voc_ids(spellings: Sequence[str], voc_rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """把官方返回的 ``voc`` 按**拼写**映射到输入。

    这个函数是"不按下标映射"的落地：官方返回顺序不保证与输入一致，
    也不保证全部命中。因此只能按拼写匹配，且同一拼写出现多个 ID 时必须
    标为 ``ambiguous`` 而不是随便挑一个。
    """
    wanted = {}
    for raw in spellings or []:
        text = str(raw or "").strip()
        if text:
            wanted.setdefault(text.lower(), text)

    matched: dict[str, dict[str, str]] = {}
    duplicates: dict[str, list[dict[str, str]]] = {}
    for row in voc_rows or []:
        if not isinstance(row, Mapping):
            continue
        voc_id = str(row.get("id") or "").strip()
        spelling = str(row.get("spelling") or "").strip()
        if not voc_id or not spelling:
            continue
        key = spelling.lower()
        if key not in wanted:
            continue                      # 上游多返回的词直接丢弃
        entry = {"id": voc_id, "spelling": spelling}
        if key in matched and matched[key]["id"] != voc_id:
            duplicates.setdefault(key, [matched[key]]).append(entry)
            continue
        matched.setdefault(key, entry)

    ambiguous = {key: rows for key, rows in duplicates.items()}
    for key in ambiguous:
        matched.pop(key, None)

    return {
        "matched": {key: matched[key] for key in matched},
        "missing": [original for key, original in wanted.items() if key not in matched],
        "ambiguous": ambiguous,
        "requested": len(wanted),
    }