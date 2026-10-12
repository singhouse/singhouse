# SPDX-License-Identifier: AGPL-3.0-only
"""Fresh local resource checks. This module never installs or changes variants."""
from __future__ import annotations

import ctypes
import json
import os
import platform
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


def _run(command: list[str]) -> str:
    result = subprocess.run(command, capture_output=True, text=True, timeout=2,
                            check=True, shell=False)
    if len(result.stdout) > 65536:
        raise ValueError("Resource probe output exceeded limit")
    return result.stdout


def _windows_memory_status():
    class MemoryStatus(ctypes.Structure):
        _fields_ = [("length", ctypes.c_uint32), ("load", ctypes.c_uint32)] + [
            (name, ctypes.c_uint64) for name in
            ("total", "available", "page_total", "page_available", "virtual_total", "virtual_available", "extended")]
    status = MemoryStatus()
    status.length = ctypes.sizeof(status)
    return status if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)) else None


def total_ram() -> int | None:
    """Observe physical memory independently of currently available capacity."""
    try:
        system = platform.system()
        if system == "Linux":
            fields = [line for line in Path("/proc/meminfo").read_text().splitlines()
                      if re.match(r"^MemTotal\b", line)]
            match = re.fullmatch(r"MemTotal:[ \t]+([0-9]+) kB", fields[0]) if len(fields) == 1 else None
            observed = int(match[1]) * 1024 if match else None
        elif system == "Windows":
            status = _windows_memory_status()
            observed = status.total if status is not None else None
        elif system == "Darwin":
            text = _run(["/usr/sbin/sysctl", "-n", "hw.memsize"]).strip()
            observed = int(text) if re.fullmatch(r"[0-9]+", text) else None
        else:
            return None
        return observed if type(observed) is int and 0 < observed <= 2**53 - 1 else None
    except (OSError, ValueError, AttributeError, subprocess.SubprocessError):
        pass
    return None


def available_ram() -> int | None:
    try:
        system = platform.system()
        if system == "Linux":
            text = Path("/proc/meminfo").read_text()
            match = re.search(r"^MemAvailable:\s+(\d+) kB$", text, re.MULTILINE)
            return int(match[1]) * 1024 if match else None
        if system == "Windows":
            status = _windows_memory_status()
            return status.available if status is not None else None
        if system == "Darwin":
            text = _run(["/usr/bin/vm_stat"])
            page = re.search(r"page size of (\d+) bytes", text)
            fields = {name: int(value) for name, value in re.findall(r"^(Pages [^:]+):\s+(\d+)\.", text, re.MULTILINE)}
            # Conservative: do not count compressed, wired, active, or speculative pages.
            if page and all(name in fields for name in ("Pages free", "Pages inactive")):
                return int(page[1]) * (fields["Pages free"] + fields["Pages inactive"])
    except (OSError, ValueError, AttributeError, subprocess.SubprocessError):
        pass
    return None


def available_vram() -> int | None:
    try:
        # The managed backend intentionally has only bundled audio tools on PATH.
        # Driver observation uses OS installation locations rather than user PATH.
        if platform.system() == "Windows":
            system_root = os.environ.get("SYSTEMROOT") or os.environ.get("WINDIR")
            if not system_root or not Path(system_root).is_absolute():
                return None
            executable = str(Path(system_root) / "System32" / "nvidia-smi.exe")
        elif platform.system() == "Linux":
            executable = "/usr/bin/nvidia-smi"
        else:
            return None
        lines = _run([executable, "--query-gpu=memory.free", "--format=csv,noheader,nounits"]).strip().splitlines()
        # Multiple devices are ambiguous: neither summing nor picking the largest
        # establishes the memory of the device the worker will actually use.
        if len(lines) == 1 and re.fullmatch(r"\d+", lines[0].strip()):
            return int(lines[0]) * 1024 * 1024
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return None


def available_disk() -> int | None:
    try:
        paths = [Path(tempfile.gettempdir())] + [Path(os.environ[key]) for key in ("UPLOADS_DIR", "STEMS_DIR") if os.environ.get(key)]
        existing = []
        for path in paths:
            while not path.exists() and path != path.parent:
                path = path.parent
            existing.append(path)
        return min(shutil.disk_usage(path).free for path in existing)
    except OSError:
        return None


def enforce_resources(runtime: dict, *, ram_probe=None, vram_probe=None, disk_probe=None, total_ram_probe=None) -> None:
    from .managed_processing import InvalidAttestation
    raw = os.environ.get("KARAOKE_DESKTOP_RESOURCE_POLICY_JSON")
    if raw is None:
        return
    def invalid(message):
        raise InvalidAttestation(message + " Review local setup and retry; no alternate variant or download was started.")
    try:
        value = json.loads(raw)
        if (not isinstance(value, dict) or set(value) != {"schema", "runtimeManifestId", "variantId", "requirements", "settings"}
                or type(value["schema"]) is not int or value["schema"] != 1
                or value["runtimeManifestId"] != runtime["runtimeManifestId"]
                or not isinstance(value["variantId"], str) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,95}", value["variantId"])
                or value["settings"] != {}):
            invalid("The selected resource policy is invalid or requests unsupported processing settings.")
        requirements = value["requirements"]
        required_keys = {"ramBytes", "vramBytes", "unifiedMemory", "workingDiskBytes"}
        if (not isinstance(requirements, dict) or set(requirements) not in (required_keys, required_keys | {"totalRamBytes"})
                or any(type(requirements[key]) is not int or not 0 < requirements[key] <= 2**53 - 1 for key in ("ramBytes", "workingDiskBytes"))
                or type(requirements["unifiedMemory"]) is not bool):
            invalid("The selected resource requirements are incomplete.")
        if "totalRamBytes" in requirements and (type(requirements["totalRamBytes"]) is not int
                or not requirements["ramBytes"] <= requirements["totalRamBytes"] <= 2**53 - 1):
            invalid("The selected physical memory requirement is invalid.")
        cuda = runtime["accelerator"] == "cuda"
        if cuda:
            if requirements["unifiedMemory"] or type(requirements["vramBytes"]) is not int or not 0 < requirements["vramBytes"] <= 2**53 - 1:
                invalid("Dedicated CUDA memory requirements are invalid.")
        elif requirements["vramBytes"] is not None:
            invalid("Dedicated GPU memory requirements do not match this accelerator.")
        unified = platform.system() == "Darwin" and platform.machine().lower() in {"arm64", "aarch64"}
        if requirements["unifiedMemory"] != unified:
            invalid("Memory architecture does not match the selected policy.")
    except (TypeError, ValueError, KeyError):
        invalid("The selected resource policy cannot be read.")
    checks = [("system memory", requirements["ramBytes"], ram_probe or available_ram),
              ("storage", requirements["workingDiskBytes"], disk_probe or available_disk)]
    if "totalRamBytes" in requirements:
        checks.insert(0, ("physical system memory", requirements["totalRamBytes"], total_ram_probe or total_ram))
    if cuda:
        checks.append(("CUDA memory", requirements["vramBytes"], vram_probe or available_vram))
    for label, required, probe in checks:
        try:
            observed = probe()
        except Exception:
            observed = None
        if type(observed) is not int or observed < 0:
            invalid(f"The {label} could not be measured.")
        if label == "physical system memory" and not 0 < observed <= 2**53 - 1:
            invalid("The physical system memory could not be measured.")
        if observed < required:
            if label == "physical system memory":
                invalid("The physical system memory is below the selected requirement.")
            invalid(f"Currently available {label} is below the selected requirement. Close other applications or free storage.")
