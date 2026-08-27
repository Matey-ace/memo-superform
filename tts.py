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


LANGUAGE_NUMBER_MAP = {
    "1": "中文", "2": "英文", "3": "日文", "4": "粤语", "5": "韩文",
    "6": "中英混合", "7": "日英混合", "8": "粤英混合", "9": "韩英混合",
    "10": "多语种混合", "11": "多语种混合(粤语)",
}

# 单次合成超时（秒）。worker 卡死时强杀并重置引擎；可用环境变量调大。
_SYNTH_TIMEOUT = float(os.environ.get("MEMO_TTS_SYNTH_TIMEOUT", "30") or 30)
_ROLE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_ROLE_FILE_KINDS = {
    "ckpt": ("gpt.ckpt", (".ckpt",)),
    "pth": ("sovits.pth", (".pth",)),
    "index": ("ref.index", (".index",)),
    "audio": ("reference", (".wav", ".mp3", ".flac", ".ogg")),
}

# 跨进程互斥锁：防止两个 Memo Superform 实例同时使用同一语音资源包
def _acquire_pack_lock(pack_dir):
    """占用资源包级文件锁。返回 (lock_file, acquired)。"""
    lock_path = os.path.join(pack_dir, ".tts.lock")
    f = None
    try:
        os.makedirs(pack_dir, exist_ok=True)
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
        print("[tts] 语音资源包正被另一实例占用，未能获取 .tts.lock 锁", flush=True)
        return None, False
    except Exception:
        if f is not None:
            try:
                f.close()
            except Exception:
                pass
        print("[tts] 获取 .tts.lock 锁失败", flush=True)
        return None, False


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


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _write_json(path, data):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return True
    except OSError:
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
        "voice": _coerce_str(state.get("voice"), "sakiko"),
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


def _role_status(role):
    missing = []
    if not role.get("gpt_file"): missing.append("GPT 模型")
    if not role.get("sovits_file"): missing.append("SoVITS 模型")
    if not role.get("audio_file"): missing.append("参考音频")
    if not str(role.get("reference_text") or "").strip(): missing.append("参考文本")
    if role.get("reference_language") not in LANGUAGE_NUMBER_MAP.values(): missing.append("参考语言")
    if not role.get("live2d_model_id"): missing.append("Live2D 模型")
    return missing


def _public_role(role):
    item = dict(role)
    item.pop("folder", None)
    item["missing"] = _role_status(item)
    item["complete"] = not item["missing"]
    return item


def _copy_if_present(source, target):
    if source and os.path.isfile(source) and not os.path.exists(target):
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(source, target)
        return True
    return False


def ensure_role_library(pack_dir):
    """Create the explicit role registry and migrate the old shared folder once.

    The original files are copied, never moved, so a failed/interrupted migration
    leaves the old resource pack usable.
    """
    existing = _read_json(_roles_path(pack_dir))
    if isinstance(existing, dict) and isinstance(existing.get("roles"), list):
        return existing
    pack = _pack_meta(pack_dir) or {}
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
         "reference_text": sakiko_text, "reference_language": "日文", "live2d_model_id": ""},
        {"role_id": "anon", "name": "千早爱音", "folder": "roles/anon", "gpt_file": "gpt.ckpt",
         "sovits_file": "sovits.pth", "audio_file": "", "index_file": "",
         "reference_text": "", "reference_language": "", "live2d_model_id": ""},
    ]
    state = {"version": 1, "active_role_id": "", "roles": roles}
    _write_json(_roles_path(pack_dir), state)
    return state


def list_roles(pack_dir):
    state = ensure_role_library(pack_dir)
    active = str(state.get("active_role_id") or "")
    return {"active_role_id": active, "roles": [_public_role(role) for role in state.get("roles") or []]}


def _write_roles(pack_dir, state):
    if not _write_json(_roles_path(pack_dir), state):
        raise TTSException("无法保存角色配置")


def _find_role(state, role_id):
    key = _safe_role_id(role_id)
    role = next((item for item in state.get("roles") or [] if item.get("role_id") == key), None)
    if not role:
        raise TTSException("未找到角色: %s" % key)
    return role


def save_role(pack_dir, data):
    state = ensure_role_library(pack_dir)
    role_id = _safe_role_id(data.get("role_id"))
    name = str(data.get("name") or "").strip()
    if not name or len(name) > 64:
        raise TTSException("角色名称不能为空且不能超过 64 个字符")
    role = next((item for item in state["roles"] if item.get("role_id") == role_id), None)
    if role is None:
        role = {"role_id": role_id, "folder": "roles/" + role_id, "gpt_file": "", "sovits_file": "", "audio_file": "", "index_file": ""}
        state["roles"].append(role)
    role.update({"name": name, "reference_text": str(data.get("reference_text") or "").strip(),
                 "reference_language": str(data.get("reference_language") or "").strip(),
                 "live2d_model_id": str(data.get("live2d_model_id") or "").strip()})
    _write_roles(pack_dir, state)
    _reset_manager()
    return _public_role(role)


