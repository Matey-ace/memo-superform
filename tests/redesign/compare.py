# -*- coding: utf-8 -*-
"""截图比对工具。

用途有两类，语义完全不同，绝不混用：

1. **禁区零差异证明**（`identical`）
   手账主题 / Live2D 陪伴模式的截图，改动前后必须**逐像素完全相同**。
   任何非零差异都是违规，必须回滚。

2. **主主题变化证明**（`changed`）
   主主题截图改动前后**必须**有显著差异，否则说明样式没有生效。

用法：
    python tests/redesign/compare.py identical <dirA> <dirB>
    python tests/redesign/compare.py changed   <dirA> <dirB> [--min-ratio 0.02]

按文件名匹配两个目录中的 PNG（忽略 tag 前缀差异），输出逐张结论并汇总。
退出码：0 = 全部符合预期，1 = 存在不符合项。
"""
import argparse
import json
import pathlib
import sys

try:
    from PIL import Image, ImageChops
except ImportError:
    print("需要 Pillow", file=sys.stderr)
    raise


def load(path):
    return Image.open(path).convert("RGB")


def diff_stats(a, b):
    """返回 (不同像素数, 总像素数, 差异比例)。尺寸不同直接视为全不同。"""
    if a.size != b.size:
        return (max(a.size[0] * a.size[1], b.size[0] * b.size[1]),
                max(a.size[0] * a.size[1], b.size[0] * b.size[1]),
                1.0)
    delta = ImageChops.difference(a, b)
    # 允许极小的抗锯齿抖动？不。禁区证明要求严格相等，这里给出精确值，
    # 由调用方决定如何解读。
    bbox = delta.getbbox()
    total = a.size[0] * a.size[1]
    if bbox is None:
        return (0, total, 0.0)
    # Count a pixel if ANY channel differs; luminance conversion can round a
    # one-level blue-channel difference to zero and falsely report equality.
    red, green, blue = delta.split()
    mask = ImageChops.lighter(ImageChops.lighter(red, green), blue)
    nonzero = total - mask.histogram()[0]
    return (nonzero, total, nonzero / total)


def normalize(name):
    """去掉 tag 前缀，只保留 view@theme@res.png 用于跨轮次匹配。"""
    stem = name[len("baseline-"):] if name.startswith("baseline-") else name
    if stem.startswith("after-"):
        stem = stem[len("after-"):]
    return stem


def index_dir(folder):
    out = {}
    for path in sorted(folder.glob("*.png")):
        out[normalize(path.name)] = path
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["identical", "changed"])
    parser.add_argument("dir_a")
    parser.add_argument("dir_b")
    parser.add_argument("--min-ratio", type=float, default=0.02)
    parser.add_argument("--json-out")
    args = parser.parse_args()

    dir_a = pathlib.Path(args.dir_a)
    dir_b = pathlib.Path(args.dir_b)
    a_map, b_map = index_dir(dir_a), index_dir(dir_b)

    only_a = sorted(set(a_map) - set(b_map))
    only_b = sorted(set(b_map) - set(a_map))
    common = sorted(set(a_map) & set(b_map))

    rows = []
    failures = 0
    if not dir_a.is_dir() or not dir_b.is_dir():
        print("! Both input directories must exist.")
        failures += 1
    if not common:
        print("! No matching screenshots; equality cannot be established.")
        failures += 1

    print("mode =", args.mode)
    print("A =", dir_a, "(%d png)" % len(a_map))
    print("B =", dir_b, "(%d png)" % len(b_map))
    if only_a:
        print("! 仅 A 有:", only_a)
    if only_b:
        print("! 仅 B 有:", only_b)

    for name in common:
        img_a, img_b = load(a_map[name]), load(b_map[name])
        nonzero, total, ratio = diff_stats(img_a, img_b)

        if args.mode == "identical":
            ok = (nonzero == 0)
            verdict = "IDENTICAL" if ok else "DIFF %d px (%.4f%%)" % (nonzero, ratio * 100)
        else:
            ok = (ratio >= args.min_ratio)
            verdict = "CHANGED %.2f%%" % (ratio * 100) if ok else "UNCHANGED (%.4f%%)" % (ratio * 100)

        if not ok:
            failures += 1
        print("  %-52s %-34s %s" % (name, "%dx%d" % img_a.size, verdict))
        rows.append({
            "file": name,
            "size": list(img_a.size),
            "diff_pixels": nonzero,
            "total_pixels": total,
            "ratio": round(ratio, 6),
            "ok": ok,
            "verdict": verdict,
        })

    if only_a or only_b:
        # 文件集合不一致本身也算失败：说明某一轮漏拍或改名。
        failures += len(only_a) + len(only_b)

    print()
    print("checked=%d failures=%d" % (len(common), failures))
    print("RESULT:", "PASS" if failures == 0 else "FAIL")

    if args.json_out:
        pathlib.Path(args.json_out).write_text(json.dumps({
            "mode": args.mode,
            "dir_a": str(dir_a),
            "dir_b": str(dir_b),
            "only_a": only_a,
            "only_b": only_b,
            "rows": rows,
            "failures": failures,
        }, ensure_ascii=False, indent=2), encoding="utf-8")

    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())