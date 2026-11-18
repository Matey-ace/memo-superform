# -*- coding: utf-8 -*-
"""生成用于测试与试用演示的真实角色包 ZIP。

**故意使用真实 sha256 与真实文件内容**：本仓库不接受「假数据跑通」的验收。
生成器自身只写二进制占位内容（模型权重无法在测试里真跑），但压缩结构、清单
字段、摘要算法、路径布局与生产包完全一致，因此安装链路是被真实校验的。

用法::

    python tests/fixtures/make_role_package.py --out D:/tmp/roles --mode full --count 2
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import zipfile
from typing import Any, Optional

GPT_PLACEHOLDER = b"\x00" * 1024
SOVITS_PLACEHOLDER = b"\x01" * 1024


def _wav_bytes(seconds: float = 0.4, rate: int = 16000) -> bytes:
    """一个最小的合法 16-bit 单声道 WAV，含真实头部。"""
    frames = int(rate * seconds)
    data_size = frames * 2
    header = b"RIFF" + struct.pack("<I", 36 + data_size) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
    header += b"data" + struct.pack("<I", data_size)
    return header + b"\x00\x00" * frames


def persona_document(name: str, *, with_version: bool = True) -> dict[str, Any]:
    payload = {
        "角色": name,
        "背景": "%s 是 MeMo 的长期陪伴角色，负责陪你走完当天的词汇任务。" % name,
        "语气": "温和、克制，先承认你做到的事，再给一句具体建议。",
        "禁忌": "不催进度，不做对比，不评价成绩高低。",
        # 人设文档的每个字段都必须是一段文本（不是数组）；多句用换行分隔。
        "示例": "今天的 20 个词你已经过了一遍，剩下的明天再来。\n"
                "这一轮错在拼写上，我记下来了，明天先看它们。",
    }
    if with_version:
        payload["版本"] = 1
    return payload


def role_files(name: str, role_id: str, *, complete: bool = True) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    if complete:
        files["gpt.ckpt"] = GPT_PLACEHOLDER
        files["sovits.pth"] = SOVITS_PLACEHOLDER
        files["ref.index"] = b"\x02" * 128
        files["reference.wav"] = _wav_bytes()
    files["persona.json"] = json.dumps(
        persona_document(name, with_version=False), ensure_ascii=False, indent=2).encode("utf-8")
    return files


def manifest(name: str, role_id: str, **extra: Any) -> dict[str, Any]:
    payload = {
        "schema": 1,
        "name": name,
        "角色": name,
        "role_id": role_id,
        "version": "2026.11.16",
        "reference_text": "这是一段用于音色参考的中文朗读文本。",
        # 必须用 tts.LANGUAGE_NUMBER_MAP 里的中文标签值；写 "zh" 会被完整性检查
        # 判为无效语言，角色永远不完整。清单里显式声明 live2d_model_id 才能装成
        # 完整角色；留空只作草稿。
        "reference_language": "中文",
        # 测试数据目录里没有真实模型：这里放一个显式占位 ID，只为满足
        # ``_role_status`` 的「非空」判定。真实安装请填已注册的 live2d_models
        # 里的 model_id，否则角色会指向不存在的模型。
        "live2d_model_id": "fixture-live2d-placeholder",
        "author": "MeMo test fixture",
        "license": "CC0-1.0",
    }
    payload.update(extra)
    return payload


def build_zip(out_path: str, roles: list[dict[str, Any]], *,
              layout: str = "multi") -> str:
    """写出 ZIP。

    ``layout="multi"``：每个角色一个子目录（一个包多角色）。
    ``layout="single"``：文件放在包根，manifest 在根。
    """
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for role in roles:
            root = role["role_id"] if layout == "multi" else ""
            prefix = (root + "/") if root else ""
            for rel_name, content in role["files"].items():
                zf.writestr(prefix + rel_name, content)
            zf.writestr(prefix + "role.json",
                        json.dumps(role["manifest"], ensure_ascii=False, indent=2))
    return out_path


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def make_full(out_dir: str, count: int = 2, *, layout: str = "multi") -> str:
    """完整角色包：全部必备资源齐全，可安装为可用角色。"""
    roles = []
    for index in range(1, count + 1):
        name = "陪伴角色 %d" % index
        role_id = "demo-role-%02d" % index
        roles.append({
            "role_id": role_id,
            "files": role_files(name, role_id, complete=True),
            "manifest": manifest(name, role_id),
        })
    return build_zip(os.path.join(out_dir, "role-pack-full.zip"), roles, layout=layout)


def make_draft(out_dir: str) -> str:
    """草稿包：缺音频与参考文本，应装成草稿并在检查阶段提示缺项。"""
    name = "草稿角色"
    role_id = "demo-draft-01"
    files = role_files(name, role_id, complete=False)
    entry = {"role_id": role_id, "files": files,
             "manifest": manifest(name, role_id, reference_text="")}
    return build_zip(os.path.join(out_dir, "role-pack-draft.zip"), [entry], layout="single")


def make_broken_hash(out_dir: str) -> str:
    """故意让 ZIP 内容与随附摘要不符，用于验证「确认前重核包身份」。"""
    path = make_full(out_dir, count=1)
    sidecar = path + ".sha256"
    with open(sidecar, "w", encoding="utf-8") as handle:
        handle.write("0" * 64 + "\n")
    return path


def make_traversal(out_dir: str) -> str:
    """含 ``../`` 越界路径的恶意包，必须被拒绝。"""
    path = os.path.join(out_dir, "role-pack-traversal.zip")
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("../../evil.txt", b"pwned")
        zf.writestr("role.json", json.dumps(manifest("越界包", "demo-evil-01"),
                                            ensure_ascii=False))
    return path


def make_duplicate(out_dir: str) -> str:
    """同一 role_id 出现两次，用于验证重复角色的处理。"""
    name = "重复角色"
    role_id = "demo-dup-01"
    entry = {"role_id": role_id, "files": role_files(name, role_id),
             "manifest": manifest(name, role_id)}
    path = os.path.join(out_dir, "role-pack-duplicate.zip")
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("a/role.json", json.dumps(manifest(name, role_id), ensure_ascii=False))
        zf.writestr("a/persona.json", entry["files"]["persona.json"])
        zf.writestr("b/role.json", json.dumps(manifest(name, role_id), ensure_ascii=False))
        zf.writestr("b/persona.json", entry["files"]["persona.json"])
    return path


MODES = {
    "full": make_full,
    "draft": make_draft,
    "broken-hash": make_broken_hash,
    "traversal": make_traversal,
    "duplicate": make_duplicate,
}


def build(out_dir: str, mode: str = "full", *, count: int = 2,
          layout: str = "multi") -> str:
    if mode == "full":
        return make_full(out_dir, count=count, layout=layout)
    if mode not in MODES:
        raise SystemExit("未知模式：%s（可选：%s）" % (mode, ", ".join(MODES)))
    return MODES[mode](out_dir)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="生成 MeMo 角色包测试样本")
    parser.add_argument("--out", default=".", help="输出目录")
    parser.add_argument("--mode", default="full", choices=sorted(MODES))
    parser.add_argument("--count", type=int, default=2, help="full 模式生成几个角色")
    parser.add_argument("--layout", default="multi", choices=("multi", "single"))
    args = parser.parse_args(argv)
    path = build(args.out, args.mode, count=max(1, args.count), layout=args.layout)
    print(path)
    print(sha256_file(path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())