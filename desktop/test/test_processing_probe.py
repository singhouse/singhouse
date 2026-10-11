# SPDX-License-Identifier: AGPL-3.0-only
import importlib.abc
import importlib.machinery
import importlib.util
import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

DESKTOP = Path(__file__).resolve().parents[1]
ARCH_LIST = ["sm_70", "sm_75", "sm_80", "sm_86", "sm_90", "sm_100", "sm_120"]


def load_probe():
    spec = importlib.util.spec_from_file_location("processing_probe_under_test", DESKTOP / "processing_probe.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def stub_torch(capability, arch_list=ARCH_LIST):
    """A torch stand-in that records device work instead of performing it."""
    torch = types.ModuleType("torch")
    torch.calls = []

    def device_work(*args, **kwargs):
        torch.calls.append(("device-work", kwargs.get("device")))
        raise AssertionError("device work ran before the capability check")

    torch.cuda = types.SimpleNamespace(
        current_device=lambda: 0,
        get_device_capability=lambda index: capability,
        get_arch_list=lambda: list(arch_list),
    )
    torch.set_num_threads = lambda count: None
    torch.manual_seed = lambda seed: None
    torch.float16, torch.float32 = "float16", "float32"
    torch.tensor = device_work
    return torch


class StubImports(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    """Serves stub modules for imports made inside the probe under test."""

    def __init__(self, modules):
        self.modules = modules

    def find_spec(self, name, path=None, target=None):
        if name in self.modules:
            return importlib.machinery.ModuleSpec(name, self)
        return None

    def create_module(self, spec):
        return self.modules[spec.name]

    def exec_module(self, module):
        pass


class ProbeCapabilityTests(unittest.TestCase):
    def setUp(self):
        self.probe = load_probe()

    def test_arch_list_comparison(self):
        supported = self.probe.capability_supported
        self.assertFalse(supported((6, 1), ARCH_LIST))
        self.assertFalse(supported((5, 2), ARCH_LIST))
        for capability in [(7, 0), (7, 5), (8, 6), (8, 9), (9, 0), (12, 0)]:
            self.assertTrue(supported(capability, ARCH_LIST), capability)
        # SASS needs the same major; PTX may be compiled for newer devices.
        self.assertFalse(supported((10, 0), ["sm_90"]))
        self.assertTrue(supported((10, 0), ["sm_90", "compute_90"]))
        self.assertFalse(supported((9, 0), ["sm_90a"]))
        self.assertEqual(self.probe.minimum_capability(ARCH_LIST), (7, 0))
        self.assertIsNone(self.probe.minimum_capability(["sm_90a"]))

    def test_matches_worker_admission_logic(self):
        try:
            from karaoke_backend.workers import memory_admission
        except ImportError:
            self.skipTest("backend package is not installed")
        arch_lists = [ARCH_LIST, ["sm_90"], ["sm_90", "compute_90"], ["sm_90a"], ["compute_75"], []]
        capabilities = [(major, minor) for major in (5, 6, 7, 8, 9, 10, 12) for minor in (0, 1, 2, 5, 6, 9)]
        for arch_list in arch_lists:
            self.assertEqual(self.probe.minimum_capability(arch_list),
                             memory_admission.minimum_capability(arch_list), arch_list)
            for capability in capabilities:
                self.assertEqual(self.probe.capability_supported(capability, arch_list),
                                 memory_admission.capability_supported(capability, arch_list),
                                 (capability, arch_list))

    def test_unsupported_gpu_message(self):
        with self.assertRaisesRegex(RuntimeError, r"^GPU compute capability 6\.1 is not supported; "
                                                  r"this runtime requires 7\.0 or newer$"):
            self.probe.require_supported_cuda(stub_torch((6, 1)))
        self.probe.require_supported_cuda(stub_torch((8, 6)))

    def test_missing_architecture_list_refuses_activation(self):
        # Without the compiled architectures support cannot be established,
        # even for a GPU that would otherwise qualify.
        for capability in [(6, 1), (8, 6)]:
            with self.assertRaisesRegex(RuntimeError, r"^The installed CUDA runtime lists no compiled GPU "
                                                      r"architectures, so this GPU cannot be checked$"):
                self.probe.require_supported_cuda(stub_torch(capability, arch_list=[]))
        torch = stub_torch((8, 6), arch_list=[])
        with self.assertRaisesRegex(RuntimeError, "no compiled GPU architectures"):
            self.run_probe("cuda", torch)
        self.assertEqual(torch.calls, [])

    def run_probe(self, accelerator, torch):
        stubs = {name: mock.MagicMock(name=name) for name in ("numpy", "soundfile", "librosa")}
        stubs["torch"] = torch
        finder = StubImports({name: module for name, module in stubs.items() if name not in sys.modules or name == "torch"})
        with mock.patch.dict(os.environ, {}, clear=False), mock.patch.object(sys, "meta_path", [finder, *sys.meta_path]):
            os.environ.pop("PYTORCH_ENABLE_MPS_FALLBACK", None)
            try:
                return self.probe.run(["separation"], accelerator, [])
            finally:
                sys.modules.pop("torch", None)

    def test_cuda_probe_refuses_unsupported_gpu_before_device_work(self):
        torch = stub_torch((6, 1))
        with self.assertRaisesRegex(RuntimeError, r"GPU compute capability 6\.1 is not supported; "
                                                  r"this runtime requires 7\.0 or newer"):
            self.run_probe("cuda", torch)
        self.assertEqual(torch.calls, [])

    def test_supported_cuda_gpu_proceeds_to_device_work(self):
        torch = stub_torch((8, 6))
        with self.assertRaisesRegex(AssertionError, "device work"):
            self.run_probe("cuda", torch)
        self.assertEqual(torch.calls, [("device-work", "cuda")])

    def test_cpu_probe_does_not_query_the_gpu(self):
        torch = stub_torch((6, 1))
        torch.cuda = None
        with self.assertRaisesRegex(AssertionError, "device work"):
            self.run_probe("cpu", torch)
        self.assertEqual(torch.calls, [("device-work", "cpu")])


if __name__ == "__main__":
    unittest.main()
