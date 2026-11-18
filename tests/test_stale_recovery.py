# -*- coding: utf-8 -*-
"""残留实例恢复：必须精确定位，绝不按进程名批量杀。

这些测试都不真的结束进程，只验证定位逻辑与拒绝条件。
"""
import os
import socket
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import launcher  # noqa: E402


class LockOwnerLookupTests(unittest.TestCase):
    """_lock_owner_pid 只看"谁监听在本应用私有端口上"，不看进程名。"""

    def test_finds_listening_pid_for_the_lock_port(self):
        fake_netstat = (
            "\r\n"
            "Active Connections\r\n"
            "\r\n"
            "  Proto  Local Address          Foreign Address        State           PID\r\n"
            "  TCP    127.0.0.1:15191        0.0.0.0:0              LISTENING       4242\r\n"
            "  TCP    127.0.0.1:8888         0.0.0.0:0              LISTENING       5151\r\n"
        )
        completed = mock.Mock(stdout=fake_netstat)
        with mock.patch("subprocess.run", return_value=completed):
            self.assertEqual(launcher._lock_owner_pid(15191), 4242)

    def test_ignores_established_connections_on_the_same_port(self):
        # 只认 LISTENING：客户端连过来的 ESTABLISHED 行不能当成锁持有者。
        fake_netstat = (
            "  TCP    127.0.0.1:15191        127.0.0.1:50000        ESTABLISHED    9999\r\n"
            "  TCP    127.0.0.1:15191        0.0.0.0:0              LISTENING       4242\r\n"
        )
        completed = mock.Mock(stdout=fake_netstat)
        with mock.patch("subprocess.run", return_value=completed):
            self.assertEqual(launcher._lock_owner_pid(15191), 4242)

    def test_returns_none_when_nobody_listens(self):
        completed = mock.Mock(stdout="  TCP    127.0.0.1:8888         0.0.0.0:0              LISTENING       5151\r\n")
        with mock.patch("subprocess.run", return_value=completed):
            self.assertIsNone(launcher._lock_owner_pid(15191))

    def test_returns_none_when_netstat_unavailable(self):
        with mock.patch("subprocess.run", side_effect=OSError("no netstat")):
            self.assertIsNone(launcher._lock_owner_pid(15191))

    def test_does_not_match_a_longer_port_number(self):
        # 151910 不能因为以 ":15191" 结尾而被误认
        completed = mock.Mock(stdout="  TCP    127.0.0.1:151910       0.0.0.0:0              LISTENING       7777\r\n")
        with mock.patch("subprocess.run", return_value=completed):
            self.assertIsNone(launcher._lock_owner_pid(15191))


class PidIdentityTests(unittest.TestCase):
    """结束进程前必须确认映像确实是本应用。"""

    def test_rejects_foreign_process_by_name(self):
        completed = mock.Mock(stdout='"chrome.exe","1234","Console","1","100,000 K"\r\n')
        with mock.patch("subprocess.run", return_value=completed):
            self.assertFalse(launcher._pid_is_our_executable(1234))

    def test_accepts_the_shipped_executable_name(self):
        completed = mock.Mock(stdout='"MemoSuperform.exe","1234","Console","1","100,000 K"\r\n')
        with mock.patch("subprocess.run", return_value=completed):
            self.assertTrue(launcher._pid_is_our_executable(1234))

    def test_rejects_missing_process(self):
        completed = mock.Mock(stdout="INFO: No tasks are running which match the specified criteria.\r\n")
        with mock.patch("subprocess.run", return_value=completed):
            self.assertFalse(launcher._pid_is_our_executable(1234))

    def test_rejects_empty_output(self):
        completed = mock.Mock(stdout="")
        with mock.patch("subprocess.run", return_value=completed):
            self.assertFalse(launcher._pid_is_our_executable(1234))


