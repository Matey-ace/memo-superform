# -*- coding: utf-8 -*-
"""Regression coverage for invisible Windows GPT-SoVITS helper processes.

The packaged app uses a windowed Python launcher.  A worker or a dependency
probe started without explicit Windows startup flags flashes a console over the
study screen.  These tests mock the process boundary so they stay deterministic
without a real GPT-SoVITS runtime.
"""

import io
import json
import os
import tempfile
import unittest
from unittest import mock

import tts


class _StartupInfo:
    def __init__(self):
        self.dwFlags = 0
        self.wShowWindow = None


class _WorkerProcess:
    def __init__(self):
        self.stdout = io.StringIO()


class TTSHiddenWindowsWorkerTests(unittest.TestCase):
    """Windows-only launch policy, exercised with mocked subprocesses."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.pack = os.path.join(self.temp.name, "tts_pack")
        self.data = os.path.join(self.temp.name, "data")
        os.makedirs(os.path.join(self.pack, ".venv311", "Scripts"), exist_ok=True)
        os.makedirs(os.path.join(self.pack, "tts_engine"), exist_ok=True)
        os.makedirs(self.data, exist_ok=True)
        self.python_exe = os.path.join(self.pack, ".venv311", "Scripts", "python.exe")
        self.worker_main = os.path.join(self.pack, "tts_engine", "worker_main.py")
        open(self.python_exe, "wb").close()
        with open(self.worker_main, "w", encoding="utf-8") as worker:
            worker.write("# worker fixture\n")
        with open(os.path.join(self.pack, "install.json"), "w", encoding="utf-8") as install:
            json.dump({"installed": True}, install)
        with tts._ENGINE_PROBE_LOCK:
            tts._ENGINE_PROBE_CACHE.clear()

    def tearDown(self):
        with tts._ENGINE_PROBE_LOCK:
            tts._ENGINE_PROBE_CACHE.clear()
        self.temp.cleanup()

    def _windows_console_mocks(self):
        return (
            mock.patch.object(tts.os, "name", "nt"),
            mock.patch.object(tts.subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True),
            mock.patch.object(tts.subprocess, "STARTF_USESHOWWINDOW", 0x00000001, create=True),
            mock.patch.object(tts.subprocess, "SW_HIDE", 0, create=True),
            mock.patch.object(tts.subprocess, "STARTUPINFO", _StartupInfo, create=True),
        )

    def _assert_hidden_windows_launch(self, kwargs):
        self.assertTrue(
            kwargs.get("creationflags", 0) & tts.subprocess.CREATE_NO_WINDOW,
            "Windows TTS helper must include CREATE_NO_WINDOW so no console steals focus",
        )
        startupinfo = kwargs.get("startupinfo")
        self.assertIsNotNone(startupinfo, "Windows TTS helper must provide hidden startup info")
        self.assertTrue(
            startupinfo.dwFlags & tts.subprocess.STARTF_USESHOWWINDOW,
            "Windows TTS helper must opt into wShowWindow handling",
        )
        self.assertEqual(
            startupinfo.wShowWindow,
            tts.subprocess.SW_HIDE,
            "Windows TTS helper must start with its console hidden",
        )

    def test_worker_spawn_hides_its_console_window(self):
        manager = tts.TTSManager.__new__(tts.TTSManager)
        manager.pack_dir = self.pack
        manager.data_dir = self.data
        manager._proc = None
        manager._reader = None
        manager._worker_paths = lambda: (self.python_exe, self.worker_main)
        fake_process = _WorkerProcess()
        fake_thread = mock.Mock()
        windows = self._windows_console_mocks()
        with windows[0], windows[1], windows[2], windows[3], windows[4], \
                mock.patch.object(tts.subprocess, "Popen", return_value=fake_process) as popen, \
                mock.patch.object(tts.threading, "Thread", return_value=fake_thread):
            manager._spawn()

        # `_spawn` hands ownership of this file to the reader thread in real
        # execution.  The mocked thread never runs, so close it in the fixture
        # even if a later assertion fails and unittest begins cleanup.
        log_file = popen.call_args.kwargs["stderr"]
        try:
            self._assert_hidden_windows_launch(popen.call_args.kwargs)
        finally:
            log_file.close()

    def test_dependency_probe_hides_its_transient_python_console(self):
        completed = mock.Mock(
            returncode=0,
            stdout="__MEMO_TTS_PROBE__[]\n",
            stderr="",
        )
        windows = self._windows_console_mocks()
        with windows[0], windows[1], windows[2], windows[3], windows[4], \
                mock.patch.object(tts.subprocess, "run", return_value=completed) as run:
            ready, reason, missing = tts._engine_dependency_status(self.pack, force=True)

        self.assertTrue(ready, reason)
        self.assertEqual(missing, [])
        self._assert_hidden_windows_launch(run.call_args.kwargs)


if __name__ == "__main__":
    unittest.main(verbosity=2)
