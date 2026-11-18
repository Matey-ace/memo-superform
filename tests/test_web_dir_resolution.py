# -*- coding: utf-8 -*-
"""确认静态根目录的判定语义，并诚实记录 onefile 下的能力边界。

重点不是"resolve_web_dir 能自愈"，而是：
 1. 它能准确判断"这个目录还能不能服务页面"；
 2. onefile 布局下不存在第二份可用资源，所以它**不可能**自愈——
    真正兜底的是 launcher 的健康判定 + 精确重启。
把这条写成测试，避免以后有人误以为加了候选目录就万事大吉。
"""
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import server  # noqa: E402


class WebDirUsabilityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="memo-webdir-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _make_full(self, base):
        os.makedirs(os.path.join(base, "js"), exist_ok=True)
        os.makedirs(os.path.join(base, "css"), exist_ok=True)
        for rel in ("index.html", "index-anon.html", "js/api.js", "css/style.css"):
            with open(os.path.join(base, rel), "w", encoding="utf-8") as handle:
                handle.write("<html>ok</html>")

    def test_rejects_missing_directory(self):
        self.assertFalse(server.web_dir_is_usable(os.path.join(self.tmp, "nope")))

    def test_rejects_empty_directory(self):
        empty = os.path.join(self.tmp, "empty")
        os.makedirs(empty)
        self.assertFalse(server.web_dir_is_usable(empty))

    def test_rejects_directory_missing_any_required_file(self):
        base = os.path.join(self.tmp, "partial")
        self._make_full(base)
        os.remove(os.path.join(base, "index.html"))
        self.assertFalse(server.web_dir_is_usable(base),
                         "缺 index.html 必须判不可用——这正是 404 的形态")

    def test_accepts_complete_directory(self):
        base = os.path.join(self.tmp, "full")
        self._make_full(base)
        self.assertTrue(server.web_dir_is_usable(base))

    def test_rejects_none(self):
        self.assertFalse(server.web_dir_is_usable(None))


class OneFileLayoutBoundaryTests(unittest.TestCase):
    """把"onefile 下没有第二份资源"这条事实钉住。

    如果哪天打包方式改成 onedir（exe 同级出现 index.html），这条会失败，
    提醒维护者：候选目录开始真正起作用了，可以更新这里的说明。
    """

    def test_no_fallback_resources_next_to_a_onefile_executable(self):
        # 仓库根的 dist/ 就是 onefile 产物目录
        dist = os.path.join(ROOT, "dist")
        if not os.path.isdir(dist):
            self.skipTest("dist/ 不存在，跳过")
        self.assertFalse(
            os.path.isfile(os.path.join(dist, "index.html")),
            "onefile 产物目录里不应有 index.html；若出现说明已改为 onedir",
        )
        self.assertFalse(
            os.path.isdir(os.path.join(dist, "_internal")),
            "onefile 产物目录里不应有 _internal；若出现说明已改为 onedir",
        )

    def test_fallback_candidates_are_dead_code_under_onefile(self):
        """候选目录在 onefile 下不可用，因此 resolve_web_dir 只能检测不能自愈。

        这不是缺陷，是能力边界；写下来防止把"检测"当成"自愈"。
        """
        import importlib
        importlib.reload(server)
        if not getattr(sys, "frozen", False):
            self.skipTest("源码模式下 sys.frozen 为假，候选路径语义不同")
        for candidate in server._WEB_DIR_CANDIDATES[1:]:
            self.assertFalse(
                server.web_dir_is_usable(candidate),
                "onefile 下不应存在可用的第二份资源目录: %s" % candidate,
            )


if __name__ == "__main__":
    unittest.main()
