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
import stat
import subprocess
import tempfile
import threading
import time
import uuid
import copy
import zipfile
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
# ``persona.json`` is the source of truth for a role's display name and
# companion prompt.  Keep the HTTP-facing names for old clients, but never
# store them in roles.json again.
_PERSONA_FIELDS = ("name", "background", "tone", "avoid", "examples")
_PERSONA_JSON_FIELDS = ("版本", "角色", "语气", "背景", "禁忌", "示例")
_PERSONA_JSON_VERSION = 1
_PERSONA_FILENAME = "persona.json"
_PERSONA_LIMITS = {"name": 64, "background": 8000, "tone": 2000, "avoid": 2000, "examples": 2000}
_PERSONA_TOTAL_LIMIT = 12000
_PERSONA_LABELS = {
    "name": "角色", "background": "背景", "tone": "语气", "avoid": "禁忌", "examples": "示例",
}
_PERSONA_UNSET = object()
_ROLE_MANIFEST_FIELDS = (
    "role_id", "gpt_file", "sovits_file", "audio_file", "index_file",
    "reference_text", "reference_language", "live2d_model_id",
)

# 这些导入覆盖 worker 入口以及日文、英文文本前处理器。仅有
# ``install.json`` 并不能证明复制过来或安装中断的虚拟环境确实能合成语音。
_ENGINE_IMPORT_PACKAGES = {
    "torch": "torch>=2.7,<2.8",
    "torchaudio": "torchaudio>=2.7,<2.8",
    "numpy": "numpy<2.0",
    "soundfile": "soundfile>=0.13.1",
    "matplotlib": "matplotlib>=3.8.0",
    "transformers": "transformers>=4.57,<5",
    "librosa": "librosa==0.10.2",
    "wordsegment": "wordsegment>=1.3.1",
    # 上游软件包在 Windows 上需要本地 C/C++ 工具链。
    # pyopenjtalk-plus 导出同名的 ``pyopenjtalk`` 模块，并提供 CPython 3.11
    # Windows wheel，因此普通用户电脑也能直接执行修复。
    "pyopenjtalk": "pyopenjtalk-plus>=0.4.1.post9",
}
_ENGINE_PROBE_LOCK = threading.RLock()
_ENGINE_PROBE_CACHE = {}
_ENGINE_PROBE_TTL = 45.0
_ENGINE_REPAIR_LOCK = threading.Lock()

# 快速挂载包同时包含本地推理运行时和模型权重，体积远大于普通设置上传。
# 因此先流式写盘，并在解压前执行归档级限制。默认上限可容纳便携式
# Python/Torch 运行时和多套音色；受管安装仍可通过环境变量收紧限制。
def _mount_limit(name, default):
    try:
        value = int(os.environ.get(name, default))
        return value if value > 0 else default
    except (TypeError, ValueError):
        return default


_TTS_PACK_MOUNT_MAX_UPLOAD_BYTES = _mount_limit("MEMO_TTS_PACK_MAX_UPLOAD_BYTES", 20 * 1024 ** 3)
_TTS_PACK_MOUNT_MAX_UNCOMPRESSED_BYTES = _mount_limit("MEMO_TTS_PACK_MAX_UNCOMPRESSED_BYTES", 28 * 1024 ** 3)
_TTS_PACK_MOUNT_MAX_FILES = _mount_limit("MEMO_TTS_PACK_MAX_FILES", 50000)
_TTS_PACK_MOUNT_CHUNK_BYTES = 1024 * 1024
_TTS_PACK_MOUNT_LOCK = threading.RLock()
# 浏览器/普通网页文件上传仍要经过 WebView 或浏览器进程；只保留小包后备入口。
# 完整 GPT-SoVITS 运行时请走桌面原生路径，不应再把数 GB ZIP 放进 HTTP 请求体。
TTS_PACK_WEB_UPLOAD_MAX_BYTES = _mount_limit(
    "MEMO_TTS_PACK_WEB_UPLOAD_MAX_BYTES", 256 * 1024 ** 2
)
_TTS_PACK_MOUNT_PROGRESS_MIN_SECONDS = 0.25
_TTS_PACK_MOUNT_PROGRESS_MIN_BYTES = 4 * 1024 ** 2
_TTS_PACK_MOUNT_DISK_RESERVE_BYTES = 256 * 1024 ** 2

# 后台挂载进入提交流程前会标记该资料包，防止新的 synthesize/preload 或角色写入
# 与最终目录交换竞争。标记只存在于本地进程；跨进程竞争仍由 .tts.lock 兜底。
_TTS_PACK_MOUNTING_LOCK = threading.RLock()
_TTS_PACK_MOUNTING = set()


def _hidden_windows_subprocess_kwargs():
    """桌面应用没有父控制台时隐藏辅助进程窗口。

    The TTS worker speaks over stdin/stdout pipes and never needs a visible
    terminal.  Without these flags Windows creates a console for ``python.exe``
    whenever Memo is running as a windowed executable, which steals focus from
    the study window.  Reuse the same options for short dependency probes so
    they cannot flash a console during a status refresh either.
    """
    if os.name != "nt":
        return {}
    kwargs = {}
    create_no_window = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if create_no_window:
        kwargs["creationflags"] = create_no_window
    startupinfo_factory = getattr(subprocess, "STARTUPINFO", None)
    if startupinfo_factory is not None:
        try:
            startupinfo = startupinfo_factory()
            startupinfo.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 1)
            startupinfo.wShowWindow = getattr(subprocess, "SW_HIDE", 0)
            kwargs["startupinfo"] = startupinfo
        except Exception:
            # 嵌入式运行时没有 STARTUPINFO 时，CREATE_NO_WINDOW 仍可覆盖普通
            # Python 安装环境。
            pass
    return kwargs


# 跨进程互斥锁：防止两个 Memo Superform 实例同时使用同一语音资源包
def _acquire_file_lock(lock_path):
    """尝试无等待锁定任意本地锁文件的一个字节。"""
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


def _normalized_pack_dir(pack_dir):
    return os.path.normcase(os.path.abspath(os.fspath(pack_dir)))


def _set_tts_pack_mounting(pack_dir, mounting):
    """登记当前进程正在安装的资料包，供运行时与角色写入路径避让。"""
    key = _normalized_pack_dir(pack_dir)
    with _TTS_PACK_MOUNTING_LOCK:
        if mounting:
            _TTS_PACK_MOUNTING.add(key)
        else:
            _TTS_PACK_MOUNTING.discard(key)


def is_tts_pack_mounting(pack_dir):
    with _TTS_PACK_MOUNTING_LOCK:
        return _normalized_pack_dir(pack_dir) in _TTS_PACK_MOUNTING


def _assert_tts_pack_not_mounting(pack_dir, operation="使用语音功能"):
    if is_tts_pack_mounting(pack_dir):
        raise TTSException("语音包正在后台挂载，请等待安装完成后再%s" % operation)


def _assert_role_write_allowed(pack_dir):
    """其他 Memo 实例持有本包 TTS 锁时拒绝编辑。"""
    _assert_tts_pack_not_mounting(pack_dir, "修改角色资料")
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
    """在本地进程之间串行写入角色清单。"""
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
        # 角色清单是模型、音频和 Live2D 绑定的唯一事实来源。进程在更改绑定时
        # 即使被中断，也不能留下只写了一半的 JSON 文件。
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
    """为新建资料包返回一套完整且角色独立的默认人设。"""
    name = str(role_name or "陪伴角色").strip()[:_PERSONA_LIMITS["name"]] or "陪伴角色"
    return {
        "name": name,
        "background": "你是背词学习中的陪伴角色，观察学习节奏并给出简短、真诚的鼓励。",
        "tone": "自然、友好、克制，不打扰学习节奏。",
        "avoid": "不要只说单个语气词，不要说教过长，不要编造成绩或使用冒犯表达。",
        "examples": "这一题记下来就很好。|保持节奏，下一题继续。",
    }


def _persona_document_from_legacy(value, role_name, *, strict=True, allow_blank=True, fill_defaults=True):
    """Convert the pre-v2 English API shape into the on-disk Chinese schema.

    ``strict`` is used by live API writes so a typo cannot silently disappear.
    Migration uses ``strict=False`` and may leave absent fields blank, keeping
    an old partial role visibly incomplete until the user finishes its dossier.
    """
    if not isinstance(value, dict):
        raise TTSException("角色人设格式无效")
    keys = set(value)
    expected = set(_PERSONA_FIELDS)
    if strict and keys != expected:
        raise TTSException("角色人设必须包含且只包含：" + "、".join(_PERSONA_FIELDS))
    if not strict and not keys.issubset(expected):
        raise TTSException("旧角色人设包含无法迁移的字段")
    defaults = _default_role_persona(role_name)
    source = {}
    for field in _PERSONA_FIELDS:
        raw = value.get(field, defaults[field] if fill_defaults else "")
        # Historic roles occasionally contained non-string values.  Keep the
        # migration lossless enough to recover the role, while new writes are
        # deliberately schema-strict.
        if strict and not isinstance(raw, str):
            raise TTSException("角色人设字段“%s”必须是文本" % _PERSONA_LABELS[field])
        source[field] = str(raw or "").strip()
    return _validate_persona_document({
        "版本": _PERSONA_JSON_VERSION,
        "角色": source["name"],
        "语气": source["tone"],
        "背景": source["background"],
        "禁忌": source["avoid"],
        "示例": source["examples"],
    }, allow_blank=allow_blank)


