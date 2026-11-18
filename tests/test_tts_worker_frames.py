# -*- coding: utf-8 -*-
"""TTS worker 帧分发的回归测试。

背景（真实缺陷，已修）：worker 会无条件推送 ``type: "progress"`` 的进度帧，并且
与结果帧**共用同一个 request_id**。旧实现 ``_read_loop`` 只按 request_id 分发、
不看 ``type``，于是第一个进度帧就被当成命令结果返回，调用方在
``tts.py`` 的 ``synthesize`` 里取不到 ``output_wav_path``，误报
"语音合成没有输出音频"。

这些测试不拉起 11GB 外部语音包，也不做真实合成：只验证帧分发这一层的语义。
"""

import os
import pathlib
import sys
import threading
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
_SANDBOX = ROOT / "_verification" / "perfvocab" / "M" / "tts-frame-tests"
_SANDBOX.mkdir(parents=True, exist_ok=True)
if not os.environ.get("MEMO_DATA_DIR"):
    os.environ["MEMO_DATA_DIR"] = str(_SANDBOX)
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import tts


class _FakeStdout:
    """把预置的 JSON 行喂给 _read_loop。"""

    def __init__(self, lines):
        self._lines = list(lines)

    def __iter__(self):
        return iter(self._lines)


class _FakeProc:
    def __init__(self, lines):
        self.stdout = _FakeStdout(lines)


class FrameDispatchTests(unittest.TestCase):
    def setUp(self):
        self.manager = tts.TTSManager.__new__(tts.TTSManager)
        self.manager._pending = {}
        self.manager._pending_lock = threading.Lock()
        self.log_path = _SANDBOX / "worker.log"

    def _run_read_loop(self, lines):
        """跑一次 _read_loop，返回它投递给等待者的消息。"""
        import queue
        holder = queue.Queue()
        self.manager._pending["rid-1"] = holder
        proc = _FakeProc(lines)
        # _read_loop 会 close(log_file)，给一个真实可关闭的对象。
        log_file = open(self.log_path, "w", encoding="utf-8")
        self.manager._read_loop(proc, log_file)
        received = []
        while True:
            try:
                received.append(holder.get_nowait())
            except queue.Empty:
                break
        return received

    def test_progress_frame_is_not_delivered_as_result(self):
        """进度帧与结果帧同 request_id 时，只能拿到结果帧。"""
        received = self._run_read_loop([
            '{"request_id":"rid-1","type":"progress","percent":10}',
            '{"request_id":"rid-1","type":"progress","percent":90}',
            '{"request_id":"rid-1","output_wav_path":"out.wav"}',
        ])
        self.assertEqual(len(received), 1)
        self.assertEqual(received[0]["output_wav_path"], "out.wav")
        # 关键断言：绝不能把进度帧当成结果。
        self.assertNotIn("percent", received[0])

    def test_progress_only_never_delivers_a_fake_success(self):
        """只有进度帧、结果还没来时，不能投递任何"像结果"的东西。

        ``_read_loop`` 结束时会把剩余等待者唤醒并投递一个 ``type: "error"`` 的
        "进程意外退出"帧（这是既有且正确的行为，否则调用方会一直等到超时）。
        因此这里断言的是：拿到的绝不能是被误认成结果的进度帧。
        """
        received = self._run_read_loop([
            '{"request_id":"rid-1","type":"progress","percent":50}',
        ])
        for message in received:
            self.assertNotIn("percent", message)
            self.assertNotIn("output_wav_path", message)
            self.assertEqual(message.get("type"), "error")

    def test_result_without_type_is_still_accepted(self):
        """没有 type 字段的旧格式结果帧必须继续可用（向后兼容）。"""
        received = self._run_read_loop([
            '{"request_id":"rid-1","output_wav_path":"out.wav"}',
        ])
        self.assertEqual(len(received), 1)
        self.assertEqual(received[0]["output_wav_path"], "out.wav")

    def test_type_matching_is_case_insensitive(self):
        received = self._run_read_loop([
            '{"request_id":"rid-1","type":"Progress","percent":5}',
            '{"request_id":"rid-1","output_wav_path":"out.wav"}',
        ])
        self.assertEqual(len(received), 1)
        self.assertEqual(received[0]["output_wav_path"], "out.wav")

    def test_non_json_lines_are_skipped(self):
        received = self._run_read_loop([
            "not json at all",
            '{"request_id":"rid-1","output_wav_path":"out.wav"}',
        ])
        self.assertEqual(len(received), 1)

    def test_other_request_id_is_ignored(self):
        received = self._run_read_loop([
            '{"request_id":"other","output_wav_path":"x.wav"}',
            '{"request_id":"rid-1","output_wav_path":"out.wav"}',
        ])
        self.assertEqual(len(received), 1)
        self.assertEqual(received[0]["output_wav_path"], "out.wav")


class IsolationTests(unittest.TestCase):
    def test_database_is_not_the_real_one(self):
        import db
        real = (ROOT / "data" / "memo-superform.db").resolve()
        self.assertNotEqual(pathlib.Path(str(db._DB_PATH)).resolve(), real)


if __name__ == "__main__":
    unittest.main()