import pathlib
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import forced_aligner


class FakeModel:
    device = "cpu"
    dtype = "float32"
    config = SimpleNamespace(timestamp_token_id=42)
    def to(self, _device): return self
    def eval(self): return self
    def __call__(self, **_inputs): return SimpleNamespace(logits="logits")


class FakeProcessor:
    def prepare_forced_aligner_inputs(self, **_kwargs):
        return {"input_ids": SimpleNamespace(to=lambda _device: "input")}, [["你", "好"]]
    def decode_forced_alignment(self, **_kwargs):
        return [[{"text": "你", "start": 0.1, "end": 0.3}, {"text": "好", "start_time": 0.31, "end_time": 0.6, "score": .9}]]


class ForcedAlignerTests(unittest.TestCase):
    def tearDown(self): forced_aligner.release()

    def test_language_normalization_and_explicit_unsupported(self):
        self.assertEqual(forced_aligner.normalize_language("zh-CN"), "Chinese")
        self.assertEqual(forced_aligner.normalize_language("EN_us"), "English")
        with self.assertRaises(forced_aligner.AlignmentRuntimeError) as caught:
            forced_aligner.normalize_language("xx")
        self.assertEqual(caught.exception.code, "ALIGNMENT_LANGUAGE_UNSUPPORTED")

    def test_optional_language_dependency_is_structured(self):
        original = forced_aligner.importlib.util.find_spec
        with mock.patch.object(forced_aligner.importlib.util, "find_spec", side_effect=lambda name: None if name == "nagisa" else original(name)):
            with self.assertRaises(forced_aligner.AlignmentRuntimeError) as caught:
                forced_aligner.normalize_language("ja")
        self.assertEqual(caught.exception.code, "ALIGNMENT_LANGUAGE_DEPENDENCY_MISSING")
        self.assertEqual(caught.exception.context["feature"], "alignment-ja")

    def test_cpu_loader_cache_and_decode_seconds(self):
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(forced_aligner, "exists", return_value=True), \
             mock.patch.object(forced_aligner, "model_dir", return_value=pathlib.Path(tmp)), \
             mock.patch("transformers.AutoProcessor.from_pretrained", return_value=FakeProcessor()) as processor_load, \
             mock.patch("transformers.AutoModelForTokenClassification.from_pretrained", return_value=FakeModel()) as model_load:
            result = forced_aligner.align_pcm(b"\x00\x00" * 16000, "你好", "zh", device="cpu")
            forced_aligner.load(device="cpu")
        self.assertEqual(processor_load.call_count, 1)
        self.assertEqual(model_load.call_count, 1)
        self.assertEqual(result["device"], "cpu")
        self.assertEqual(result["words"][0]["timing"], "aligned")
        self.assertEqual(result["words"][1]["end"], .6)

    def test_loader_preserves_error_context(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(forced_aligner, "exists", return_value=True), \
             mock.patch.object(forced_aligner, "model_dir", return_value=pathlib.Path(tmp)), \
             mock.patch("transformers.AutoProcessor.from_pretrained", side_effect=OSError("bad aligner")):
            with self.assertRaises(forced_aligner.AlignmentRuntimeError) as caught:
                forced_aligner.load(device="cpu")
        self.assertEqual(caught.exception.code, "ALIGNER_LOAD_FAILED")
        self.assertEqual(caught.exception.context["device"], "cpu")
        self.assertEqual(caught.exception.context["type"], "OSError")


if __name__ == "__main__": unittest.main()