def _validate_persona_document(value, *, allow_blank=True):
    """Validate the exact, versioned ``persona.json`` schema.

    A draft may leave non-name fields empty.  The role status turns those into
    actionable missing items and blocks activation; this lets a user create a
    package before every detail is ready without ever treating it as complete.
    """
    if not isinstance(value, dict) or set(value) != set(_PERSONA_JSON_FIELDS):
        raise TTSException("角色人设 JSON 必须包含且只包含：" + "、".join(_PERSONA_JSON_FIELDS))
    if type(value.get("版本")) is not int or value.get("版本") != _PERSONA_JSON_VERSION:
        raise TTSException("角色人设 JSON 的“版本”必须为 %d" % _PERSONA_JSON_VERSION)
    mapping = {
        "name": value.get("角色"), "tone": value.get("语气"), "background": value.get("背景"),
        "avoid": value.get("禁忌"), "examples": value.get("示例"),
    }
    normalized = {}
    for field in _PERSONA_FIELDS:
        raw = mapping[field]
        if not isinstance(raw, str):
            raise TTSException("角色人设字段“%s”必须是文本" % _PERSONA_LABELS[field])
        text = raw.strip()
        if len(text) > _PERSONA_LIMITS[field]:
            raise TTSException("角色人设字段“%s”不能超过 %d 个字符" % (_PERSONA_LABELS[field], _PERSONA_LIMITS[field]))
        if field == "name" and not text:
            raise TTSException("角色人设字段“角色”不能为空")
        if not allow_blank and not text:
            raise TTSException("角色人设字段“%s”不能为空" % _PERSONA_LABELS[field])
        normalized[field] = text
    if sum(len(normalized[field]) for field in _PERSONA_FIELDS) > _PERSONA_TOTAL_LIMIT:
        raise TTSException("整份角色人设不能超过 %d 个字符" % _PERSONA_TOTAL_LIMIT)
    return {
        "版本": _PERSONA_JSON_VERSION,
        "角色": normalized["name"],
        "语气": normalized["tone"],
        "背景": normalized["background"],
        "禁忌": normalized["avoid"],
        "示例": normalized["examples"],
    }


def _normalize_persona_document(value, role_name, *, allow_blank=True):
    """Accept either the v2 Chinese document or the legacy English API body."""
    if not isinstance(value, dict):
        raise TTSException("角色人设格式无效")
    keys = set(value)
    if keys == set(_PERSONA_JSON_FIELDS):
        return _validate_persona_document(value, allow_blank=allow_blank)
    return _persona_document_from_legacy(value, role_name, strict=True, allow_blank=allow_blank)


def _persona_document_to_public(document):
    """Return the stable English API shape used by the existing renderer."""
    if not isinstance(document, dict):
        return {}
    return {
        "name": document.get("角色", ""),
        "background": document.get("背景", ""),
        "tone": document.get("语气", ""),
        "avoid": document.get("禁忌", ""),
        "examples": document.get("示例", ""),
    }


def _normalize_persona(value, role_name, *, allow_empty=False):
    """Backward-compatible public helper returning the legacy English shape."""
    if value is None and allow_empty:
        return {}
    return _persona_document_to_public(_normalize_persona_document(value, role_name))


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
    """读取现代配置值，或读取包含注释和数字的旧版文件。"""
    raw = _read_text_file(path)
    if raw in LANGUAGE_NUMBER_MAP:
        return LANGUAGE_NUMBER_MAP[raw]
    if raw in LANGUAGE_NUMBER_MAP.values():
        return raw
    numbers = re.findall(r"(?m)^\s*(1[01]|[1-9])\s*$", raw)
    return LANGUAGE_NUMBER_MAP.get(numbers[-1], default) if numbers else default


def _role_status(role, pack_dir=None, staged_dir=None, *, persona_document=_PERSONA_UNSET):
    missing = []
    # 上传始终使用这些规范文件名。手工编辑或过期的清单一律视为不完整，
    # 不跟随其中任意指定的文件名。
    if role.get("gpt_file") != "gpt.ckpt": missing.append("GPT 模型")
    if role.get("sovits_file") != "sovits.pth": missing.append("SoVITS 模型")
    audio_file = str(role.get("audio_file") or "")
    # 此处仅检查 ``startswith('reference')`` 并不充分：手工写入的
    # ``reference/../../other.wav`` 仍会通过并越出角色目录。只接受
    # upload_role_file 生成的精确规范文件名。
    if audio_file not in {"reference" + suffix for suffix in _ROLE_FILE_KINDS["audio"][1]}:
        missing.append("参考音频")
    if not str(role.get("reference_text") or "").strip(): missing.append("参考文本")
    if role.get("reference_language") not in LANGUAGE_NUMBER_MAP.values(): missing.append("参考语言")
    if not role.get("live2d_model_id"): missing.append("Live2D 模型")
    if persona_document is _PERSONA_UNSET:
        persona_document = _load_role_persona_document(pack_dir, role) if pack_dir else None
    if persona_document is None:
        missing.append("角色人设")
    else:
        for field in ("background", "tone", "avoid", "examples"):
            public = _persona_document_to_public(persona_document)
            if not str(public.get(field) or "").strip():
                missing.append("角色人设（%s）" % _PERSONA_LABELS[field])
    if pack_dir:
        folder = _role_folder(pack_dir, role)
        required = {
            "GPT 模型": role.get("gpt_file"),
            "SoVITS 模型": role.get("sovits_file"),
            "参考音频": role.get("audio_file"),
        }
        for label, name in required.items():
            # 畸形清单已把该资源报告为缺失；不要跟随非规范文件名，但即使文本、
            # 语言或 Live2D 也不完整，仍要继续检查其他有效资源。
            if label in missing:
                continue
            staged = os.path.join(staged_dir, str(name)) if staged_dir else ""
            if not ((staged and os.path.isfile(staged)) or os.path.isfile(os.path.join(folder, str(name)))):
                missing.append(label)
    return missing


def _public_role(role, pack_dir=None, *, persona_document=_PERSONA_UNSET):
    item = dict(role)
    item.pop("folder", None)
    # ``name`` and ``persona`` used to live in roles.json.  They are now
    # intentionally rebuilt from the per-role document for every response.
    item.pop("name", None)
    item.pop("persona", None)
    if persona_document is _PERSONA_UNSET:
        persona_document = _load_role_persona_document(pack_dir, role) if pack_dir else None
    public_persona = _persona_document_to_public(persona_document)
    item["name"] = public_persona.get("name", "")
    item["persona"] = public_persona
    item["missing"] = _role_status(item, pack_dir, persona_document=persona_document)
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
    """返回角色在磁盘上唯一允许使用的目录。

    ``folder`` remains in old manifests for migration compatibility, but is
    deliberately not trusted when resolving assets.  This prevents a stale or
    edited manifest from making one role consume another role's files.
    """
    return os.path.join(pack_dir, _canonical_role_folder(role.get("role_id")))


def _persona_path(pack_dir, role):
    """Return the only allowed path for a role's persona document."""
    return os.path.join(_role_folder(pack_dir, role), _PERSONA_FILENAME)


def _load_role_persona_document(pack_dir, role):
    """Read a v2 persona document without applying a legacy fallback.

    Missing or malformed documents deliberately return ``None`` so the role is
    visible as a draft instead of silently borrowing text from another role.
    ``ensure_role_library`` handles all legacy migration before normal reads.
    """
    if not pack_dir:
        return None
    document = _read_json(_persona_path(pack_dir, role))
    if document is None:
        return None
    try:
        return _validate_persona_document(document)
    except TTSException:
        return None


def _write_role_persona_document(pack_dir, role, document):
    path = _persona_path(pack_dir, role)
    if not _write_json(path, document):
        raise TTSException("无法保存角色人设 JSON")


def _persona_snapshot(pack_dir, role):
    """Capture raw bytes so a paired role/Live2D operation can roll back."""
    path = _persona_path(pack_dir, role)
    try:
        with open(path, "rb") as f:
            return True, f.read()
    except FileNotFoundError:
        return False, b""
    except OSError as exc:
        raise TTSException("无法读取角色人设回滚数据：%s" % exc)


def _restore_persona_snapshot(pack_dir, role, snapshot):
    existed, payload = snapshot
    path = _persona_path(pack_dir, role)
    if existed:
        temp = path + "." + uuid.uuid4().hex + ".rollback"
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(temp, "wb") as f:
                f.write(payload)
                f.flush()
            os.replace(temp, path)
        finally:
            if os.path.exists(temp):
                try:
                    os.unlink(temp)
                except OSError:
                    pass
    else:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass


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
    """返回一次暂存更新提供的准确角色清单字段。"""
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


def _role_manifest_entry(role):
    """Return one v2 roles.json entry without display/persona authority."""
    role_id = _safe_role_id(role.get("role_id"))
    entry = {"role_id": role_id}
    for field in _ROLE_MANIFEST_FIELDS[1:]:
        entry[field] = str(role.get(field) or "").strip()
    return entry


def _role_library_v2(state):
    if not (isinstance(state, dict) and state.get("version") == 2 and isinstance(state.get("roles"), list)):
        return False
    # A few intermediate builds stamped the manifest as v2 while still
    # retaining v1 display/persona fields.  Treat only the lean manifest as
    # final v2; the transitional shape is promoted once below.  Deliberately
    # do *not* require persona.json here: a genuinely new v2 pack that omits
    # it must remain a visible draft rather than receiving invented content.
    legacy_fields = {"name", "persona", "folder"}
    return all(isinstance(role, dict) and not (legacy_fields & set(role)) for role in state["roles"])


