# -*- coding: utf-8 -*-
"""角色包安装：检查、确认、逐角色提交、可恢复的批处理作业。

四条设计约束，它们决定了本文件的结构：

1. **整包检查与逐角色提交分离。** 先把 ZIP 全部读一遍并算出「会装成什么」，
   再让用户确认；确认时**重新核对包身份**（sha256 与角色集合），防止两次点击
   之间换了压缩包。
2. **每角色独立事务。** 一个角色失败只回滚该角色，其余照常提交，作业状态为
   ``partial_failed`` 而不是整体失败——17 个角色不能因为第 18 个坏了白装。
3. **日志先写、恢复先读。** 提交每一步都追加到 ``role_packages/journals``，
   启动时先恢复未结束日志再接新任务，避免断电留下半装状态。
4. **只接受受控来源。** 拒绝任意下载 URL 与压缩包内的越界路径；解包前先算
   磁盘峰值并保留余量。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import time
import uuid
import zipfile
from pathlib import PurePosixPath
from typing import Any, Callable, Mapping, Optional, Protocol, Sequence

import companion_runtime

MAX_BATCH_ZIPS = 16
MAX_BATCH_ROLES = 32
MAX_ZIP_BYTES = 20 * 1024 ** 3
MAX_UNPACKED_BYTES = 28 * 1024 ** 3
MAX_UNPACKED_MEMBERS = 50000
MAX_SINGLE_FILE_BYTES = 8 * 1024 ** 3
RESERVE_BYTES = 1 * 1024 ** 3
MAX_ROLE_TEXT_BYTES = 64 * 1024

JOB_STATES = ("queued", "inspecting", "awaiting_confirm", "installing",
              "completed", "partial_failed", "cancelled", "failed", "recovering")

_REQUIRED_AUDIO = (".wav", ".mp3", ".flac", ".ogg", ".m4a")

# 角色包内允许的成员扩展名（审计 P2-1）。
# 角色包是"用户主动选择的本地 ZIP"，但其中曾可夹带 .exe/.dll/.ps1/.bat/.lnk/.js
# 等可执行文件，它们会随包落盘到数据目录。虽然当前执行链只从固定的
# .venv311/Scripts/python.exe 与 tts_engine/worker_main.py 启动（不执行角色目录内容），
# 但落盘的可执行文件仍可能被误点或被备份带走，故在检查阶段直接拒绝。
_ALLOWED_MEMBER_SUFFIXES = frozenset({
    ".json", ".txt", ".md",
    ".wav", ".mp3", ".flac", ".ogg", ".m4a",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
    ".model", ".mat", ".bin",
    # GPT-SoVITS 模型权重与索引
    ".ckpt", ".pth", ".safetensors", ".pt", ".onnx", ".index",
})
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class RolePackageError(RuntimeError):
    """角色包请求非法。"""


class RolePackageConflict(RolePackageError):
    """同一包身份/角色标识冲突，需要用户明确选择策略。"""


class RoleWriter(Protocol):
    """安装原语适配器。生产用 ``TtsRoleWriter``，测试可注入假实现。"""

    def write_role(self, spec: dict[str, Any]) -> dict[str, Any]:
        ...

    def delete_role(self, role_id: str) -> None:
        ...


class TtsRoleWriter:
    """把 ``tts.install_role_resources`` 适配成本服务的写入口。"""

    def __init__(self, pack_dir: Optional[str] = None) -> None:
        self.pack_dir = pack_dir

    def _dir(self) -> str:
        if self.pack_dir:
            return self.pack_dir
        return companion_runtime.data_paths()["tts_pack_dir"]

    def write_role(self, spec: dict[str, Any]) -> dict[str, Any]:
        import tts
        return tts.install_role_resources(self._dir(), spec)

    def delete_role(self, role_id: str) -> None:
        import tts
        tts.delete_role(self._dir(), role_id)


# --------------------------------------------------------------------------- #
# 路径与摘要
# --------------------------------------------------------------------------- #

def _paths() -> dict[str, str]:
    return companion_runtime.ensure_data_paths()


def _sha256_file(path: str, *, limit: int = MAX_SINGLE_FILE_BYTES) -> str:
    digest = hashlib.sha256()
    total = 0
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise RolePackageError("单个文件超过允许大小")
            digest.update(chunk)
    return digest.hexdigest()


def _free_bytes(path: str) -> int:
    try:
        return shutil.disk_usage(path).free
    except OSError:
        return 0


def _journal_path(job_id: str) -> str:
    return os.path.join(_paths()["journals"], "%s.json" % _safe_token(job_id))


def _safe_token(value: Any) -> str:
    text = str(value or "")
    if not _SAFE_ID.match(text):
        raise RolePackageError("标识不合法")
    return text


def _atomic_write(path: str, payload: Any) -> None:
    """原子写 JSON：先写临时文件再 ``os.replace``，断电不会留下半个文件。"""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = "%s.%s.tmp" % (path, uuid.uuid4().hex)
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, sort_keys=True, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def _read_json(path: str) -> Optional[dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        return payload if isinstance(payload, dict) else None
    except (OSError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# registry（安装来源，不是第二套人设）
# --------------------------------------------------------------------------- #

def read_registry() -> dict[str, Any]:
    payload = _read_json(_paths()["registry"]) or {}
    return {
        "version": int(payload.get("version") or 1),
        "packages": payload.get("packages") if isinstance(payload.get("packages"), dict) else {},
        "roles": payload.get("roles") if isinstance(payload.get("roles"), dict) else {},
        "updated_at": str(payload.get("updated_at") or ""),
    }


def _write_registry(registry: Mapping[str, Any]) -> None:
    payload = dict(registry)
    payload["version"] = int(payload.get("version") or 1)
    payload["updated_at"] = companion_runtime.utc_now_iso()
    _atomic_write(_paths()["registry"], payload)


# --------------------------------------------------------------------------- #
# 压缩包读取：先检查，再确认，最后提交
# --------------------------------------------------------------------------- #

def _safe_member(name: str, root: str) -> str:
    """拒绝绝对路径、``..`` 与盘符，防止 zip-slip 写到包外。"""
    cleaned = name.replace("\\", "/")
    if cleaned.startswith("/") or re.match(r"^[A-Za-z]:", cleaned):
        raise RolePackageError("压缩包包含绝对路径：%s" % name)
    parts = [part for part in cleaned.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise RolePackageError("压缩包包含越界路径：%s" % name)
    target = os.path.abspath(os.path.join(root, *parts)) if parts else root
    if not (target == root or target.startswith(root + os.sep)):
        raise RolePackageError("压缩包包含越界路径：%s" % name)
    return target


def _read_manifest(zf: zipfile.ZipFile, root: str) -> dict[str, Any]:
    for candidate in ("role.json", "manifest.json", "role_manifest.json"):
        member = "%s/%s" % (root, candidate) if root else candidate
        try:
            info = zf.getinfo(member)
        except KeyError:
            continue
        if info.file_size > MAX_ROLE_TEXT_BYTES:
            raise RolePackageError("角色清单过大")
        with zf.open(info) as handle:
            payload = json.loads(handle.read().decode("utf-8"))
        if not isinstance(payload, dict):
            raise RolePackageError("角色清单必须是对象")
        payload["_manifest_name"] = candidate
        return payload
    raise RolePackageError("角色包缺少 role.json")


def inspect_source(source_ref: Any) -> dict[str, Any]:
    """读取一个来源（本地 ZIP 路径），返回会装成什么。

    只读不写：不落地任何角色文件，因此用户可以放心先「查看」再决定。
    """
    paths = _paths()
    source = str(source_ref or "").strip()
    if not source:
        raise RolePackageError("缺少来源")
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", source):
        # 明确拒绝任意下载 URL：只接受本机受控路径。
        raise RolePackageError("只接受本机压缩包，不接受下载地址")
    path = os.path.abspath(source)
    root = os.path.abspath(paths["incoming"])
    if not path.startswith(root + os.sep):
        raise RolePackageError("来源必须位于导入目录内")
    if not os.path.isfile(path):
        raise RolePackageError("来源文件不存在")
    size = os.path.getsize(path)
    if size > MAX_ZIP_BYTES:
        raise RolePackageError("压缩包超过允许大小")

    inspection_id = companion_runtime.new_id("insp")
    digest = _sha256_file(path)
    roles: list[dict[str, Any]] = []
    try:
        with zipfile.ZipFile(path) as zf:
            infos = [info for info in zf.infolist() if not info.is_dir()]
            # 解包上限必须在「检查」阶段就执行，否则用户会先看到一份可装的清单，
            # 到确认阶段才被拒绝。zipfile 读元数据不消耗内存，先做廉价校验。
            if len(infos) > MAX_UNPACKED_MEMBERS:
                raise RolePackageError("压缩包成员数量超过上限")
            for info in infos:
                if info.file_size > MAX_SINGLE_FILE_BYTES:
                    raise RolePackageError("压缩包内单个文件超过上限")
            if sum(info.file_size for info in infos) > MAX_UNPACKED_BYTES:
                raise RolePackageError("解包后体积超过上限")
            role_roots: set[str] = set()
            for info in infos:
                parts = info.filename.replace("\\", "/").split("/")
                if parts and parts[-1] in ("role.json", "manifest.json", "role_manifest.json"):
                    role_roots.add("/".join(parts[:-1]))
            for role_root in sorted(role_roots):
                manifest = _read_manifest(zf, role_root)
                files = [info.filename for info in infos
                         if not role_root or info.filename.startswith(role_root + "/")]
                for name in files:
                    _safe_member(name, paths["incoming"])
                    # 扩展名白名单：拒绝夹带可执行类型（审计 P2-1）。
                    # 无扩展名的文件（如部分模型权重）也拒绝，避免绕过。
                    suffix = PurePosixPath(str(name).replace("\\", "/")).suffix.lower()
                    if suffix not in _ALLOWED_MEMBER_SUFFIXES:
                        raise RolePackageError("角色包包含不允许的文件类型：%s" % name)
                missing = _missing_fields(zf, role_root, manifest)
                roles.append({
                    "role_root": role_root,
                    "name": str(manifest.get("name") or manifest.get("角色") or role_root or "未命名角色"),
                    "package_role_id": str(manifest.get("role_id") or ""),
                    "version": str(manifest.get("version") or ""),
                    "file_count": len(files),
                    "unpacked_bytes": sum(zf.getinfo(name).file_size for name in files),
                    "missing": missing,
                    "complete": not missing,
                    "manifest": {key: value for key, value in manifest.items()
                                 if not key.startswith("_")},
                })
    except zipfile.BadZipFile as exc:
        raise RolePackageError("压缩包损坏：%s" % exc)
    if not roles:
        raise RolePackageError("压缩包里没有可安装的角色")
    if len(roles) > MAX_BATCH_ROLES:
        raise RolePackageError("单个压缩包的角色数量超过上限")

    registry = read_registry()
    for item in roles:
        existing = registry["roles"].get(item["package_role_id"]) if item["package_role_id"] else None
        item["conflict"] = "upgrade" if existing else "new"
        item["existing_role_id"] = (existing or {}).get("local_role_id")
        item["notes"] = []
        if item["conflict"] == "upgrade":
            item["notes"].append("已安装过同一角色，将作为升级处理并保留长期记忆")
        if not item["complete"]:
            item["notes"].append("缺少项，将安装为草稿角色")

    unpacked = sum(item["unpacked_bytes"] for item in roles)
    estimated = size + unpacked
    free = _free_bytes(paths["incoming"])
    inspection = {
        "inspection_id": inspection_id,
        "source_ref": path,
        "source_name": os.path.basename(path),
        "source_bytes": size,
        "source_sha256": digest,
        "role_count": len(roles),
        "roles": roles,
        "estimated_peak_bytes": estimated,
        "free_bytes": free,
        "enough_space": free >= estimated + RESERVE_BYTES,
        "reviewed_at": companion_runtime.utc_now_iso(),
    }
    _atomic_write(os.path.join(paths["jobs"], "%s.inspect.json" % inspection_id), inspection)
    return inspection


def _missing_fields(zf: zipfile.ZipFile, root: str, manifest: Mapping[str, Any]) -> list[str]:
    """按角色包约定检查必备资源，返回缺失项（空列表=完整）。"""
    def _names(prefix: str) -> set[str]:
        wanted = ("%s/%s" % (root, prefix)).lstrip("/")
        return {info.filename.replace("\\", "/") for info in zf.infolist()
                if not info.is_dir() and info.filename.replace("\\", "/").startswith(wanted)}

    missing: list[str] = []
    if not _names("gpt.ckpt"):
        missing.append("gpt.ckpt")
    if not _names("sovits.pth"):
        missing.append("sovits.pth")
    audio = set()
    for suffix in _REQUIRED_AUDIO:
        audio |= _names("reference" + suffix)
    if not audio:
        missing.append("reference audio")
    if not any(_names(name) for name in ("persona.json", "ref.index")):
        # 允许草稿，但必须提示：没有 persona.json 就无法展示人设文本。
        missing.append("persona.json")
    if not str(manifest.get("reference_text") or "").strip():
        missing.append("reference_text")
    return missing


# --------------------------------------------------------------------------- #
# 作业与提交
# --------------------------------------------------------------------------- #

class _JobStore:
    """作业状态。内存里持有可取消标记，磁盘上是恢复依据。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._cancel: dict[str, bool] = {}

    def save(self, job: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self._jobs[job["job_id"]] = job
        _atomic_write(_journal_path(job["job_id"]), job)
        return job

    def get(self, job_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            cached = self._jobs.get(_safe_token(job_id))
        if cached:
            return cached
        payload = _read_json(_journal_path(job_id))
        if payload:
            with self._lock:
                self._jobs[payload["job_id"]] = payload
        return payload

    def list(self, *, limit: int = 20) -> list[dict[str, Any]]:
        with self._lock:
            cached = list(self._jobs.values())
        known = {item["job_id"] for item in cached}
        journals_dir = _paths()["journals"]
        for name in os.listdir(journals_dir) if os.path.isdir(journals_dir) else []:
            if not name.endswith(".json"):
                continue
            job_id = name[:-5]
            if job_id in known:
                continue
            payload = _read_json(os.path.join(journals_dir, name))
            if payload and payload.get("job_id"):
                cached.append(payload)
        cached.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
        return cached[:max(1, min(int(limit or 20), 100))]

    def request_cancel(self, job_id: str) -> None:
        with self._lock:
            self._cancel[_safe_token(job_id)] = True

    def is_cancelled(self, job_id: str) -> bool:
        with self._lock:
            return bool(self._cancel.get(str(job_id)))

    def clear_cancel(self, job_id: str) -> None:
        with self._lock:
            self._cancel.pop(str(job_id), None)


_store = _JobStore()
_install_lock = threading.Lock()


def _writer() -> RoleWriter:
    return TtsRoleWriter()


def stage_local_files(paths: Sequence[str]) -> list[str]:
    """把桌面端选中的本机 ZIP 复制进受控 ``incoming``，返回受控引用。

    为什么必须复制而不是直接返回原路径：``inspect_source`` 只接受
    ``incoming`` 目录内的来源，若直接把 ``C:\\Users\\...\\x.zip`` 交给服务端，
    就等于给了一条「读任意本机文件」的通道。复制还有第二个好处——来源文件
    之后被用户移动或删除也不影响安装。
    """
    paths_info = _paths()
    incoming = os.path.abspath(paths_info["incoming"])
    staged: list[str] = []
    if len(paths) > MAX_BATCH_ZIPS:
        raise RolePackageError("单批最多导入 %d 个压缩包" % MAX_BATCH_ZIPS)
    for raw in paths:
        source = os.path.abspath(str(raw or ""))
        if not os.path.isfile(source):
            raise RolePackageError("选中的文件不存在")
        if not source.lower().endswith(".zip"):
            raise RolePackageError("只接受 ZIP 角色包")
        size = os.path.getsize(source)
        if size <= 0:
            raise RolePackageError("空压缩包")
        if size > MAX_ZIP_BYTES:
            raise RolePackageError("压缩包超过允许大小")
        # 目标名去冲突：同名文件不能互相覆盖（两次导入同名包是常见操作）。
        base = os.path.basename(source)
        stem, suffix = os.path.splitext(base)
        target = os.path.join(incoming, base)
        counter = 1
        while os.path.exists(target):
            counter += 1
            target = os.path.join(incoming, "%s-%d%s" % (stem, counter, suffix))
        if os.path.isfile(source) and os.path.abspath(source).startswith(incoming + os.sep):
            # 已在受控目录内：不必复制，直接复用。
            staged.append(os.path.abspath(source))
            continue
        shutil.copyfile(source, target)
        staged.append(os.path.abspath(target))
    return staged


def start_install(inspection_id: str, *, selections: Optional[Sequence[Mapping[str, Any]]] = None,
                  writer: Optional[RoleWriter] = None,
                  background: bool = True) -> dict[str, Any]:
    """确认并开始安装。确认时**重新核对**来源摘要与角色集合。"""
    paths = _paths()
    inspection = _read_json(os.path.join(paths["jobs"],
                                        "%s.inspect.json" % _safe_token(inspection_id)))
    if not inspection:
        raise RolePackageError("检查结果不存在或已过期")
    source = str(inspection["source_ref"])
    if not os.path.isfile(source):
        raise RolePackageError("来源文件已不存在，请重新导入")
    if _sha256_file(source) != inspection["source_sha256"]:
        raise RolePackageConflict("来源文件在确认后发生变化，请重新检查")

    chosen: list[dict[str, Any]] = []
    wanted = {str(item.get("role_root") or ""): item for item in (selections or [])}
    for role in inspection["roles"]:
        override = wanted.get(str(role["role_root"]))
        if selections and override is None:
            continue  # 只装用户勾选的角色
        chosen.append({
            "role_root": role["role_root"],
            "name": role["name"],
            "package_role_id": role["package_role_id"],
            "conflict": str((override or {}).get("conflict") or role["conflict"]),
            "existing_role_id": role.get("existing_role_id"),
        })
    if not chosen:
        raise RolePackageError("没有选择要安装的角色")
    if len(chosen) > MAX_BATCH_ROLES:
        raise RolePackageError("单批角色数量超过上限")

    job_id = companion_runtime.new_id("job")
    job = {
        "job_id": job_id,
        "state": "queued",
        "source_ref": source,
        "source_sha256": inspection["source_sha256"],
        "inspection_id": inspection["inspection_id"],
        "total_roles": len(chosen),
        "completed_roles": 0,
        "failed_roles": 0,
        "bytes_written": 0,
        "roles": [dict(item, status="pending", result=None, error=None) for item in chosen],
        "created_at": companion_runtime.utc_now_iso(),
        "updated_at": companion_runtime.utc_now_iso(),
        "finished_at": None,
        "recoverable": False,
        "message": "",
    }
    _store.save(job)
    if background:
        thread = threading.Thread(target=_run_install, args=(job_id, inspection, writer),
                                  name="role-package-%s" % job_id, daemon=True)
        thread.start()
        return _store.get(job_id) or job
    _run_install(job_id, inspection, writer)
    return _store.get(job_id) or job


def _run_install(job_id: str, inspection: Mapping[str, Any],
                 writer: Optional[RoleWriter]) -> None:
    job = _store.get(job_id)
    if not job:
        return
    adapter = writer or _writer()
    paths = _paths()
    staging_root = os.path.join(paths["staging"], job_id)
    try:
        os.makedirs(staging_root, exist_ok=True)
        job["state"] = "installing"
        _store.save(job)
        with zipfile.ZipFile(str(inspection["source_ref"])) as zf:
            for entry in job["roles"]:
                if _store.is_cancelled(job_id):
                    job["state"] = "cancelled"
                    job["message"] = "已取消，未提交的角色未做任何改动"
                    _store.save(job)
                    return
                _install_one(job, entry, zf, adapter, staging_root)
                _store.save(job)
        if job["failed_roles"] == 0:
            job["state"] = "completed"
            job["message"] = "全部角色安装完成"
        else:
            job["state"] = "partial_failed"
            job["message"] = "%d 个角色成功，%d 个失败" % (job["completed_roles"],
                                                          job["failed_roles"])
        job["finished_at"] = companion_runtime.utc_now_iso()
        _store.save(job)
    except Exception as exc:
        job["state"] = "failed"
        job["message"] = str(exc)
        job["recoverable"] = True
        job["finished_at"] = companion_runtime.utc_now_iso()
        _store.save(job)
    finally:
        _store.clear_cancel(job_id)
        shutil.rmtree(staging_root, ignore_errors=True)


def _install_one(job: dict[str, Any], entry: dict[str, Any], zf: zipfile.ZipFile,
                 adapter: RoleWriter, staging_root: str) -> None:
    """提交一个角色。失败只影响本条目，作业继续处理其余角色。"""
    import tts  # noqa: F401  —— 保证适配器的方法可解析

    role_root = str(entry["role_root"])
    stage = os.path.join(staging_root, _safe_token(entry["package_role_id"] or "role"))
    try:
        os.makedirs(stage, exist_ok=True)
        written = 0
        prefix = (role_root + "/") if role_root else ""
        for info in zf.infolist():
            if info.is_dir():
                continue
            target = _safe_member(info.filename, staging_root)
            if prefix and not info.filename.startswith(prefix):
                continue
            rel = info.filename[len(prefix):] if prefix else info.filename
            if "/" in rel:
                os.makedirs(os.path.dirname(target), exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
            written += int(info.file_size)
        manifest = _read_manifest(zf, role_root)
        persona = _read_persona(zf, role_root)
        mode = "upgrade" if entry["conflict"] == "upgrade" else "create"
        spec = {
            "mode": mode,
            "role_id": entry.get("existing_role_id") or (entry["package_role_id"] or ""),
            "expect_role_id": entry.get("existing_role_id") or "",
            "staged_dir": stage,
            "manifest": {
                "gpt_file": "gpt.ckpt" if os.path.isfile(os.path.join(stage, "gpt.ckpt")) else "",
                "sovits_file": "sovits.pth" if os.path.isfile(os.path.join(stage, "sovits.pth")) else "",
                "index_file": "ref.index" if os.path.isfile(os.path.join(stage, "ref.index")) else "",
                "audio_file": _audio_name(stage),
                "reference_text": str(manifest.get("reference_text") or ""),
                "reference_language": str(manifest.get("reference_language") or ""),
                "live2d_model_id": str(manifest.get("live2d_model_id") or ""),
            },
            "persona_document": persona,
            # 升级时不覆盖用户手改过的人设，除非包明确声明。
            "replace_persona": bool(manifest.get("replace_persona")) or mode == "create",
        }
        public = adapter.write_role(spec)
        registry = read_registry()
        local_role_id = str((public or {}).get("role_id") or spec["role_id"] or "")
        if local_role_id:
            registry["roles"][entry["package_role_id"] or local_role_id] = {
                "local_role_id": local_role_id,
                "source_sha256": job["source_sha256"],
                "source_name": os.path.basename(str(job["source_ref"])),
                "package_version": str(manifest.get("version") or ""),
                "installed_at": companion_runtime.utc_now_iso(),
            }
            registry["packages"][job["source_sha256"]] = {
                "source_name": os.path.basename(str(job["source_ref"])),
                "installed_at": companion_runtime.utc_now_iso(),
                "role_count": job["total_roles"],
            }
            _write_registry(registry)
        entry["status"] = "installed"
        entry["result"] = {"role_id": local_role_id, "name": entry["name"],
                           "mode": mode, "files": written}
        job["completed_roles"] += 1
        job["bytes_written"] += written
    except Exception as exc:
        entry["status"] = "failed"
        entry["error"] = str(exc)
        job["failed_roles"] += 1
        job["recoverable"] = True
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def _read_persona(zf: zipfile.ZipFile, root: str) -> Optional[dict[str, Any]]:
    member = ("%s/persona.json" % root) if root else "persona.json"
    try:
        info = zf.getinfo(member)
    except KeyError:
        return None
    if info.file_size > MAX_ROLE_TEXT_BYTES:
        raise RolePackageError("persona.json 过大")
    with zf.open(info) as handle:
        payload = json.loads(handle.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise RolePackageError("persona.json 必须是对象")
    return payload


def _audio_name(stage: str) -> str:
    for suffix in _REQUIRED_AUDIO:
        if os.path.isfile(os.path.join(stage, "reference" + suffix)):
            return "reference" + suffix
    return ""


# --------------------------------------------------------------------------- #
# 对外查询 / 取消 / 恢复
# --------------------------------------------------------------------------- #

def job_status(job_id: str) -> dict[str, Any]:
    job = _store.get(job_id)
    if not job:
        raise RolePackageError("作业不存在")
    return job


def list_jobs(*, limit: int = 20) -> list[dict[str, Any]]:
    return _store.list(limit=limit)


def cancel_job(job_id: str) -> dict[str, Any]:
    """提交前取消。已提交的角色保留（补偿已完成），未提交的不动。"""
    _safe_token(job_id)
    job = _store.get(job_id)
    if not job:
        raise RolePackageError("作业不存在")
    if job.get("state") in ("completed", "partial_failed", "cancelled", "failed"):
        return job
    _store.request_cancel(job_id)
    return {"job_id": job_id, "state": job.get("state"), "cancel_requested": True}


def recover_pending() -> dict[str, Any]:
    """启动时恢复：任何停在提交中的作业都标记为可恢复并交给用户决定。"""
    recovered = []
    for job in _store.list(limit=100):
        state = str(job.get("state") or "")
        if state in ("queued", "installing", "inspecting", "recovering"):
            job["state"] = "recovering"
            job["recoverable"] = True
            job["message"] = "上次安装未正常结束；已提交的角色保留，可重新检查后再装"
            _store.save(job)
            recovered.append(job["job_id"])
    return {"recovered": recovered, "count": len(recovered)}


def start_catalog_batch(items: Sequence[Mapping[str, Any]], profile_id: Any = 0) -> dict[str, Any]:
    """委托给 Live2D 服务：只接受目录 ID，不收任意下载地址。"""
    import live2d_service
    return live2d_service.start_catalog_batch(list(items), profile_id)