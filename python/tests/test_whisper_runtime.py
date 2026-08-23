import pathlib
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import transcribe_whisper

class FakeTorch:
    def __init__(self, cuda=False, mps=False):
        self.cuda = SimpleNamespace(is_available=lambda: cuda)
        self.backends = SimpleNamespace(mps=SimpleNamespace(is_available=lambda: mps))

class WhisperRuntimeTests(unittest.TestCase):
    def test_auto_cpu_uses_int8(self):
        self.assertEqual(transcribe_whisper.resolve_whisper_runtime("auto", torch_module=FakeTorch()), ("cpu", "int8"))

    def test_auto_on_mps_machine_uses_supported_cpu_backend(self):
        self.assertEqual(transcribe_whisper.resolve_whisper_runtime("auto", torch_module=FakeTorch(mps=True)), ("cpu", "int8"))

    def test_cuda_unavailable_is_explicit_error(self):
        with self.assertRaisesRegex(RuntimeError, "CUDA"):
            transcribe_whisper.resolve_whisper_runtime("cuda", torch_module=FakeTorch())

    def test_cuda_uses_float16(self):
        self.assertEqual(transcribe_whisper.resolve_whisper_runtime("auto", torch_module=FakeTorch(cuda=True)), ("cuda", "float16"))

    def test_mps_is_explicitly_unsupported(self):
        with self.assertRaisesRegex(RuntimeError, "不支持 MPS"):
            transcribe_whisper.resolve_whisper_runtime("mps", torch_module=FakeTorch(mps=True))

    def test_invalid_compute_type_fails_without_fallback(self):
        with self.assertRaisesRegex(ValueError, "compute type"):
            transcribe_whisper.resolve_whisper_runtime("cpu", "float16", FakeTorch())

    def test_native_segment_timestamps_remain_seconds(self):
        segment = SimpleNamespace(start=1.25, end=2.5, text=" hello ")
        model = SimpleNamespace(transcribe=lambda *_args, **_kwargs: ([segment], SimpleNamespace(language="en")))
        with mock.patch.object(transcribe_whisper, "_get_model", return_value=(model, ("tiny", "cpu", "int8", "faster-whisper"))):
            result = transcribe_whisper.transcribe_pcm(bytes(16000 * 2), "tiny", device="cpu")
        self.assertEqual(result["segments"][0]["start"], 1.25)
        self.assertEqual(result["segments"][0]["end"], 2.5)
        self.assertEqual(result["segments"][0]["timing"], "native")
        self.assertEqual(result["duration"], 1.0)

if __name__ == "__main__": unittest.main()