def _new_role_id(state):
    """Generate an opaque, filesystem-safe ID when a caller creates a role."""
    existing = {str(item.get("role_id") or "") for item in state.get("roles") or [] if isinstance(item, dict)}
    for _ in range(8):
        role_id = "role-" + uuid.uuid4().hex[:16]
        if role_id not in existing:
            return role_id
    raise TTSException("生成角色标识失败，请重试")


def _legacy_persona_document_for_role(role):
    """Create a v2 document from a v1 manifest entry without dropping drafts."""
    raw = role.get("persona") if isinstance(role, dict) else None
    fallback = ""
    if isinstance(raw, dict):
        fallback = str(raw.get("name") or "").strip()
    fallback = fallback or str(role.get("name") or role.get("role_id") or "陪伴角色").strip()
    fallback = fallback[:_PERSONA_LIMITS["name"]] or "陪伴角色"
    if isinstance(raw, dict) and set(raw) == set(_PERSONA_JSON_FIELDS):
        try:
            return _validate_persona_document(raw)
        except TTSException:
            pass
    legacy = {}
    if isinstance(raw, dict):
        legacy = {field: raw[field] for field in _PERSONA_FIELDS if field in raw}
    # The role manifest still supplies a stable display fallback when an old
    # profile omitted or blanked its English ``name`` field.  Other absent
    # fields intentionally stay empty so the package remains a draft.
    if not str(legacy.get("name") or "").strip():
        legacy["name"] = fallback
    # A v1 record with no inline profile must remain a draft.  Filling a
    # complete default here would hide the missing persona.json and would also
    # prevent the browser's legacy per-character override from being migrated.
    return _persona_document_from_legacy(legacy, fallback, strict=False, fill_defaults=False)


def _migrate_role_library_to_v2(pack_dir, state):
    """Atomically promote a v1 manifest to v2 plus per-role persona files.

    Persona writes are made first, but every previous file is snapshotted and
    restored if a later write fails.  The v1 roles.json remains untouched until
    all documents are durable, so an interrupted migration can always retry.
    """
    if not isinstance(state, dict) or not isinstance(state.get("roles"), list):
        raise TTSException("角色配置格式无效，无法迁移")
    roles = []
    documents = []
    for raw in state.get("roles") or []:
        if not isinstance(raw, dict):
            raise TTSException("角色配置包含无效条目，无法迁移")
        entry = _role_manifest_entry(raw)
        roles.append(entry)
        # If an interrupted intermediate migration already produced a valid
        # persona.json, it is newer than the stale inline copy and must win.
        # This keeps reruns idempotent while still allowing a v1-only record
        # to be promoted on first launch.
        document = _load_role_persona_document(pack_dir, entry)
        documents.append((entry, document or _legacy_persona_document_for_role(raw)))
    active = str(state.get("active_role_id") or "").strip()
    if active:
        active = _safe_role_id(active)
    migrated = {"version": 2, "active_role_id": active, "roles": roles}
    snapshots = []
    try:
        for role, document in documents:
            snapshot = _persona_snapshot(pack_dir, role)
            snapshots.append((role, snapshot))
            _write_role_persona_document(pack_dir, role, document)
        _write_roles(pack_dir, migrated)
    except Exception:
        for role, snapshot in reversed(snapshots):
            try:
                _restore_persona_snapshot(pack_dir, role, snapshot)
            except OSError:
                pass
        raise
    return migrated


def _legacy_shared_role_state(pack_dir):
    """Build the old shared-folder migration source before promoting it to v2."""
    legacy = os.path.join(pack_dir, "reference_audio", "sakiko")
    root = _roles_root(pack_dir)
    sakiko_dir, anon_dir = os.path.join(root, "sakiko"), os.path.join(root, "anon")
    os.makedirs(sakiko_dir, exist_ok=True)
    os.makedirs(anon_dir, exist_ok=True)
    # 原始 D_sakiko 命名资源归属祥子；规范名 gpt/sovits 是后续上传内容，
    # 有意隔离为爱音草稿。
    _copy_if_present(os.path.join(legacy, "GPT-SoVITS_models", "sakiko_v2pp-e15.ckpt"), os.path.join(sakiko_dir, "gpt.ckpt"))
    _copy_if_present(os.path.join(legacy, "GPT-SoVITS_models", "sakiko_v2pp_e8_s520.pth"), os.path.join(sakiko_dir, "sovits.pth"))
    _copy_if_present(os.path.join(legacy, "black_sakiko.wav"), os.path.join(sakiko_dir, "reference.wav"))
    sakiko_text = _read_text_file(os.path.join(legacy, "reference_text_black_sakiko.txt"))
    _copy_if_present(os.path.join(legacy, "GPT-SoVITS_models", "gpt.ckpt"), os.path.join(anon_dir, "gpt.ckpt"))
    _copy_if_present(os.path.join(legacy, "GPT-SoVITS_models", "sovits.pth"), os.path.join(anon_dir, "sovits.pth"))
    return {
        "version": 1,
        "active_role_id": "",
        "roles": [
            {"role_id": "sakiko", "name": "丰川祥子", "folder": "roles/sakiko", "gpt_file": "gpt.ckpt",
             "sovits_file": "sovits.pth", "audio_file": "reference.wav", "index_file": "",
             "reference_text": sakiko_text, "reference_language": "日文", "live2d_model_id": "",
             "persona": _default_role_persona("丰川祥子")},
            {"role_id": "anon", "name": "千早爱音", "folder": "roles/anon", "gpt_file": "gpt.ckpt",
             "sovits_file": "sovits.pth", "audio_file": "", "index_file": "",
             "reference_text": "", "reference_language": "", "live2d_model_id": "",
             "persona": _default_role_persona("千早爱音")},
        ],
    }


def ensure_role_library(pack_dir):
    """Establish the v2 role library and atomically migrate v1 data once."""
    with _ROLE_LIBRARY_LOCK:
        existing = _read_json(_roles_path(pack_dir))
        if _role_library_v2(existing):
            return existing
        with _role_write_guard(pack_dir):
            # Another local process may have completed migration while we were
            # waiting for the write lock.
            existing = _read_json(_roles_path(pack_dir))
            if _role_library_v2(existing):
                return existing
            if isinstance(existing, dict) and isinstance(existing.get("roles"), list):
                return _migrate_role_library_to_v2(pack_dir, existing)
            return _migrate_role_library_to_v2(pack_dir, _legacy_shared_role_state(pack_dir))


def _role_write_operation(operation):
    """同时在进程内锁和文件锁保护下执行一次角色变更。"""
    @wraps(operation)
    def wrapped(pack_dir, *args, **kwargs):
        # 获取操作保护前先完成一次性迁移；迁移路径自带保护，而文件锁不可重入。
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
    """只读取已声明角色，绝不解析旧 pack.json 音色。"""
    with _ROLE_LIBRARY_LOCK:
        role = _find_role(ensure_role_library(pack_dir), role_id)
        missing = _role_status(role, pack_dir)
        if require_complete and missing:
            raise TTSException("角色资料未配齐: " + "、".join(missing))
        return _public_role(role, pack_dir)


