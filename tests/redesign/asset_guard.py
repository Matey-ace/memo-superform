"""Snapshot public assets before redesign; never inspect user data directories."""
import argparse
import ast
import hashlib
import json
import pathlib
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / "docs/redesign/source-before"
MANIFEST = EVIDENCE / "assets-sha256.json"
PATTERNS = ("*.html", "js/**/*", "css/**/*", "fonts/**/*", "img/**/*", "vendor/**/*",
            "memo_injection.py", "tests/font-gif-manifest.sha256")
EDITABLE = {
    "js/ui-style.js", "js/charts.js", "memo_injection.py",
    "css/theme-constructivist-tokens.css", "css/theme-constructivist-components.css",
    "css/theme-constructivist-layout.css", "css/maimemo-standard.css",
}
COPIES = ("js/ui-style.js", "js/charts.js", "memo_injection.py", "index.html",
          "css/maimemo-standard.css", "css/style.css", "css/study-web-standard.css")


def assets():
    paths = set()
    for pattern in PATTERNS:
        paths.update(p for p in ROOT.glob(pattern) if p.is_file())
    return {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(paths)}


def protected_fragments():
    records = []

    def record(name, before, after):
        digest = lambda value: hashlib.sha256(value.encode("utf-8")).hexdigest()
        records.append({"fragment": name, "before_sha256": digest(before),
                        "after_sha256": digest(after), "identical": before == after})

    relative = "js/ui-style.js"
    old = (EVIDENCE / relative).read_text(encoding="utf-8")
    new = (ROOT / relative).read_text(encoding="utf-8")
    start = "    } else {\n        css('css/style.css'"
    end = "\n    }\n\n    function applyBody"
    record("ui-style: prefix including entire notebook branch",
           old[:old.index(start)], new[:new.index(start)])
    record("ui-style: body/theme/activation lifecycle",
           old[old.index(end):], new[new.index(end):])

    def constant_string(node):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            return constant_string(node.left) + constant_string(node.right)
        raise ValueError("Expected only a string literal or string concatenation")

    def constants(path):
        result = {}
        for node in ast.parse(path.read_text(encoding="utf-8")).body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1:
                target = node.targets[0]
                if isinstance(target, ast.Name):
                    result[target.id] = constant_string(node.value)
        return result

    before = constants(EVIDENCE / "memo_injection.py")
    after = constants(ROOT / "memo_injection.py")
    for name, value in before.items():
        if name != "MEMO_STUDY_THEME":
            record("injection: " + name, value, after.get(name, ""))
    # Only an insertion after sync setup and before the original theme-class
    # toggles is authorized. Existing paths, fonts and observers remain exact.
    marker = 'root.classList.toggle("memo-notebook",mode==="notebook");'
    old_prefix, old_suffix = before["MEMO_STUDY_THEME"].split(marker, 1)
    new_prefix, new_suffix = after["MEMO_STUDY_THEME"].split(marker, 1)
    record("study-theme: original root/parent discrimination",
           old_prefix, new_prefix[:len(old_prefix)])
    record("study-theme: skin/fonts/observers/pageshow",
           old_suffix, new_suffix)
    records.append({"fragment": "study-theme: insertion point retained",
                    "identical": new_prefix.startswith(old_prefix)})
    relative = "css/maimemo-standard.css"
    old = (EVIDENCE / relative).read_text(encoding="utf-8")
    new = (ROOT / relative).read_text(encoding="utf-8")
    record("study-css: all original rules", old, new[:len(old)])

    relative = "js/charts.js"
    old = (EVIDENCE / relative).read_text(encoding="utf-8")
    new = (ROOT / relative).read_text(encoding="utf-8")
    theme_start = "    function getThemeColors() {"
    record("charts: original palettes and data aggregation",
           old[:old.index(theme_start)], new[:new.index(theme_start)])
    chart_regions = (
        ("setters, rendering ownership and lifecycle", "    function setRecords(",
         "    function renderRecommendationChart("),
        ("recommendation loading and list generation", "    function renderRecommendationChart(",
         "    function recCardHtml("),
        ("recommendation data, events and visible routing", "    function buildRecSummary(",
         "    function getHeatmapPalettes("),
    )
    for name, start, end in chart_regions:
        record("charts: " + name,
               old[old.index(start):old.index(end)],
               new[new.index(start):new.index(end)])
    persistence_start = "    function getPaletteIndex("
    record("charts: palette persistence and public exports",
           old[old.index(persistence_start):], new[new.index(persistence_start):])
    return records


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("snapshot", "verify"))
    args = parser.parse_args()
    if args.mode == "snapshot":
        if MANIFEST.exists():
            parser.error("Refusing to replace original evidence")
        current = assets()
        EVIDENCE.mkdir(parents=True, exist_ok=True)
        for relative in COPIES:
            target = EVIDENCE / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        MANIFEST.write_text(json.dumps({"algorithm": "SHA256", "files": current},
                                      indent=2) + "\n", encoding="utf-8")
        print("SNAPSHOT", len(current), "assets;", len(COPIES), "source copies")
        return 0
    original = json.loads(MANIFEST.read_text(encoding="utf-8"))["files"]
    current = assets()
    changed = sorted(p for p in set(original) | set(current)
                     if original.get(p) != current.get(p))
    forbidden = [p for p in changed if p not in EDITABLE]
    fragments = protected_fragments()
    fragment_failures = [r["fragment"] for r in fragments if not r["identical"]]
    print(json.dumps({"checked": len(original), "changed": changed,
                      "outside_declared_editable_scope": forbidden,
                      "fragments": fragments, "fragment_failures": fragment_failures}, indent=2))
    return 1 if forbidden or fragment_failures else 0


if __name__ == "__main__":
    sys.exit(main())