def upload_role_file(pack_dir, role_id, kind, filename, data):
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
    folder = os.path.join(pack_dir, role["folder"])
    os.makedirs(folder, exist_ok=True)
    target = os.path.join(folder, target_name)
    temp = target + ".tmp"
    with open(temp, "wb") as out:
        out.write(data)
        out.flush()
    os.replace(temp, target)
    role[{"ckpt": "gpt_file", "pth": "sovits_file", "index": "index_file", "audio": "audio_file"}[kind]] = target_name
    _write_roles(pack_dir, state)
    _reset_manager()
    return _public_role(role)


def delete_role(pack_dir, role_id):
    state = ensure_role_library(pack_dir)
    role = _find_role(state, role_id)
    if role.get("role_id") == "sakiko":
        raise TTSException("默认迁移角色不可删除")
    state["roles"].remove(role)
    if state.get("active_role_id") == role["role_id"]:
        state["active_role_id"] = ""
    _write_roles(pack_dir, state)
    _reset_manager()
    return True


def activate_role(pack_dir, role_id):
    state = ensure_role_library(pack_dir)
    role = _find_role(state, role_id)
    missing = _role_status(role)
    if missing:
        raise TTSException("角色资料未配齐: " + "、".join(missing))
    state["active_role_id"] = role["role_id"]
    _write_roles(pack_dir, state)
    _reset_manager()
    return _public_role(role)


def _install_meta(pack_dir):
    return _read_json(os.path.join(pack_dir, "install.json"))