def roles_referencing_live2d(pack_dir, model_id):
    """返回绑定到 Live2D 模型的角色元数据，且不触发迁移。

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
            # 删除必须保守失败。清单不可读时无法证明模型未被使用，直接删除可能
            # 破坏未知角色。
            raise TTSException("角色配置损坏，无法确认 Live2D 模型是否仍被绑定")
        roles = state["roles"]
        result = []
        for role in roles:
            if not isinstance(role, dict) or str(role.get("live2d_model_id") or "") != key:
                continue
            document = _load_role_persona_document(pack_dir, role)
            public = _persona_document_to_public(document)
            result.append({
                "role_id": str(role.get("role_id") or ""),
                "name": str(public.get("name") or role.get("role_id") or ""),
            })
        return result


def role_library_snapshot(pack_dir):
    """供 API 协调 Live2D 变更使用的内部事务快照。"""
    with _ROLE_LIBRARY_LOCK:
        return copy.deepcopy(ensure_role_library(pack_dir))


@_role_write_operation
def restore_role_library(pack_dir, snapshot):
    """配对服务失败后恢复此前捕获的角色库。"""
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("roles"), list):
        raise TTSException("角色配置回滚数据无效")
    with _ROLE_LIBRARY_LOCK:
        _reset_manager()
        _write_roles(pack_dir, copy.deepcopy(snapshot))


def _candidate_role(pack_dir, state, data, *, staged_dir=None, check_active=True):
    """Validate a role edit and return its manifest entry plus persona document.

    New UI calls send an explicit ``persona`` document and omit ``role_id``.
    Older clients retain the former ``name`` and English ``persona`` payloads;
    those forms are normalized at this boundary rather than persisted again.
    """
    requested_id = str(data.get("role_id") or "").strip()
    role_id = _safe_role_id(requested_id) if requested_id else _new_role_id(state)
    existing = next((item for item in state.get("roles") or [] if item.get("role_id") == role_id), None)

    legacy_name = str(data.get("name") or "").strip()
    existing_document = _load_role_persona_document(pack_dir, existing) if existing else None
    if "persona" in data and data.get("persona") is not None:
        fallback_name = legacy_name or (existing_document or {}).get("角色") or role_id
        persona_document = _normalize_persona_document(data.get("persona"), fallback_name, allow_blank=True)
    elif existing_document is not None:
        persona_document = dict(existing_document)
        # Retain legacy API compatibility: a supplied old ``name`` renames
        # the package by rewriting the source-of-truth document.
        if legacy_name:
            persona_document["角色"] = legacy_name
            persona_document = _validate_persona_document(persona_document, allow_blank=True)
    elif legacy_name:
        persona_document = _persona_document_from_legacy({}, legacy_name, strict=False, allow_blank=True)
    else:
        raise TTSException("新角色需要提供角色人设")

    candidate = dict(existing or {
        "role_id": role_id, "gpt_file": "", "sovits_file": "", "audio_file": "", "index_file": "",
        "reference_text": "", "reference_language": "", "live2d_model_id": "",
    })
    candidate["role_id"] = role_id
    candidate.update({
        "reference_text": str(data.get("reference_text") or "").strip(),
        "reference_language": str(data.get("reference_language") or "").strip(),
        "live2d_model_id": str(data.get("live2d_model_id") or "").strip(),
    })
    candidate = _role_manifest_entry(candidate)
    if check_active and state.get("active_role_id") == role_id:
        missing = _role_status(candidate, pack_dir, staged_dir, persona_document=persona_document)
        if missing:
            raise TTSException("当前已启用角色不能保存为未完成状态: " + "、".join(missing))
    return existing, candidate, persona_document


def preview_role_save(pack_dir, data):
    """在其他服务变更自身绑定前校验角色编辑。"""
    with _ROLE_LIBRARY_LOCK:
        _, candidate, persona_document = _candidate_role(pack_dir, ensure_role_library(pack_dir), data)
        return _public_role(candidate, pack_dir, persona_document=persona_document)


@_role_write_operation
def save_role(pack_dir, data, *, after_commit=None):
    """持久化角色元数据，并可配对执行当前角色副作用。

    ``after_commit`` is deliberately executed while the role write lock is
    still held.  The local API uses it to move the corresponding Live2D
    preference in the same logical transaction, so two rapid role changes
    cannot leave the TTS manifest and renderer pointing at different roles.
    """
    with _ROLE_LIBRARY_LOCK:
        state = ensure_role_library(pack_dir)
        before = copy.deepcopy(state)
        existing, candidate, persona_document = _candidate_role(pack_dir, state, data)
        is_active = state.get("active_role_id") == candidate["role_id"]
        if is_active:
            # 在清单变化前停止旧 worker。此锁释放后开始的请求必须按新角色资料
            # 创建 worker，不能复用缓存的模型权重。
            _reset_manager()
        snapshot = _persona_snapshot(pack_dir, candidate)
        if existing is None:
            state["roles"].append(candidate)
            role = candidate
        else:
            existing.clear()
            existing.update(candidate)
            role = existing
        try:
            _write_role_persona_document(pack_dir, role, persona_document)
            _write_roles(pack_dir, state)
            public = _public_role(role, pack_dir, persona_document=persona_document)
            if after_commit:
                after_commit(public)
        except Exception:
            try:
                _write_roles(pack_dir, before)
            finally:
                _restore_persona_snapshot(pack_dir, role, snapshot)
                _reset_manager()
            raise
    return public


@_role_write_operation
def update_role_persona(pack_dir, role_id, persona):
    """保存一个角色的陪伴人设，不改动 TTS 资源。"""
    with _ROLE_LIBRARY_LOCK:
        state = ensure_role_library(pack_dir)
        role = _find_role(state, role_id)
        old_document = _load_role_persona_document(pack_dir, role) or {}
        fallback_name = old_document.get("角色") or role.get("role_id")
        document = _normalize_persona_document(persona, fallback_name, allow_blank=True)
        snapshot = _persona_snapshot(pack_dir, role)
        try:
            _write_role_persona_document(pack_dir, role, document)
        except Exception:
            _restore_persona_snapshot(pack_dir, role, snapshot)
            raise
        return _public_role(role, pack_dir, persona_document=document)


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
        _write_roles(pack_dir, state)
    return _public_role(role, pack_dir)


@_role_write_operation
def begin_role_update(pack_dir, role_id):
    """为当前角色的原子更新创建私有暂存区。"""
    with _ROLE_LIBRARY_LOCK:
        state = ensure_role_library(pack_dir)
        role = _find_role(state, role_id)
        batch_id = uuid.uuid4().hex
        stage_dir = _role_stage_dir(pack_dir, role["role_id"], batch_id)
        os.makedirs(stage_dir, exist_ok=False)
        return batch_id


@_role_write_operation
def stage_role_file(pack_dir, role_id, batch_id, kind, filename, data):
    """暂存一个候选资源，不改动正在使用的角色包。"""
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
            # 暂存包只保留一条参考音频，确保同一次编辑保存中重新选择音频的结果
            # 确定且唯一。
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
    """界面保存失败后移除尚未提交的私有暂存区。"""
    with _ROLE_LIBRARY_LOCK:
        state = ensure_role_library(pack_dir)
        role = _find_role(state, role_id)
        stage_dir = _role_stage_dir(pack_dir, role["role_id"], batch_id)
        if os.path.isdir(stage_dir):
            shutil.rmtree(stage_dir)
        return True


def _restore_staged_assets(stage_dir, applied, backups):
    """撤销部分应用的暂存更新，并保留文件以便重试。"""
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
    # 替换可能在旧规范文件已移入 ``.rollback``、但新暂存文件尚未记入
    # ``applied`` 时失败。这些未触碰的备份也必须恢复，否则失败事务会让
    # roles.json 指向已经消失的旧资源。
    for target, backup in backups.items():
        if target in restored or not os.path.isfile(backup):
            continue
        try:
            if not os.path.isfile(target):
                os.replace(backup, target)
        except OSError:
            pass


def _apply_staged_assets(folder, stage_dir, fields):
    """把暂存的规范文件原子交换到角色目录。

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
    """提交暂存角色资源、元数据以及可选的配对回调。

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
        existing, candidate, persona_document = _candidate_role(pack_dir, state, data, check_active=False)
        staged_fields = _staged_asset_fields(stage_dir)
        candidate.update(staged_fields)
        candidate = _role_manifest_entry(candidate)
        is_active = state.get("active_role_id") == candidate["role_id"]
        if is_active:
            missing = _role_status(candidate, pack_dir, stage_dir, persona_document=persona_document)
            if missing:
                raise TTSException("当前已启用角色不能保存为未完成状态: " + "、".join(missing))
            # 在角色锁内、公开新清单前重置，避免后续请求把旧模型缓存与新文件混用。
            _reset_manager()
        before = copy.deepcopy(state)
        folder = _role_folder(pack_dir, candidate)
        os.makedirs(folder, exist_ok=True)
        persona_before = _persona_snapshot(pack_dir, candidate)
        applied, backups = _apply_staged_assets(folder, stage_dir, staged_fields)
        try:
            if existing is None:
                state["roles"].append(candidate)
                committed = candidate
            else:
                existing.clear()
                existing.update(candidate)
                committed = existing
            _write_role_persona_document(pack_dir, committed, persona_document)
            _write_roles(pack_dir, state)
            public = _public_role(committed, pack_dir, persona_document=persona_document)
            if after_commit:
                after_commit(public)
        except Exception:
            try:
                _write_roles(pack_dir, before)
            finally:
                try:
                    _restore_persona_snapshot(pack_dir, candidate, persona_before)
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
    """启用完整角色，并原子配对所有依赖状态。"""
    with _ROLE_LIBRARY_LOCK:
        state = ensure_role_library(pack_dir)
        before = copy.deepcopy(state)
        role = _find_role(state, role_id)
        missing = _role_status(role, pack_dir)
        if missing:
            raise TTSException("角色资料未配齐: " + "、".join(missing))
        # 提交当前角色前确认清单中的精确路径存在；过期清单对应的角色绝不能成为兜底。
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
    """返回 worker 运行时的 ``(ready, reason, missing_modules)``。

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
            **_hidden_windows_subprocess_kwargs()
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
    """原地修复 worker 缺失的软件包，并在完成后验证。

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
        # 原地修复成功后，不要让此前可用的陪伴语音悄悄保持关闭。解释器变更期间
        # 临时停止，只有子进程探测确认运行时恢复可用后，才恢复用户之前的选择。
        was_enabled = bool(state.get("enabled"))
        state["enabled"] = False
        _save_state(data_dir, state)
        packages = [
            _ENGINE_IMPORT_PACKAGES[name] for name in missing
            if name in _ENGINE_IMPORT_PACKAGES
        ]
        # ``pyopenjtalk`` 是已知的日文运行时依赖，即使导入探测在列出模块前被
        # 中断，也必须使用其兼容 Windows 的预编译发行版。
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
                **_hidden_windows_subprocess_kwargs()
            )
            if bootstrap.returncode:
                raise TTSException("无法准备资源包 pip：" + (bootstrap.stdout or "")[-500:])
            command = [python_exe, "-m", "pip", "install", "--disable-pip-version-check", *packages]
        try:
            installed = subprocess.run(
                command, cwd=pack_dir, text=True, encoding="utf-8", errors="replace",
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=900,
                **_hidden_windows_subprocess_kwargs()
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


def _runtime_layout_missing(pack_dir):
    """返回已挂载包仍缺少的精确运行时文件。"""
    required = (
        (".venv311/Scripts/python.exe", _venv_python(pack_dir)),
        ("tts_engine/worker_main.py", os.path.join(pack_dir, "tts_engine", "worker_main.py")),
    )
    return [label for label, path in required if not os.path.isfile(path)]


def _engine_ready(pack_dir):
    """合成前校验安装元数据、worker 文件和模块导入。

    install.json 只是安装完成标记；若它丢失但环境实际完整
    （venv 解释器与 worker 均存在），自动重建标记，避免用户误以为功能损坏。
    """
    runtime_missing = _runtime_layout_missing(pack_dir)
    if runtime_missing:
        return False, "语音包尚待补齐，缺少：" + "、".join(runtime_missing)
    meta = _install_meta(pack_dir)
    if not meta or not meta.get("installed"):
        _write_install_meta(pack_dir)
    dependency_ready, dependency_reason, _missing = _engine_dependency_status(pack_dir)
    if not dependency_ready:
        return False, dependency_reason
    return True, ""


def _safe_zip_member_parts(info):
    """校验一个归档成员，并返回其相对路径片段。

    A voice resource pack is often exchanged outside the application, so the
    installer treats the ZIP as untrusted input.  In particular, never hand a
    member name directly to ``extractall``: ZIP Slip paths, Windows drive paths
    and symlink entries could otherwise escape ``data/tts_pack``.
    """
    raw_name = str(getattr(info, "filename", "") or "")
    if not raw_name or "\x00" in raw_name:
        raise TTSException("语音包内含无效文件名")
    normalized = raw_name.replace("\\", "/")
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        raise TTSException("语音包不能包含绝对路径文件")
    raw_parts = normalized.split("/")
    if any(part == ".." for part in raw_parts):
        raise TTSException("语音包不能包含上级目录路径")
    parts = [part for part in raw_parts if part not in ("", ".")]
    if not parts:
        raise TTSException("语音包内含无效文件路径")

    mode = (int(getattr(info, "external_attr", 0)) >> 16) & 0o170000
    is_directory = bool(info.is_dir() or mode == stat.S_IFDIR)
    if mode == stat.S_IFLNK:
        raise TTSException("语音包不能包含链接文件")
    if mode and not is_directory and mode != stat.S_IFREG:
        raise TTSException("语音包包含不支持的特殊文件")
    return parts, is_directory


def _inspect_tts_pack_archive(archive):
    """解压前检查所有成员名称和总大小。

    返回 ``(members, total_size, total_files)``。目录项不计入文件与字节进度，
    但仍参与完整的路径安全校验。
    """
    infos = archive.infolist()
    if not infos:
        raise TTSException("语音包 ZIP 是空的")
    if len(infos) > _TTS_PACK_MOUNT_MAX_FILES:
        raise TTSException("语音包文件数量过多")

    total_size = 0
    files = set()
    directories = set()
    members = []
    for info in infos:
        parts, is_directory = _safe_zip_member_parts(info)
        key = "/".join(parts).casefold()
        if key in files or (is_directory and key in directories):
            raise TTSException("语音包含有重复文件路径")
        if is_directory:
            if key in files or any(file_path.startswith(key + "/") for file_path in files):
                raise TTSException("语音包内的文件与目录路径冲突")
            directories.add(key)
        else:
            # Windows 上的这类冲突会使解压结果取决于归档顺序，因此统一拒绝。
            if (key in directories or any(key.startswith(directory + "/") for directory in files)
                    or any(directory.startswith(key + "/") for directory in directories)):
                raise TTSException("语音包内的文件与目录路径冲突")
            files.add(key)
            file_size = int(getattr(info, "file_size", 0) or 0)
            compressed_size = int(getattr(info, "compress_size", 0) or 0)
            if file_size < 0 or compressed_size < 0:
                raise TTSException("语音包内含无效文件大小")
            total_size += file_size
            if total_size > _TTS_PACK_MOUNT_MAX_UNCOMPRESSED_BYTES:
                raise TTSException("解压后的语音包过大")
            # 极大且压缩率异常高的成员通常是 ZIP 炸弹；正常模型权重和虚拟环境
            # 二进制文件的压缩率远低于此。
            if file_size >= 128 * 1024 ** 2 and compressed_size * 200 < file_size:
                raise TTSException("语音包压缩比例异常")
        members.append((info, parts, is_directory))
    return members, total_size, len(files)


def _notify_tts_pack_progress(callback, stage, **payload):
    """调用可选进度回调；进度显示失败不能影响资料包安全安装。"""
    if not callable(callback):
        return
    try:
        callback(stage, payload)
    except Exception:
        # 回调由 UI/任务层提供，安装底层不应因状态展示问题失去原子回滚保障。
        pass


def _extract_tts_pack_archive(archive_path, extract_dir, on_progress=None):
    """把一个 ZIP 安全解压到私有暂存目录，并按节流粒度报告进度。"""
    try:
        archive = zipfile.ZipFile(archive_path, "r")
    except (OSError, zipfile.BadZipFile) as exc:
        raise TTSException("请选择有效的语音包 ZIP 文件：%s" % exc)

    root = os.path.abspath(extract_dir)
    try:
        members, total_size, total_files = _inspect_tts_pack_archive(archive)
        completed_bytes = 0
        completed_files = 0
        last_report_bytes = -1
        last_report_at = 0.0

        def report(force=False):
            nonlocal last_report_bytes, last_report_at
            now = time.monotonic()
            if not force:
                if (completed_bytes - last_report_bytes < _TTS_PACK_MOUNT_PROGRESS_MIN_BYTES and
                        now - last_report_at < _TTS_PACK_MOUNT_PROGRESS_MIN_SECONDS):
                    return
            last_report_bytes = completed_bytes
            last_report_at = now
            _notify_tts_pack_progress(
                on_progress,
                "extracting",
                completed_bytes=completed_bytes,
                total_bytes=total_size,
                completed_files=completed_files,
                total_files=total_files,
            )

        report(force=True)
        for info, parts, is_directory in members:
            destination = os.path.abspath(os.path.join(root, *parts))
            try:
                if os.path.commonpath((root, destination)) != root:
                    raise TTSException("语音包内含越界文件路径")
            except ValueError:
                raise TTSException("语音包内含无效文件路径")
            if is_directory:
                os.makedirs(destination, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            written = 0
            try:
                with archive.open(info, "r") as source, open(destination, "xb") as target:
                    while True:
                        chunk = source.read(_TTS_PACK_MOUNT_CHUNK_BYTES)
                        if not chunk:
                            break
                        target.write(chunk)
                        written += len(chunk)
                        completed_bytes += len(chunk)
                        report()
            except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
                raise TTSException("解压语音包失败：%s" % exc)
            if written != int(info.file_size):
                raise TTSException("语音包内文件大小校验失败")
            completed_files += 1
            report(force=completed_files == total_files)
    finally:
        archive.close()


def _find_tts_pack_root(extract_dir):
    """接受直接位于根目录的资料包，或仅多一层外目录的 ZIP。"""
    direct_meta = os.path.join(extract_dir, "pack.json")
    if os.path.isfile(direct_meta):
        return extract_dir
    ignored = {"__macosx", ".ds_store"}
    entries = []
    try:
        for entry in os.scandir(extract_dir):
            if entry.name.casefold() in ignored:
                continue
            entries.append(entry)
    except OSError as exc:
        raise TTSException("读取已解压语音包失败：%s" % exc)
    if len(entries) == 1 and entries[0].is_dir():
        wrapped = entries[0].path
        if os.path.isfile(os.path.join(wrapped, "pack.json")):
            return wrapped
    raise TTSException("语音包根目录必须包含 pack.json（可放在 ZIP 的唯一顶层文件夹中）")


def _missing_mount_paths(role):
    """把一个角色的状态标签转换为用户可补齐的路径或设置项。"""
    role_id = _safe_role_id(role.get("role_id"))
    role_dir = "roles/%s" % role_id
    expected = {
        "GPT 模型": role_dir + "/gpt.ckpt",
        "SoVITS 模型": role_dir + "/sovits.pth",
        "参考音频": role_dir + "/reference.wav（也可为 .mp3 / .flac / .ogg）",
        "参考文本": "roles.json → %s.reference_text" % role_id,
        "参考语言": "roles.json → %s.reference_language" % role_id,
        "角色人设": role_dir + "/persona.json",
        "角色人设（背景）": role_dir + "/persona.json → 背景",
        "角色人设（语气）": role_dir + "/persona.json → 语气",
        "角色人设（禁忌）": role_dir + "/persona.json → 禁忌",
        "角色人设（示例）": role_dir + "/persona.json → 示例",
        "Live2D 模型": "设置 → 角色资料包 → 绑定 Live2D",
        "Live2D 模型（不可用）": "设置 → 角色资料包 → 绑定可用的 Live2D",
    }
    return [expected.get(item, item) for item in role.get("missing") or []]


def _incomplete_role_reports(roles):
    """为角色库生成持久、面向用户的缺项清单。"""
    reports = []
    for role in roles or []:
        missing = list(role.get("missing") or [])
        if not missing:
            continue
        reports.append({
            "role_id": role.get("role_id"),
            "name": role.get("name") or role.get("role_id"),
            "missing": missing,
            "missing_paths": _missing_mount_paths(role),
        })
    return reports


def _inspect_tts_pack_root(pack_root):
    """读取待挂载归档并报告缺项，而不因资料未齐而拒绝。

    ``pack.json`` 是 Memo 语音包唯一最低限度的结构标识。其余运行时和角色资料
    均可暂缺，使设置页能够展示其准确预期位置，用户可通过现有角色编辑器或修复
    流程完成资料包。
    """
    pack = _pack_meta(pack_root)
    if not isinstance(pack, dict):
        raise TTSException("语音包的 pack.json 格式无效")
    library = list_roles(pack_root)
    voice_ready = []
    for role in library.get("roles") or []:
        # 这份列表用于“可合成的声线”提示；Live2D 与陪伴人设仍会使角色
        # 保持草稿、阻止启用，但不掩盖已经齐全的语音模型资料。
        missing = [item for item in role.get("missing") or []
                   if item != "Live2D 模型" and not str(item).startswith("角色人设")]
        if not missing:
            voice_ready.append(role)
    incomplete_roles = _incomplete_role_reports(library.get("roles") or [])
    readiness = {
        "runtime_missing": _runtime_layout_missing(pack_root),
        "incomplete_roles": incomplete_roles,
        "voice_ready_roles": voice_ready,
        "complete": not _runtime_layout_missing(pack_root) and not incomplete_roles,
    }
    return pack, library, readiness


def _clear_engine_probe_cache(pack_dir):
    with _ENGINE_PROBE_LOCK:
        _ENGINE_PROBE_CACHE.pop(os.path.abspath(pack_dir), None)


def _check_tts_pack_can_be_replaced(pack_dir):
    """停止本进程的空闲 worker，并在其他进程持有资料包锁时拒绝替换。"""
    manager = _manager_for_pack(pack_dir)
    if manager is not None and manager.is_busy:
        raise TTSException("正在生成语音，请等待当前生成完成后再挂载语音包")
    # worker 持有解释器和当前模型文件；Windows 交换其外层资料包目录前必须先结束它。
    _reset_manager()
    probe, acquired = _acquire_pack_lock(pack_dir)
    if not acquired:
        raise TTSException("语音资源包正被另一个 Memo Superform 实例使用，请先关闭另一个实例后再挂载")
    _release_pack_lock(probe)


def _replace_tts_pack_atomically(pack_dir, data_dir, candidate_dir):
    """用已完成结构校验的暂存包替换当前资料包目录。"""
    pack_dir = os.path.abspath(pack_dir)
    data_dir = os.path.abspath(data_dir)
    parent = os.path.dirname(pack_dir)
    if os.path.islink(pack_dir):
        raise TTSException("语音资源包目录不能是链接路径")
    os.makedirs(parent, exist_ok=True)
    os.makedirs(data_dir, exist_ok=True)

    previous_state = _load_state(data_dir)
    disabled_state = dict(previous_state)
    disabled_state["enabled"] = False
    if not _save_state(data_dir, disabled_state):
        raise TTSException("保存语音开关状态失败")

    backup_dir = os.path.join(parent, ".tts-pack-backup-" + uuid.uuid4().hex)
    moved_previous = False
    mounted = False
    try:
        if os.path.lexists(pack_dir):
            os.replace(pack_dir, backup_dir)
            moved_previous = True
        os.replace(candidate_dir, pack_dir)
        mounted = True
    except Exception:
        # 同时回滚状态与目录。任何部分解压结果都不会进入正式路径，因此挂载失败
        # 后旧资料包仍保持用户原先的完整状态。
        if moved_previous and not os.path.lexists(pack_dir):
            try:
                os.replace(backup_dir, pack_dir)
            except OSError:
                pass
        _save_state(data_dir, previous_state)
        raise
    finally:
        # 只有新目录正式生效后才丢弃旧完整包。清理失败最多留下私有回滚副本，
        # 不会影响正在使用的资料包。
        if mounted and moved_previous and os.path.isdir(backup_dir):
            shutil.rmtree(backup_dir, ignore_errors=True)
    _clear_engine_probe_cache(pack_dir)


def mount_tts_pack_archive(pack_dir, data_dir, archive_path, source_name="", *,
                           on_progress=None, before_switch=None):
    """把完整或待补齐的 GPT-SoVITS ZIP 安装到 ``data/tts_pack``。

    可接受 ZIP 的内容为完整 ``tts_pack`` 目录，可直接位于归档根目录或唯一一层
    顶层文件夹内，通常包含便携运行时（``.venv311``）、``tts_engine``、
    ``pack.json`` 与角色资料。``pack.json`` 是唯一强制结构标识：缺少运行时或
    角色文件的包会作为草稿挂载，并向设置页报告每一项缺失内容。解压在正式资料包
    旁完成，且只会在 ZIP 与清单校验成功后原子切换。
    """
    archive_path = os.path.abspath(os.fspath(archive_path))
    if not os.path.isfile(archive_path):
        raise TTSException("未找到待挂载的语音包 ZIP")
    try:
        archive_size = os.path.getsize(archive_path)
    except OSError as exc:
        raise TTSException("读取语音包失败：%s" % exc)
    if archive_size <= 0:
        raise TTSException("语音包 ZIP 是空的")
    if archive_size > _TTS_PACK_MOUNT_MAX_UPLOAD_BYTES:
        raise TTSException("语音包 ZIP 超过允许大小")

    pack_dir = os.path.abspath(pack_dir)
    parent = os.path.dirname(pack_dir)
    os.makedirs(parent, exist_ok=True)
    _notify_tts_pack_progress(
        on_progress,
        "checking",
        completed_bytes=0,
        total_bytes=0,
        completed_files=0,
        total_files=0,
        archive_bytes=archive_size,
    )
    try:
        with zipfile.ZipFile(archive_path, "r") as archive:
            _members, unpacked_size, unpacked_files = _inspect_tts_pack_archive(archive)
    except TTSException:
        raise
    except (OSError, zipfile.BadZipFile) as exc:
        raise TTSException("请选择有效的语音包 ZIP 文件：%s" % exc)
    try:
        free_bytes = shutil.disk_usage(parent).free
    except OSError as exc:
        raise TTSException("无法检查语音包安装磁盘空间：%s" % exc)
    required_bytes = unpacked_size + _TTS_PACK_MOUNT_DISK_RESERVE_BYTES
    if free_bytes < required_bytes:
        raise TTSException(
            "语音包安装磁盘空间不足：至少需要 %.2f GB 可用空间，当前仅 %.2f GB"
            % (required_bytes / 1024 ** 3, free_bytes / 1024 ** 3)
        )
    _notify_tts_pack_progress(
        on_progress,
        "checking",
        completed_bytes=0,
        total_bytes=unpacked_size,
        completed_files=0,
        total_files=unpacked_files,
        archive_bytes=archive_size,
        required_bytes=required_bytes,
        free_bytes=free_bytes,
    )
    extraction_dir = tempfile.mkdtemp(prefix=".tts-pack-extract-", dir=parent)
    candidate_dir = ""
    try:
        with _TTS_PACK_MOUNT_LOCK:
            _extract_tts_pack_archive(archive_path, extraction_dir, on_progress=on_progress)
            _notify_tts_pack_progress(
                on_progress,
                "validating",
                completed_bytes=unpacked_size,
                total_bytes=unpacked_size,
                completed_files=unpacked_files,
                total_files=unpacked_files,
            )
            source_root = _find_tts_pack_root(extraction_dir)
            pack, library, readiness = _inspect_tts_pack_root(source_root)
            candidate_dir = os.path.join(parent, ".tts-pack-ready-" + uuid.uuid4().hex)
            os.replace(source_root, candidate_dir)
            if callable(before_switch):
                before_switch()
            _notify_tts_pack_progress(
                on_progress,
                "replacing",
                completed_bytes=unpacked_size,
                total_bytes=unpacked_size,
                completed_files=unpacked_files,
                total_files=unpacked_files,
            )
            _check_tts_pack_can_be_replaced(pack_dir)
            _replace_tts_pack_atomically(pack_dir, data_dir, candidate_dir)
            candidate_dir = ""  # ownership moved to the live package path
            incomplete = bool(readiness["runtime_missing"] or readiness["incomplete_roles"])
            return {
                "ok": True,
                "message": (
                    "语音包已挂载，但仍有待补齐内容；请按设置页提示补齐后再开启语音。"
                    if incomplete else
                    "语音包已挂载；已停止旧语音进程，请在角色资料包中确认 Live2D 绑定后开启语音。"
                ),
                "pack_name": str(pack.get("name") or "语音资源包"),
                "version": pack.get("version"),
                "roles": library.get("roles") or [],
                "active_role_id": str(library.get("active_role_id") or ""),
                "voice_ready_role_ids": [role.get("role_id") for role in readiness["voice_ready_roles"]],
                "runtime_missing": readiness["runtime_missing"],
                "incomplete_roles": readiness["incomplete_roles"],
                "complete": not incomplete,
                "enabled": False,
                "source_name": os.path.basename(str(source_name or archive_path)),
            }
    except TTSException:
        raise
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        raise TTSException("挂载语音包失败：%s" % exc)
    finally:
        if candidate_dir and os.path.isdir(candidate_dir):
            shutil.rmtree(candidate_dir, ignore_errors=True)
        if os.path.isdir(extraction_dir):
            shutil.rmtree(extraction_dir, ignore_errors=True)


def mount_tts_pack_stream(pack_dir, data_dir, stream, content_length, source_name=""):
    """把 ZIP 流式接收到临时文件，避免数 GB 资料包常驻内存。"""
    try:
        content_length = int(content_length)
    except (TypeError, ValueError):
        content_length = 0
    if content_length <= 0:
        raise TTSException("未收到语音包文件")
    if content_length > _TTS_PACK_MOUNT_MAX_UPLOAD_BYTES:
        raise TTSException("语音包 ZIP 超过允许大小")

    parent = os.path.dirname(os.path.abspath(pack_dir))
    os.makedirs(parent, exist_ok=True)
    temp_path = ""
    try:
        with tempfile.NamedTemporaryFile(prefix=".tts-pack-upload-", suffix=".zip", dir=parent, delete=False) as target:
            temp_path = target.name
            remaining = content_length
            while remaining:
                chunk = stream.read(min(_TTS_PACK_MOUNT_CHUNK_BYTES, remaining))
                if not chunk:
                    raise TTSException("语音包上传中断")
                target.write(chunk)
                remaining -= len(chunk)
        return mount_tts_pack_archive(pack_dir, data_dir, temp_path, source_name)
    except OSError as exc:
        raise TTSException("保存语音包上传文件失败：%s" % exc)
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass


class TTSPackMountJobManager:
    """把耗时的语音包安装从 HTTP/WebView 线程移到单一后台任务。

    本地原生文件选择与浏览器小包上传都落到该管理器。状态快照刻意只包含文件名
    和大小，绝不把本机完整路径返回给网页。
    """

    _MAX_TERMINAL_JOBS = 24
    _ACTIVE_STATES = {"queued", "running"}

    def __init__(self, pack_dir, data_dir):
        self.pack_dir = os.path.abspath(os.fspath(pack_dir))
        self.data_dir = os.path.abspath(os.fspath(data_dir))
        self._lock = threading.RLock()
        self._jobs = {}
        self._job_order = []
        self._active_job_id = ""
        self.recover_stale_staging()

    @property
    def _parent_dir(self):
        return os.path.dirname(self.pack_dir)

    @property
    def _install_lock_path(self):
        # 独立于 ``tts_pack/.tts.lock``：后者由常驻 worker 占用，而这个锁覆盖
        # 从解压暂存到目录交换的整个安装窗口，供另一个实例的启动恢复逻辑避让。
        return os.path.join(self._parent_dir, ".tts-pack-install.lock")

    def _snapshot_locked(self, job):
        total = max(0, int(job.get("total_bytes") or 0))
        completed = max(0, int(job.get("completed_bytes") or 0))
        state = str(job.get("state") or "queued")
        if state == "completed":
            percent = 100
        elif total:
            percent = max(0, min(99, int(completed * 100 / total)))
        else:
            percent = 0
        snapshot = {
            "job_id": job["job_id"],
            "source_name": job["source_name"],
            "source_size": int(job.get("source_size") or 0),
            "state": state,
            "stage": str(job.get("stage") or "queued"),
            "completed_bytes": completed,
            "total_bytes": total,
            "completed_files": max(0, int(job.get("completed_files") or 0)),
            "total_files": max(0, int(job.get("total_files") or 0)),
            "percent": percent,
            "message": str(job.get("message") or ""),
            "error": str(job.get("error") or ""),
        }
        if state == "completed" and isinstance(job.get("result"), dict):
            snapshot["result"] = copy.deepcopy(job["result"])
        return snapshot

    def _prune_terminal_jobs_locked(self):
        terminal = [job_id for job_id in self._job_order
                    if self._jobs.get(job_id, {}).get("state") not in self._ACTIVE_STATES]
        while len(terminal) > self._MAX_TERMINAL_JOBS:
            job_id = terminal.pop(0)
            self._jobs.pop(job_id, None)
            try:
                self._job_order.remove(job_id)
            except ValueError:
                pass

    def _reserve_job(self, source_name, source_size, stage="queued"):
        source_name = os.path.basename(str(source_name or "语音包.zip")) or "语音包.zip"
        # ``_finish`` publishes the terminal snapshot just before its worker finally
        # clears the process-wide mount gate. Do not let a second request slip into
        # that tiny interval and have the first worker clear the second one's gate.
        if is_tts_pack_mounting(self.pack_dir):
            raise TTSException("已有语音包正在完成挂载，请等待当前安装完全结束后再导入")
        with self._lock:
            if self._active_job_id:
                active = self._jobs.get(self._active_job_id)
                if active and active.get("state") in self._ACTIVE_STATES:
                    raise TTSException("已有语音包正在挂载，请等待当前安装完成后再导入")
                self._active_job_id = ""
            job_id = uuid.uuid4().hex
            self._jobs[job_id] = {
                "job_id": job_id,
                "source_name": source_name,
                "source_size": int(source_size),
                "state": "queued",
                "stage": stage,
                "completed_bytes": 0,
                "total_bytes": 0,
                "completed_files": 0,
                "total_files": 0,
                "message": "等待开始安装",
                "error": "",
                "result": None,
            }
            self._job_order.append(job_id)
            self._active_job_id = job_id
            return self._snapshot_locked(self._jobs[job_id])

    def _update(self, job_id, **values):
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            for key, value in values.items():
                if value is not None:
                    job[key] = value
            return self._snapshot_locked(job)

    def _finish(self, job_id, *, result=None, error=""):
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            if error:
                job.update({"state": "failed", "stage": "failed", "error": str(error), "message": str(error)})
            else:
                job.update({
                    "state": "completed", "stage": "done", "result": copy.deepcopy(result) if isinstance(result, dict) else {},
                    "error": "", "message": "语音包已挂载",
                })
                total = int(job.get("total_bytes") or 0)
                if total:
                    job["completed_bytes"] = total
                total_files = int(job.get("total_files") or 0)
                if total_files:
                    job["completed_files"] = total_files
            if self._active_job_id == job_id:
                self._active_job_id = ""
            self._prune_terminal_jobs_locked()
            return self._snapshot_locked(job)

    def is_active(self):
        with self._lock:
            job = self._jobs.get(self._active_job_id)
            active_job = bool(job and job.get("state") in self._ACTIVE_STATES)
        # Keep tray exit/API write protection enabled until the worker has released
        # the process-wide gate, including the short terminal-snapshot interval.
        return active_job or is_tts_pack_mounting(self.pack_dir)

    def get_job(self, job_id):
        with self._lock:
            job = self._jobs.get(str(job_id or ""))
            if not job:
                raise TTSException("未找到该语音包安装任务")
            return self._snapshot_locked(job)

    def _validate_local_archive(self, path):
        try:
            archive_path = os.path.abspath(os.fspath(path))
        except (TypeError, ValueError):
            raise TTSException("请选择有效的语音包 ZIP 文件")
        if not archive_path.lower().endswith(".zip"):
            raise TTSException("请选择完整的语音包 ZIP 文件")
        if not os.path.isfile(archive_path):
            raise TTSException("未找到待挂载的语音包 ZIP")
        try:
            size = os.path.getsize(archive_path)
        except OSError as exc:
            raise TTSException("读取语音包失败：%s" % exc)
        if size <= 0:
            raise TTSException("语音包 ZIP 是空的")
        if size > _TTS_PACK_MOUNT_MAX_UPLOAD_BYTES:
            raise TTSException("语音包 ZIP 超过允许大小")
        return archive_path, size

    def start_local_archive(self, path):
        """排入原生文件选择/拖放取得的本机 ZIP。"""
        archive_path, size = self._validate_local_archive(path)
        snapshot = self._reserve_job(os.path.basename(archive_path), size)
        thread = threading.Thread(
            target=self._run_job,
            args=(snapshot["job_id"], archive_path, False),
            name="memo-tts-pack-mount",
            daemon=True,
        )
        thread.start()
        return snapshot

    def start_stream(self, stream, content_length, source_name=""):
        """为网页小包后备入口流式落盘，随后交由相同后台任务安装。"""
        try:
            content_length = int(content_length)
        except (TypeError, ValueError):
            content_length = 0
        if content_length <= 0:
            raise TTSException("未收到语音包文件")
        if content_length > TTS_PACK_WEB_UPLOAD_MAX_BYTES:
            raise TTSException("浏览器模式仅支持不超过 256 MiB 的语音包，请使用桌面 EXE 原生导入")
        if source_name and not str(source_name).lower().endswith(".zip"):
            raise TTSException("请选择完整的语音包 ZIP 文件")
        snapshot = self._reserve_job(source_name or "语音包.zip", content_length, stage="uploading")
        temp_path = ""
        try:
            os.makedirs(self._parent_dir, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                prefix=".tts-pack-upload-", suffix=".zip", dir=self._parent_dir, delete=False
            ) as target:
                temp_path = target.name
                remaining = content_length
                while remaining:
                    chunk = stream.read(min(_TTS_PACK_MOUNT_CHUNK_BYTES, remaining))
                    if not chunk:
                        raise TTSException("语音包上传中断")
                    target.write(chunk)
                    remaining -= len(chunk)
            self._update(snapshot["job_id"], stage="queued", message="上传完成，等待开始安装")
            thread = threading.Thread(
                target=self._run_job,
                args=(snapshot["job_id"], temp_path, True),
                name="memo-tts-pack-mount",
                daemon=True,
            )
            thread.start()
            return self.get_job(snapshot["job_id"])
        except Exception as exc:
            if temp_path:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass
            self._finish(snapshot["job_id"], error=str(exc))
            if isinstance(exc, TTSException):
                raise
            raise TTSException("保存语音包上传文件失败：%s" % exc)

    def _on_progress(self, job_id, stage, payload):
        labels = {
            "checking": "正在检查语音包与磁盘空间…",
            "extracting": "正在解压语音包…",
            "validating": "正在校验角色资料…",
            "switching": "正在安全替换旧语音包…",
        }
        # 底层保留 ``replacing`` 作为目录交换的技术术语，API 公开的任务阶段
        # 使用更直观也更稳定的 ``switching``。
        public_stage = "switching" if stage == "replacing" else stage
        values = dict(payload or {})
        values.update({"state": "running", "stage": public_stage,
                       "message": labels.get(public_stage, "正在安装语音包…")})
        self._update(job_id, **values)

    def _wait_for_voice(self, job_id):
        self._update(
            job_id,
            state="running",
            stage="waiting_for_voice",
            message="正在等待当前语音任务结束…",
        )
        while True:
            manager = _manager_for_pack(self.pack_dir)
            if manager is None or not manager.is_busy:
                return
            time.sleep(0.15)

    def _run_job(self, job_id, archive_path, remove_archive):
        install_lock = None
        mounting = False
        try:
            install_lock, acquired = _acquire_file_lock(self._install_lock_path)
            if not acquired:
                raise TTSException("语音包正在由另一个 Memo Superform 实例后台挂载，请等待其完成")
            _set_tts_pack_mounting(self.pack_dir, True)
            mounting = True
            self._update(job_id, state="running", stage="checking", message="正在检查语音包…")
            result = mount_tts_pack_archive(
                self.pack_dir,
                self.data_dir,
                archive_path,
                source_name=os.path.basename(archive_path),
                on_progress=lambda stage, payload: self._on_progress(job_id, stage, payload),
                before_switch=lambda: self._wait_for_voice(job_id),
            )
            self._finish(job_id, result=result)
        except Exception as exc:
            self._finish(job_id, error=str(exc) or "语音包挂载失败")
        finally:
            if mounting:
                _set_tts_pack_mounting(self.pack_dir, False)
            _release_pack_lock(install_lock)
            if remove_archive:
                try:
                    os.unlink(archive_path)
                except OSError:
                    pass

    def recover_stale_staging(self):
        """恢复异常退出留下的旧包备份，并清理专用临时目录。

        只处理本模块生成且具有严格前缀的项目，绝不扫描或删除用户目录中的其他文件。
        """
        recovery_lock, acquired = _acquire_file_lock(self._install_lock_path)
        if not acquired:
            # 另一实例正在安装时，任何暂存或备份目录都可能仍是有效工作内容。
            return False
        try:
            parent = self._parent_dir
            try:
                os.makedirs(parent, exist_ok=True)
                entries = list(os.scandir(parent))
            except OSError:
                return False
            backups = []
            for entry in entries:
                if entry.name.startswith(".tts-pack-backup-") and entry.is_dir(follow_symlinks=False):
                    backups.append(entry)
            if not os.path.lexists(self.pack_dir) and backups:
                try:
                    newest = max(backups, key=lambda item: item.stat(follow_symlinks=False).st_mtime)
                    os.replace(newest.path, self.pack_dir)
                except OSError:
                    # 保留备份，供下一次启动或人工恢复；不能因清理逻辑覆盖用户文件。
                    return False
            pack_exists = os.path.isdir(self.pack_dir) and not os.path.islink(self.pack_dir)
            prefixes = (".tts-pack-extract-", ".tts-pack-ready-", ".tts-pack-upload-")
            for entry in entries:
                if os.path.islink(entry.path):
                    continue
                should_remove = entry.name.startswith(prefixes)
                if pack_exists and entry.name.startswith(".tts-pack-backup-"):
                    should_remove = True
                if not should_remove:
                    continue
                try:
                    if entry.is_dir(follow_symlinks=False):
                        shutil.rmtree(entry.path, ignore_errors=True)
                    elif entry.is_file(follow_symlinks=False):
                        os.unlink(entry.path)
                except OSError:
                    pass
            return True
        finally:
            _release_pack_lock(recovery_lock)


def _read_text_file(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return f.read().strip()
    except OSError:
        return ""


def _resolve_role(pack_dir, role_id=None):
    """只解析清单明确指向的角色文件，绝不扫描目录猜测文件。"""
    state = ensure_role_library(pack_dir)
    selected = role_id or state.get("active_role_id")
    if not selected:
        raise TTSException("请先在设置中启用一个资料完整的角色")
    role = _find_role(state, selected)
    missing = _role_status(role, pack_dir)
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
    """供角色包版本之前的调用方使用的兼容哨兵。

    旧入口会直接写入任意 ``pack.json`` 音色目录，可能把新模型悄悄配到其他角色
    的音频上。为扩展兼容保留可调用名称，但不执行任何写入。
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
        try:
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
                **_hidden_windows_subprocess_kwargs()
            )
        except Exception:
            log_file.close()
            raise
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
            # 完整关闭会释放资源包锁；内部重启路径刻意保留它，否则同一管理器会把
            # 自己刚释放的锁误判为被其他应用实例占用。
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
                # 保留 ``_call`` 已执行的 worker 重置，同时向用户区分普通合成超时
                # 与确实缓慢或失败的冷模型加载。
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
        # 状态刷新时直接报告竞争中的 Memo 实例。过去若返回看似无害的未加载状态，
        # 界面会声称语音已启用，直到第一次触摸才因锁冲突失败。
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
        # 现在唯一的解析来源是角色清单；尤其不能回退到旧 pack.json 目录，也不能
        # 选择首个匹配的 .wav/.ckpt/.pth 文件。
        return _resolve_role(self.pack_dir, voice_name)


