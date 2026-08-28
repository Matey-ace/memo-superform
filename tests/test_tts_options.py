import unittest
import os
import tempfile

import tts


class TTSOptionsCoercionTests(unittest.TestCase):
    def test_coerce_num_returns_default_for_invalid(self):
        self.assertEqual(tts._coerce_num("abc", 0.5), 0.5)
        self.assertEqual(tts._coerce_num(True, 0.5), 0.5)
        self.assertEqual(tts._coerce_num(None, 0.5), 0.5)
        self.assertEqual(tts._coerce_num(float("inf"), 0.5), 0.5)

    def test_coerce_num_enforces_range(self):
        self.assertEqual(tts._coerce_num(1.2, 0.5, low=0.0, high=3.0), 1.2)
        self.assertEqual(tts._coerce_num(99, 0.5, low=0.0, high=3.0), 0.5)
        self.assertEqual(tts._coerce_num(-1, 0.5, low=0.0, high=3.0), 0.5)

    def test_coerce_split_method(self):
        self.assertEqual(tts._coerce_split_method("CUT1"), "cut1")
        self.assertEqual(tts._coerce_split_method("cut5"), "cut5")
        self.assertEqual(tts._coerce_split_method("bogus"), "cut0")
        self.assertEqual(tts._coerce_split_method(None), "cut0")

    def test_coerce_bool_variants(self):
        self.assertTrue(tts._coerce_bool("1"))
        self.assertTrue(tts._coerce_bool("yes"))
        self.assertTrue(tts._coerce_bool("TRUE"))
        self.assertFalse(tts._coerce_bool("false"))
        self.assertFalse(tts._coerce_bool(None))
        self.assertIs(tts._coerce_bool(0.0, default=True), False)

    def test_synthesize_payload_passthrough(self):
        manager = tts.TTSManager.__new__(tts.TTSManager)
        manager.data_dir = "/tmp/tts-generated"
        manager._busy = False
        manager._last_status = {}
        captured = {}
        out_dir = tempfile.mkdtemp()
        out_path = os.path.join(out_dir, "out.wav")
        with open(out_path, "wb") as fake_wav:
            fake_wav.write(b"RIFF")

        def fake_call(message, timeout=None):
            captured["message"] = message
            return {"type": "ok", "output_wav_path": out_path}

        manager._call = fake_call
        manager._resolve_voice_config = lambda name: {
            "ref_audio_path": "/tmp/ref.wav",
            "prompt_text": "hello",
            "ref_language": "zh",
        }
        manager.synthesize(
            "你好",
            "sakiko",
            speed=1.1,
            top_k=33,
            fragment_interval=1.2,
            text_split_method="cut2",
            seed=42,
            use_cuda_graph=True,
            parallel_infer=True,
        )
        payload = captured["message"]["payload"]
        self.assertEqual(payload["top_k"], 33)
        self.assertEqual(payload["fragment_interval"], 1.2)
        self.assertEqual(payload["text_split_method"], "cut2")
        self.assertEqual(payload["seed"], 42)
        self.assertIs(payload["use_cuda_graph"], True)
        self.assertIs(payload["parallel_infer"], True)

    def test_first_synthesis_gets_cold_start_timeout_then_loaded_voice_uses_normal_timeout(self):
        """Loading GPT/SoVITS must not be killed by the ordinary request budget."""
        manager = tts.TTSManager.__new__(tts.TTSManager)
        manager.data_dir = "/tmp/tts-generated"
        manager._busy = False
        manager._last_status = {}
        # Keep the fixture compatible with implementations that additionally
        # inspect worker liveness when deciding whether this is a cold start.
        manager._proc = type("LiveWorker", (), {"poll": lambda self: None})()
        observed_timeouts = []
        out_dir = tempfile.mkdtemp()
        out_path = os.path.join(out_dir, "out.wav")
        with open(out_path, "wb") as fake_wav:
            fake_wav.write(b"RIFF")

        def fake_call(_message, timeout=None):
            observed_timeouts.append(timeout)
            return {"type": "ok", "output_wav_path": out_path}

        manager._call = fake_call
        manager._resolve_voice_config = lambda _name: {
            "ref_audio_path": "/tmp/ref.wav",
            "prompt_text": "完整参考文本",
            "ref_language": "日文",
        }

        manager.synthesize("第一句冷启动语音。", "anon")
        manager.synthesize("第二句已加载语音。", "anon")

        self.assertEqual(len(observed_timeouts), 2)
        self.assertGreater(
            observed_timeouts[0], observed_timeouts[1],
            "first cold synthesis must receive a longer worker timeout than an already loaded voice",
        )
        self.assertEqual(
            observed_timeouts[1], tts._SYNTH_TIMEOUT,
            "subsequent loaded synthesis must retain the ordinary timeout budget",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