class RecoveryFlowTests(unittest.TestCase):
    """恢复流程的拒绝分支：任何"不能确定"的情况都不许动手。"""

    def test_healthy_instance_short_circuits_without_terminating(self):
        health = {"url": "http://127.0.0.1:8888/", "mode": "web"}
        with mock.patch.object(launcher, "find_running_health", return_value=health), \
             mock.patch.object(launcher, "activate_existing_instance", return_value=True), \
             mock.patch.object(launcher, "reopen_running_web_app", return_value=True), \
             mock.patch.object(launcher, "_lock_owner_pid") as owner:
            self.assertTrue(launcher.recover_stale_instance("web", None, wait_seconds=0.5))
            owner.assert_not_called()

    def test_refuses_to_terminate_when_owner_pid_unknown(self):
        with mock.patch.object(launcher, "find_running_health", return_value=None), \
             mock.patch.object(launcher, "_lock_owner_pid", return_value=None), \
             mock.patch("subprocess.run") as run:
            self.assertFalse(launcher.recover_stale_instance("web", None, wait_seconds=0.3))
            run.assert_not_called()

    def test_refuses_to_terminate_foreign_executable(self):
        with mock.patch.object(launcher, "find_running_health", return_value=None), \
             mock.patch.object(launcher, "_lock_owner_pid", return_value=4321), \
             mock.patch.object(launcher, "_pid_is_our_executable", return_value=False), \
             mock.patch("subprocess.run") as run:
            self.assertFalse(launcher.recover_stale_instance("web", None, wait_seconds=0.3))
            run.assert_not_called()

    def test_refuses_to_terminate_itself(self):
        with mock.patch.object(launcher, "find_running_health", return_value=None), \
             mock.patch.object(launcher, "_lock_owner_pid", return_value=os.getpid()), \
             mock.patch("subprocess.run") as run:
            self.assertFalse(launcher.recover_stale_instance("web", None, wait_seconds=0.3))
            run.assert_not_called()

    def test_terminates_precisely_then_reports_restart(self):
        # 第一次查有宿主，杀完之后查不到 -> 返回 "restart"
        calls = {"n": 0}

        def owner(port=None):
            calls["n"] += 1
            return 4321 if calls["n"] <= 1 else None

        with mock.patch.object(launcher, "find_running_health", return_value=None), \
             mock.patch.object(launcher, "_lock_owner_pid", side_effect=owner), \
             mock.patch.object(launcher, "_pid_is_our_executable", return_value=True), \
             mock.patch("subprocess.run", return_value=mock.Mock(stdout="", returncode=0)) as run:
            result = launcher.recover_stale_instance("web", None, wait_seconds=0.3)
        self.assertEqual(result, "restart")
        # 必须带 /PID，绝不能出现按映像名批量结束的写法
        argv = run.call_args[0][0]
        self.assertEqual(argv[:2], ["taskkill", "/PID"])
        self.assertIn("4321", argv)
        self.assertNotIn("/IM", argv)

    def test_reports_failure_when_lock_still_held_after_kill(self):
        with mock.patch.object(launcher, "find_running_health", return_value=None), \
             mock.patch.object(launcher, "_lock_owner_pid", return_value=4321), \
             mock.patch.object(launcher, "_pid_is_our_executable", return_value=True), \
             mock.patch("subprocess.run", return_value=mock.Mock(stdout="", returncode=0)):
            self.assertFalse(launcher.recover_stale_instance("web", None, wait_seconds=0.3))


class MainFlowTests(unittest.TestCase):
    """main() 在"恢复成功后"必须真的把服务起起来，不能落进 health["url"]。

    这条对应一个实测到的真实缺陷：恢复成功、锁也重新拿到了，但代码继续往下
    执行到"已有健康实例"分支，此时 health 是 None，health["url"] 抛 KeyError/
    TypeError，表现为"程序卡住、端口没起来、窗口显示 Unhandled exception"。
    """

    def _run_main(self, recovered, second_guard, health_first=None, health_later=None):
        guards = [None, second_guard]
        started = {"web": False, "desktop": False}

        def run_web(guard=None, oauth_callback_url=None):
            started["web"] = True

        with mock.patch.object(launcher, "parse_args", create=True), \
             mock.patch.object(launcher, "acquire_single_instance", side_effect=guards), \
             mock.patch.object(launcher, "find_running_health", return_value=health_first), \
             mock.patch.object(launcher, "recover_stale_instance", return_value=recovered), \
             mock.patch.object(launcher, "run_web", side_effect=run_web), \
             mock.patch.object(launcher, "cleanup_stale_runtime_dirs", return_value=0), \
             mock.patch.object(launcher, "register_maimemo_oauth_protocol", return_value=True), \
             mock.patch.object(launcher, "_release_guard"), \
             mock.patch.object(launcher, "read_launcher_config", return_value="web"):
            code = launcher.main([])
        return code, started

    def test_restart_path_actually_starts_the_server(self):
        guard = mock.Mock()
        code, started = self._run_main("restart", guard)
        self.assertEqual(code, 0)
        self.assertTrue(started["web"], "恢复后必须真的启动网页服务，而不是继续走'已有实例'分支")

    def test_restart_does_not_raise_when_health_is_none(self):
        # 这一条在修复前会抛 AttributeError/TypeError
        guard = mock.Mock()
        try:
            self._run_main("restart", guard)
        except (AttributeError, KeyError, TypeError) as exc:
            self.fail("恢复成功后又崩了：%r" % (exc,))

    def test_unrecoverable_stale_instance_returns_error_without_crashing(self):
        with mock.patch.object(launcher, "acquire_single_instance", return_value=None), \
             mock.patch.object(launcher, "find_running_health", return_value=None), \
             mock.patch.object(launcher, "recover_stale_instance", return_value=False), \
             mock.patch.object(launcher, "show_message") as msg, \
             mock.patch.object(launcher, "register_maimemo_oauth_protocol", return_value=True), \
             mock.patch.object(launcher, "read_launcher_config", return_value="web"):
            code = launcher.main([])
        self.assertEqual(code, 1)
        self.assertTrue(msg.called, "无法恢复时必须明确告知用户")


