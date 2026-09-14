# SPDX-License-Identifier: AGPL-3.0-only
"""The managed float-WAV boundary, independent of any model checkpoint."""
import importlib.util
import tempfile
from pathlib import Path
import unittest

from karaoke_backend.workers import managed_demucs


class ManagedDemucsTests(unittest.TestCase):
    def test_other_output_formats_are_rejected_before_importing_ml_dependencies(self):
        with self.assertRaisesRegex(ValueError, "float32 WAV"):
            managed_demucs.save_float_wav(None, "output.flac", 16000, as_float=True)
        with self.assertRaisesRegex(ValueError, "float32 WAV"):
            managed_demucs.save_float_wav(None, "output.wav", 16000)

    def test_cli_rejects_other_codec_paths(self):
        with self.assertRaises(SystemExit):
            managed_demucs.main(["-n", "mdx_extra", "--device", "cpu", "--float32", "--mp3", "-o", "output", "input.wav"])

    @unittest.skipUnless(all(importlib.util.find_spec(name) for name in ("torch", "soundfile", "demucs")),
                         "processing dependencies required for waveform integration")
    def test_float_wav_preserves_shape_rate_and_upstream_clipping(self):
        import torch
        import numpy as np
        import soundfile
        from demucs.audio import prevent_clip
        waveform = torch.tensor([[-2., -0.5, 0., 0.5, 2.], [1., -1., 0.2, -0.2, 0.]])
        with tempfile.TemporaryDirectory(prefix="managed-demucs-waveform-") as temporary:
            for clip in ("rescale", "clamp", "tanh", "none"):
                path = Path(temporary) / (clip + ".wav")
                managed_demucs.save_float_wav(waveform, path, 22050, as_float=True, clip=clip)
                restored, rate = soundfile.read(path, dtype="float32", always_2d=True)
                expected = prevent_clip(waveform, mode=clip).T.numpy()
                self.assertEqual(rate, 22050)
                self.assertEqual(restored.shape, (5, 2))
                self.assertEqual(soundfile.info(path).subtype, "FLOAT")
                np.testing.assert_array_equal(restored, expected)


if __name__ == "__main__":
    unittest.main()
