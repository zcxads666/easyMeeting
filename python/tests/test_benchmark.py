import time
import unittest
from unittest import mock
import pathlib
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import transcribe_whisper


class BenchmarkTests(unittest.TestCase):
    def setUp(self): transcribe_whisper._cache.clear()
    def test_cold_contract_rtf_and_median(self):
        pcm = b"\0\0" * 16000
        def fake_get(*_args):
            transcribe_whisper._cache[("tiny", "cpu", "int8", "faster-whisper")] = object()
            return object(), ("tiny", "cpu", "int8", "faster-whisper")
        with mock.patch.object(transcribe_whisper, "resolve_whisper_runtime", return_value=("cpu", "int8")), \
             mock.patch.object(transcribe_whisper, "_get_model", side_effect=fake_get), \
             mock.patch.object(transcribe_whisper, "transcribe_pcm", side_effect=lambda *_args: time.sleep(.002)):
            result = transcribe_whisper.benchmark_pcm(pcm, "tiny", warmup_runs=1, measured_runs=3)
        self.assertTrue(result["coldStart"]); self.assertEqual(result["audioDurationSeconds"], 1)
        self.assertAlmostEqual(result["realtimeFactor"], 1 / result["rtf"], places=5)
        self.assertEqual(result["measuredRuns"], 3)
    def test_warm_model_has_zero_load_time(self):
        key = ("tiny", "cpu", "int8", "faster-whisper"); transcribe_whisper._cache[key] = object()
        with mock.patch.object(transcribe_whisper, "resolve_whisper_runtime", return_value=("cpu", "int8")), \
             mock.patch.object(transcribe_whisper, "_get_model", return_value=(object(), key)), \
             mock.patch.object(transcribe_whisper, "transcribe_pcm", return_value={}):
            result = transcribe_whisper.benchmark_pcm(b"\0\0" * 16000, "tiny", warmup_runs=0)
        self.assertFalse(result["coldStart"]); self.assertEqual(result["modelLoadMs"], 0)
    def test_inference_failure_is_not_swallowed(self):
        with mock.patch.object(transcribe_whisper, "resolve_whisper_runtime", return_value=("cpu", "int8")), \
             mock.patch.object(transcribe_whisper, "_get_model", return_value=(object(), ("tiny", "cpu", "int8", "faster-whisper"))), \
             mock.patch.object(transcribe_whisper, "transcribe_pcm", side_effect=RuntimeError("inference failed")):
            with self.assertRaisesRegex(RuntimeError, "inference failed"):
                transcribe_whisper.benchmark_pcm(b"\0\0" * 100, "tiny")


if __name__ == "__main__": unittest.main()
