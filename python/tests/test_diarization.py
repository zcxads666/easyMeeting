import pathlib
import sys
import tempfile
import types
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import diarization
import model_manager


class Annotation:
    def __init__(self, items): self.items = items
    def itertracks(self, yield_label=False):
        for start, end, speaker in self.items: yield SimpleNamespace(start=start, end=end), None, speaker


class FakePipeline:
    calls = []
    @classmethod
    def from_pretrained(cls, path): cls.calls.append(("load", path)); return cls()
    def to(self, device): self.device = str(device); return self
    def __call__(self, file, **kwargs):
        self.calls.append(("run", file, kwargs))
        return SimpleNamespace(
            speaker_diarization=Annotation([(0, 1, "SPEAKER_00"), (.8, 2, "SPEAKER_01")]),
            exclusive_speaker_diarization=Annotation([(0, .9, "SPEAKER_00"), (.9, 2, "SPEAKER_01")]))


class DiarizationTests(unittest.TestCase):
    def tearDown(self): diarization.release(); FakePipeline.calls.clear()

    def pyannote_modules(self):
        package = types.ModuleType("pyannote"); audio = types.ModuleType("pyannote.audio"); audio.Pipeline = FakePipeline
        package.audio = audio; return {"pyannote": package, "pyannote.audio": audio}

    def test_cpu_pipeline_cache_exclusive_turns_and_fixed_speakers(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(diarization, "exists", return_value=True), \
             mock.patch.object(diarization, "model_dir", return_value=pathlib.Path(tmp)), mock.patch.dict(sys.modules, self.pyannote_modules()):
            result = diarization.diarize_file("audio.wav", device="cpu", num_speakers=2)
            diarization.load(device="cpu")
        self.assertEqual(sum(1 for call in FakePipeline.calls if call[0] == "load"), 1)
        self.assertEqual(result["device"], "cpu"); self.assertEqual(result["speakerCount"], 2)
        self.assertEqual(result["exclusiveSpeakerTurns"][1]["start"], .9)
        self.assertEqual([call for call in FakePipeline.calls if call[0] == "run"][0][2]["num_speakers"], 2)

    def test_unsupported_mps_and_unavailable_cuda_are_explicit(self):
        with self.assertRaises(diarization.DiarizationRuntimeError) as mps: diarization.resolve_device("mps")
        self.assertEqual(mps.exception.code, "DIARIZATION_DEVICE_UNSUPPORTED")
        fake_torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False), backends=SimpleNamespace(mps=None))
        with self.assertRaises(diarization.DiarizationRuntimeError) as cuda: diarization.resolve_device("cuda", fake_torch)
        self.assertEqual(cuda.exception.code, "DIARIZATION_DEVICE_UNAVAILABLE")

    def test_gated_model_requires_token_before_worker(self):
        manager = model_manager.DownloadManager()
        with self.assertRaises(model_manager.ModelLifecycleError) as caught:
            manager.start(diarization.DEFAULT_MODEL)
        self.assertEqual(caught.exception.code, "HF_AUTH_REQUIRED")


if __name__ == "__main__": unittest.main()
