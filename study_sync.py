#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Memo Superform 学习记录增量同步。

墨墨开放 API 会提供当前学习记录集合，但没有 ``updated_at`` 游标，也没有可安全
用于分页的偏移量。本模块刻意正视这一限制：

* 普通刷新只读取较小的活动窗口和本地已知到期 ID；
* 初始化/核验使用互不重叠的 ``next_study_date`` 区间；
* 若日期细分到一天后某区间仍含 1000 条记录，则报告不完整，不静默截断；
* 同步绝不依据局部响应删除本地记录。

本模块有意独立于 ``server.py`` 和 ``db.py``。``DbStudySyncRepository`` 记录
数据库层需要实现的最小 SQLite 契约，而服务本身可用纯 Python 仓库和传输层测试。
"""

from __future__ import annotations

import hashlib
import json
import random
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Iterable, Mapping, Optional, Protocol, Sequence


MAIMEMO_OPEN_API = "https://open.maimemo.com/open/api/v1/memo/study/query_study_records"
MAIMEMO_TODAY_ITEMS_API = "https://open.maimemo.com/open/api/v1/memo/study/get_today_items"
BEIJING_TZ = timezone(timedelta(hours=8))
MAX_QUERY_RECORDS = 1000
DEFAULT_BOOTSTRAP_START = date(2020, 1, 1)
DEFAULT_BOOTSTRAP_END = date(2200, 12, 31)


class StudySyncError(RuntimeError):
    """学习同步失败的基础异常。"""


class SyncCancelled(StudySyncError):
    """调用方取消正在运行的同步时抛出。"""


class RemoteAPIError(StudySyncError):
    """墨墨返回的 HTTP/API 错误。"""

    def __init__(self, message: str, *, status: Optional[int] = None):
        super().__init__(message)
        self.status = status


class DataIncompleteError(StudySyncError):
    """远程 API 信息不足，无法得出可靠结果。"""


class RepositoryContractError(StudySyncError):
    """持久化适配器尚未实现必要操作。"""


@dataclass(frozen=True)
class HTTPResponse:
    """与传输实现无关的轻量 HTTP 响应对象。"""

    status: int
    headers: Mapping[str, str] = field(default_factory=dict)
    body: Any = field(default_factory=dict)


class HTTPTransport(Protocol):
    def post_json(
        self,
        url: str,
        payload: Mapping[str, Any],
        headers: Mapping[str, str],
        timeout: float,
    ) -> HTTPResponse:
        """POST JSON 并返回解码后的响应，失败时抛出 OSError。"""


class UrllibJSONTransport:
    """仅用 Python 标准库实现的生产传输层。"""

    def post_json(
        self,
        url: str,
        payload: Mapping[str, Any],
        headers: Mapping[str, str],
        timeout: float,
    ) -> HTTPResponse:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(url, data=data, method="POST")
        for key, value in headers.items():
            request.add_header(str(key), str(value))
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read()
                return HTTPResponse(
                    status=int(getattr(response, "status", response.getcode())),
                    headers={str(k): str(v) for k, v in response.headers.items()},
                    body=_decode_json_body(raw),
                )
        except urllib.error.HTTPError as exc:
            raw = exc.read() if exc.fp else b""
            return HTTPResponse(
                status=int(exc.code),
                headers={str(k): str(v) for k, v in (exc.headers or {}).items()},
                body=_decode_json_body(raw),
            )


def _decode_json_body(raw: bytes) -> Any:
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {"raw_error": raw.decode("utf-8", errors="replace")[:1000]}


def beijing_today(now: Optional[datetime] = None) -> date:
    """返回北京时间的当前日历日期。"""

    if now is None:
        now = datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now.astimezone(BEIJING_TZ).date()


def token_profile_id(token: str) -> str:
    """返回本地数据使用的稳定、不可逆用户键。"""

    value = (token or "").strip()
    if not value:
        raise ValueError("Maimemo token is required")
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def record_fingerprint(record: Mapping[str, Any]) -> str:
    """只按确定顺序散列文档声明的 StudyRecord 字段。"""

    payload = {
        "voc_id": record.get("voc_id"),
        "voc_spelling": record.get("voc_spelling"),
        "add_date": record.get("add_date"),
        "first_study_date": record.get("first_study_date"),
        "last_study_date": record.get("last_study_date"),
        "next_study_date": record.get("next_study_date"),
        "last_response": record.get("last_response"),
        "study_count": record.get("study_count"),
        "tags": record.get("tags"),
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def normalise_record(record: Mapping[str, Any]) -> dict[str, Any]:
    """保持 API 契约稳定，并拒绝没有稳定键的记录。"""

    voc_id = str(record.get("voc_id") or "").strip()
    if not voc_id:
        raise DataIncompleteError("study record has no voc_id")
    result = {
        "voc_id": voc_id,
        "voc_spelling": str(record.get("voc_spelling") or "").strip(),
        "add_date": record.get("add_date"),
        "first_study_date": record.get("first_study_date"),
        "last_study_date": record.get("last_study_date"),
        "next_study_date": record.get("next_study_date"),
        "last_response": record.get("last_response"),
        "study_count": _safe_int(record.get("study_count")),
        "tags": record.get("tags"),
    }
    result["content_hash"] = record_fingerprint(result)
    return result


def today_item_fingerprint(item: Mapping[str, Any]) -> str:
    """为文档声明的 StudyTodayItem 结构返回稳定指纹。"""

    payload = {
        "voc_id": item.get("voc_id"),
        "voc_spelling": item.get("voc_spelling"),
        "order": item.get("order"),
        "first_response": item.get("first_response"),
        "is_new": bool(item.get("is_new")),
        "is_finished": bool(item.get("is_finished")),
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def normalise_today_item(item: Mapping[str, Any]) -> dict[str, Any]:
    """校验今日条目，并只保留其稳定公开字段。"""

    voc_id = str(item.get("voc_id") or "").strip()
    if not voc_id:
        raise DataIncompleteError("today item has no voc_id")
    result = {
        "voc_id": voc_id,
        "voc_spelling": str(item.get("voc_spelling") or "").strip(),
        "order": _safe_int(item.get("order")),
        "first_response": item.get("first_response"),
        "is_new": bool(item.get("is_new")),
        "is_finished": bool(item.get("is_finished")),
    }
    result["content_hash"] = today_item_fingerprint(result)
    return result


def _safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _coerce_date(value: Any) -> Optional[date]:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.date()
        return value.astimezone(BEIJING_TZ).date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    if len(text) >= 10:
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            pass
    return None


def _as_iso_start(day: date) -> str:
    return day.isoformat() + "T00:00:00+08:00"


def _as_iso_end(day: date) -> str:
    return day.isoformat() + "T23:59:59.999+08:00"


def _chunks(values: Sequence[str], size: int = MAX_QUERY_RECORDS) -> Iterable[list[str]]:
    for index in range(0, len(values), size):
        yield list(values[index:index + size])


def _dedupe_records(records: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for raw in records:
        item = normalise_record(raw)
        by_id[item["voc_id"]] = item
    return list(by_id.values())


@dataclass(frozen=True)
class RateLimit:
    max_requests: int
    seconds: float


class SlidingWindowRateLimiter:
    """适配墨墨 10 秒/60 秒/5 小时配额窗口的线程安全限流器。"""

    DEFAULT_LIMITS = (
        RateLimit(20, 10.0),
        RateLimit(40, 60.0),
        RateLimit(2000, 5 * 60 * 60.0),
    )

    def __init__(
        self,
        limits: Sequence[RateLimit] = DEFAULT_LIMITS,
        *,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._limits = tuple(limits)
        self._clock = monotonic
        self._timestamps: deque[float] = deque()
        self._lock = threading.Lock()

    def acquire(self, cancel_event: threading.Event) -> None:
        while True:
            if cancel_event.is_set():
                raise SyncCancelled("sync cancelled")
            with self._lock:
                now = self._clock()
                largest_window = max(limit.seconds for limit in self._limits)
                while self._timestamps and now - self._timestamps[0] >= largest_window:
                    self._timestamps.popleft()
                waits: list[float] = []
                for limit in self._limits:
                    recent = [stamp for stamp in self._timestamps if now - stamp < limit.seconds]
                    if len(recent) >= limit.max_requests:
                        waits.append(max(0.0, limit.seconds - (now - recent[0])))
                if not waits:
                    self._timestamps.append(now)
                    return
                delay = max(waits)
            # Event.wait 既可中断，也避免使用不可中断的 sleep。
            if cancel_event.wait(delay):
                raise SyncCancelled("sync cancelled")


class ProfileRateLimiter:
    """按本机稳定档案隔离的开放平台滑动窗口限流器。"""

    def __init__(self, limits: Sequence[RateLimit] = SlidingWindowRateLimiter.DEFAULT_LIMITS) -> None:
        self._limits = tuple(limits)
        self._limiters: dict[str, SlidingWindowRateLimiter] = {}
        self._lock = threading.RLock()

    def acquire(self, cancel_event: threading.Event, profile_id: Optional[str] = None) -> None:
        key = str(profile_id or "default").strip().lower() or "default"
        with self._lock:
            limiter = self._limiters.get(key)
            if limiter is None:
                limiter = SlidingWindowRateLimiter(self._limits)
                self._limiters[key] = limiter
        limiter.acquire(cancel_event)


class MaimemoStudyClient:
    """带身份验证和有限重试的墨墨学习记录客户端。"""

    def __init__(
        self,
        transport: Optional[HTTPTransport] = None,
        *,
        limiter: Optional[Any] = None,
        endpoint: str = MAIMEMO_OPEN_API,
        today_items_endpoint: str = MAIMEMO_TODAY_ITEMS_API,
        timeout: float = 30.0,
        max_retries: int = 4,
        random_fn: Callable[[], float] = random.random,
    ) -> None:
        self.transport = transport or UrllibJSONTransport()
        self.limiter = limiter or SlidingWindowRateLimiter()
        self.endpoint = endpoint
        self.today_items_endpoint = today_items_endpoint
        self.timeout = timeout
        self.max_retries = max_retries
        self.random_fn = random_fn

    def count(
        self, token: str, cancel_event: threading.Event, on_retry: Optional[Callable[[str], None]] = None,
        *, profile_id: Optional[str] = None,
    ) -> int:
        data = self.query(token, {"as_count": True}, cancel_event, on_retry=on_retry, profile_id=profile_id)
        try:
            return max(0, int(data.get("count", 0)))
        except (TypeError, ValueError):
            raise DataIncompleteError("remote count is invalid")

    def records(
        self,
        token: str,
        params: Mapping[str, Any],
        cancel_event: threading.Event,
        *,
        on_retry: Optional[Callable[[str], None]] = None,
        profile_id: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        data = self.query(token, params, cancel_event, on_retry=on_retry, profile_id=profile_id)
        records = data.get("records", [])
        if not isinstance(records, list):
            raise DataIncompleteError("remote records is not an array")
        # 此处保留原始响应数量。即使上游错误导致 ``voc_id`` 重复，恰有 1000 条的
        # 响应仍可能已被 API 截断，日期区间拆分必须保持保守。
        return [normalise_record(record) for record in records]

    def today_items(
        self,
        token: str,
        cancel_event: threading.Event,
        *,
        on_retry: Optional[Callable[[str], None]] = None,
        profile_id: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """读取今日精简条目列表，绝不用完整查询代替。

        ``get_today_items`` is the only reliable cheap signal that an active
        study item changed.  If the endpoint cannot provide a complete list,
        the caller must keep its existing study data and request a later
        reconciliation rather than fall back to a broad date-range fetch.
        """

        data = self.query(
            token,
            {"limit": MAX_QUERY_RECORDS},
            cancel_event,
            on_retry=on_retry,
            endpoint=self.today_items_endpoint,
            profile_id=profile_id,
        )
        items = data.get("today_items", [])
        if not isinstance(items, list):
            raise DataIncompleteError("remote today_items is not an array")
        if len(items) >= MAX_QUERY_RECORDS:
            raise DataIncompleteError("today_items reached the API limit")
        result: dict[str, dict[str, Any]] = {}
        for item in items:
            clean = normalise_today_item(item)
            if clean["voc_id"] in result:
                raise DataIncompleteError("today_items contains duplicate voc_id")
            result[clean["voc_id"]] = clean
        return list(result.values())

    def query(
        self,
        token: str,
        params: Mapping[str, Any],
        cancel_event: threading.Event,
        *,
        on_retry: Optional[Callable[[str], None]] = None,
        endpoint: Optional[str] = None,
        profile_id: Optional[str] = None,
    ) -> Mapping[str, Any]:
        last_error: Optional[Exception] = None
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token,
        }
        for attempt in range(self.max_retries + 1):
            if cancel_event.is_set():
                raise SyncCancelled("sync cancelled")
            try:
                self.limiter.acquire(cancel_event, profile_id)
            except TypeError:
                # 兼容外部集成传入的旧单桶 limiter。
                self.limiter.acquire(cancel_event)
            try:
                response = self.transport.post_json(endpoint or self.endpoint, params, headers, self.timeout)
            except (OSError, TimeoutError, urllib.error.URLError) as exc:
                last_error = exc
                if attempt >= self.max_retries:
                    raise RemoteAPIError("Maimemo network request failed: %s" % exc) from exc
                self._retry_wait(attempt, None, cancel_event, on_retry, "network retry")
                continue

            if 200 <= response.status < 300:
                return self._unwrap_api_body(response.body)

            retryable = response.status == 429 or 500 <= response.status < 600
            if retryable and attempt < self.max_retries:
                last_error = RemoteAPIError("Maimemo HTTP %s" % response.status, status=response.status)
                retry_after = _retry_after_seconds(response.headers)
                label = "rate limited; retrying" if response.status == 429 else "server retry"
                self._retry_wait(attempt, retry_after, cancel_event, on_retry, label)
                continue

            message = _api_error_message(response.body) or "Maimemo HTTP %s" % response.status
            raise RemoteAPIError(message, status=response.status)
        raise RemoteAPIError("Maimemo request failed: %s" % (last_error or "unknown"))

    def _retry_wait(
        self,
        attempt: int,
        retry_after: Optional[float],
        cancel_event: threading.Event,
        on_retry: Optional[Callable[[str], None]],
        label: str,
    ) -> None:
        delay = retry_after if retry_after is not None else min(30.0, 0.75 * (2 ** attempt) + self.random_fn() * 0.25)
        if on_retry:
            on_retry("%s in %.1fs" % (label, delay))
        if cancel_event.wait(max(0.0, delay)):
            raise SyncCancelled("sync cancelled")

    @staticmethod
    def _unwrap_api_body(body: Any) -> Mapping[str, Any]:
        if not isinstance(body, Mapping):
            raise RemoteAPIError("Maimemo returned a non-object JSON body")
        if body.get("success") is False:
            raise RemoteAPIError(_api_error_message(body) or "Maimemo API rejected the request")
        data = body.get("data", body)
        if not isinstance(data, Mapping):
            raise RemoteAPIError("Maimemo returned an invalid data object")
        return data


def _retry_after_seconds(headers: Mapping[str, str]) -> Optional[float]:
    value = ""
    for key, item in headers.items():
        if key.lower() == "retry-after":
            value = str(item).strip()
            break
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            target = parsedate_to_datetime(value)
            if target.tzinfo is None:
                target = target.replace(tzinfo=timezone.utc)
            return max(0.0, (target - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError, IndexError):
            return None


def _api_error_message(body: Any) -> str:
    if not isinstance(body, Mapping):
        return ""
    if body.get("error"):
        return str(body["error"])
    errors = body.get("errors")
    if isinstance(errors, list) and errors:
        first = errors[0]
        if isinstance(first, Mapping):
            return str(first.get("msg") or first.get("message") or first.get("code") or "")
        return str(first)
    return str(body.get("message") or "")


class StudySyncRepository(Protocol):
    """:class:`StudySyncService` 所需的持久化契约。

    All writes are scoped to ``profile_id``.  ``upsert_study_records`` must
    atomically compare the supplied ``content_hash`` with the stored hash and
    avoid writing unchanged business records.
    """

    def ensure_sync_profile(self, profile_id: str) -> None: ...
    def get_sync_state(self, profile_id: str) -> Mapping[str, Any]: ...
    def set_sync_state(self, profile_id: str, **values: Any) -> None: ...
    def get_study_record_hashes(self, profile_id: str, voc_ids: Sequence[str]) -> Mapping[str, str]: ...
    def get_today_item_hashes(self, profile_id: str, item_date: date, voc_ids: Sequence[str]) -> Mapping[str, str]: ...
    def upsert_today_items(self, profile_id: str, item_date: date, items: Sequence[Mapping[str, Any]]) -> Mapping[str, int]: ...
    def get_due_candidate_voc_ids(self, profile_id: str, start_date: date, end_date: date) -> Sequence[str]: ...
    def upsert_study_records(self, profile_id: str, records: Sequence[Mapping[str, Any]]) -> Mapping[str, int]: ...
    def is_sync_interval_complete(self, profile_id: str, start_date: date, end_date: date) -> bool: ...
    def record_sync_interval(self, profile_id: str, start_date: date, end_date: date, *, complete: bool, source: str) -> None: ...
    def begin_sync_run(self, profile_id: str, mode: str, reason: str) -> Optional[str]: ...
    def finish_sync_run(self, run_id: Optional[str], status: str, details: Mapping[str, Any]) -> None: ...
    def mark_needs_reconcile(self, profile_id: str, reason: str) -> None: ...


class DbStudySyncRepository:
    """对 ``db`` 中 SQLite 函数的轻量兼容适配器。

    适配器刻意不额外导入模块。调用方会在 SQLite 初始化完成后传入数据库模块，因此
    pyodbc 始终是可选依赖，新安装中不存在也不影响运行。
    """

    def __init__(self, db_module: Any):
        self.db = db_module

    def _call(self, name: str, *args: Any, **kwargs: Any) -> Any:
        func = getattr(self.db, name, None)
        if not callable(func):
            raise RepositoryContractError("db.%s is required by study_sync" % name)
        return func(*args, **kwargs)

    def ensure_sync_profile(self, profile_id: str) -> None:
        self._call("ensure_sync_profile", profile_id)

    def get_sync_state(self, profile_id: str) -> Mapping[str, Any]:
        return self._call("get_sync_state", profile_id) or {}

    def set_sync_state(self, profile_id: str, **values: Any) -> None:
        self._call("set_sync_state", profile_id, **values)

    def get_study_record_hashes(self, profile_id: str, voc_ids: Sequence[str]) -> Mapping[str, str]:
        if not voc_ids:
            return {}
        return self._call("get_study_record_hashes", profile_id, list(voc_ids)) or {}

    def get_today_item_hashes(self, profile_id: str, item_date: date, voc_ids: Sequence[str]) -> Mapping[str, str]:
        if not voc_ids:
            return {}
        func = getattr(self.db, "get_today_item_hashes", None)
        if not callable(func):
            raise RepositoryContractError("db.get_today_item_hashes is required by study_sync")
        return func(profile_id, item_date, list(voc_ids)) or {}

    def upsert_today_items(self, profile_id: str, item_date: date, items: Sequence[Mapping[str, Any]]) -> Mapping[str, int]:
        if not items:
            return {"added": 0, "updated": 0, "unchanged": 0}
        func = getattr(self.db, "upsert_today_items", None)
        if not callable(func):
            raise RepositoryContractError("db.upsert_today_items is required by study_sync")
        result = func(profile_id, item_date, list(items))
        if not isinstance(result, Mapping):
            raise RepositoryContractError("db.upsert_today_items must return a mapping")
        return result

    def get_due_candidate_voc_ids(self, profile_id: str, start_date: date, end_date: date) -> Sequence[str]:
        return self._call("get_due_candidate_voc_ids", profile_id, start_date, end_date) or []

    def upsert_study_records(self, profile_id: str, records: Sequence[Mapping[str, Any]]) -> Mapping[str, int]:
        if not records:
            return {"added": 0, "updated": 0, "unchanged": 0}
        result = self._call("upsert_study_records", profile_id, list(records))
        if not isinstance(result, Mapping):
            raise RepositoryContractError("db.upsert_study_records must return a mapping")
        return result

    def get_record_count(self, profile_id: str) -> Optional[int]:
        func = getattr(self.db, "get_record_count", None)
        return int(func(profile_id)) if callable(func) else None

    def is_sync_interval_complete(self, profile_id: str, start_date: date, end_date: date) -> bool:
        return bool(self._call("is_sync_interval_complete", profile_id, start_date, end_date))

    def record_sync_interval(self, profile_id: str, start_date: date, end_date: date, *, complete: bool, source: str) -> None:
        self._call("record_sync_interval", profile_id, start_date, end_date, complete=complete, source=source)

    def begin_sync_run(self, profile_id: str, mode: str, reason: str) -> Optional[str]:
        return self._call("begin_sync_run", profile_id, mode, reason)

    def finish_sync_run(self, run_id: Optional[str], status: str, details: Mapping[str, Any]) -> None:
        if run_id is not None:
            self._call("finish_sync_run", run_id, status, dict(details))

    def mark_needs_reconcile(self, profile_id: str, reason: str) -> None:
        self._call("mark_needs_reconcile", profile_id, reason)

    # 可选核验钩子。未实现时有意不根据 API 的局部视图删除或停用任何记录。
    def mark_reconcile_seen(self, profile_id: str, voc_ids: Sequence[str]) -> None:
        func = getattr(self.db, "mark_reconcile_seen", None)
        if callable(func):
            func(profile_id, list(voc_ids))

    def mark_absent_after_two_reconciles(self, profile_id: str) -> int:
        func = getattr(self.db, "mark_absent_after_two_reconciles", None)
        return int(func(profile_id) or 0) if callable(func) else 0


@dataclass
class SyncStatus:
    task_id: str
    profile_id: str
    mode: str
    reason: str
    status: str = "queued"
    phase: str = "queued"
    active: bool = True
    started_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    finished_at: Optional[str] = None
    added: int = 0
    updated: int = 0
    unchanged: int = 0
    changed: int = 0
    records_count: int = 0
    needs_reconcile: bool = False
    error: Optional[str] = None
    progress_current: int = 0
    progress_total: int = 0
    _lock: threading.RLock = field(default_factory=threading.RLock, repr=False, compare=False)

    def update(self, **values: Any) -> None:
        with self._lock:
            for key, value in values.items():
                if hasattr(self, key):
                    setattr(self, key, value)
            self.changed = self.added + self.updated

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            total = max(0, int(self.progress_total))
            current = max(0, int(self.progress_current))
            return {
                "task_id": self.task_id,
                "profile_id": self.profile_id,
                "mode": self.mode,
                "reason": self.reason,
                "status": self.status,
                "phase": self.phase,
                "active": self.active,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
                "added": self.added,
                "updated": self.updated,
                "unchanged": self.unchanged,
                "changed": self.changed,
                "records_count": self.records_count,
                "needs_reconcile": self.needs_reconcile,
                "error": self.error,
                "progress": {
                    "current": current,
                    "total": total,
                    "percent": int((current * 100) / total) if total else 0,
                },
            }


class StudySyncService:
    """供 :class:`SyncManager` 和测试使用的同步 worker。"""

    def __init__(
        self,
        repository: StudySyncRepository,
        *,
        client: Optional[MaimemoStudyClient] = None,
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
        bootstrap_start: date = DEFAULT_BOOTSTRAP_START,
        bootstrap_end: date = DEFAULT_BOOTSTRAP_END,
        activity_window_days: int = 30,
        today_probe_interval: timedelta = timedelta(minutes=15),
    ) -> None:
        self.repository = repository
        self.client = client or MaimemoStudyClient()
        self.now = now
        self.bootstrap_start = bootstrap_start
        self.bootstrap_end = bootstrap_end
        self.activity_window_days = max(1, int(activity_window_days))
        self.today_probe_interval = today_probe_interval

    @staticmethod
    def _normalise_profile_id(value: str) -> str:
        text = str(value or "").strip().lower()
        if len(text) == 64 and all(char in "0123456789abcdef" for char in text):
            return text
        return token_profile_id(text)

    def run(
        self,
        token: str,
        mode: str,
        *,
        reason: str = "manual",
        cancel_event: Optional[threading.Event] = None,
        status: Optional[SyncStatus] = None,
        seed_records: Optional[Sequence[Mapping[str, Any]]] = None,
        profile_id: Optional[str] = None,
    ) -> dict[str, Any]:
        if mode not in {"incremental", "bootstrap", "reconcile"}:
            raise ValueError("mode must be incremental, bootstrap, or reconcile")
        profile_id = self._normalise_profile_id(profile_id or token)
        cancel_event = cancel_event or threading.Event()
        status = status or SyncStatus(uuid.uuid4().hex, profile_id, mode, reason)
        self.repository.ensure_sync_profile(profile_id)
        run_id = self.repository.begin_sync_run(profile_id, mode, reason)
        status.update(status="running", phase="starting", active=True)
        try:
            if mode == "bootstrap":
                self._run_bootstrap(profile_id, token, cancel_event, status, seed_records=seed_records, source="bootstrap")
            elif mode == "reconcile":
                self._run_reconcile(profile_id, token, cancel_event, status)
            else:
                self._run_incremental(profile_id, token, cancel_event, status, reason=reason)
            status.update(status="completed", phase="completed", active=False, finished_at=self.now().isoformat())
            result = status.snapshot()
            self.repository.finish_sync_run(run_id, "completed", result)
            return result
        except SyncCancelled:
            self.repository.mark_needs_reconcile(profile_id, "sync cancelled before completion")
            status.update(
                status="cancelled", phase="cancelled", active=False, needs_reconcile=True,
                finished_at=self.now().isoformat(), error="sync cancelled",
            )
            result = status.snapshot()
            self.repository.finish_sync_run(run_id, "cancelled", result)
            return result
        except Exception as exc:
            self.repository.mark_needs_reconcile(profile_id, str(exc))
            status.update(
                status="failed", phase="failed", active=False, needs_reconcile=True,
                finished_at=self.now().isoformat(), error=str(exc),
            )
            result = status.snapshot()
            self.repository.finish_sync_run(run_id, "failed", result)
            return result

    def should_run_weekly_reconcile(self, profile_id: str) -> bool:
        state = self.repository.get_sync_state(profile_id) or {}
        last = _parse_datetime(state.get("last_reconcile_at"))
        if last is None:
            return True
        return self.now().astimezone(timezone.utc) - last.astimezone(timezone.utc) >= timedelta(days=7)

    def _run_bootstrap(
        self,
        profile_id: str,
        token: str,
        cancel_event: threading.Event,
        status: SyncStatus,
        *,
        seed_records: Optional[Sequence[Mapping[str, Any]]],
        source: str,
    ) -> None:
        clean_seed: list[dict[str, Any]] = []
        seed_is_trusted = False
        if seed_records:
            status.update(phase="importing_seed")
            try:
                clean_seed = _validate_seed_records(seed_records)
                seed_is_trusted = True
                self._apply_if_changed(profile_id, clean_seed, status)
            except DataIncompleteError:
                # 只有所有记录都带唯一稳定 ID 时，旧浏览器缓存才有价值。畸形或重复
                # 的缓存按不存在处理并建立经核验的基线，不让整个安装流程失败。
                status.update(phase="seed_untrusted")

        status.update(phase="counting")
        remote_total = self.client.count(
            token, cancel_event, on_retry=lambda text: status.update(phase=text), profile_id=profile_id
        )
        if seed_is_trusted and len(clean_seed) == remote_total:
            # 唯一快速初始化路径：结构有效的缓存状态与远程数量完全一致，因此无需
            # 再请求包括 2020–2022 在内的历史区间。
            self.repository.set_sync_state(
                profile_id,
                bootstrap_complete=True,
                bootstrap_source="browser_seed",
                last_remote_count=remote_total,
                last_incremental_at=self.now().isoformat(),
                last_incremental_date=beijing_today(self.now()).isoformat(),
                last_reconcile_at=self.now().isoformat(),
                needs_reconcile=False,
                last_error=None,
            )
            status.update(records_count=len(clean_seed), progress_total=remote_total,
                          progress_current=len(clean_seed), phase="seed_baseline_complete")
            return
        status.update(phase="fetching_ranges", progress_total=remote_total, progress_current=0)
        seen: set[str] = set()
        self._fetch_range_tree(
            profile_id,
            token,
            self.bootstrap_start,
            self.bootstrap_end,
            cancel_event,
            status,
            seen,
            source=source,
            skip_complete=(source == "bootstrap"),
        )
        counter = getattr(self.repository, "get_record_count", None)
        local_total = counter(profile_id) if callable(counter) else None
        verified_total = len(seen) if local_total is None else int(local_total)
        if verified_total != remote_total:
            raise DataIncompleteError("bootstrap count mismatch: local %d of remote %d" % (verified_total, remote_total))
        self.repository.set_sync_state(
            profile_id,
            bootstrap_complete=True,
            last_remote_count=remote_total,
            last_incremental_at=self.now().isoformat(),
            last_incremental_date=beijing_today(self.now()).isoformat(),
            last_reconcile_at=self.now().isoformat(),
            needs_reconcile=False,
            last_error=None,
        )
        status.update(records_count=verified_total, progress_current=verified_total, phase="writing_complete")

    def _run_reconcile(
        self,
        profile_id: str,
        token: str,
        cancel_event: threading.Event,
        status: SyncStatus,
    ) -> None:
        status.update(phase="counting")
        remote_total = self.client.count(
            token, cancel_event, on_retry=lambda text: status.update(phase=text), profile_id=profile_id
        )
        status.update(phase="reconciling_ranges", progress_total=remote_total, progress_current=0)
        seen: set[str] = set()
        self._fetch_range_tree(
            profile_id,
            token,
            self.bootstrap_start,
            self.bootstrap_end,
            cancel_event,
            status,
            seen,
            source="reconcile",
            skip_complete=False,
        )
        if len(seen) != remote_total:
            raise DataIncompleteError("reconcile count mismatch: fetched %d of remote %d" % (len(seen), remote_total))
        marker = getattr(self.repository, "mark_reconcile_seen", None)
        if callable(marker):
            marker(profile_id, sorted(seen))
        absent_marker = getattr(self.repository, "mark_absent_after_two_reconciles", None)
        if callable(absent_marker):
            absent_marker(profile_id)
        self.repository.set_sync_state(
            profile_id,
            bootstrap_complete=True,
            last_remote_count=remote_total,
            last_reconcile_at=self.now().isoformat(),
            last_incremental_at=self.now().isoformat(),
            last_incremental_date=beijing_today(self.now()).isoformat(),
            needs_reconcile=False,
            last_error=None,
        )
        status.update(records_count=len(seen), progress_current=len(seen), phase="reconcile_complete")

    def _run_incremental(
        self,
        profile_id: str,
        token: str,
        cancel_event: threading.Event,
        status: SyncStatus,
        *,
        reason: str,
    ) -> None:
        state = self.repository.get_sync_state(profile_id) or {}
        if not state.get("bootstrap_complete"):
            # 首次普通刷新安全且确定；明确记录其状态，不把局部活动窗口扫描伪装成
            # 完整本地基线。
            self._run_bootstrap(profile_id, token, cancel_event, status, seed_records=None, source="bootstrap")
            return

        status.update(phase="checking")
        remote_total = self.client.count(
            token, cancel_event, on_retry=lambda text: status.update(phase=text), profile_id=profile_id
        )
        previous_total = _optional_int(state.get("last_remote_count"))
        today = beijing_today(self.now())
        need_probe = self._needs_today_probe(state, today, reason)
        candidates = self._due_candidates(profile_id, state, today)
        existing_at_start: dict[str, str] = {}
        discovered_new: set[str] = set()
        pending_today_items: list[dict[str, Any]] = []
        refreshed_ids: set[str] = set()

        if previous_total is not None and remote_total < previous_total:
            self._set_needs_reconcile(profile_id, status, "remote count decreased; no local deletion performed")

        if need_probe:
            # 此处不查询整个日期范围。精简今日条目接口负责检测变化，只有精简状态
            # 已变化的 ID 才进入完整 StudyRecord 查询。
            status.update(phase="checking_today_items")
            today_items = self.client.today_items(
                token,
                cancel_event,
                on_retry=lambda text: status.update(phase=text),
                profile_id=profile_id,
            )
            item_hashes = self._get_today_item_hashes(profile_id, today, [item["voc_id"] for item in today_items])
            changed_items = [item for item in today_items if item_hashes.get(item["voc_id"]) != item["content_hash"]]
            pending_today_items = changed_items
            candidates.update(item["voc_id"] for item in changed_items)

        if candidates:
            status.update(phase="checking_due", progress_total=len(candidates), progress_current=0)
            for batch in _chunks(sorted(candidates)):
                if cancel_event.is_set():
                    raise SyncCancelled("sync cancelled")
                records = self.client.records(token, {"voc_ids": batch, "limit": MAX_QUERY_RECORDS}, cancel_event,
                                              on_retry=lambda text: status.update(phase=text), profile_id=profile_id)
                returned_ids = {item["voc_id"] for item in records}
                refreshed_ids.update(returned_ids)
                missing_ids = set(batch) - returned_ids
                if missing_ids:
                    self._set_needs_reconcile(
                        profile_id, status,
                        "targeted query omitted %d requested record(s)" % len(missing_ids),
                    )
                known = self.repository.get_study_record_hashes(profile_id, [item["voc_id"] for item in records])
                for voc_id, value in known.items():
                    existing_at_start.setdefault(voc_id, value)
                self._note_new_ids(records, existing_at_start, discovered_new)
                self._apply_if_changed(profile_id, records, status)
                status.update(progress_current=status.progress_current + len(batch))

        if pending_today_items:
            confirmed_items = [item for item in pending_today_items if item["voc_id"] in refreshed_ids]
            self._store_today_item_hashes(profile_id, today, confirmed_items, {})

        if previous_total is not None and remote_total > previous_total:
            status.update(phase="scanning_active_window")
            end = today + timedelta(days=self.activity_window_days)
            activity_records = self._fetch_date_range(profile_id, token, today, end, cancel_event, status)
            known = self.repository.get_study_record_hashes(profile_id, [item["voc_id"] for item in activity_records])
            for voc_id, value in known.items():
                existing_at_start.setdefault(voc_id, value)
            self._note_new_ids(activity_records, existing_at_start, discovered_new)
            self._apply_if_changed(profile_id, activity_records, status)
            if len(discovered_new) < remote_total - previous_total:
                self._set_needs_reconcile(
                    profile_id,
                    status,
                    "remote count increased but active window did not identify every new record",
                )

        values: dict[str, Any] = {
            "last_remote_count": remote_total,
            "last_incremental_at": self.now().isoformat(),
            "last_incremental_date": today.isoformat(),
            "last_error": None,
        }
        if need_probe:
            values["last_today_probe_at"] = self.now().isoformat()
        if not status.needs_reconcile:
            values["needs_reconcile"] = False
        self.repository.set_sync_state(profile_id, **values)
        status.update(phase="up_to_date", records_count=status.added + status.updated + status.unchanged)

    def _get_today_item_hashes(self, profile_id: str, item_date: date, voc_ids: Sequence[str]) -> Mapping[str, str]:
        """从 SQLite 读取精简条目散列，并以状态 JSON 兜底。

        The fallback exists only for an interrupted upgrade before the SQLite
        table is created.  A normal v0.70 database provides the dedicated two
        functions documented by ``DbStudySyncRepository``.
        """

        if not voc_ids:
            return {}
        reader = getattr(self.repository, "get_today_item_hashes", None)
        if callable(reader):
            try:
                return reader(profile_id, item_date, list(voc_ids)) or {}
            except RepositoryContractError:
                pass
        state = self.repository.get_sync_state(profile_id) or {}
        if state.get("today_item_hash_date") != item_date.isoformat():
            return {}
        values = state.get("today_item_hashes") or {}
        if isinstance(values, str):
            try:
                values = json.loads(values)
            except json.JSONDecodeError:
                values = {}
        if not isinstance(values, Mapping):
            return {}
        return {voc_id: str(values[voc_id]) for voc_id in voc_ids if voc_id in values}

    def _store_today_item_hashes(
        self,
        profile_id: str,
        item_date: date,
        changed_items: Sequence[Mapping[str, Any]],
        existing_hashes: Mapping[str, str],
    ) -> None:
        if not changed_items:
            return
        writer = getattr(self.repository, "upsert_today_items", None)
        if callable(writer):
            try:
                writer(profile_id, item_date, list(changed_items))
                return
            except RepositoryContractError:
                pass
        # 滚动升级期间对已有 SQLite 状态行的兼容路径；这是元数据，不是学习记录写入。
        merged = dict(existing_hashes)
        merged.update({str(item["voc_id"]): str(item["content_hash"]) for item in changed_items})
        self.repository.set_sync_state(
            profile_id,
            today_item_hash_date=item_date.isoformat(),
            today_item_hashes=merged,
        )

    def _fetch_range_tree(
        self,
        profile_id: str,
        token: str,
        start_day: date,
        end_day: date,
        cancel_event: threading.Event,
        status: SyncStatus,
        seen: set[str],
        *,
        source: str,
        skip_complete: bool,
        depth: int = 0,
    ) -> None:
        if cancel_event.is_set():
            raise SyncCancelled("sync cancelled")
        if start_day > end_day:
            return
        if skip_complete and self.repository.is_sync_interval_complete(profile_id, start_day, end_day):
            return
        if depth > 32:
            self.repository.record_sync_interval(profile_id, start_day, end_day, complete=False, source=source)
            raise DataIncompleteError("date range split depth exceeded")
        records = self._fetch_date_range(profile_id, token, start_day, end_day, cancel_event, status)
        if len(records) >= MAX_QUERY_RECORDS:
            if start_day == end_day:
                self.repository.record_sync_interval(profile_id, start_day, end_day, complete=False, source=source)
                raise DataIncompleteError("single day %s returned %d records" % (start_day.isoformat(), len(records)))
            midpoint = start_day + timedelta(days=(end_day - start_day).days // 2)
            self._fetch_range_tree(profile_id, token, start_day, midpoint, cancel_event, status, seen,
                                   source=source, skip_complete=skip_complete, depth=depth + 1)
            self._fetch_range_tree(profile_id, token, midpoint + timedelta(days=1), end_day, cancel_event, status, seen,
                                   source=source, skip_complete=skip_complete, depth=depth + 1)
            return
        self._apply_if_changed(profile_id, records, status)
        seen.update(item["voc_id"] for item in records)
        status.update(progress_current=len(seen), records_count=len(seen))
        self.repository.record_sync_interval(profile_id, start_day, end_day, complete=True, source=source)

    def _fetch_date_range(
        self,
        profile_id: str,
        token: str,
        start_day: date,
        end_day: date,
        cancel_event: threading.Event,
        status: SyncStatus,
    ) -> list[dict[str, Any]]:
        return self.client.records(
            token,
            {
                "next_study_date": {"start": _as_iso_start(start_day), "end": _as_iso_end(end_day)},
                "limit": MAX_QUERY_RECORDS,
            },
            cancel_event,
            on_retry=lambda text: status.update(phase=text),
            profile_id=profile_id,
        )

    def _apply_if_changed(self, profile_id: str, records: Sequence[Mapping[str, Any]], status: SyncStatus) -> None:
        if not records:
            return
        normalised = _dedupe_records(records)
        known = self.repository.get_study_record_hashes(profile_id, [item["voc_id"] for item in normalised])
        changed = [item for item in normalised if known.get(item["voc_id"]) != item["content_hash"]]
        unchanged = len(normalised) - len(changed)
        if changed:
            outcome = self.repository.upsert_study_records(profile_id, changed)
            status.update(
                added=status.added + _safe_int(outcome.get("added")),
                updated=status.updated + _safe_int(outcome.get("updated")),
                unchanged=status.unchanged + _safe_int(outcome.get("unchanged")) + unchanged,
            )
        else:
            status.update(unchanged=status.unchanged + unchanged)

    def _needs_today_probe(self, state: Mapping[str, Any], today: date, reason: str) -> bool:
        if reason in {"manual", "force", "user"}:
            return True
        previous = _parse_datetime(state.get("last_today_probe_at"))
        if previous is None:
            return True
        if previous.astimezone(BEIJING_TZ).date() != today:
            return True
        return self.now().astimezone(timezone.utc) - previous.astimezone(timezone.utc) >= self.today_probe_interval

    def _due_candidates(self, profile_id: str, state: Mapping[str, Any], today: date) -> set[str]:
        previous = _coerce_date(state.get("last_incremental_date"))
        # 本地查询只返回此区间内已知到期的 ID，因此不会重新下载历史区间。
        start = today if previous is None else min(today, previous + timedelta(days=1))
        raw = self.repository.get_due_candidate_voc_ids(profile_id, start, today)
        return {str(value) for value in raw if str(value)}

    @staticmethod
    def _note_new_ids(records: Sequence[Mapping[str, Any]], known: Mapping[str, str], found: set[str]) -> None:
        for record in records:
            if record["voc_id"] not in known:
                found.add(record["voc_id"])

    def _set_needs_reconcile(self, profile_id: str, status: SyncStatus, reason: str) -> None:
        self.repository.mark_needs_reconcile(profile_id, reason)
        status.update(needs_reconcile=True)


def _parse_datetime(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _optional_int(value: Any) -> Optional[int]:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _validate_seed_records(records: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    if not isinstance(records, Sequence) or isinstance(records, (str, bytes, bytearray)):
        raise DataIncompleteError("seed_records must be an array")
    required = ("voc_id", "voc_spelling", "add_date", "study_count", "tags")
    for raw in records:
        if not isinstance(raw, Mapping):
            raise DataIncompleteError("seed_records contains a non-object record")
        if any(key not in raw or raw.get(key) is None for key in required):
            raise DataIncompleteError("seed_records is missing a required StudyRecord field")
        if not str(raw.get("voc_id") or "").strip() or not str(raw.get("voc_spelling") or "").strip():
            raise DataIncompleteError("seed_records contains an empty stable identifier")
        try:
            int(raw.get("study_count"))
        except (TypeError, ValueError):
            raise DataIncompleteError("seed_records contains an invalid study_count")
    clean = _dedupe_records(records)
    if len(clean) != len(records):
        raise DataIncompleteError("seed_records contains duplicate or invalid voc_id values")
    return clean


@dataclass
class _ManagedTask:
    status: SyncStatus
    cancel_event: threading.Event
    thread: threading.Thread


class SyncManager:
    """每个由令牌派生的用户对应一个后台任务，并支持取消和状态查询。"""

    def __init__(self, service: StudySyncService):
        self.service = service
        self._tasks: dict[str, _ManagedTask] = {}
        self._last_status: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()

    def start(
        self,
        token: str,
        mode: str = "incremental",
        *,
        reason: str = "manual",
        seed_records: Optional[Sequence[Mapping[str, Any]]] = None,
        profile_id: Optional[str] = None,
    ) -> dict[str, Any]:
        # OAuth 的 access token 会定期刷新；任务与 SQLite 档案必须使用 OIDC
        # subject 派生的稳定 ID，而不是短期 token。本参数也让旧手动 Token
        # 调用保持原来的 hash 行为。
        profile_id = self._resolve_profile(profile_id or token)
        with self._lock:
            current = self._tasks.get(profile_id)
            if current and current.thread.is_alive():
                return current.status.snapshot()
            status = SyncStatus(uuid.uuid4().hex, profile_id, mode, reason)
            cancel_event = threading.Event()
            thread = threading.Thread(
                target=self._run_task,
                args=(profile_id, token, mode, reason, seed_records, cancel_event, status),
                name="memo-study-sync-" + profile_id[:12],
                daemon=True,
            )
            self._tasks[profile_id] = _ManagedTask(status=status, cancel_event=cancel_event, thread=thread)
            thread.start()
            return status.snapshot()

    def _run_task(
        self,
        profile_id: str,
        token: str,
        mode: str,
        reason: str,
        seed_records: Optional[Sequence[Mapping[str, Any]]],
        cancel_event: threading.Event,
        status: SyncStatus,
    ) -> None:
        result = self.service.run(
            token,
            mode,
            reason=reason,
            cancel_event=cancel_event,
            status=status,
            seed_records=seed_records,
            profile_id=profile_id,
        )
        with self._lock:
            self._last_status[profile_id] = result

    def cancel(self, token_or_profile_id: str) -> dict[str, Any]:
        profile_id = self._resolve_profile(token_or_profile_id)
        with self._lock:
            task = self._tasks.get(profile_id)
            if not task or not task.thread.is_alive():
                return self.status(profile_id)
            task.cancel_event.set()
            task.status.update(phase="cancelling")
            return task.status.snapshot()

    def status(self, token_or_profile_id: str) -> dict[str, Any]:
        profile_id = self._resolve_profile(token_or_profile_id)
        with self._lock:
            task = self._tasks.get(profile_id)
            if task:
                return task.status.snapshot()
            return dict(self._last_status.get(profile_id, {
                "profile_id": profile_id,
                "status": "idle",
                "phase": "idle",
                "active": False,
                "mode": None,
                "changed": 0,
                "added": 0,
                "updated": 0,
                "unchanged": 0,
                "records_count": 0,
                "needs_reconcile": False,
                "error": None,
                "progress": {"current": 0, "total": 0, "percent": 0},
            }))

    def maybe_start_weekly_reconcile(
        self,
        token: str,
        *,
        is_dashboard_idle: Callable[[], bool],
        is_study_active: Callable[[], bool],
    ) -> Optional[dict[str, Any]]:
        profile_id = token_profile_id(token)
        if not is_dashboard_idle() or is_study_active() or not self.service.should_run_weekly_reconcile(profile_id):
            return None
        return self.start(token, "reconcile", reason="weekly")

    @staticmethod
    def _resolve_profile(value: str) -> str:
        text = (value or "").strip()
        if len(text) == 64 and all(char in "0123456789abcdef" for char in text.lower()):
            return text.lower()
        return token_profile_id(text)


__all__ = [
    "BEIJING_TZ", "DEFAULT_BOOTSTRAP_END", "DEFAULT_BOOTSTRAP_START", "HTTPResponse",
    "MAIMEMO_OPEN_API", "MAX_QUERY_RECORDS", "DataIncompleteError", "DbStudySyncRepository",
    "MaimemoStudyClient", "ProfileRateLimiter", "RateLimit", "RemoteAPIError", "RepositoryContractError",
    "SlidingWindowRateLimiter", "StudySyncError", "StudySyncService", "SyncCancelled",
    "SyncManager", "SyncStatus", "UrllibJSONTransport", "beijing_today", "normalise_record",
    "record_fingerprint", "token_profile_id",
]