_MANAGER = None
_MANAGER_LOCK = threading.Lock()


def _reset_manager():
    """角色资源或选择变化后丢弃缓存的 worker 和模型。"""
    global _MANAGER
    with _MANAGER_LOCK:
        manager, _MANAGER = _MANAGER, None
        # 在旧管理器确实释放 `.tts.lock` 前持续持有生命周期锁。否则另一个请求会在
        # 极短间隙装入新管理器、获取旧锁失败，并在关闭完成后仍处于失效状态。
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
            # 模块级管理器状态会被进程内测试共享，也可能遇到数据目录切换。绝不复用
            # 为另一资源包获取的 worker 或锁。
            try:
                _MANAGER.shutdown()
            except Exception:
                pass
            _MANAGER = None
        if _MANAGER is not None and not _MANAGER._pack_locked:
            # 获取锁失败的管理器不可复用；立即丢弃，让后续请求能在其他应用退出后重新取锁。
            try:
                _MANAGER.shutdown()
            except Exception:
                pass
            _MANAGER = None
        if _MANAGER is None:
            _MANAGER = TTSManager(pack_dir, data_dir)
        return _MANAGER


def _manager_for_pack(pack_dir):
    """返回本进程现有管理器，不获取新的资料包锁。"""
    with _MANAGER_LOCK:
        manager = _MANAGER
        if manager is not None and os.path.abspath(manager.pack_dir) == os.path.abspath(pack_dir):
            return manager
    return None