class StaleDirectoryCleanupTests(unittest.TestCase):
    """清理 _MEI* 必须按内容确认归属，不能只看文件名。

    这条来自实测缺陷：之前只看 index.html/js/api.js/js/app.js 是否存在，
    于是一个"恰好也有这些文件"的 PyInstaller 程序目录会被当成我们的删掉。
    """

    FOREIGN_HTML = "<!doctype html><html><head><title>Some Other Tool</title></head><body>x</body></html>"
    OURS_HTML = "<!doctype html><html><head><title>Memo Superform - 墨墨数据磁贴</title></head></html>"

    def setUp(self):
        import tempfile
        self.root = tempfile.mkdtemp(prefix="memo-cleanup-unit-")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.root, ignore_errors=True)

    def _make(self, name, html):
        d = os.path.join(self.root, name)
        os.makedirs(os.path.join(d, "js"), exist_ok=True)
        for rel in ("js/api.js", "js/app.js"):
            with open(os.path.join(d, rel), "w", encoding="utf-8") as handle:
                handle.write("// x")
        if html is not None:
            with open(os.path.join(d, "index.html"), "w", encoding="utf-8") as handle:
                handle.write(html)
        return d

    def test_never_deletes_a_foreign_pyinstaller_directory(self):
        foreign = self._make("_MEI900001", self.FOREIGN_HTML)
        launcher.cleanup_stale_runtime_dirs(temp_root=self.root, max_age_seconds=0)
        self.assertTrue(os.path.isdir(foreign),
                        "另一个 PyInstaller 程序的目录被误删了——这是数据损坏级别的缺陷")

    def test_deletes_our_own_stale_directory(self):
        mine = self._make("_MEI900002", self.OURS_HTML)
        launcher.cleanup_stale_runtime_dirs(temp_root=self.root, max_age_seconds=0)
        self.assertFalse(os.path.isdir(mine), "自己的残留目录应当被清掉")

    def test_keeps_directory_without_recognisable_content(self):
        unknown = self._make("_MEI900003", None)
        launcher.cleanup_stale_runtime_dirs(temp_root=self.root, max_age_seconds=0)
        self.assertTrue(os.path.isdir(unknown),
                        "无法确认归属时应当保留（宁可留垃圾也不误删）")

    def test_never_deletes_a_directory_not_named_mei(self):
        other = self._make("_NOT_MEI", self.OURS_HTML)
        launcher.cleanup_stale_runtime_dirs(temp_root=self.root, max_age_seconds=0)
        self.assertTrue(os.path.isdir(other), "只处理 _MEI* 前缀")

    def test_looks_like_our_runtime_requires_signature(self):
        foreign = self._make("_MEI900004", self.FOREIGN_HTML)
        mine = self._make("_MEI900005", self.OURS_HTML)
        self.assertFalse(launcher._looks_like_our_runtime(foreign))
        self.assertTrue(launcher._looks_like_our_runtime(mine))


class NoBatchKillTests(unittest.TestCase):
    """源码里不许出现按进程名批量结束的写法。"""

    def test_launcher_never_kills_by_image_name(self):
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "launcher.py")
        with open(path, "r", encoding="utf-8") as handle:
            source = handle.read()
        self.assertNotIn('"/IM"', source, "不得按映像名批量结束进程")
        self.assertNotIn("taskkill /IM", source)
        self.assertNotIn("Stop-Process -Name", source)


if __name__ == "__main__":
    unittest.main()
