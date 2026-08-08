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
import os
import queue
import re
import subprocess
import threading
import time
import uuid


LANGUAGE_NUMBER_MAP = {
    "1": "中文", "2": "英文", "3": "日文", "4": "粤语", "5": "韩文",
    "6": "中英混合", "7": "日英混合", "8": "粤英混合", "9": "韩英混合",
    "10": "多语种混合", "11": "多语种混合(粤语)",
}


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


def _load_state(data_dir):
    state = _read_json(_state_path(data_dir)) or {}
    return {
        "enabled": bool(state.get("enabled")),
        "voice": state.get("voice") or "sakiko",
        "language": state.get("language") or "中英混合",
        "speed": float(state.get("speed") or 1.0),
    }


def _save_state(data_dir, state):
    return _write_json(_state_path(data_dir), state)


def _pack_meta(pack_dir):
    return _read_json(os.path.join(pack_dir, "pack.json"))


def _install_meta(pack_dir):
    return _read_json(os.path.join(pack_dir, "install.json"))


def _venv_python(pack_dir):
    return os.path.join(pack_dir, ".venv311", "Scripts", "python.exe")


def _engine_ready(pack_dir):
    """install.json 存在且 venv 解释器存在即认为引擎就绪。"""
    meta = _install_meta(pack_dir)
    if not meta or not meta.get("installed"):
        return False, "资源包尚未安装，请先运行 setup.bat 完成安装"
    if not os.path.exists(_venv_python(pack_dir)):
        return False, "未找到 .venv311 解释器，请重新运行 setup.bat"
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
    raw_lan = _read_text_file(lan_file)
    if raw_lan and raw_lan in LANGUAGE_NUMBER_MAP:
        ref_lan = LANGUAGE_NUMBER_MAP[raw_lan]

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


def clean_text(text):
    """清洗待合成文本：去括号/引号，空文本抛错。"""
    cleaned = re.sub(r"[（(].*?[)）]", "", str(text))
    cleaned = cleaned.replace("「", "").replace("」", "")
    cleaned = re.sub(r"[\[\]【】]", "", cleaned)
    cleaned = cleaned.strip()
    cleaned = re.sub(r"^[^A-Za-z0-9\u3040-\u30FF\u4E00-\u9FFF]+", "", cleaned)
    cleaned = cleaned.replace(" ", "")
    cleaned = cleaned.replace("...", "，")
    if not cleaned or re.fullmatch(r"[\W_]+", cleaned):
        raise TTSException("文本为空或无法合成语音")
    return cleaned


class TTSManager:
    """管理 GPT-SoVITS worker 子进程（JSON 行协议）。"""

    def __init__(self, pack_dir, data_dir):
        self.pack_dir = pack_dir
        self.data_dir = data_dir
        self._proc = None
        self._pending = {}
        self._pending_lock = threading.Lock()
        self._cmd_lock = threading.RLock()
        self._reader = None
        self._busy = False
        self._last_status = {}

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
            raise TTSException("未找到 .venv311 解释器，请重新运行 setup.bat")
        if not os.path.exists(worker_main):
            raise TTSException("资源包缺少 tts_engine/worker_main.py")

        env = os.environ.copy()
        # 子进程 stdin/stdout 统一使用 UTF-8，避免中文 Windows(GBK) 环境下 JSON 乱码
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
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

    def _call(self, command, timeout=None):
        """带一次自动重启的调用。"""
        with self._cmd_lock:
            self._ensure_started()
            try:
                return self._send(command, timeout=timeout)
            except TTSException:
                raise
            except Exception as exc:
                # 进程崩溃等情况：重启一次再试
                try:
                    self._shutdown_process()
                except Exception:
                    pass
                self._ensure_started()
                return self._send(command, timeout=timeout)

    def _shutdown_process(self):
        if self._proc is not None and self._proc.poll() is None:
            try:
                self._proc.stdin.write(json.dumps({"type": "shutdown"}) + "\n")
                self._proc.stdin.flush()
                self._proc.wait(timeout=15)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
        self._proc = None

    # ---------- 对外操作 ----------

    def synthesize(self, text, voice_name, language="中文", speed=1.0):
        voice = self._resolve_voice_config(voice_name)
        payload = {
            "text": text,
            "text_language": language,
            "ref_audio_path": voice["ref_audio_path"],
            "prompt_text": voice["prompt_text"],
            "ref_language": voice["ref_language"],
            "output_dir": os.path.join(self.data_dir, "generated_audios"),
            "speed_factor": float(speed),
            "fragment_interval": 0.5,
            "text_split_method": "cut0",
            "top_k": 15,
            "seed": -1,
            "use_cuda_graph": False,
            "parallel_infer": False,
        }
        self._busy = True
        try:
            result = self._call({
                "type": "synthesize",
                "character_name": voice_name,
                "voice": voice,
                "payload": payload,
            })
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
            if self._proc is not None and self._proc.poll() is None:
                self._shutdown_process()

    def _resolve_voice_config(self, voice_name):
        pack = _pack_meta(self.pack_dir)
        if not pack:
            raise TTSException("未检测到语音资源包")
        return _resolve_voice(self.pack_dir, pack, voice_name)


_MANAGER = None
_MANAGER_LOCK = threading.Lock()


def _get_manager(pack_dir, data_dir):
    global _MANAGER
    with _MANAGER_LOCK:
        if _MANAGER is None:
            _MANAGER = TTSManager(pack_dir, data_dir)
        return _MANAGER


# ---------- 供 server.py 调用的模块级接口 ----------

def get_status(pack_dir, data_dir):
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
    voices = []
    for voice in pack.get("voices") or []:
        voices.append({
            "name": voice.get("name"),
            "label": voice.get("label") or voice.get("name"),
            "language": voice.get("ref_language") or pack.get("default_language") or "中文",
        })
    worker = {}
    manager = _get_manager(pack_dir, data_dir)
    try:
        if ready and state.get("enabled"):
            worker = manager.worker_status(state.get("voice") or "sakiko")
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


def speak(pack_dir, data_dir, text, voice=None, language=None, speed=None):
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
    voice_name = voice or state.get("voice") or "sakiko"
    language = language or state.get("language") or "中文"
    speed = speed if speed is not None else state.get("speed") or 1.0
    manager = _get_manager(pack_dir, data_dir)
    if manager.is_busy:
        raise TTSException("正在合成中，请稍候")
    wav_path = manager.synthesize(cleaned, voice_name, language, speed)
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