def _venv_python(pack_dir):
    # 仅支持 Windows（Linux 支持已归档到 codex/linux-archived，不再维护）
    return os.path.join(pack_dir, ".venv311", "Scripts", "python.exe")


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
    """install.json 存在且 venv 解释器存在即认为引擎就绪。

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
    return True, ""


def _first_file(directory, patterns):
    if not os.path.isdir(directory):
        return None
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return None
    suffixes = tuple(p.lower() for p in patterns)
    for name in names:
        if name.lower().endswith(suffixes):
            full = os.path.join(directory, name)
            if os.path.isfile(full):
                return full
    return None


def _read_text_file(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return f.read().strip()
    except OSError:
        return ""


def _find_matching_ref_text(folder, ref_audio, voice):
    """参考文本文件名不固定时（如 reference_text_black_sakiko.txt），
    按参考音频文件名自动匹配。"""
    if not ref_audio:
        return ""
    stem = os.path.splitext(os.path.basename(ref_audio))[0].lower()
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        return ""
    # 1) 文件名包含参考音频主干（如 black_sakiko）
    for name in names:
        low = name.lower()
        if low.endswith(".txt") and "language" not in low and stem in low:
            return _read_text_file(os.path.join(folder, name))
    # 2) 任意 reference_text*.txt
    for name in names:
        low = name.lower()
        if low.startswith("reference_text") and low.endswith(".txt"):
            return _read_text_file(os.path.join(folder, name))
    return ""


def _resolve_voice(pack_dir, pack, voice_name):
    """解析音色配置：返回 worker voice 字典；缺失文件时抛出 TTSException。"""
    voices = pack.get("voices") or []
    voice = next((v for v in voices if v.get("name") == voice_name), None)
    if voice is None:
        raise TTSException("未找到音色: %s" % voice_name)

    folder = os.path.join(pack_dir, voice.get("folder", ""))
    model_dir = os.path.join(folder, voice.get("model_dir", "GPT-SoVITS_models"))
    ckpt = _first_file(model_dir, (".ckpt",))
    pth = _first_file(model_dir, (".pth",))
    ref_audio = _first_file(folder, (".wav", ".mp3", ".flac", ".ogg"))
    ref_text_path = os.path.join(folder, voice.get("ref_text", "reference_text.txt"))
    ref_text = _read_text_file(ref_text_path)
    if not ref_text:
        ref_text = _find_matching_ref_text(folder, ref_audio, voice)
    ref_lan = voice.get("ref_language") or "中文"
    lan_file = os.path.join(folder, voice.get("ref_language_file", "reference_audio_language.txt"))
    ref_lan = _read_reference_language(lan_file, ref_lan)

    missing = []
    if not ckpt:
        missing.append("GPT-SoVITS_models/*.ckpt")
    if not pth:
        missing.append("GPT-SoVITS_models/*.pth")
    if not ref_audio:
        missing.append("参考音频 (*.wav/*.mp3)")
    if not ref_text:
        missing.append("reference_text.txt")
    if missing:
        raise TTSException("音色 %s 不完整，缺少: %s" % (voice_name, "、".join(missing)))

    return {
        "name": voice_name,
        "folder": voice.get("folder", ""),
        "gpt_model_path": ckpt,
        "sovits_model_path": pth,
        "ref_audio_path": ref_audio,
        "prompt_text": ref_text,
        "ref_language": ref_lan,
    }


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
    folder = os.path.join(pack_dir, role["folder"])
    paths = {
        "gpt_model_path": os.path.join(folder, role["gpt_file"]),
        "sovits_model_path": os.path.join(folder, role["sovits_file"]),
        "ref_audio_path": os.path.join(folder, role["audio_file"]),
    }
    if not all(os.path.isfile(path) for path in paths.values()):
        raise TTSException("角色资料文件缺失，请重新上传")
    return {"name": role["role_id"], "folder": role["folder"], **paths,
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


_MODEL_FILE_KINDS = {
    "ckpt": (".ckpt", "gpt.ckpt"),
    "pth": (".pth", "sovits.pth"),
    "index": (".index", "ref.index"),
}


def import_model_file(pack_dir, voice_name, kind, data):
    """把一个 GPT-SoVITS 模型文件写入对应音色的模型目录。

    kind 为 ckpt/pth/index；data 为该文件的原始字节。返回写入路径。
    """
    if kind not in _MODEL_FILE_KINDS:
        raise TTSException("未知模型文件类型: %s" % kind)
    if not data:
        raise TTSException("文件内容为空")
    pack = _pack_meta(pack_dir)
    if not pack:
        raise TTSException("语音资源包未就绪（缺少 pack.json）")
    voice = next((v for v in (pack.get("voices") or []) if v.get("name") == voice_name), None)
    if voice is None:
        raise TTSException("未找到音色: %s" % voice_name)
    folder = str(voice.get("folder") or "")
    model_dir = os.path.join(pack_dir, folder, voice.get("model_dir", "GPT-SoVITS_models"))
    os.makedirs(model_dir, exist_ok=True)
    _, target_name = _MODEL_FILE_KINDS[kind]
    target = os.path.join(model_dir, target_name)
    tmp = target + ".tmp"
    with open(tmp, "wb") as out:
        out.write(data)
        out.flush()
    os.replace(tmp, target)
    return target


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
                    self._shutdown_process()
                except Exception:
                    pass
                self._ensure_started()
                return self._send(command, timeout=timeout)

    def _shutdown_process(self):
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
            # 无论 proc 是否为 None 都必须释放资源包锁，避免句柄泄漏
            _release_pack_lock(self._lock_file)
            self._lock_file = None

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
        try:
            result = self._call({
                "type": "synthesize",
                "character_name": voice_name,
                "voice": voice,
                "payload": payload,
            }, timeout=_SYNTH_TIMEOUT)
        finally:
            self._busy = False
        if result.get("type") == "error":
            raise TTSException(result.get("message") or "语音合成失败")
        wav_path = result.get("output_wav_path")
        if not wav_path or not os.path.exists(wav_path):
            raise TTSException("语音合成没有输出音频")
        self._last_status["is_loaded"] = True
        return wav_path

    def preload(self, voice_name="sakiko"):
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
            })
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

    def worker_status(self, voice_name="sakiko"):
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
        # A role id is the modern, explicit configuration.  Keep the legacy
        # pack resolver only for compatibility with old callers/tests.
        try:
            return _resolve_role(self.pack_dir, voice_name)
        except TTSException as role_error:
            state = _read_json(_roles_path(self.pack_dir))
            if state and any(item.get("role_id") == str(voice_name or "") for item in state.get("roles") or []):
                raise role_error
        pack = _pack_meta(self.pack_dir)
        if not pack:
            raise TTSException("未检测到语音资源包")
        return _resolve_voice(self.pack_dir, pack, voice_name)


_MANAGER = None
_MANAGER_LOCK = threading.Lock()


def _reset_manager():
    """Discard cached worker/model after a role asset or selection changes."""
    global _MANAGER
    with _MANAGER_LOCK:
        manager, _MANAGER = _MANAGER, None
    if manager is not None:
        try:
            manager.shutdown()
        except Exception:
            pass


def _get_manager(pack_dir, data_dir):
    global _MANAGER
    with _MANAGER_LOCK:
        if _MANAGER is None:
            _MANAGER = TTSManager(pack_dir, data_dir)
        return _MANAGER


# ---------- 供 server.py 调用的模块级接口 ----------

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
        }
    ready, reason = _engine_ready(pack_dir)
    state = _load_state(data_dir)
    role_library = list_roles(pack_dir)
    voices = [{"name": item["role_id"], "label": item["name"], "language": item.get("reference_language") or "",
               "complete": item["complete"], "missing": item["missing"]} for item in role_library["roles"]]
    worker = {}
    manager = _get_manager(pack_dir, data_dir)
    try:
        if ready and state.get("enabled") and role_library.get("active_role_id"):
            worker = manager.worker_status(role_library["active_role_id"])
    except Exception:
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
        "busy": bool(worker.get("busy") or manager.is_busy),
        "active_role_id": role_library.get("active_role_id") or "",
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
    state["enabled"] = bool(enabled)
    _save_state(data_dir, state)
    manager = _get_manager(pack_dir, data_dir)
    if not enabled:
        manager.shutdown()
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
    voice_name = voice or list_roles(pack_dir).get("active_role_id")
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
    manager = _get_manager(pack_dir, data_dir)
    state = _load_state(data_dir)
    return manager.preload(voice or state.get("voice") or "sakiko")


def shutdown(pack_dir, data_dir):
    manager = _get_manager(pack_dir, data_dir)
    manager.shutdown()
    return True
