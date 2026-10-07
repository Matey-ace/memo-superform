"""Record per-file review boundaries; execution never implies a full source audit."""
import csv
import hashlib
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "quality-coverage.csv"
REVIEWED = {
    "app.py", "build_info.py", "diagnostics.py", "static_security.py", "release-guards.ps1",
    "requirements-build.lock", "package.json", "package-lock.json", ".github/workflows/regression.yml",
    "tests/quality_coverage.py", "docs/quality-hardening.md", "docs/quality-runtime.json",
    ".github/workflows/pages.yml", "docs/maimemo-open-platform-submission.md",
}
PATH_REVIEW = {
    "app_api.py", "app_update.py", "codex_auth.py", "db.py", "launcher.py", "live2d_service.py",
    "maimemo_auth.py", "server.py", "study_sync.py", "tts.py", "recommender.py", "memo_proxy.py",
    "memo_injection.py", "windows_tray.py", "MemoSuperform.spec", "release.ps1",
    "README.md", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md", "css/diary.css", ".gitignore",
}


def status_for(name):
    if name == "LICENSE":
        return "排除", "标准 AGPL-3.0 许可全文；保留原文，不作为应用代码审查"
    if name.startswith("_archive/"):
        return "排除", "历史归档；不进入当前构建"
    if name.startswith(("vendor/", "fonts/", "img/")):
        return "排除", "第三方组件/字体/素材；记录资源摘要，未逐行审查，声明与运行另验"
    if name == "docs/quality-coverage.csv":
        return "已审查", "生成的覆盖清单；摘要留空避免自引用"
    if name in REVIEWED:
        return "已审查", "本轮阅读或新增的完整小文件；详见问题总账"
    if name.startswith("tests/"):
        return "部分审查", "统一入口已执行；新增行为用例已审阅，既有用例不视为逐行覆盖"
    if name in PATH_REVIEW or name.startswith("js/"):
        return "部分审查", "重点故障路径、生命周期和相应差异已检查；全文件审查仍保留边界"
    if name.endswith((".html", ".sql")) or name.startswith("css/"):
        return "部分审查", "已检验关联入口/数据/样式路径；完整视觉和逐行验收仍待完成"
    return "待审查", "已盘点；本轮未形成完整阅读与验证证据"


def main():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.touch(exist_ok=True)
    result = subprocess.run(["git", "ls-files", "-c", "-o", "--exclude-standard", "-z"],
                            cwd=ROOT, check=True, capture_output=True)
    names = sorted(set(result.stdout.decode("utf-8").strip("\0").split("\0")))
    rows = []
    for name in names:
        path = ROOT / name
        status, reason = status_for(name)
        size = digest = ""
        if path.is_file() and path.resolve().is_relative_to(ROOT) and path != OUTPUT:
            size = path.stat().st_size
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
        rows.append([name, status, reason, size, digest])
    with OUTPUT.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["path", "review_status", "scope_and_reason", "bytes", "sha256"])
        writer.writerows(rows)
    print("COVERAGE_FILES=" + str(len(rows)))


if __name__ == "__main__":
    main()
