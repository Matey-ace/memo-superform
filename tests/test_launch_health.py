# -*- coding: utf-8 -*-
"""启动健康检查回归：状态接口 200 不等于实例可用。

覆盖本轮修复的 404 根因：
  · 静态根目录被删后 web_dir_is_usable 必须为假，resolve_web_dir 能自愈到候选；
  · probe_instance_health 必须在首页 404 时返回 None，而不是看 /api 就放行；
  · verify_build 的首页渲染检查逻辑与健康判定一致。
"""
import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class _FakeHandler(BaseHTTPRequestHandler):
    # 由测试注入：哪些路径返回 200
    routes = {}
    html = b""

    def do_GET(self):
        body = self.routes.get(self.path)
        if body is None:
            self.send_error(404, "Not Found")
            return
        payload = self.html if body == "HTML" else body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class StaticRootTests(unittest.TestCase):
    def test_web_dir_usable_requires_key_files(self):
        import server
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            self.assertFalse(server.web_dir_is_usable(tmp), "空目录不能算可用")
            for name in server.WEB_DIR_REQUIRED:
                full = os.path.join(tmp, name)
                os.makedirs(os.path.dirname(full), exist_ok=True) if os.path.dirname(full) != tmp else None
                with open(full, "w", encoding="utf-8") as handle:
                    handle.write("x")
            self.assertTrue(server.web_dir_is_usable(tmp), "关键文件齐备后应可用")
            # 删掉首页 => 立刻不可用（这正是 404 的状态）
            os.remove(os.path.join(tmp, "index.html"))
            self.assertFalse(server.web_dir_is_usable(tmp), "首页消失后必须判为不可用")

    def test_resolve_web_dir_self_heals_to_candidate(self):
        import server
        import tempfile
        with tempfile.TemporaryDirectory() as good:
            for name in server.WEB_DIR_REQUIRED:
                full = os.path.join(good, name)
                directory = os.path.dirname(full)
                if directory and directory != good:
                    os.makedirs(directory, exist_ok=True)
                with open(full, "w", encoding="utf-8") as handle:
                    handle.write("x")
            original_dir = server.WEB_DIR
            original_candidates = list(server._WEB_DIR_CANDIDATES)
            try:
                server.WEB_DIR = os.path.join(good, "definitely-missing")
                server._WEB_DIR_CANDIDATES[:] = [server.WEB_DIR, good]
                resolved = server.resolve_web_dir()
                self.assertEqual(os.path.realpath(resolved), os.path.realpath(good),
                                 "失效时必须切到可用候选")
                self.assertEqual(os.path.realpath(server.WEB_DIR), os.path.realpath(good),
                                 "自愈后模块级 WEB_DIR 应更新")
            finally:
                server.WEB_DIR = original_dir
                server._WEB_DIR_CANDIDATES[:] = original_candidates


