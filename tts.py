#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tts.py - 语音资源包检测与 TTS 引擎接口（预留）

当前版本只实现资源包检测（data/tts_pack/pack.json）与状态上报；
GPT-SoVITS 推理引擎按“语音资源包”方案另行接入。
"""

import json
import os


def scan_pack(pack_dir):
    """读取资源包 pack.json；未找到或格式非法返回 None。"""
    pack_json = os.path.join(pack_dir, "pack.json")
    try:
        with open(pack_json, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return None
        return data
    except (OSError, ValueError):
        return None


def get_status(pack_dir):
    pack = scan_pack(pack_dir)
    if pack is None:
        return {
            "enabled": False,
            "pack_ready": False,
            "pack_path": pack_dir,
            "version": None,
            "voices": [],
            "device": None,
            "busy": False,
            "reason": "未检测到语音资源包（请将资源包放到 %s 并确保包含 pack.json）" % pack_dir,
        }
    voices = pack.get("voices")
    return {
        "enabled": False,
        "pack_ready": True,
        "pack_path": pack_dir,
        "version": pack.get("version"),
        "voices": voices if isinstance(voices, list) else [],
        "device": None,
        "busy": False,
        "reason": "资源包已就绪，语音引擎尚未接入",
    }
