import json
import pathlib
import tempfile
import threading
import time
import unittest
from unittest import mock

import model_manager


def valid_model(directory, qwen=False):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "config.json").write_text("{}")
    (directory / "model.bin").write_bytes(b"weights")
    if qwen: (directory / "preprocessor_config.json").write_text("{}")


class ModelLifecycleTests(unittest.TestCase):
    def test_legacy_model_migrates_manifest_and_broken_is_preserved(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(model_manager, "MODELS_DIR", pathlib.Path(tmp)):
            valid_model(model_manager._whisper_local_dir("tiny"))
            state = model_manager.verify_model("whisper-tiny")
            self.assertEqual(state["status"], "ready")
            self.assertTrue((model_manager._whisper_local_dir("tiny") / model_manager.MANIFEST_NAME).is_file())
            broken = model_manager._whisper_local_dir("base"); broken.mkdir(); (broken / "config.json").write_text("{}")
            self.assertEqual(model_manager.verify_model("whisper-base")["status"], "broken")
            self.assertTrue(broken.exists())

    def test_download_finalize_duplicate_and_unknown_total(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(model_manager, "MODELS_DIR", pathlib.Path(tmp)), \
             mock.patch.object(model_manager, "repository_total_bytes", return_value=None), \
             mock.patch.object(model_manager.shutil, "disk_usage", return_value=mock.Mock(free=10**12)):
            manager = model_manager.DownloadManager()
            def fake_download(model_id, destination, cancel_event):
                time.sleep(.05); valid_model(pathlib.Path(destination))
            with mock.patch.object(model_manager, "download", side_effect=fake_download):
                first = manager.start("whisper-tiny"); second = manager.start("whisper-tiny")
                self.assertEqual(first["status"], "queued"); self.assertTrue(second["alreadyDownloading"])
                self.wait_terminal(manager, "whisper-tiny")
            state = manager.status("whisper-tiny")
            self.assertEqual(state["status"], "ready"); self.assertIsNone(state["progress"])
            self.assertTrue((model_manager._whisper_local_dir("tiny") / model_manager.MANIFEST_NAME).is_file())
            self.assertFalse(model_manager.download_dir("whisper-tiny").exists())

    def test_real_progress_cancel_and_incomplete_recovery(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(model_manager, "MODELS_DIR", pathlib.Path(tmp)), \
             mock.patch.object(model_manager, "repository_total_bytes", return_value=100), \
             mock.patch.object(model_manager.shutil, "disk_usage", return_value=mock.Mock(free=10**12)):
            manager = model_manager.DownloadManager()
            def slow_download(_id, destination, cancel_event):
                destination = pathlib.Path(destination); destination.mkdir(parents=True, exist_ok=True)
                for _ in range(10):
                    if cancel_event.is_set(): raise InterruptedError()
                    with (destination / "part").open("ab") as file: file.write(b"x" * 10)
                    time.sleep(.06)
            with mock.patch.object(model_manager, "download", side_effect=slow_download):
                manager.start("whisper-tiny"); time.sleep(.3)
                observed = manager.status("whisper-tiny")
                self.assertGreater(observed["downloadedBytes"], 0); self.assertIsNotNone(observed["progress"])
                self.assertTrue(manager.cancel("whisper-tiny")); self.wait_terminal(manager, "whisper-tiny")
            self.assertEqual(manager.status("whisper-tiny")["status"], "cancelled")
            recovered = model_manager.DownloadManager().status("whisper-tiny")
            self.assertEqual(recovered["status"], "cancelled")

    def test_insufficient_disk_and_broken_download(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(model_manager, "MODELS_DIR", pathlib.Path(tmp)), \
             mock.patch.object(model_manager.shutil, "disk_usage", return_value=mock.Mock(free=1)):
            manager = model_manager.DownloadManager(); manager.start("whisper-tiny"); self.wait_terminal(manager, "whisper-tiny")
            self.assertEqual(manager.status("whisper-tiny")["error"]["code"], "DISK_SPACE_INSUFFICIENT")
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(model_manager, "MODELS_DIR", pathlib.Path(tmp)), \
             mock.patch.object(model_manager, "repository_total_bytes", return_value=None), \
             mock.patch.object(model_manager.shutil, "disk_usage", return_value=mock.Mock(free=10**12)), \
             mock.patch.object(model_manager, "download", side_effect=lambda _id, destination, _cancel: pathlib.Path(destination).mkdir(parents=True, exist_ok=True)):
            manager = model_manager.DownloadManager(); manager.start("whisper-tiny"); self.wait_terminal(manager, "whisper-tiny")
            self.assertEqual(manager.status("whisper-tiny")["status"], "broken")

    def test_delete_and_per_model_lock(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(model_manager, "MODELS_DIR", pathlib.Path(tmp)):
            valid_model(model_manager._whisper_local_dir("tiny")); model_manager.verify_model("whisper-tiny")
            with model_manager.model_operation("whisper-tiny"):
                with self.assertRaises(model_manager.ModelLifecycleError) as caught: model_manager.delete("whisper-tiny")
                self.assertEqual(caught.exception.code, "MODEL_BUSY")
            self.assertEqual(model_manager.delete("whisper-tiny")["status"], "not_installed")

    @staticmethod
    def wait_terminal(manager, model_id):
        for _ in range(100):
            if manager.status(model_id)["status"] in ("ready", "cancelled", "broken", "error"): return
            time.sleep(.02)
        raise AssertionError("download did not finish")


if __name__ == "__main__": unittest.main()
