import pathlib
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import runtime

class FakeTorch:
    float32 = "float32"
    float16 = "float16"
    bfloat16 = "bfloat16"
    def __init__(self, cuda=False, mps=False, bf16=False):
        self.cuda = SimpleNamespace(is_available=lambda: cuda, is_bf16_supported=lambda: bf16,
                                    get_device_name=lambda _i: "Fake GPU",
                                    get_device_properties=lambda _i: SimpleNamespace(total_memory=1024))
        self.backends = SimpleNamespace(mps=SimpleNamespace(is_available=lambda: mps))

class RuntimeDeviceTests(unittest.TestCase):
    def test_auto_prefers_cuda_then_mps_then_cpu(self):
        self.assertEqual(runtime.resolve_device("auto", FakeTorch(cuda=True, mps=True)), "cuda")
        self.assertEqual(runtime.resolve_device("auto", FakeTorch(mps=True)), "mps")
        self.assertEqual(runtime.resolve_device("auto", FakeTorch()), "cpu")

    def test_cpu_is_first_class_and_uses_float32(self):
        torch = FakeTorch()
        self.assertEqual(runtime.resolve_device("cpu", torch), "cpu")
        self.assertEqual(runtime.select_dtype("cpu", torch), "float32")

    def test_unavailable_explicit_device_fails_without_fallback(self):
        with self.assertRaisesRegex(RuntimeError, "CUDA"):
            runtime.resolve_device("cuda", FakeTorch())

    def test_cuda_dtype_is_capability_based(self):
        self.assertEqual(runtime.select_dtype("cuda", FakeTorch(cuda=True, bf16=True)), "bfloat16")
        self.assertEqual(runtime.select_dtype("cuda", FakeTorch(cuda=True)), "float16")

    def test_memory_failures_map_to_structured_oom_without_device_fallback(self):
        error = RuntimeError("CUDA out of memory. Tried to allocate 2 GiB")
        self.assertEqual(runtime.inference_error_code(error), "MODEL_OUT_OF_MEMORY")
        self.assertIn("CPU", runtime.inference_error_message(error, "failed"))
        self.assertEqual(runtime.inference_error_code(RuntimeError("bad input"), "BAD_INPUT"), "BAD_INPUT")

if __name__ == "__main__": unittest.main()
