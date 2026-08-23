import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import main


class P3IntegrationTests(unittest.TestCase):
    def test_workload_switch_releases_other_heavy_caches(self):
        with mock.patch.object(main.streaming_vllm, "active_sessions", return_value=0), \
             mock.patch.object(main.transcribe_whisper, "release") as whisper, \
             mock.patch.object(main.transcribe_qwen, "release") as qwen, \
             mock.patch.object(main.forced_aligner, "release") as aligner, \
             mock.patch.object(main.diarization, "release") as diarization:
            main._prepare_workload("alignment")
        whisper.assert_called_once(); qwen.assert_called_once(); diarization.assert_called_once(); aligner.assert_not_called()

    def test_true_streaming_session_blocks_conflicting_postprocessor(self):
        with mock.patch.object(main.streaming_vllm, "active_sessions", return_value=1):
            with self.assertRaises(main.HTTPException) as caught: main._prepare_workload("alignment")
        self.assertEqual(caught.exception.detail["code"], "MODEL_BUSY")

    def test_optional_requirements_are_not_in_base_runtime(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        base = (root / "requirements.txt").read_text(encoding="utf-8").lower()
        self.assertNotIn("pyannote", base); self.assertNotIn("vllm", base); self.assertNotIn("nagisa", base)
        diarization = (root / "requirements-diarization.txt").read_text(encoding="utf-8")
        streaming = (root / "requirements-streaming.txt").read_text(encoding="utf-8")
        self.assertIn("pyannote.audio", diarization); self.assertIn("qwen-asr[vllm]", streaming)


if __name__ == "__main__": unittest.main()
