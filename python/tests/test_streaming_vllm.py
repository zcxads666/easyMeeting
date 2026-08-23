import pathlib
import sys
import types
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import streaming_vllm


class FakeState:
    def __init__(self): self.text = ""; self.language = "Chinese"


class FakeModel:
    def init_streaming_state(self, **kwargs): self.init_kwargs = kwargs; return FakeState()
    def streaming_transcribe(self, samples, state): self.samples = samples; state.text = "真实增量"
    def finish_streaming_transcribe(self, state): state.text = "最终文本"


class StreamingTests(unittest.TestCase):
    def tearDown(self):
        streaming_vllm._sessions.clear(); streaming_vllm._model = None; streaming_vllm._model_key = None

    def test_capability_requires_linux_cuda_and_optional_packages(self):
        torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True))
        with mock.patch.object(streaming_vllm.platform, "system", return_value="Linux"), \
             mock.patch.object(streaming_vllm.importlib.util, "find_spec", return_value=object()):
            self.assertTrue(streaming_vllm.capability(torch)["available"])
        with mock.patch.object(streaming_vllm.platform, "system", return_value="Darwin"), \
             mock.patch.object(streaming_vllm.importlib.util, "find_spec", return_value=object()):
            value = streaming_vllm.capability(torch)
        self.assertFalse(value["available"]); self.assertIn("Linux", value["reason"])

    def test_official_stateful_api_has_real_partial_and_unknown_timing(self):
        fake = FakeModel(); module = types.ModuleType("qwen_asr")
        module.Qwen3ASRModel = SimpleNamespace(LLM=lambda **kwargs: fake)
        with mock.patch.object(streaming_vllm, "capability", return_value={"available": True}), \
             mock.patch.object(streaming_vllm.model_manager, "verify_model", return_value={"status": "ready"}), \
             mock.patch.object(streaming_vllm.model_manager, "model_dir", return_value=pathlib.Path("/models/qwen")), \
             mock.patch.object(streaming_vllm.model_manager, "retain_model") as retain, \
             mock.patch.object(streaming_vllm.model_manager, "release_model") as release, \
             mock.patch.dict(sys.modules, {"qwen_asr": module}):
            started = streaming_vllm.start("Qwen/test")
            partial = streaming_vllm.send(started["sessionId"], b"\0\0" * 1600)
            final = streaming_vllm.stop(started["sessionId"])
        retain.assert_called_once_with("Qwen/test"); release.assert_called_once_with("Qwen/test")
        self.assertEqual(partial["text"], "真实增量"); self.assertTrue(partial["changed"])
        self.assertEqual((final["start"], final["end"], final["timing"]), (None, None, "unknown"))

    def test_unavailable_is_explicit(self):
        with mock.patch.object(streaming_vllm, "capability", return_value={"available": False, "reason": "no CUDA"}):
            with self.assertRaises(streaming_vllm.StreamingRuntimeError) as caught: streaming_vllm.load("Qwen/test")
        self.assertEqual(caught.exception.code, "TRUE_STREAMING_UNAVAILABLE")


if __name__ == "__main__": unittest.main()