def _check_pack_runtime_available(pack_dir):
    """为状态读取探测其他进程的锁，但不保留该锁。"""
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
    """返回唯一允许合成或预加载的角色。

    ``voice`` 过去可选择任意旧 pack.json 音色；现在只有与当前清单启用角色一致时
    才会被接受，避免旧下拉框或旧客户端重新唤起先前角色的模型。
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
            "runtime_missing_files": _runtime_layout_missing(pack_dir) if pack is not None else [],
            "incomplete_roles": [],
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
            "runtime_missing_files": [],
            "incomplete_roles": [],
        }
    ready, reason = _engine_ready(pack_dir)
    role_library = list_roles(pack_dir)
    active_role_id, role_ready = _active_role_status(role_library)
    state = _load_state(data_dir)
    role_error = ""
    # 修复历史遗留状态：从未启用完整角色，但全局功能开关仍为开启。若仍报告已启用，
    # 触摸会表现为静默失败，也可能让旧 worker 模型残留内存。此处关闭开关；用户必须
    # 先明确启用完整角色，之后才能重新打开语音。
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
        "runtime_missing_files": _runtime_layout_missing(pack_dir),
        "incomplete_roles": _incomplete_role_reports(role_library["roles"]),
        "roles": role_library["roles"],
    }


def set_enabled(pack_dir, data_dir, enabled):
    _assert_tts_pack_not_mounting(pack_dir, "切换语音开关")
    pack = _pack_meta(pack_dir)
    if pack is None:
        raise TTSException("未检测到语音资源包")
    ready, reason = _engine_ready(pack_dir)
    if enabled and not ready:
        raise TTSException(reason)
    state = _load_state(data_dir)
    if enabled:
        _active_role_for_request(pack_dir)
        # 关闭会释放跨进程资料包锁。重新启用前先丢弃管理器，避免旧对象保留过期锁标记
        # 并与另一个 Memo 实例同时运行。
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
    _assert_tts_pack_not_mounting(pack_dir, "生成语音")
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
    _assert_tts_pack_not_mounting(pack_dir, "预加载语音模型")
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
    _assert_tts_pack_not_mounting(pack_dir, "关闭语音引擎")
    manager = _get_manager(pack_dir, data_dir)
    manager.shutdown()
    return True
