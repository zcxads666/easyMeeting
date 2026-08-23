import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import model_manager

class ModelCatalogTests(unittest.TestCase):
    def test_catalog_is_structured_and_has_native_hf_qwen(self):
        required = {"id", "label", "engine", "backend", "source", "estimatedSize",
                    "supportedDevices", "recommendedDevice", "supportsTimestamps", "supportsStreaming"}
        self.assertTrue(all(required <= set(item) for item in model_manager.MODEL_CATALOG))
        qwen = [item for item in model_manager.MODEL_CATALOG if item["engine"] == "qwen"]
        self.assertEqual({item["id"] for item in qwen}, {
            "Qwen/Qwen3-ASR-0.6B-hf", "Qwen/Qwen3-ASR-1.7B-hf"})
        self.assertTrue(all(item["source"] == "huggingface" for item in qwen))
        self.assertTrue(all("cpu" in item["supportedDevices"] for item in qwen))

    def test_invalid_model_fails(self):
        with self.assertRaisesRegex(ValueError, "未知模型"):
            model_manager.download("Qwen/not-real")

if __name__ == "__main__": unittest.main()