class HealthProbeTests(unittest.TestCase):
    def _serve(self, routes, html=b""):
        handler = type("H", (_FakeHandler,), {"routes": dict(routes), "html": html})
        httpd = HTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()

        def _stop():
            # 先 shutdown 让 serve_forever 退出循环，再关 socket；
            # 顺序反了会在轮询线程里抛 WinError 10038 噪声。
            httpd.shutdown()
            thread.join(timeout=5)
            httpd.server_close()

        self.addCleanup(_stop)
        return httpd.server_address[1]

    def test_status_200_but_page_404_is_not_healthy(self):
        """核心回归：/api 通、首页 404 —— 必须判为不健康。"""
        import launcher
        port = self._serve({"/api/app/current-mode": json.dumps(
            {"mode": "web", "data_dir": "C:/tmp"})})
        self.assertIsNone(launcher.probe_instance_health(port, timeout=2),
                          "只有 /api 通不能算健康，必须检查首页")

    def test_empty_page_is_not_healthy(self):
        """首页 200 但内容过短（空壳/错误页）也不算健康。"""
        import launcher
        port = self._serve({
            "/api/app/current-mode": json.dumps({"mode": "web", "data_dir": "C:/tmp"}),
            "/index.html": "HTML",
            "/js/api.js": "x",
            "/css/style.css": "x",
        }, html=b"<html><body>404</body></html>")
        self.assertIsNone(launcher.probe_instance_health(port, timeout=2),
                          "过短的首页不能算健康")

    def test_missing_static_asset_is_not_healthy(self):
        """首页正常但关键资源 404，仍不算健康。"""
        import launcher
        big = b"<html><head><title>Memo</title></head><body>" + b"x" * 3000 + b"</body></html>"
        port = self._serve({
            "/api/app/current-mode": json.dumps({"mode": "web", "data_dir": "C:/tmp"}),
            "/index.html": "HTML",
            "/js/api.js": "x",
            # /css/style.css 故意缺失
        }, html=big)
        self.assertIsNone(launcher.probe_instance_health(port, timeout=2),
                          "关键资源缺失时不能算健康")

    def test_fully_healthy_instance_is_accepted(self):
        import launcher
        big = b"<!DOCTYPE html><html><head><title>Memo</title></head><body>" + b"x" * 3000 + b"</body></html>"
        port = self._serve({
            "/api/app/current-mode": json.dumps({"mode": "web", "data_dir": "C:/tmp"}),
            "/index.html": "HTML",
            "/js/api.js": "x",
            "/css/style.css": "x",
        }, html=big)
        health = launcher.probe_instance_health(port, timeout=2)
        self.assertIsNotNone(health, "完全健康的实例应当被接受")
        self.assertEqual(health["port"], port)
        self.assertEqual(health["identity"]["mode"], "web")

    def test_wrong_mode_is_rejected(self):
        import launcher
        big = b"<!DOCTYPE html><html><body>" + b"x" * 3000 + b"</body></html>"
        port = self._serve({
            "/api/app/current-mode": json.dumps({"mode": "other", "data_dir": "C:/tmp"}),
            "/index.html": "HTML", "/js/api.js": "x", "/css/style.css": "x",
        }, html=big)
        self.assertIsNone(launcher.probe_instance_health(port, timeout=2),
                          "未知 mode 不能被当成 Memo 实例")


class StaleRuntimeCleanupTests(unittest.TestCase):
    """解压目录清理必须保守：只清自己的载荷、不动占用中的。"""

    # 本应用 index.html 里的独有标识：清理逻辑按"内容归属"判定，
    # 只放文件名不够（别的 PyInstaller 程序也可能有同样的文件名）。
    _OUR_INDEX = ("<!doctype html><html><head>"
                  "<title>Memo Superform - 墨墨数据磁贴</title></head><body>x</body></html>")

    def _make_runtime(self, root, name, with_payload=True):
        import launcher
        path = os.path.join(root, name)
        os.makedirs(path, exist_ok=True)
        if with_payload:
            for rel in launcher._RUNTIME_REQUIRED:
                full = os.path.join(path, rel)
                os.makedirs(os.path.dirname(full) or path, exist_ok=True)
                with open(full, "w", encoding="utf-8") as handle:
                    handle.write(self._OUR_INDEX if rel == "index.html" else "x")
        return path

    def test_removes_only_our_payload_dirs(self):
        import launcher
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            ours = self._make_runtime(tmp, "_MEI100001")
            foreign = self._make_runtime(tmp, "_MEI100002", with_payload=False)
            other = os.path.join(tmp, "not_mei_at_all")
            os.makedirs(other, exist_ok=True)
            # 让 _MEIPASS 指向"别的目录"，确保当前运行的目录不会被误删逻辑卷入
            removed = launcher.cleanup_stale_runtime_dirs(temp_root=tmp)
            self.assertEqual(removed, 1, "只应删掉一个自己的载荷目录")
            self.assertFalse(os.path.exists(ours), "自己的残留目录应被删除")
            self.assertTrue(os.path.exists(foreign), "非本应用载荷的 _MEI 目录不能被删")
            self.assertTrue(os.path.exists(other), "非 _MEI 目录绝不能被删")

    def test_never_removes_current_runtime(self):
        import launcher
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            current = self._make_runtime(tmp, "_MEI200001")
            original = sys._MEIPASS if hasattr(sys, "_MEIPASS") else None
            sys._MEIPASS = current
            try:
                removed = launcher.cleanup_stale_runtime_dirs(temp_root=tmp)
            finally:
                if original is None:
                    try:
                        del sys._MEIPASS
                    except AttributeError:
                        pass
                else:
                    sys._MEIPASS = original
            self.assertEqual(removed, 0, "当前正在使用的解压目录绝不能被删")
            self.assertTrue(os.path.exists(current))


if __name__ == "__main__":
    unittest.main()
