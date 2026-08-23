import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import model_manager
import transcribe_qwen

class FakeModel:
    def to(self, device): self.device = device; return self
    def eval(self): return self

class QwenLoaderTests(unittest.TestCase):
    def tearDown(self): transcribe_qwen.release()

    def test_missing_and_invalid_model_are_distinct(self):
        with self.assertRaises(ValueError): transcribe_qwen._load("not-real", "cpu")
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(model_manager, "MODELS_DIR", pathlib.Path(tmp)):
            with self.assertRaises(FileNotFoundError):
                transcribe_qwen._load("Qwen/Qwen3-ASR-0.6B-hf", "cpu")

    def test_cpu_loader_uses_native_auto_classes_and_cache(self):
        mid = "Qwen/Qwen3-ASR-0.6B-hf"
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(model_manager, "MODELS_DIR", pathlib.Path(tmp)):
            local = model_manager._qwen_local_dir(mid)
            local.mkdir(parents=True); (local / "config.json").write_text("{}")
            with mock.patch("transformers.AutoProcessor.from_pretrained", return_value=object()) as processor, \
                 mock.patch("transformers.AutoModelForMultimodalLM.from_pretrained", return_value=FakeModel()) as model:
                first, key = transcribe_qwen._load(mid, "cpu")
                second, second_key = transcribe_qwen._load(mid, "cpu")
                self.assertIs(first, second)
                self.assertEqual(key, second_key)
                self.assertEqual(key[1:4], ("cpu", "float32", "transformers"))
                processor.assert_called_once()
                model.assert_called_once()

    def test_loader_preserves_exception_context(self):
        mid = "Qwen/Qwen3-ASR-0.6B-hf"
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(model_manager, "MODELS_DIR", pathlib.Path(tmp)):
            local = model_manager._qwen_local_dir(mid)
            local.mkdir(parents=True); (local / "config.json").write_text("{}")
            with mock.patch("transformers.AutoProcessor.from_pretrained", side_effect=OSError("bad config")):
                with self.assertRaises(transcribe_qwen.QwenRuntimeError) as caught:
                    transcribe_qwen._load(mid, "cpu")
                self.assertEqual(caught.exception.context["type"], "OSError")
                self.assertEqual(caught.exception.context["model"], mid)
                self.assertEqual(caught.exception.context["device"], "cpu")
                self.assertIn("bad config", caught.exception.context["technicalMessage"])

if __name__ == "__main__": unittest.main()
