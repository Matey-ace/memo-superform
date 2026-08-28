#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tts.py - MeMo 语音资源包（GPT-SoVITS）接入层

职责：
  - 检测 data/tts_pack/ 资源包与安装状态（install.json + .venv311）
  - 用资源包内 .venv311 解释器拉起 tts_engine/worker_main.py 子进程
  - 通过 JSON 行协议下发 load_model / synthesize / get_status / shutdown 命令
  - 供 server.py 的 /api/tts/* 接口调用

未挂载资源包或引擎未安装时，所有功能返回明确错误，不影响 MeMo 其他功能。
"""

from __future__ import annotations

import json
import math
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import uuid
import copy
from contextlib import contextmanager
from functools import wraps


LANGUAGE_NUMBER_MAP = {
    "1": "中文", "2": "英文", "3": "日文", "4": "粤语", "5": "韩文",
    "6": "中英混合", "7": "日英混合", "8": "粤英混合", "9": "韩英混合",
    "10": "多语种混合", "11": "多语种混合(粤语)",
}

# 已加载模型的单次合成超时（秒）。worker 卡死时强杀并重置引擎；可用环境变量调大。
_SYNTH_TIMEOUT = float(os.environ.get("MEMO_TTS_SYNTH_TIMEOUT", "30") or 30)
# 首次加载模型会导入文本前端、加载 GPT/SoVITS 权重并初始化 GPU。它远慢于
# 普通一句合成，绝不能沿用 30 秒热路径超时，否则用户第一次触摸会刚好在模型
# 即将完成时被杀掉并表现为“永远没有声音”。
_COLD_START_TIMEOUT = max(
    _SYNTH_TIMEOUT,
    float(os.environ.get("MEMO_TTS_COLD_START_TIMEOUT", "180") or 180),
)
_ROLE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_ROLE_STAGE_ID_RE = re.compile(r"^[a-f0-9]{32}$")
_ROLE_FILE_KINDS = {
    "ckpt": ("gpt.ckpt", (".ckpt",)),
    "pth": ("sovits.pth", (".pth",)),
    "index": ("ref.index", (".index",)),
    "audio": ("reference", (".wav", ".mp3", ".flac", ".ogg")),
}
_ROLE_LIBRARY_LOCK = threading.RLock()
_PERSONA_FIELDS = ("name", "background", "tone", "avoid", "examples")
_PERSONA_LIMITS = {"name": 40, "background": 800, "tone": 400, "avoid": 400, "examples": 600}

# These imports cover the worker entry point plus the Japanese and English
# text preprocessors.  ``install.json`` alone is not proof that a copied or
# interrupted virtual environment can actually synthesize speech.
_ENGINE_IMPORT_PACKAGES = {
    "torch": "torch>=2.7,<2.8",
    "torchaudio": "torchaudio>=2.7,<2.8",
    "numpy": "numpy<2.0",
    "soundfile": "soundfile>=0.13.1",
    "matplotlib": "matplotlib>=3.8.0",
    "transformers": "transformers>=4.57,<5",
    "librosa": "librosa==0.10.2",
    "wordsegment": "wordsegment>=1.3.1",
    # The upstream package requires a local C/C++ toolchain on Windows.
    # pyopenjtalk-plus exports the identical ``pyopenjtalk`` module and ships
    # a CPython 3.11 Windows wheel, making repair work on normal end-user PCs.
    "pyopenjtalk": "pyopenjtalk-plus>=0.4.1.post9",
}
_ENGINE_PROBE_LOCK = threading.RLock()
_ENGINE_PROBE_CACHE = {}
_ENGINE_PROBE_TTL = 45.0
_ENGINE_REPAIR_LOCK = threading.Lock()

# 跨进程互斥锁：防止两个 Memo Superform 实例同时使用同一语音资源包
def _acquire_file_lock(lock_path):
    """Acquire one byte of an arbitrary local lock file without waiting."""
    f = None
    try:
        os.makedirs(os.path.dirname(lock_path) or ".", exist_ok=True)
        f = open(lock_path, "a+b")
        if os.name == "nt":
            # Windows 的 msvcrt.locking 不能锁 EOF 之后的区域：
            # 先保证文件至少有 1 字节，再回到文件头锁定
            f.seek(0, os.SEEK_END)
            if f.tell() == 0:
                f.write(b"\x00")
                f.flush()
            f.seek(0)
            import msvcrt
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return f, True
    except OSError:
        if f is not None:
            try:
                f.close()
            except Exception:
                pass
        return None, False
    except Exception:
        if f is not None:
            try:
                f.close()
            except Exception:
                pass
        return None, False


def _acquire_pack_lock(pack_dir):
    """占用资源包级文件锁。返回 (lock_file, acquired)。"""
    lock_file, acquired = _acquire_file_lock(os.path.join(pack_dir, ".tts.lock"))
    if not acquired:
        print("[tts] 语音资源包正被另一实例占用，未能获取 .tts.lock 锁", flush=True)
    return lock_file, acquired


def _release_pack_lock(lock_file):
    if lock_file is None:
        return
    try:
        if os.name == "nt":
            import msvcrt
            try:
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
        else:
            import fcntl
            try:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
        lock_file.close()
    except Exception:
        pass


class TTSException(Exception):
    """语音引擎相关的可读错误。"""


def _assert_role_write_allowed(pack_dir):
    """Reject edits while another Memo instance owns this pack's TTS lock."""
    manager_lock = globals().get("_MANAGER_LOCK")
    manager = None
    if manager_lock is not None:
        with manager_lock:
            manager = globals().get("_MANAGER")
            if (manager is not None and manager._pack_locked and
                    os.path.abspath(manager.pack_dir) == os.path.abspath(pack_dir)):
                return
    probe, acquired = _acquire_pack_lock(pack_dir)
    if acquired:
        _release_pack_lock(probe)
        return
    raise TTSException("语音资源包正被另一个 Memo Superform 实例使用，请先关闭另一个实例后再修改角色资料")


@contextmanager
def _role_write_guard(pack_dir):
    """Serialize role-manifest writes across local processes."""
    _assert_role_write_allowed(pack_dir)
    lock_file, acquired = _acquire_file_lock(os.path.join(pack_dir, ".roles.lock"))
    if not acquired:
        raise TTSException("角色资料正在由另一个实例更新，请稍后重试")
    try:
        yield
    finally:
        _release_pack_lock(lock_file)


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _write_json(path, data):
    temp = ""
    try:
        directory = os.path.dirname(path) or "."
        os.makedirs(directory, exist_ok=True)
        # A role manifest is the single source of truth for the model, audio,
        # and Live2D binding.  Never leave a partially-written JSON file if the
        # process is interrupted while changing one of those bindings.
        temp = path + "." + uuid.uuid4().hex + ".tmp"
        with open(temp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
        os.replace(temp, path)
        return True
    except OSError:
        if temp:
            try:
                os.unlink(temp)
            except OSError:
                pass
        return False


def _state_path(data_dir):
    return os.path.join(data_dir, "tts_state.json")


def _coerce_speed(value):
    """speed 仅接受前端支持的 0.5-1.5 倍速，否则回退 1.0。"""
    if isinstance(value, bool):
        return 1.0
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value.strip())
        except (TypeError, ValueError):
            return 1.0
    else:
        return 1.0
    if not math.isfinite(number) or not (0.5 <= number <= 1.5):
        return 1.0
    return number


def _coerce_enabled(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "on")
    return False


def _coerce_str(value, default):
    return value if isinstance(value, str) and value.strip() else default


def _default_role_persona(role_name):
    """A complete, role-local fallback for newly created packages."""
    name = str(role_name or "陪伴角色").strip()[:40] or "陪伴角色"
    return {
        "name": name,
        "background": "你是背词学习中的陪伴角色，观察学习节奏并给出简短、真诚的鼓励。",
        "tone": "自然、友好、克制，不打扰学习节奏。",
        "avoid": "不要只说单个语气词，不要说教过长，不要编造成绩或使用冒犯表达。",
        "examples": "这一题记下来就很好。|保持节奏，下一题继续。",
    }


def _normalize_persona(value, role_name, *, allow_empty=False):
    """Validate the persona stored inside one role manifest."""
    if value is None and allow_empty:
        return {}
    if not isinstance(value, dict):
        raise TTSException("角色人设格式无效")
    result = {}
    defaults = _default_role_persona(role_name)
    for field in _PERSONA_FIELDS:
        raw = value.get(field, defaults[field])
        text = str(raw or "").strip()
        if not text or len(text) > _PERSONA_LIMITS[field]:
            raise TTSException("角色人设字段“%s”不能为空且不能超过 %d 个字符" % (field, _PERSONA_LIMITS[field]))
        result[field] = text
    return result


_TEXT_SPLIT_METHODS = {"cut0", "cut1", "cut2", "cut5"}


def _coerce_num(value, default, low=None, high=None):
    """把任意类型的数值归一化为可选范围内的 float，非法时返回 default。"""
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value.strip())
        except (TypeError, ValueError):
            return default
    else:
        return default
    if not math.isfinite(number):
        return default
    if low is not None and number < low:
        return default
    if high is not None and number > high:
        return default
    return number


def _coerce_bool(value, default=False):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in ("true", "1", "yes", "on"):
            return True
        if normalized in ("false", "0", "no", "off"):
            return False
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def _coerce_split_method(value):
    method = value if isinstance(value, str) else ""
    method = method.strip().lower()
    return method if method in _TEXT_SPLIT_METHODS else "cut0"


def _load_state(data_dir):
    state = _read_json(_state_path(data_dir)) or {}
    return {
        "enabled": _coerce_enabled(state.get("enabled")),
        "language": _coerce_str(state.get("language"), "中英混合"),
        "speed": _coerce_speed(state.get("speed")),
    }


def _save_state(data_dir, state):
    return _write_json(_state_path(data_dir), state)


def _pack_meta(pack_dir):
    return _read_json(os.path.join(pack_dir, "pack.json"))


def _roles_path(pack_dir):
    return os.path.join(pack_dir, "roles.json")


def _roles_root(pack_dir):
    return os.path.join(pack_dir, "roles")


def _safe_role_id(value):
    role_id = str(value or "").strip().lower()
    if not _ROLE_ID_RE.fullmatch(role_id):
        raise TTSException("角色标识只能使用小写字母、数字、- 和 _")
    return role_id


def _read_reference_language(path, default="中文"):
    """Read a modern value or a legacy file containing comments plus a number."""
    raw = _read_text_file(path)
    if raw in LANGUAGE_NUMBER_MAP:
        return LANGUAGE_NUMBER_MAP[raw]
    if raw in LANGUAGE_NUMBER_MAP.values():
        return raw
    numbers = re.findall(r"(?m)^\s*(1[01]|[1-9])\s*$", raw)
    return LANGUAGE_NUMBER_MAP.get(numbers[-1], default) if numbers else default


def _role_status(role, pack_dir=None, staged_dir=None):
    missing = []
    # Uploads always use these canonical names.  Treat a hand-edited or stale
    # manifest as incomplete instead of following an arbitrary filename.
    if role.get("gpt_file") != "gpt.ckpt": missing.append("GPT 模型")
    if role.get("sovits_file") != "sovits.pth": missing.append("SoVITS 模型")
    audio_file = str(role.get("audio_file") or "")
    # ``startswith('reference')`` is not sufficient here: a hand-edited
    # manifest such as ``reference/../../other.wav`` would still pass it and
    # break the role-directory boundary.  Only the exact canonical names
    # produced by upload_role_file are valid.
    if audio_file not in {"reference" + suffix for suffix in _ROLE_FILE_KINDS["audio"][1]}:
        missing.append("参考音频")
    if not str(role.get("reference_text") or "").strip(): missing.append("参考文本")
    if role.get("reference_language") not in LANGUAGE_NUMBER_MAP.values(): missing.append("参考语言")
    if not role.get("live2d_model_id"): missing.append("Live2D 模型")
    if pack_dir and not missing:
        folder = _role_folder(pack_dir, role)
        required = {
            "GPT 模型": role.get("gpt_file"),
            "SoVITS 模型": role.get("sovits_file"),
            "参考音频": role.get("audio_file"),
        }
        for label, name in required.items():
            staged = os.path.join(staged_dir, str(name)) if staged_dir else ""
            if not ((staged and os.path.isfile(staged)) or os.path.isfile(os.path.join(folder, str(name)))):
                missing.append(label)
    return missing


def _public_role(role, pack_dir=None):
    item = dict(role)
    item.pop("folder", None)
    item["missing"] = _role_status(item, pack_dir)
    item["complete"] = not item["missing"]
    return item


def _copy_if_present(source, target):
    if source and os.path.isfile(source) and not os.path.exists(target):
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(source, target)
        return True
    return False


def _canonical_role_folder(role_id):
    return os.path.join("roles", _safe_role_id(role_id))


def _role_folder(pack_dir, role):
    """Return the only allowed on-disk directory for a role.

    ``folder`` remains in old manifests for migration compatibility, but is
    deliberately not trusted when resolving assets.  This prevents a stale or
    edited manifest from making one role consume another role's files.
    """
    return os.path.join(pack_dir, _canonical_role_folder(role.get("role_id")))


def _role_stage_root(pack_dir, role_id):
    return os.path.join(pack_dir, _canonical_role_folder(role_id), ".staging")


def _safe_stage_id(value):
    batch_id = str(value or "").strip().lower()
    if not _ROLE_STAGE_ID_RE.fullmatch(batch_id):
        raise TTSException("角色更新批次无效")
    return batch_id


def _role_stage_dir(pack_dir, role_id, batch_id):
    return os.path.join(_role_stage_root(pack_dir, _safe_role_id(role_id)), _safe_stage_id(batch_id))


def _staged_asset_fields(stage_dir):
    """Return the exact role-manifest fields supplied by one staged update."""
    fields = {}
    if os.path.isfile(os.path.join(stage_dir, "gpt.ckpt")):
        fields["gpt_file"] = "gpt.ckpt"
    if os.path.isfile(os.path.join(stage_dir, "sovits.pth")):
        fields["sovits_file"] = "sovits.pth"
    if os.path.isfile(os.path.join(stage_dir, "ref.index")):
        fields["index_file"] = "ref.index"
    for suffix in _ROLE_FILE_KINDS["audio"][1]:
        name = "reference" + suffix
        if os.path.isfile(os.path.join(stage_dir, name)):
            fields["audio_file"] = name
            break
    return fields


def ensure_role_library(pack_dir):
    """Create the explicit role registry and migrate the old shared folder once.

    The original files are copied, never moved, so a failed/interrupted migration
    leaves the old resource pack usable.
    """
    with _ROLE_LIBRARY_LOCK:
        existing = _read_json(_roles_path(pack_dir))
        if isinstance(existing, dict) and isinstance(existing.get("roles"), list):
            return existing
        with _role_write_guard(pack_dir):
            # Another local process may have completed migration while this one
            # waited for the write guard.
            existing = _read_json(_roles_path(pack_dir))
            if isinstance(existing, dict) and isinstance(existing.get("roles"), list):
                return existing
            legacy = os.path.join(pack_dir, "reference_audio", "sakiko")
            root = _roles_root(pack_dir)
            sakiko_dir, anon_dir = os.path.join(root, "sakiko"), os.path.join(root, "anon")
            os.makedirs(sakiko_dir, exist_ok=True)
            os.makedirs(anon_dir, exist_ok=True)
            # Original named D_sakiko assets belong to Sakiko.  Canonical gpt/sovits are
            # previous uploads and are intentionally isolated as the Anon draft.
            _copy_if_present(os.path.join(legacy, "GPT-SoVITS_models", "sakiko_v2pp-e15.ckpt"), os.path.join(sakiko_dir, "gpt.ckpt"))
            _copy_if_present(os.path.join(legacy, "GPT-SoVITS_models", "sakiko_v2pp_e8_s520.pth"), os.path.join(sakiko_dir, "sovits.pth"))
            _copy_if_present(os.path.join(legacy, "black_sakiko.wav"), os.path.join(sakiko_dir, "reference.wav"))
            sakiko_text = _read_text_file(os.path.join(legacy, "reference_text_black_sakiko.txt"))
            _copy_if_present(os.path.join(legacy, "GPT-SoVITS_models", "gpt.ckpt"), os.path.join(anon_dir, "gpt.ckpt"))
            _copy_if_present(os.path.join(legacy, "GPT-SoVITS_models", "sovits.pth"), os.path.join(anon_dir, "sovits.pth"))
            roles = [
                {"role_id": "sakiko", "name": "丰川祥子", "folder": "roles/sakiko", "gpt_file": "gpt.ckpt",
                 "sovits_file": "sovits.pth", "audio_file": "reference.wav", "index_file": "",
                 "reference_text": sakiko_text, "reference_language": "日文", "live2d_model_id": "",
                 "persona": _default_role_persona("丰川祥子")},
                {"role_id": "anon", "name": "千早爱音", "folder": "roles/anon", "gpt_file": "gpt.ckpt",
                 "sovits_file": "sovits.pth", "audio_file": "", "index_file": "",
                 "reference_text": "", "reference_language": "", "live2d_model_id": "",
                 "persona": _default_role_persona("千早爱音")},
            ]
            state = {"version": 1, "active_role_id": "", "roles": roles}
            _write_json(_roles_path(pack_dir), state)
            return state


def _role_write_operation(operation):
    """Apply one role mutation under both process-local and file locking."""
    @wraps(operation)
    def wrapped(pack_dir, *args, **kwargs):
        # Complete a one-time migration before taking the operation guard; the
        # migration path has its own guard and lock files are not re-entrant.
        ensure_role_library(pack_dir)
        with _role_write_guard(pack_dir):
            return operation(pack_dir, *args, **kwargs)
    return wrapped


def list_roles(pack_dir):
    with _ROLE_LIBRARY_LOCK:
        state = ensure_role_library(pack_dir)
        active = str(state.get("active_role_id") or "")
        return {"active_role_id": active, "roles": [_public_role(role, pack_dir) for role in state.get("roles") or []]}


def _write_roles(pack_dir, state):
    if not _write_json(_roles_path(pack_dir), state):
        raise TTSException("无法保存角色配置")


def _find_role(state, role_id):
    key = _safe_role_id(role_id)
    role = next((item for item in state.get("roles") or [] if item.get("role_id") == key), None)
    if not role:
        raise TTSException("未找到角色: %s" % key)
    return role


def get_role(pack_dir, role_id, *, require_complete=False):
    """Read a declared role without ever resolving legacy pack.json voices."""
    with _ROLE_LIBRARY_LOCK:
        role = _find_role(ensure_role_library(pack_dir), role_id)
        missing = _role_status(role, pack_dir)
        if require_complete and missing:
            raise TTSException("角色资料未配齐: " + "、".join(missing))
        return _public_role(role, pack_dir)


def roles_referencing_live2d(pack_dir, model_id):
    """Return role metadata bound to a Live2D model without triggering migration.

    This is used before deleting a model.  A missing registry is equivalent to
    no role references; it must not create a new draft library as a side effect.
    """
    key = str(model_id or "").strip()
    if not key:
        return []
    with _ROLE_LIBRARY_LOCK:
        path = _roles_path(pack_dir)
        if not os.path.exists(path):
            return []
        state = _read_json(path)
        if not isinstance(state, dict) or not isinstance(state.get("roles"), list):
            # Deletion must fail closed.  An unreadable manifest cannot prove a
            # model is unused, and deleting it would invalidate an unknown role.
            raise TTSException("角色配置损坏，无法确认 Live2D 模型是否仍被绑定")
        roles = state["roles"]
        return [
            {"role_id": str(role.get("role_id") or ""), "name": str(role.get("name") or role.get("role_id") or "")}
            for role in roles
            if isinstance(role, dict) and str(role.get("live2d_model_id") or "") == key
        ]


def role_library_snapshot(pack_dir):
    """Internal API transaction snapshot for coordinated Live2D changes."""
    with _ROLE_LIBRARY_LOCK:
        return copy.deepcopy(ensure_role_library(pack_dir))


@_role_write_operation
def restore_role_library(pack_dir, snapshot):
    """Restore a previously captured registry after a paired service failed."""
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("roles"), list):
        raise TTSException("角色配置回滚数据无效")
    with _ROLE_LIBRARY_LOCK:
        _reset_manager()
        _write_roles(pack_dir, copy.deepcopy(snapshot))


def _candidate_role(pack_dir, state, data, *, staged_dir=None, check_active=True):
    """Validate metadata changes without writing them to the registry."""
    role_id = _safe_role_id(data.get("role_id"))
    name = str(data.get("name") or "").strip()
    if not name or len(name) > 64:
        raise TTSException("角色名称不能为空且不能超过 64 个字符")
    existing = next((item for item in state.get("roles") or [] if item.get("role_id") == role_id), None)
    candidate = dict(existing or {
        "role_id": role_id, "folder": _canonical_role_folder(role_id),
        "gpt_file": "", "sovits_file": "", "audio_file": "", "index_file": "", "persona": {},
    })
    # The folder is not user-configurable.  This preserves the role package
    # invariant even for manifests created by older app versions.
    candidate["folder"] = _canonical_role_folder(role_id)
    candidate.update({"name": name, "reference_text": str(data.get("reference_text") or "").strip(),
                      "reference_language": str(data.get("reference_language") or "").strip(),
                      "live2d_model_id": str(data.get("live2d_model_id") or "").strip()})
    if "persona" in data:
        candidate["persona"] = _normalize_persona(data.get("persona"), name)
    elif existing is None:
        candidate["persona"] = _default_role_persona(name)
    elif not isinstance(candidate.get("persona"), dict):
        # Existing pre-v0.77 manifests are migrated by the frontend using the
        # browser's old character-id overrides.  Keep an explicit empty marker
        # until that lossless migration can write the role-local value.
        candidate["persona"] = {}
    if check_active and state.get("active_role_id") == role_id:
        missing = _role_status(candidate, pack_dir, staged_dir)
        if missing:
            raise TTSException("当前已启用角色不能保存为未完成状态: " + "、".join(missing))
    return existing, candidate


def preview_role_save(pack_dir, data):
    """Validate a role edit before another service changes its own binding."""
    with _ROLE_LIBRARY_LOCK:
        _, candidate = _candidate_role(pack_dir, ensure_role_library(pack_dir), data)
        return _public_role(candidate, pack_dir)


@_role_write_operation
def save_role(pack_dir, data, *, after_commit=None):
    """Persist role metadata, optionally pairing an active-role side effect.

    ``after_commit`` is deliberately executed while the role write lock is
    still held.  The local API uses it to move the corresponding Live2D
    preference in the same logical transaction, so two rapid role changes
    cannot leave the TTS manifest and renderer pointing at different roles.
    """
    with _ROLE_LIBRARY_LOCK:
        state = ensure_role_library(pack_dir)
        before = copy.deepcopy(state)
        existing, candidate = _candidate_role(pack_dir, state, data)
        is_active = state.get("active_role_id") == candidate["role_id"]
        if is_active:
            # Stop the old worker before its manifest changes.  A request that
            # starts after this lock is released must construct a worker for the
            # new role data rather than reuse cached model weights.
            _reset_manager()
        if existing is None:
            state["roles"].append(candidate)
            role = candidate
        else:
            existing.clear()
            existing.update(candidate)
            role = existing
        _write_roles(pack_dir, state)
        public = _public_role(role, pack_dir)
        if after_commit:
            try:
                after_commit(public)
            except Exception:
                _write_roles(pack_dir, before)
                _reset_manager()
                raise
    return public


@_role_write_operation
def update_role_persona(pack_dir, role_id, persona):
    """Persist one role's companion persona without touching TTS assets."""
    with _ROLE_LIBRARY_LOCK:
        state = ensure_role_library(pack_dir)
        role = _find_role(state, role_id)
        role["persona"] = _normalize_persona(persona, role.get("name"))
        _write_roles(pack_dir, state)
        return _public_role(role, pack_dir)


@_role_write_operation
def upload_role_file(pack_dir, role_id, kind, filename, data):
    with _ROLE_LIBRARY_LOCK:
        state = ensure_role_library(pack_dir)
        role = _find_role(state, role_id)
        kind = str(kind or "").lower()
        if kind not in _ROLE_FILE_KINDS or not data:
            raise TTSException("不支持的角色文件类型或文件为空")
        target_name, suffixes = _ROLE_FILE_KINDS[kind]
        suffix = os.path.splitext(str(filename or ""))[1].lower()
        if suffix not in suffixes:
            raise TTSException("文件扩展名与类型不匹配")
        if kind == "audio": target_name += suffix
        folder = _role_folder(pack_dir, role)
        if state.get("active_role_id") == role["role_id"]:
            _reset_manager()
        os.makedirs(folder, exist_ok=True)
        target = os.path.join(folder, target_name)
        temp = target + ".tmp"
        with open(temp, "wb") as out:
            out.write(data)
            out.flush()
        os.replace(temp, target)
        role[{"ckpt": "gpt_file", "pth": "sovits_file", "index": "index_file", "audio": "audio_file"}[kind]] = target_name
        role["folder"] = _canonical_role_folder(role["role_id"])
        _write_roles(pack_dir, state)
    return _public_role(role, pack_dir)


@_role_write_operation
def begin_role_update(pack_dir, role_id):
    """Open a private staging area for an atomic active-role update."""
    with _ROLE_LIBRARY_LOCK:
        state = ensure_role_library(pack_dir)
        role = _find_role(state, role_id)
        batch_id = uuid.uuid4().hex
        stage_dir = _role_stage_dir(pack_dir, role["role_id"], batch_id)
        os.makedirs(stage_dir, exist_ok=False)
        return batch_id


@_role_write_operation
def stage_role_file(pack_dir, role_id, batch_id, kind, filename, data):
    """Store one proposed asset without touching the live role package."""
    with _ROLE_LIBRARY_LOCK:
        state = ensure_role_library(pack_dir)
        role = _find_role(state, role_id)
        stage_dir = _role_stage_dir(pack_dir, role["role_id"], batch_id)
        if not os.path.isdir(stage_dir):
            raise TTSException("角色更新批次不存在或已结束")
        kind = str(kind or "").lower()
        if kind not in _ROLE_FILE_KINDS or not data:
            raise TTSException("不支持的角色文件类型或文件为空")
        target_name, suffixes = _ROLE_FILE_KINDS[kind]
        suffix = os.path.splitext(str(filename or ""))[1].lower()
        if suffix not in suffixes:
            raise TTSException("文件扩展名与类型不匹配")
        if kind == "audio":
            # A staged package has exactly one reference track.  This makes an
            # audio re-selection within one editor save deterministic.
            for old_suffix in _ROLE_FILE_KINDS["audio"][1]:
                old = os.path.join(stage_dir, "reference" + old_suffix)
                if os.path.isfile(old):
                    os.unlink(old)
            target_name += suffix
        target = os.path.join(stage_dir, target_name)
        temp = target + ".tmp"
        with open(temp, "wb") as out:
            out.write(data)
            out.flush()
        os.replace(temp, target)
        return {"batch_id": _safe_stage_id(batch_id), "kind": kind, "file": target_name}


@_role_write_operation
def discard_role_update(pack_dir, role_id, batch_id):
    """Remove an uncommitted private staging area after a failed UI save."""
    with _ROLE_LIBRARY_LOCK:
        state = ensure_role_library(pack_dir)
        role = _find_role(state, role_id)
        stage_dir = _role_stage_dir(pack_dir, role["role_id"], batch_id)
        if os.path.isdir(stage_dir):
            shutil.rmtree(stage_dir)
        return True


def _restore_staged_assets(stage_dir, applied, backups):
    """Undo a partly applied staged update and retain files for retry."""
    restored = set()
    for target in reversed(applied):
        try:
            if os.path.isfile(target):
                os.replace(target, os.path.join(stage_dir, os.path.basename(target)))
        except OSError:
            pass
        backup = backups.get(target)
        if backup and os.path.isfile(backup):
            try:
                os.replace(backup, target)
                restored.add(target)
            except OSError:
                pass
    # A replace can fail after the old canonical file has already been moved
    # into ``.rollback`` but before the new staged file was recorded in
    # ``applied``.  Restore those untouched backups too; otherwise a failed
    # transaction can leave roles.json pointing at a vanished old asset.
    for target, backup in backups.items():
        if target in restored or not os.path.isfile(backup):
            continue
        try:
            if not os.path.isfile(target):
                os.replace(backup, target)
        except OSError:
            pass


def _apply_staged_assets(folder, stage_dir, fields):
    """Atomically swap staged canonical files into a role folder.

    Replacing each file is an OS-level atomic rename; old files are retained in
    the stage directory until the manifest and paired Live2D update succeed.
    """
    backup_dir = os.path.join(stage_dir, ".rollback")
    os.makedirs(backup_dir, exist_ok=True)
    applied, backups = [], {}
    try:
        for field in ("gpt_file", "sovits_file", "index_file", "audio_file"):
            name = fields.get(field)
            if not name:
                continue
            staged = os.path.join(stage_dir, name)
            target = os.path.join(folder, name)
            if not os.path.isfile(staged):
                continue
            backup = os.path.join(backup_dir, name)
            if os.path.isfile(target):
                os.replace(target, backup)
                backups[target] = backup
            os.replace(staged, target)
            applied.append(target)
        return applied, backups
    except Exception:
        _restore_staged_assets(stage_dir, applied, backups)
        raise


@_role_write_operation
def commit_role_update(pack_dir, role_id, batch_id, data, *, after_commit=None):
    """Commit staged role assets, metadata, and an optional paired callback.

    The callback is used by the HTTP layer to update the matching Live2D
    preference.  A callback failure rolls back both the manifest and every
    asset rename, so an active role never persists a half-new package.
    """
    with _ROLE_LIBRARY_LOCK:
        state = ensure_role_library(pack_dir)
        role = _find_role(state, role_id)
        batch_id = _safe_stage_id(batch_id)
        stage_dir = _role_stage_dir(pack_dir, role["role_id"], batch_id)
        if not os.path.isdir(stage_dir):
            raise TTSException("角色更新批次不存在或已结束")
        if _safe_role_id(data.get("role_id")) != role["role_id"]:
            raise TTSException("角色更新目标不一致")
        existing, candidate = _candidate_role(pack_dir, state, data, check_active=False)
        staged_fields = _staged_asset_fields(stage_dir)
        candidate.update(staged_fields)
        candidate["folder"] = _canonical_role_folder(candidate["role_id"])
        is_active = state.get("active_role_id") == candidate["role_id"]
        if is_active:
            missing = _role_status(candidate, pack_dir, stage_dir)
            if missing:
                raise TTSException("当前已启用角色不能保存为未完成状态: " + "、".join(missing))
            # Reset under the role lock before exposing the new manifest, so
            # later requests cannot reuse the old model cache with new files.
            _reset_manager()
        before = copy.deepcopy(state)
        folder = _role_folder(pack_dir, candidate)
        os.makedirs(folder, exist_ok=True)
        applied, backups = _apply_staged_assets(folder, stage_dir, staged_fields)
        try:
            if existing is None:
                state["roles"].append(candidate)
                committed = candidate
            else:
                existing.clear()
                existing.update(candidate)
                committed = existing
            _write_roles(pack_dir, state)
            public = _public_role(committed, pack_dir)
            if after_commit:
                after_commit(public)
        except Exception:
            try:
                _write_roles(pack_dir, before)
            finally:
                _restore_staged_assets(stage_dir, applied, backups)
            raise
        try:
            shutil.rmtree(stage_dir, ignore_errors=True)
        except OSError:
            pass
        return public


@_role_write_operation
def delete_role(pack_dir, role_id):
    with _ROLE_LIBRARY_LOCK:
        state = ensure_role_library(pack_dir)
        role = _find_role(state, role_id)
        if state.get("active_role_id") == role["role_id"]:
            raise TTSException("不能删除当前已启用角色；请先启用另一位资料完整的角色")
        if role.get("role_id") == "sakiko":
            raise TTSException("默认迁移角色不可删除")
        state["roles"].remove(role)
        _write_roles(pack_dir, state)
    _reset_manager()
    return True


@_role_write_operation
def activate_role(pack_dir, role_id, *, after_commit=None):
    """Activate a complete role and pair any dependent state atomically."""
    with _ROLE_LIBRARY_LOCK:
        state = ensure_role_library(pack_dir)
        before = copy.deepcopy(state)
        role = _find_role(state, role_id)
        missing = _role_status(role, pack_dir)
        if missing:
            raise TTSException("角色资料未配齐: " + "、".join(missing))
        # Ensure the manifest's exact paths exist before committing the active
        # role.  A role with a stale manifest must never become the fallback.
        _resolve_role(pack_dir, role["role_id"])
        _reset_manager()
        state["active_role_id"] = role["role_id"]
        _write_roles(pack_dir, state)
        public = _public_role(role, pack_dir)
        if after_commit:
            try:
                after_commit(public)
            except Exception:
                _write_roles(pack_dir, before)
                _reset_manager()
                raise
    return public


def _install_meta(pack_dir):
    return _read_json(os.path.join(pack_dir, "install.json"))


def _venv_python(pack_dir):
    # 仅支持 Windows（Linux 支持已归档到 codex/linux-archived，不再维护）
    return os.path.join(pack_dir, ".venv311", "Scripts", "python.exe")


def _engine_dependency_status(pack_dir, *, force=False):
    """Return ``(ready, reason, missing_modules)`` for the worker runtime.

    A resource pack used to declare itself installed as soon as setup wrote
    install.json.  That misses interrupted uv/pip installs (and specifically
    a missing Japanese ``pyopenjtalk`` module), which then only surfaces after
    a user touches the character.  Probe imports in the pack's own interpreter
    and cache briefly so normal status refreshes remain inexpensive.
    """
    pack_dir = os.path.abspath(pack_dir)
    python_exe = os.path.abspath(_venv_python(pack_dir))
    try:
        stamp = os.path.getmtime(python_exe)
    except OSError:
        stamp = None
    key = os.path.abspath(pack_dir)
    now = time.monotonic()
    with _ENGINE_PROBE_LOCK:
        cached = _ENGINE_PROBE_CACHE.get(key)
        if (not force and cached and cached.get("stamp") == stamp and
                now - cached.get("checked_at", 0) < _ENGINE_PROBE_TTL):
            return cached["ready"], cached["reason"], list(cached["missing"])

    imports_json = json.dumps(list(_ENGINE_IMPORT_PACKAGES), ensure_ascii=True)
    probe = (
        "import importlib,json\n"
        "missing=[]\n"
        "for name in " + imports_json + ":\n"
        "    try:\n"
        "        importlib.import_module(name)\n"
        "    except Exception as exc:\n"
        "        missing.append([name, str(exc)])\n"
        "print('__MEMO_TTS_PROBE__'+json.dumps(missing, ensure_ascii=True))\n"
    )
    missing, detail = [], ""
    try:
        completed = subprocess.run(
            [python_exe, "-c", probe], cwd=pack_dir, text=True,
            encoding="utf-8", errors="replace", stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=25,
        )
        output = (completed.stdout or "") + "\n" + (completed.stderr or "")
        marker = "__MEMO_TTS_PROBE__"
        line = next((item for item in reversed(output.splitlines()) if marker in item), "")
        if line:
            try:
                decoded = json.loads(line.split(marker, 1)[1])
                missing = [str(item[0]) for item in decoded if isinstance(item, list) and item]
                detail = "; ".join(
                    "%s: %s" % (str(item[0]), str(item[1]))
                    for item in decoded if isinstance(item, list) and len(item) > 1
                )
            except (TypeError, ValueError):
                detail = "依赖检查返回了无法解析的结果"
        elif completed.returncode:
            detail = (completed.stderr or completed.stdout or "Python 依赖检查失败").strip()[-500:]
        else:
            detail = "依赖检查没有返回结果"
    except subprocess.TimeoutExpired:
        detail = "语音环境依赖检查超时"
    except OSError as exc:
        detail = "无法启动语音环境检查：%s" % exc

    ready = not missing and not detail
    if not ready:
        labels = "、".join(missing) if missing else "运行时"
        reason = "语音环境缺少或无法加载依赖（%s）；请点击“修复语音环境”" % labels
        if detail:
            reason += "。" + detail[:320]
    else:
        reason = ""
    with _ENGINE_PROBE_LOCK:
        _ENGINE_PROBE_CACHE[key] = {
            "stamp": stamp, "checked_at": now, "ready": ready,
            "reason": reason, "missing": list(missing),
        }
    return ready, reason, missing


def repair_environment(pack_dir, data_dir):
    """Repair missing worker packages in place and verify them afterwards.

    This intentionally installs into *the resource pack's* venv.  It never
    touches the application's Python environment or model/reference files.
    """
    if not _ENGINE_REPAIR_LOCK.acquire(blocking=False):
        raise TTSException("语音环境正在修复，请等待当前任务结束")
    try:
        pack_dir = os.path.abspath(pack_dir)
        data_dir = os.path.abspath(data_dir)
        python_exe = os.path.abspath(_venv_python(pack_dir))
        if not os.path.exists(python_exe):
            raise TTSException("未找到 .venv311 解释器，请先运行资源包 setup.bat")
        if not os.path.exists(os.path.join(pack_dir, "tts_engine", "worker_main.py")):
            raise TTSException("资源包缺少 tts_engine/worker_main.py")
        _ready, _reason, missing = _engine_dependency_status(pack_dir, force=True)
        if _ready:
            return {"ok": True, "message": "语音环境已完整，无需修复", "installed": []}
        _assert_role_write_allowed(pack_dir)
        _reset_manager()
        state = _load_state(data_dir)
        # Do not leave a previously working companion silently disabled after
        # a successful in-place repair.  It is temporarily stopped while its
        # interpreter changes, then restored to the user's prior choice only
        # after the subprocess probe proves the runtime is usable again.
        was_enabled = bool(state.get("enabled"))
        state["enabled"] = False
        _save_state(data_dir, state)
        packages = [
            _ENGINE_IMPORT_PACKAGES[name] for name in missing
            if name in _ENGINE_IMPORT_PACKAGES
        ]
        # ``pyopenjtalk`` is the known Japanese runtime requirement and must
        # use its prebuilt Windows-compatible distribution even if an import
        # probe was interrupted before it could list the module.
        japanese_package = _ENGINE_IMPORT_PACKAGES["pyopenjtalk"]
        if japanese_package not in packages:
            packages.append(japanese_package)
        if not packages:
            raise TTSException("未能识别需要修复的语音依赖：" + (_reason or "请重新运行资源包 setup.bat"))

        uv = shutil.which("uv")
        if uv:
            command = [uv, "pip", "install", "--python", python_exe, *packages]
        else:
            bootstrap = subprocess.run(
                [python_exe, "-m", "ensurepip", "--upgrade"], cwd=pack_dir,
                text=True, encoding="utf-8", errors="replace",
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180,
            )
            if bootstrap.returncode:
                raise TTSException("无法准备资源包 pip：" + (bootstrap.stdout or "")[-500:])
            command = [python_exe, "-m", "pip", "install", "--disable-pip-version-check", *packages]
        try:
            installed = subprocess.run(
                command, cwd=pack_dir, text=True, encoding="utf-8", errors="replace",
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=900,
            )
        except subprocess.TimeoutExpired:
            raise TTSException("语音环境修复超时，请检查网络后重试")
        if installed.returncode:
            raise TTSException("语音环境修复失败：" + (installed.stdout or "")[-900:])
        ready, reason, still_missing = _engine_dependency_status(pack_dir, force=True)
        if not ready:
            raise TTSException("修复后语音环境仍不可用：" + (reason or "、".join(still_missing)))
        state["enabled"] = was_enabled
        _save_state(data_dir, state)
        return {
            "ok": True,
            "message": "语音环境已修复" + ("，已恢复此前的语音开关。" if was_enabled else "。"),
            "installed": packages,
            "enabled": was_enabled,
        }
    finally:
        _ENGINE_REPAIR_LOCK.release()


def _write_install_meta(pack_dir, source="ModelScope"):
    """重建 install.json（与 setup.ps1 写入的内容保持一致）。"""
    pack = _pack_meta(pack_dir) or {}
    # 仅支持 Windows（Linux 支持已归档到 codex/linux-archived，不再维护）
    ffmpeg_name = "ffmpeg.exe"
    ffmpeg_exe = os.path.join(pack_dir, "ffmpeg", "bin", ffmpeg_name)
    data = {
        "installed": True,
        "version": pack.get("version") or "1.0.0",
        "source": source,
        "installed_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "ffmpeg_dir": os.path.join(pack_dir, "ffmpeg", "bin") if os.path.exists(ffmpeg_exe) else "",
    }
    return _write_json(os.path.join(pack_dir, "install.json"), data)


def _engine_ready(pack_dir):
    """Validate install metadata, worker files, and imports before synthesis.

    install.json 只是安装完成标记；若它丢失但环境实际完整
    （venv 解释器与 worker 均存在），自动重建标记，避免用户误以为功能损坏。
    """
    meta = _install_meta(pack_dir)
    if not meta or not meta.get("installed"):
        if (os.path.exists(_venv_python(pack_dir))
                and os.path.exists(os.path.join(pack_dir, "tts_engine", "worker_main.py"))):
            _write_install_meta(pack_dir)
            meta = _install_meta(pack_dir)
        else:
            return False, "资源包尚未安装，请先运行安装脚本（Windows: setup.bat）完成安装"
    if not os.path.exists(_venv_python(pack_dir)):
        return False, "未找到 .venv311 解释器，请重新运行安装脚本（Windows: setup.bat）"
    if not os.path.exists(os.path.join(pack_dir, "tts_engine", "worker_main.py")):
        return False, "资源包缺少 tts_engine/worker_main.py，资源包不完整"
    dependency_ready, dependency_reason, _missing = _engine_dependency_status(pack_dir)
    if not dependency_ready:
        return False, dependency_reason
    return True, ""


def _read_text_file(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return f.read().strip()
    except OSError:
        return ""


def _resolve_role(pack_dir, role_id=None):
    """Resolve only manifest-addressed role files; never scan a role directory."""
    state = ensure_role_library(pack_dir)
    selected = role_id or state.get("active_role_id")
    if not selected:
        raise TTSException("请先在设置中启用一个资料完整的角色")
    role = _find_role(state, selected)
    missing = _role_status(role)
    if missing:
        raise TTSException("角色资料未配齐: " + "、".join(missing))
    folder = _role_folder(pack_dir, role)
    paths = {
        "gpt_model_path": os.path.join(folder, role["gpt_file"]),
        "sovits_model_path": os.path.join(folder, role["sovits_file"]),
        "ref_audio_path": os.path.join(folder, role["audio_file"]),
    }
    if not all(os.path.isfile(path) for path in paths.values()):
        raise TTSException("角色资料文件缺失，请重新上传")
    return {"name": role["role_id"], "folder": _canonical_role_folder(role["role_id"]), **paths,
            "prompt_text": role["reference_text"], "ref_language": role["reference_language"]}


def clean_text(text):
    """清洗待合成文本：去括号/引号，空文本抛错。"""
    cleaned = re.sub(r"[（(].*?[)）]", "", str(text))
    cleaned = cleaned.replace("「", "").replace("」", "")
    cleaned = re.sub(r"[\[\]【】]", "", cleaned)
    cleaned = cleaned.strip()
    cleaned = re.sub(r"^[^A-Za-z0-9\u3040-\u30FF\u4E00-\u9FFF]+", "", cleaned)
    # 保留英文单词之间的边界；直接删除空格会把 "hello world" 合并成
    # "helloworld"，导致英文和中英混合朗读明显错误。
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    cleaned = cleaned.replace("...", "，")
    if not cleaned or re.fullmatch(r"[\W_]+", cleaned):
        raise TTSException("文本为空或无法合成语音")
    return cleaned


def import_model_file(pack_dir, voice_name, kind, data):
    """Compatibility sentinel for callers from pre-role-package releases.

    The old endpoint wrote directly into an arbitrary ``pack.json`` voice
    folder, which could silently pair a new model with another role's audio.
    Keep a callable name for extension compatibility, but perform no write.
    """
    raise TTSException("旧模型上传入口已移除；请通过角色资料上传 GPT、SoVITS 或 index 文件")


class TTSManager:
    """管理 GPT-SoVITS worker 子进程（JSON 行协议）。"""

    def __init__(self, pack_dir, data_dir):
        self.pack_dir = pack_dir
        self.data_dir = data_dir
        self._lock_file, self._pack_locked = _acquire_pack_lock(pack_dir)
        self._proc = None
        self._pending = {}
        self._pending_lock = threading.Lock()
        self._cmd_lock = threading.RLock()
        self._reader = None
        self._busy = False
        self._last_status = {}

    def _check_pack_lock(self):
        # _pack_locked=True 表示本实例已持有锁，只有未持锁（被其它实例占用）才报错
        if not self._pack_locked:
            raise TTSException("语音资源包正被另一个实例使用，请先关闭其它 Memo Superform 实例")

    @property
    def is_busy(self):
        return self._busy

    # ---------- 进程生命周期 ----------

    def _worker_paths(self):
        venv_py = _venv_python(self.pack_dir)
        worker_main = os.path.join(self.pack_dir, "tts_engine", "worker_main.py")
        return venv_py, worker_main

    def _spawn(self):
        venv_py, worker_main = self._worker_paths()
        if not os.path.exists(venv_py):
            raise TTSException("未找到 .venv311 解释器，请重新运行安装脚本（Windows: setup.bat）")
        if not os.path.exists(worker_main):
            raise TTSException("资源包缺少 tts_engine/worker_main.py")

        # 便携包：若包内自带 CPython 运行时，就把 venv 的 home 指向它，
        # 这样整个包无论解压到哪都能找到解释器（否则 pyvenv.cfg 里是打包机器的绝对方路径）。
        bundled_py = os.path.join(self.pack_dir, "python")
        if os.path.exists(os.path.join(bundled_py, "python.exe")):
            try:
                cfg_path = os.path.join(self.pack_dir, ".venv311", "pyvenv.cfg")
                if os.path.exists(cfg_path):
                    lines = []
                    for line in open(cfg_path, "r", encoding="utf-8").read().splitlines():
                        if line.lower().startswith("home ="):
                            lines.append("home = " + bundled_py)
                        else:
                            lines.append(line)
                    with open(cfg_path, "w", encoding="utf-8") as cfg_file:
                        cfg_file.write("\n".join(lines) + "\n")
            except Exception:
                pass

        env = os.environ.copy()
        # 子进程 stdin/stdout 统一使用 UTF-8，避免中文 Windows(GBK) 环境下 JSON 乱码
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        ffmpeg_dir = os.path.join(self.pack_dir, "ffmpeg", "bin")
        if not os.path.isdir(ffmpeg_dir):
            install = _install_meta(self.pack_dir) or {}
            ffmpeg_dir = install.get("ffmpeg_dir") or ""
        if ffmpeg_dir and os.path.isdir(ffmpeg_dir):
            env["PATH"] = ffmpeg_dir + os.pathsep + env.get("PATH", "")

        log_path = os.path.join(self.data_dir, "tts_worker.log")
        log_file = open(log_path, "a", encoding="utf-8", errors="replace")
        engine_dir = os.path.join(self.pack_dir, "tts_engine")
        proc = subprocess.Popen(
            [venv_py, worker_main],
            cwd=engine_dir,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=log_file,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        self._proc = proc
        self._reader = threading.Thread(target=self._read_loop, args=(proc, log_file), daemon=True)
        self._reader.start()

    def _read_loop(self, proc, log_file):
        try:
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                request_id = str(message.get("request_id", ""))
                with self._pending_lock:
                    holder = self._pending.pop(request_id, None)
                if holder is not None:
                    holder.put(message)
        except Exception:
            pass
        finally:
            try:
                log_file.close()
            except Exception:
                pass
            # 进程意外退出：唤醒所有等待者
            with self._pending_lock:
                pending = dict(self._pending)
                self._pending.clear()
            for request_id, holder in pending.items():
                holder.put({
                    "type": "error",
                    "request_id": request_id,
                    "message": "语音引擎进程意外退出（详见 data/tts_worker.log）",
                })

    def _ensure_started(self):
        self._check_pack_lock()
        if self._proc is None or self._proc.poll() is not None:
            self._spawn()

    def _is_dead(self):
        return self._proc is None or self._proc.poll() is not None

    def _send(self, command, timeout=None):
        """发送一条命令并等待同 request_id 的结果。"""
        command = dict(command)
        command["request_id"] = command.get("request_id") or str(uuid.uuid4())
        request_id = command["request_id"]
        holder = queue.Queue()
        with self._pending_lock:
            self._pending[request_id] = holder
        try:
            self._proc.stdin.write(json.dumps(command, ensure_ascii=False) + "\n")
            self._proc.stdin.flush()
            return holder.get(timeout=timeout)
        except queue.Empty:
            raise TTSException("语音引擎响应超时")
        finally:
            with self._pending_lock:
                self._pending.pop(request_id, None)

    def _kill_process(self):
        """强杀 worker 进程并清空引用（下一次调用会重新拉起）。"""
        if self._proc is not None and self._proc.poll() is None:
            try:
                self._proc.kill()
            except Exception:
                pass
            try:
                self._proc.wait(timeout=5)
            except Exception:
                pass
        self._proc = None

    def _call(self, command, timeout=None):
        """带一次自动重启的调用。"""
        with self._cmd_lock:
            self._ensure_started()
            try:
                return self._send(command, timeout=timeout)
            except TTSException as exc:
                # 命令超时：worker 可能卡死，强杀并重置，避免后续命令继续排队挂起
                self._kill_process()
                raise TTSException("%s（已重置语音引擎，请重试）" % exc)
            except Exception as exc:
                # 进程崩溃等情况：重启一次再试
                try:
                    self._shutdown_process(release_lock=False)
                except Exception:
                    pass
                self._ensure_started()
                return self._send(command, timeout=timeout)

    def _shutdown_process(self, release_lock=True):
        proc = self._proc
        self._proc = None
        try:
            if proc is not None:
                # poll() 在进程句柄失效时（如解释器退出期间）可能抛 OSError[Errno 22]，整体兜底
                if proc.poll() is None:
                    try:
                        proc.stdin.write(json.dumps({"type": "shutdown"}) + "\n")
                        proc.stdin.flush()
                        proc.wait(timeout=15)
                    except Exception:
                        try:
                            proc.kill()
                        except Exception:
                            pass
        except Exception:
            if proc is not None:
                try:
                    proc.kill()
                except Exception:
                    pass
        finally:
            # A full shutdown releases the resource-pack lock.  The internal
            # restart path deliberately keeps it, otherwise the same manager
            # would mistake its own released lock for another app instance.
            if release_lock:
                _release_pack_lock(self._lock_file)
                self._lock_file = None
                self._pack_locked = False

    # ---------- 对外操作 ----------

    def synthesize(self, text, voice_name, language="中文", speed=1.0, *,
                   top_k=15, fragment_interval=0.5, text_split_method="cut0",
                   seed=-1, use_cuda_graph=False, parallel_infer=False):
        voice = self._resolve_voice_config(voice_name)
        payload = {
            "text": text,
            "text_language": language,
            "ref_audio_path": voice["ref_audio_path"],
            "prompt_text": voice["prompt_text"],
            "ref_language": voice["ref_language"],
            "output_dir": os.path.join(self.data_dir, "generated_audios"),
            "speed_factor": float(speed),
            "fragment_interval": _coerce_num(fragment_interval, 0.5, low=0.0, high=5.0),
            "text_split_method": _coerce_split_method(text_split_method),
            "top_k": int(_coerce_num(top_k, 15, low=1, high=100)),
            "seed": int(_coerce_num(seed, -1)),
            "use_cuda_graph": _coerce_bool(use_cuda_graph, False),
            "parallel_infer": _coerce_bool(parallel_infer, False),
        }
        self._busy = True
        cold_start = not bool(self._last_status.get("is_loaded"))
        timeout = _COLD_START_TIMEOUT if cold_start else _SYNTH_TIMEOUT
        try:
            try:
                result = self._call({
                    "type": "synthesize",
                    "character_name": voice_name,
                    "voice": voice,
                    "payload": payload,
                }, timeout=timeout)
            except TTSException as exc:
                # Preserve the worker reset performed by ``_call``, but tell
                # the user whether this was an ordinary synthesis timeout or a
                # genuinely slow/failed cold model load.
                if cold_start and "响应超时" in str(exc):
                    raise TTSException(
                        "语音引擎首次加载超过 %d 秒（已重置，请使用“预加载已启用角色模型”后重试）"
                        % int(timeout)
                    )
                raise
        finally:
            self._busy = False
        if result.get("type") == "error":
            raise TTSException(result.get("message") or "语音合成失败")
        wav_path = result.get("output_wav_path")
        if not wav_path or not os.path.exists(wav_path):
            raise TTSException("语音合成没有输出音频")
        self._last_status["is_loaded"] = True
        return wav_path

    def preload(self, voice_name):
        try:
            voice = self._resolve_voice_config(voice_name)
        except TTSException:
            raise
        self._busy = True
        try:
            result = self._call({
                "type": "load_model",
                "character_name": voice_name,
                "voice": voice,
                "payload": {},
            }, timeout=_COLD_START_TIMEOUT)
        finally:
            self._busy = False
        if result.get("type") == "error":
            raise TTSException(result.get("message") or "模型加载失败")
        self._last_status["is_loaded"] = True
        return True

    def _busy_status(self, voice):
        """合成/加载期间的状态：只读缓存，不发命令、不抢锁。"""
        return {
            "is_loaded": bool(self._last_status.get("is_loaded")),
            "device_policy": self._last_status.get("device_policy"),
            "loaded_device": self._last_status.get("loaded_device"),
            "busy": True,
            "gpt_model_path": voice.get("gpt_model_path"),
            "sovits_model_path": voice.get("sovits_model_path"),
        }

    def worker_status(self, voice_name=None):
        # Surface a competing Memo instance during status refresh.  Returning
        # a harmless-looking unloaded status here used to let the UI claim
        # voice was enabled, only for the first touch to fail on the lock.
        self._check_pack_lock()
        voice_name = voice_name or _active_role_for_request(self.pack_dir)
        try:
            voice = self._resolve_voice_config(voice_name)
        except TTSException:
            voice = {"name": voice_name, "gpt_model_path": "", "sovits_model_path": ""}
        # 合成/预加载进行中：直接返回缓存，避免阻塞在 _cmd_lock 上
        if self._busy:
            return self._busy_status(voice)
        # 空闲但锁被占用（命令刚提交、busy 标记尚未置位）：同样走缓存
        if not self._cmd_lock.acquire(blocking=False):
            return self._busy_status(voice)
        try:
            if self._is_dead():
                self._last_status = {}
                return {"is_loaded": False, "device_policy": None, "loaded_device": None,
                        "gpt_model_path": voice.get("gpt_model_path"),
                        "sovits_model_path": voice.get("sovits_model_path")}
            try:
                result = self._call(
                    {"type": "get_status", "character_name": voice_name, "voice": voice},
                    timeout=5,
                )
            except TTSException:
                # 超时/进程异常：返回上一次已知状态
                return {**self._last_status, "busy": False}
            if isinstance(result, dict):
                self._last_status = dict(result)
            return result if isinstance(result, dict) else {"is_loaded": False}
        finally:
            self._cmd_lock.release()

    def shutdown(self):
        with self._cmd_lock:
            self._shutdown_process()

    def _resolve_voice_config(self, voice_name):
        # There is exactly one resolver now: the role manifest.  In
        # particular, do not fall back to the legacy pack.json directory or
        # choose the first matching .wav/.ckpt/.pth file.
        return _resolve_role(self.pack_dir, voice_name)


_MANAGER = None
_MANAGER_LOCK = threading.Lock()


def _reset_manager():
    """Discard cached worker/model after a role asset or selection changes."""
    global _MANAGER
    with _MANAGER_LOCK:
        manager, _MANAGER = _MANAGER, None
        # Keep the lifecycle lock until the old manager has actually released
        # `.tts.lock`.  Otherwise another request can install a new manager in
        # the tiny gap, fail to acquire the old lock, and remain poisoned after
        # the shutdown finishes.
        if manager is not None:
            try:
                manager.shutdown()
            except Exception:
                pass


def _get_manager(pack_dir, data_dir):
    global _MANAGER
    with _MANAGER_LOCK:
        if (_MANAGER is not None and
                (os.path.abspath(_MANAGER.pack_dir) != os.path.abspath(pack_dir) or
                 os.path.abspath(_MANAGER.data_dir) != os.path.abspath(data_dir))):
            # Module-level manager state is shared by in-process tests and by
            # a possible data-directory switch.  Never reuse a worker or lock
            # acquired for another resource pack.
            try:
                _MANAGER.shutdown()
            except Exception:
                pass
            _MANAGER = None
        if _MANAGER is not None and not _MANAGER._pack_locked:
            # A failed acquisition is never a reusable manager.  Drop it so a
            # later request can acquire the lock after the other app exits.
            try:
                _MANAGER.shutdown()
            except Exception:
                pass
            _MANAGER = None
        if _MANAGER is None:
            _MANAGER = TTSManager(pack_dir, data_dir)
        return _MANAGER


def _manager_for_pack(pack_dir):
    """Return this process's live manager without acquiring a new pack lock."""
    with _MANAGER_LOCK:
        manager = _MANAGER
        if manager is not None and os.path.abspath(manager.pack_dir) == os.path.abspath(pack_dir):
            return manager
    return None


def _check_pack_runtime_available(pack_dir):
    """Probe another process's lock without retaining it for a status read."""
    manager = _manager_for_pack(pack_dir)
    if manager is not None:
        manager._check_pack_lock()
        return manager
    probe, acquired = _acquire_pack_lock(pack_dir)
    if not acquired:
        raise TTSException("语音资源包正被另一个 Memo Superform 实例使用，请先关闭其它 Memo Superform 实例")
    _release_pack_lock(probe)
    return None


# ---------- 供 server.py 调用的模块级接口 ----------

def _active_role_for_request(pack_dir, requested_role=None):
    """Return the only role permitted to synthesize or preload.

    ``voice`` used to select an arbitrary legacy pack.json voice.  It is now
    accepted only when it matches the current manifest's active role, so a
    stale dropdown or old client cannot revive a previous character's model.
    """
    with _ROLE_LIBRARY_LOCK:
        state = ensure_role_library(pack_dir)
        active = str(state.get("active_role_id") or "").strip()
        if not active:
            raise TTSException("请先在设置中启用一个资料完整的角色")
        requested = str(requested_role or "").strip()
        if requested and requested != active:
            raise TTSException("语音仅使用当前已启用角色；请先切换并启用所选角色")
        _resolve_role(pack_dir, active)
        return active


def _active_role_status(role_library):
    active_id = str(role_library.get("active_role_id") or "")
    active = next((role for role in role_library.get("roles") or [] if role.get("role_id") == active_id), None)
    return active_id, bool(active and active.get("complete"))

def get_status(pack_dir, data_dir):
    """状态接口的稳定出口：任何异常都不允许返回 500。"""
    try:
        return _get_status_inner(pack_dir, data_dir)
    except Exception as exc:
        pack = _pack_meta(pack_dir)
        return {
            "enabled": False,
            "pack_ready": pack is not None,
            "engine_ready": False,
            "install_error": "状态读取异常：%s" % exc,
            "version": (pack or {}).get("version"),
            "voices": [],
            "device": None,
            "loaded": False,
            "busy": False,
            "active_role_id": "",
            "role_ready": False,
            "role_error": "",
            "runtime_ready": False,
            "runtime_error": "",
        }


def _get_status_inner(pack_dir, data_dir):
    pack = _pack_meta(pack_dir)
    if pack is None:
        return {
            "enabled": False,
            "pack_ready": False,
            "engine_ready": False,
            "install_error": "未检测到语音资源包（请将资源包放到 %s 并确保包含 pack.json）" % pack_dir,
            "version": None,
            "voices": [],
            "device": None,
            "loaded": False,
            "busy": False,
            "active_role_id": "",
            "role_ready": False,
            "role_error": "",
            "runtime_ready": False,
            "runtime_error": "",
        }
    ready, reason = _engine_ready(pack_dir)
    role_library = list_roles(pack_dir)
    active_role_id, role_ready = _active_role_status(role_library)
    state = _load_state(data_dir)
    role_error = ""
    # Repair the historical state in which the global feature toggle survived
    # even though no complete role had ever been activated.  Reporting that as
    # enabled made touches appear to fail silently and could leave an old worker
    # model in memory.  Disabling is safe: the user must explicitly activate a
    # complete role before turning voice back on.
    if state.get("enabled") and not role_ready:
        state["enabled"] = False
        _save_state(data_dir, state)
        _reset_manager()
        role_error = "请先启用一位资料完整的角色，再开启语音"
    voices = [{"name": item["role_id"], "label": item["name"], "language": item.get("reference_language") or "",
               "complete": item["complete"], "missing": item["missing"]} for item in role_library["roles"]]
    worker = {}
    manager = None
    runtime_error = ""
    try:
        if ready and state.get("enabled") and role_ready:
            manager = _check_pack_runtime_available(pack_dir)
            if manager is not None:
                worker = manager.worker_status(active_role_id)
    except TTSException as exc:
        runtime_error = str(exc)
        worker = {}
    except Exception as exc:
        runtime_error = "语音运行时状态读取失败：%s" % exc
        worker = {}
    return {
        "enabled": bool(state.get("enabled")),
        "pack_ready": True,
        "engine_ready": ready,
        "install_error": "" if ready else reason,
        "version": pack.get("version"),
        "voices": voices,
        "device": worker.get("loaded_device") or worker.get("device_policy"),
        "loaded": bool(worker.get("is_loaded")),
        "busy": bool(worker.get("busy") or (manager and manager.is_busy)),
        "active_role_id": active_role_id,
        "role_ready": role_ready,
        "role_error": role_error,
        "runtime_ready": bool(ready and state.get("enabled") and role_ready and not runtime_error),
        "runtime_error": runtime_error,
        "roles": role_library["roles"],
    }


def set_enabled(pack_dir, data_dir, enabled):
    pack = _pack_meta(pack_dir)
    if pack is None:
        raise TTSException("未检测到语音资源包")
    ready, reason = _engine_ready(pack_dir)
    if enabled and not ready:
        raise TTSException(reason)
    state = _load_state(data_dir)
    if enabled:
        _active_role_for_request(pack_dir)
        # A shutdown releases the cross-process pack lock.  Discard the manager
        # before re-enabling so a stale object cannot retain an old lock flag
        # and run beside another Memo instance.
        _reset_manager()
        manager = _get_manager(pack_dir, data_dir)
        try:
            manager._check_pack_lock()
        except Exception:
            _reset_manager()
            raise
        state["enabled"] = True
        _save_state(data_dir, state)
        return state
    state["enabled"] = False
    _save_state(data_dir, state)
    _reset_manager()
    return state


def speak(pack_dir, data_dir, text, voice=None, language=None, speed=None, *,
          top_k=None, fragment_interval=None, text_split_method=None,
          seed=None, use_cuda_graph=None, parallel_infer=None):
    pack = _pack_meta(pack_dir)
    if pack is None:
        raise TTSException("未检测到语音资源包")
    ready, reason = _engine_ready(pack_dir)
    if not ready:
        raise TTSException(reason)
    state = _load_state(data_dir)
    if not state.get("enabled"):
        raise TTSException("语音功能未启用，请在设置中开启")
    cleaned = clean_text(text)
    voice_name = _active_role_for_request(pack_dir, voice)
    language = language or state.get("language") or "中文"
    speed = _coerce_speed(speed if speed is not None else state.get("speed"))
    manager = _get_manager(pack_dir, data_dir)
    if manager.is_busy:
        raise TTSException("正在合成中，请稍候")
    wav_path = manager.synthesize(
        cleaned,
        voice_name,
        language,
        speed,
        top_k=top_k if top_k is not None else 15,
        fragment_interval=fragment_interval if fragment_interval is not None else 0.5,
        text_split_method=text_split_method if text_split_method is not None else "cut0",
        seed=seed if seed is not None else -1,
        use_cuda_graph=use_cuda_graph if use_cuda_graph is not None else False,
        parallel_infer=parallel_infer if parallel_infer is not None else False,
    )
    return wav_path


def preload(pack_dir, data_dir, voice=None):
    pack = _pack_meta(pack_dir)
    if pack is None:
        raise TTSException("未检测到语音资源包")
    ready, reason = _engine_ready(pack_dir)
    if not ready:
        raise TTSException(reason)
    state = _load_state(data_dir)
    if not state.get("enabled"):
        raise TTSException("语音功能未启用，请在设置中开启")
    voice_name = _active_role_for_request(pack_dir, voice)
    manager = _get_manager(pack_dir, data_dir)
    return manager.preload(voice_name)


def shutdown(pack_dir, data_dir):
    manager = _get_manager(pack_dir, data_dir)
    manager.shutdown()
    return True
