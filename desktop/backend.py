# SPDX-License-Identifier: AGPL-3.0-only
"""Run an isolated, disposable development backend for the desktop shell."""

from __future__ import annotations

import argparse
import asyncio
from contextlib import contextmanager, redirect_stdout
import importlib.metadata
import importlib.util
import hashlib
import json
import math
import os
import platform
import re
from pathlib import Path
import secrets
import signal
import shutil
import socket
import struct
import stat
import sys
import tempfile
import threading
import wave


def own_process_tree():
    """Windows descendants inherit a kill-on-close job; POSIX owns a session."""
    if os.name != "nt":
        if os.getsid(0) != os.getpid():
            os.setsid()
        return None
    import ctypes
    from ctypes import wintypes

    class BasicLimits(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class IO(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in
                    ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                     "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BasicLimits), ("IoInfo", IO),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    limits = ExtendedLimits()
    limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
        error = ctypes.WinError(ctypes.get_last_error())
        kernel.CloseHandle(job)
        raise error
    # Deliberately held until process teardown, never inherited by children.
    return job


def kill_owned_tree():
    if os.name == "nt":
        os._exit(1)  # Kernel closes the held job and terminates descendants.
    os.killpg(os.getpid(), signal.SIGKILL)


def windows_durable_replace(source, destination, directories, kernel=None):
    """Write-through replacement plus an OS metadata-flush handle.

    Directory flushing is not available on every Windows filesystem. A volume
    flush is a stricter fallback and can be denied to an ordinary account; in
    that case fail before replacement rather than report durable activation.
    """
    import ctypes
    from ctypes import wintypes
    if kernel is None:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.FlushFileBuffers.argtypes = [wintypes.HANDLE]
    kernel.FlushFileBuffers.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.MoveFileExW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
    kernel.MoveFileExW.restype = wintypes.BOOL
    handles = []

    def acquire(path, flags):
        handle = kernel.CreateFileW(str(path), 0xC0000000, 7, None, 3, flags, None)
        if handle in (None, ctypes.c_void_p(-1).value):
            return None
        if not kernel.FlushFileBuffers(handle):
            kernel.CloseHandle(handle)
            return None
        return handle

    try:
        for directory in directories:
            handle = acquire(directory, 0x02200000)  # BACKUP_SEMANTICS | OPEN_REPARSE_POINT
            if handle is None:
                for held in handles:
                    kernel.CloseHandle(held)
                handles.clear()
                drives = {source.drive, destination.drive}
                if any(not re.fullmatch(r"[A-Za-z]:", drive) for drive in drives):
                    raise RuntimeError("Native metadata flush is unavailable for this Windows volume")
                for drive in drives:
                    volume = acquire("\\\\.\\" + drive, 0)
                    if volume is None:
                        raise RuntimeError("Windows denied both directory and volume metadata flush; activation was not performed")
                    handles.append(volume)
                break
            handles.append(handle)
        if source != destination and not kernel.MoveFileExW(str(source), str(destination), 0x9):  # REPLACE_EXISTING | WRITE_THROUGH
            raise RuntimeError("Windows write-through runtime replacement failed")
        if any(not kernel.FlushFileBuffers(handle) for handle in handles):
            raise RuntimeError("Windows could not confirm durable runtime metadata")
    finally:
        for handle in handles:
            kernel.CloseHandle(handle)


def durable_replace(source: Path, destination: Path):
    """Commit a local file/tree only if its bytes and directory entries flush."""
    if not source.is_absolute() or not destination.is_absolute() or source.is_symlink() or destination.is_symlink():
        raise RuntimeError("Durable replacement requires absolute non-symlink paths")
    directories = set()
    paths = list(source.rglob("*")) if source.is_dir() else []
    paths.append(source)
    for path in paths:
        if path.is_symlink():
            raise RuntimeError("Cannot commit a runtime containing symbolic links")
        if path.is_dir():
            directories.add(path)
        elif path.is_file():
            descriptor = os.open(path, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
            try:
                if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                    raise RuntimeError("Runtime payload contains a non-regular file")
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        else:
            raise RuntimeError("Cannot commit a non-regular runtime payload")
    # Include ancestors: a newly created store itself must survive a restart.
    directories.update(source.parents)
    directories.update(destination.parents)
    ordered = sorted(directories, key=lambda path: len(path.parts), reverse=True)
    if os.name == "nt":
        windows_durable_replace(source, destination, ordered)
    else:
        handles = []
        try:
            for directory in ordered:
                descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
                handles.append(descriptor)
                os.fsync(descriptor)  # Unsupported metadata sync fails before rename.
            os.replace(source, destination)
            for descriptor in handles:
                os.fsync(descriptor)
        finally:
            for descriptor in handles:
                os.close(descriptor)
    return {"schema": 1, "durable": True}


def validate_root(root: Path) -> Path:
    root = root.resolve(strict=True)
    for relative in ("backend/src/karaoke_backend/__init__.py",
                     "lyricsync/src/lyricsync/__init__.py", "frontend/dist/index.html"):
        path = root / relative
        if not path.is_file() or not path.resolve().is_relative_to(root):
            raise RuntimeError(f"Missing release source or built frontend: {relative}")
    for path in (root / "frontend/dist").rglob("*"):
        if path.is_symlink():
            raise RuntimeError("Built frontend must not contain symbolic links")
    return root


def reject_plugins() -> None:
    for distribution in importlib.metadata.distributions():
        if any(ep.group.startswith("karaoke_backend.")
               for ep in distribution.entry_points):
            raise RuntimeError("Use a clean core-only environment without backend plugins")
    if importlib.util.find_spec("karaoke_premium") is not None:
        raise RuntimeError("Use a clean core-only environment")


def isolated_environment(runtime: Path, origin: str, password: str, *, disposable: bool = True) -> dict[str, str]:
    # Preserve only OS executable discovery; every application setting is new.
    env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "WINDIR", "COMSPEC")
           if key in os.environ}
    env.update({
        "TMPDIR": str(runtime), "TMP": str(runtime), "TEMP": str(runtime),
        "XDG_CACHE_HOME": str(runtime / "cache"),
        "XDG_CONFIG_HOME": str(runtime / "config"),
        "XDG_DATA_HOME": str(runtime / "data"),
        "HF_HOME": str(runtime / "cache/huggingface"),
        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
        "PYTHONDONTWRITEBYTECODE": "1", "AUTH_MODE": "single_host",
        "DATABASE_URL": "sqlite+aiosqlite:///" + str(runtime / "desktop.db"),
        "UPLOADS_DIR": str(runtime / "uploads"), "STEMS_DIR": str(runtime / "stems"),
        "SESSION_SECRET": secrets.token_urlsafe(48),
        "SESSION_COOKIE": "karaoke_session", "SESSION_HTTPS_ONLY": "false",
        "KARAOKE_GATE_PASSWORD": password, "BASE_URL": origin,
        "CORS_ORIGINS": origin, "KARAOKE_PROVIDERS_DIR": "", "KARAOKE_PROVIDERS": "none",
        "KARAOKE_LRCLIB": "0", "KARAOKE_MODAL": "0", "LOG_LEVEL": "INFO",
    })
    if disposable:
        env.update({"HOME": str(runtime), "USERPROFILE": str(runtime)})
    return env


@contextmanager
def persistent_directory(supplied: Path):
    """An OS-held lock has no stale-PID recovery race and survives lock-file reuse."""
    if not supplied.is_absolute() or supplied.is_symlink():
        raise RuntimeError("Data directory must be absolute and not a symbolic link")
    supplied.mkdir(mode=0o700, parents=True, exist_ok=True)
    if hasattr(os, "getuid") and supplied.stat().st_uid != os.getuid():
        raise RuntimeError("Data directory must belong to the current user")
    lock_path = supplied / "owner.lock"
    if lock_path.is_symlink():
        raise RuntimeError("Invalid owner lock")
    with lock_path.open("a+b") as lock:
        lock.seek(0)
        if not lock.read(1):
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise RuntimeError("This installation's library is already open") from error
        # Closing releases the lock, including when this process crashes. Never
        # unlink the file: another process may already hold its inode open.
        yield supplied.resolve()


def persistent_environment(runtime: Path, origin: str, password: str, native: Path):
    env = isolated_environment(runtime, origin, password, disposable=False)
    if (runtime / ".env").exists():
        raise RuntimeError("Desktop settings use settings.json; remove .env from the data directory")
    settings = runtime / "settings.json"
    if settings.is_symlink():
        raise RuntimeError("Invalid settings file")
    if not settings.exists():
        descriptor, temporary = tempfile.mkstemp(prefix=".settings-", dir=runtime)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump({"schema": 1, "sessionSecret": secrets.token_urlsafe(48)}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, settings)
        finally:
            Path(temporary).unlink(missing_ok=True)
    config = json.loads(settings.read_text(encoding="utf-8"))
    if config.get("schema") != 1 or not isinstance(config.get("sessionSecret"), str) or len(config["sessionSecret"]) < 48:
        raise RuntimeError("Invalid desktop settings; existing data has been preserved")
    env["SESSION_SECRET"] = config["sessionSecret"]
    env["PATH"] = str(native / "ffmpeg/bin")
    return env


def processing_environment(runtime: Path, identity: dict, processing: Path | None,
                           models: Path | None, probe: dict | None = None,
                           model_policy: dict | None = None,
                           trusted_locks: list[str] | None = None) -> dict[str, str]:
    """Recheck selected immutable files before giving workers executable paths."""
    env = {"KARAOKE_PROCESSING_PYTHON": "", "KARAOKE_DEMUCS_PYTHON": "",
           "KARAOKE_PROCESSING_ACCELERATOR": "",
           "KARAOKE_AUDIO_SEPARATOR_DEVICE": "",
           "KARAOKE_HEART_CKPT": "",
           "KARAOKE_DESKTOP_MODEL_SETS_JSON": "",
           "KARAOKE_HEART_MODEL_STATUS_JSON": json.dumps({"installed": False, "modelId": "heart-transcriptor", "revision": None}),
           "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
           "PYTORCH_ENABLE_MPS_FALLBACK": "0",
           "NUMBA_CACHE_DIR": str(runtime / "cache/numba"),
           "HF_HOME": str(runtime / "cache/huggingface"),
           "TORCH_HOME": str(runtime / "cache/torch"),
           "KARAOKE_MODEL_DIR": str(runtime / "cache/audio-separator")}

    def verify(directory: Path, store: str, kind: str):
        expected_parent = runtime.parent / store / "packs"
        if directory.parent != expected_parent or not re.fullmatch(r"[a-f0-9]{64}", directory.name):
            raise RuntimeError("Invalid managed processing path")
        for ancestor in (expected_parent.parent, expected_parent, directory):
            if ancestor.is_symlink():
                raise RuntimeError("Managed processing directories must not be symbolic links")
        descriptor = os.open(directory / "manifest.json", os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(descriptor, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise RuntimeError("Managed processing manifest must be a regular file")
            raw = stream.read()
        if hashlib.sha256(raw).hexdigest() != directory.name:
            raise RuntimeError("Managed processing manifest was modified")
        manifest = json.loads(raw)
        if manifest.get("schema") != 1 or manifest.get("kind") != kind:
            raise RuntimeError("Invalid managed processing manifest")
        allowed = {"manifest.json"}
        path_keys = {"manifest.json"}
        case_sensitive = kind == "processing" and manifest.get("platform") == "linux"
        for record in manifest["files"]:
            if (not isinstance(record.get("path"), str)
                    or any(not re.fullmatch(r"[A-Za-z0-9._+() -]+", part) or part.strip() != part
                           or part in {".", ".."} or part.endswith(".")
                           or re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", part, re.I)
                           for part in record["path"].split("/"))):
                raise RuntimeError("Invalid managed processing file path")
            relative = Path(record["path"])
            if relative.is_absolute() or any(part in {"..", "."} for part in relative.parts):
                raise RuntimeError("Invalid managed processing file path")
            path = directory / relative
            name = relative.as_posix()
            path_key = name if case_sensitive else name.casefold()
            if path_key in path_keys:
                raise RuntimeError("Duplicate managed processing file path")
            path_keys.add(path_key)
            allowed.add(name)
            if any(parent.is_symlink() for parent in (path, *path.parents) if parent != directory.parent):
                raise RuntimeError("Managed processing files must not be symbolic links")
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(descriptor, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size != record["size"] or hashlib.file_digest(stream, "sha256").hexdigest() != record["sha256"]:
                    raise RuntimeError("Managed processing file verification failed")
        actual = set()
        for path in directory.rglob("*"):
            if path.is_symlink() or not (path.is_dir() or path.is_file()):
                raise RuntimeError("Unexpected managed processing file type")
            if path.is_file():
                actual.add(path.relative_to(directory).as_posix())
        if actual != allowed:
            raise RuntimeError("Managed processing file inventory does not match its manifest")
        if not isinstance(manifest.get("models"), list) or len(set(manifest["models"])) != len(manifest["models"]):
            raise RuntimeError("Invalid or duplicate managed model IDs")
        return manifest

    model_manifest = verify(models, "model-cache", "models") if models else None
    if model_manifest:
        from urllib.parse import urlparse
        if model_policy is None:
            model_policy = json.loads(Path(__file__).with_name("models.json").read_text())
        if model_policy.get("schema") != 1 or not model_manifest["models"]:
            raise RuntimeError("Invalid application model policy")
        expected_files = {}
        for model_id in model_manifest["models"]:
            entries = [entry for entry in model_policy["models"] if entry["id"] == model_id]
            if len(entries) != 1 or not entries[0].get("files"):
                raise RuntimeError("Model set is not defined by the application policy")
            for record in entries[0]["files"]:
                if record["path"] in expected_files:
                    raise RuntimeError("Overlapping model policy inventories")
                expected_files[record["path"]] = record
        if len(expected_files) != len(model_manifest["files"]):
            raise RuntimeError("Model inventory does not match application policy")
        for record in model_manifest["files"]:
            locked = expected_files.get(record["path"])
            url = urlparse(record["url"])
            if not locked or any(record.get(key) != locked.get(key) for key in ("path", "revision", "sha256", "size", "url", "executable")):
                raise RuntimeError("Model file differs from immutable application policy")
            if (record["executable"] is not False or url.scheme != "https" or url.username or url.password
                    or url.fragment or url.port not in (None, 443) or url.hostname not in model_policy["allowedHosts"]
                    or not re.fullmatch(r"(?:[a-f0-9]{40}|[a-f0-9]{64})", record["revision"])
                    or not ((len(record["revision"]) == 64 and record["revision"] == record["sha256"])
                            or record["revision"] in url.path.split("/"))):
                raise RuntimeError("Invalid upstream model policy source")
        env.update({"HF_HOME": str(models / "huggingface"),
                    "TORCH_HOME": str(models / "torch"),
                    "KARAOKE_MODEL_DIR": str(models / "audio-separator")})
        if "heart-transcriptor" in model_manifest["models"]:
            entry = next(entry for entry in model_policy["models"] if entry["id"] == "heart-transcriptor")
            directories = {str(Path(record["path"]).parent) for record in entry["files"]}
            revisions = {record["revision"] for record in entry["files"]}
            if len(directories) != 1 or len(revisions) != 1:
                raise RuntimeError("Heart model inventory must describe one complete checkpoint")
            env["KARAOKE_HEART_CKPT"] = str(models / directories.pop())
            env["KARAOKE_HEART_MODEL_STATUS_JSON"] = json.dumps({
                "installed": True, "modelId": "heart-transcriptor", "revision": revisions.pop(),
            })
    if processing:
        manifest = verify(processing, "processing", "processing")
        for key in ("appVersion", "backendVersion", "lyricsyncVersion", "platform", "arch"):
            if manifest.get(key) != identity[key]:
                raise RuntimeError("Processing runtime is incompatible with this app")
        python_record = next((record for record in manifest["files"]
                              if record["path"] == manifest.get("python") and record["executable"]), None)
        if python_record is None:
            raise RuntimeError("Processing runtime has no managed Python executable")
        python_path = str(processing / python_record["path"])
        functional = manifest.get("probe", {}).get("schema") == 2
        capabilities = manifest.get("capabilities", [])
        checks = {name: True for name in ("deviceTensor", "nativeAudio", *capabilities)}
        if functional:
            # Independently bind positive admission to the app's exact trusted
            # input lock. A selected path or IPC readiness boolean is insufficient.
            if trusted_locks is None:
                policy = json.loads(Path(__file__).with_name("processing-locks.json").read_text())
                if policy.get("schema") != 1:
                    raise RuntimeError("Invalid application processing trust policy")
                trusted_locks = policy.get("lockSha256", [])
            provenance = manifest.get("provenance", {})
            raw_lock = provenance.get("inputLock", "")
            lock_hash = hashlib.sha256(raw_lock.encode()).hexdigest()
            if (not isinstance(trusted_locks, list) or lock_hash not in trusted_locks
                    or provenance.get("lockSha256") != lock_hash):
                raise RuntimeError("Processing input lock is not trusted by this application release")
            input_lock = json.loads(raw_lock)
            if input_lock.get("schema") != 1 or input_lock.get("kind") != "processing-input":
                raise RuntimeError("Invalid processing input lock")
            for key in ("appVersion", "backendVersion", "lyricsyncVersion", "pythonVersion", "platform", "arch",
                        "accelerator", "python", "capabilities", "models", "modelCapabilities", "probe", "files", "packages", "sourceCommit"):
                actual = (provenance.get(key) if key in {"packages", "sourceCommit"} else
                          [{name: value for name, value in record.items() if name != "url"} for record in manifest["files"]]
                          if key == "files" else manifest.get(key))
                if actual != input_lock.get(key):
                    raise RuntimeError("Processing manifest differs from its input lock")
            required = {"transcription": ["faster_whisper", "lyricsync.transcription.heart", "karaoke_backend.workers.heart_transcriptor"],
                        "separation": ["demucs.separate", "audio_separator.separator"]}
            if (not capabilities or len(set(capabilities)) != len(capabilities)
                    or any(name not in required for name in capabilities)
                    or manifest["probe"].get("type") != "python-functional-v1"
                    or manifest["probe"].get("modules") != sorted({module for name in capabilities for module in required[name]})
                    or manifest.get("accelerator") not in {"cpu", "cuda", "metal"}
                    or (manifest["accelerator"] == "metal" and any(
                        manifest.get("modelCapabilities", {}).get(model) == "transcription" and model != "heart-transcriptor"
                        for model in manifest["models"]))):
                raise RuntimeError("Unsupported functional processing probe")
        fixed_probe = {"runtimeManifestId": processing.name, "pythonPath": python_path,
                       "pythonSha256": python_record["sha256"], "probePassed": True,
                       "accelerator": manifest["accelerator"],
                       "verifiedCapabilities": capabilities if functional else [],
                       "capabilitiesReady": functional}
        if functional:
            fixed_probe.update({"probeSchema": 2, "checks": checks})
        expected_component_keys = set(manifest.get("probe", {}).get("modules", []))
        # JSON equality alone accepts 1 == True in Python: require actual booleans
        # for all readiness and demonstrated-check fields at this boundary.
        probe_passed = (isinstance(probe, dict) and set(probe) == {*fixed_probe, "components"}
                        and all(probe[key] == value for key, value in fixed_probe.items())
                        and probe["probePassed"] is True
                        and probe["capabilitiesReady"] is functional
                        and (not functional or (probe["probeSchema"] == 2 and type(probe["probeSchema"]) is int
                             and isinstance(probe["checks"], dict)
                             and all(value is True for value in probe["checks"].values())))
                        and isinstance(probe["components"], dict)
                        and set(probe["components"]) == expected_component_keys
                        and all(isinstance(value, str) and value for value in probe["components"].values()))
        capabilities_ready = probe_passed and functional
        env["KARAOKE_PROCESSING_PYTHON"] = python_path if capabilities_ready else ""
        env["KARAOKE_DEMUCS_PYTHON"] = env["KARAOKE_PROCESSING_PYTHON"]
        env["KARAOKE_PROCESSING_ACCELERATOR"] = manifest["accelerator"] if capabilities_ready else ""
        env["KARAOKE_AUDIO_SEPARATOR_DEVICE"] = ({"cpu": "cpu", "cuda": "cuda", "metal": "mps"}[manifest["accelerator"]]
                                                   if capabilities_ready else "")
        attestation = (probe if probe_passed else
                       {**fixed_probe, "components": {}, "probePassed": False,
                        "capabilitiesReady": False, "verifiedCapabilities": []})
        # The shared-core worker protocol remains the existing exact schema;
        # functional evidence is checked at the desktop admission boundary.
        env["KARAOKE_DESKTOP_PROCESSING_JSON"] = json.dumps(
            {key: value for key, value in attestation.items() if key not in {"probeSchema", "checks"}})
        env["KARAOKE_DESKTOP_MODEL_SETS_JSON"] = json.dumps({
            "schema": 1, "runtimeManifestId": processing.name,
            "modelManifestId": models.name if model_manifest else None,
            "requiredModels": {
                capability: sorted(model for model in manifest["models"]
                                   if manifest.get("modelCapabilities", {}).get(model) == capability) if functional else []
                for capability in ("transcription", "separation")},
            "verifiedModelIds": sorted(model_manifest["models"]) if model_manifest else [],
        })
    return env


def validate_native(native: Path) -> dict:
    native = native.resolve(strict=True)
    identity = json.loads((native / "manifest.json").read_text(encoding="utf-8"))
    keys = {"schema", "appVersion", "backendVersion", "lyricsyncVersion", "pythonVersion", "platform", "arch", "runtimeId"}
    if set(identity) != keys or identity["schema"] != 1 or any(
        not isinstance(identity[key], str) or not re.fullmatch(r"[A-Za-z0-9._+-]{1,128}", identity[key])
        for key in keys - {"schema"}
    ):
        raise RuntimeError("Invalid native runtime manifest")
    machine = {"AMD64": "x64", "x86_64": "x64", "aarch64": "arm64", "arm64": "arm64", "ARM64": "arm64"}.get(platform.machine())
    if identity["platform"] != sys.platform or identity["arch"] != machine or identity["pythonVersion"] != platform.python_version():
        raise RuntimeError("Bundled Python does not match runtime identity")
    python_root = (native / "python").resolve(strict=True)
    if not Path(sys.executable).resolve().is_relative_to(python_root) or not sys.flags.isolated:
        raise RuntimeError("Packaged backend requires its isolated bundled Python")
    for package, distribution, version in (("karaoke_backend", "karaoke-backend", "backendVersion"), ("lyricsync", "lyricsync", "lyricsyncVersion")):
        spec = importlib.util.find_spec(package)
        if spec is None or not spec.origin or not Path(spec.origin).resolve().is_relative_to(python_root):
            raise RuntimeError(f"Missing installed bundled package: {package}")
        if importlib.metadata.version(distribution) != identity[version]:
            raise RuntimeError(f"Installed package version mismatch: {package}")
    for relative in ("static/index.html", "ffmpeg/bin/ffmpeg" + (".exe" if os.name == "nt" else ""), "ffmpeg/bin/ffprobe" + (".exe" if os.name == "nt" else "")):
        path = native / relative
        if not path.is_file() or not path.resolve().is_relative_to(native):
            raise RuntimeError(f"Missing bundled resource: {relative}")
    for path in (native / "static").rglob("*"):
        if path.is_symlink():
            raise RuntimeError("Bundled static files must not contain symbolic links")
    return identity


class LoopbackOnly:
    """Reject foreign Host and Origin headers, including DNS rebinding."""

    def __init__(self, app, origin: str):
        self.app = app
        self.origin = origin.encode("ascii")
        self.authority = self.origin.removeprefix(b"http://")

    async def __call__(self, scope, receive, send):
        if scope["type"] in {"http", "websocket"}:
            headers = scope.get("headers", [])
            hosts = [v for k, v in headers if k.lower() == b"host"]
            origins = [v for k, v in headers if k.lower() == b"origin"]
            if hosts != [self.authority] or (origins and origins != [self.origin]):
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                else:
                    await send({"type": "http.response.start", "status": 403,
                                "headers": [(b"content-type", b"text/plain")]})
                    await send({"type": "http.response.body", "body": b"Forbidden"})
                return
        await self.app(scope, receive, send)


def write_tone(path: Path, frequency: float) -> None:
    """Original quiet synthetic tone, sixty seconds, with smooth pulse edges."""
    rate = 16000
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        # Integer frequencies make this one-second loop phase continuous.
        second = bytearray()
        for index in range(rate):
            t = index / rate
            envelope = math.sin(math.pi * t) ** 2
            second.extend(struct.pack("<h", round(500 * envelope * math.sin(2 * math.pi * frequency * t))))
        for _ in range(60):
            output.writeframes(second)


def watch_parent(fd: int, enforce_timeout: bool = False) -> threading.Event:
    """Signal parent loss when its lifetime pipe closes, even during startup.

    Direct launches must also keep stdin open. A daemon uses raw reads so an
    open pipe cannot hold Python's buffered stdin lock during interpreter exit.
    The server consumes the flag in its main loop, after startup has completed,
    so normal lifespan shutdown and temporary-directory cleanup still run.
    """
    closed = threading.Event()

    def read_until_eof():
        try:
            while os.read(fd, 4096):
                pass
        except OSError:
            pass
        finally:
            closed.set()
            if enforce_timeout:
                # Covers a stuck import, lifespan startup, or worker shutdown.
                # Normal exit finishes sooner; no stale PID is ever targeted.
                threading.Event().wait(15)
                kill_owned_tree()

    threading.Thread(target=read_until_eof, name="desktop-parent", daemon=True).start()
    return closed


def demo_word_sync() -> dict:
    """Canonical timed words for both the player's loader and stage renderer."""
    phrases = ["Soft light circles slowly", "Small waves drift gently", "Bright dots follow time"]
    lines = [[{"text": word, "start": 2 + n * 5 + i, "end": 2.8 + n * 5 + i}
              for i, word in enumerate(phrases[n % len(phrases)].split())]
             for n in range(11)]
    segments = [{"start": line[0]["start"], "end": line[-1]["end"],
                 "text": " ".join(word["text"] for word in line), "words": line}
                for line in lines]
    return {"segments": segments, "lines": lines, "metadata": {"method": "synthetic"}}


async def seed_demo(app) -> None:
    from karaoke_backend.api.identity import SINGLE_HOST_ID
    from karaoke_backend.database import AsyncSessionLocal
    from karaoke_backend.models.song import LyricsSet, Song

    stems = Path(os.environ["STEMS_DIR"]) / "synthetic-demo"
    stems.mkdir(parents=True)
    await asyncio.to_thread(write_tone, stems / "instrumental.wav", 220.0)
    await asyncio.to_thread(write_tone, stems / "lead_vocals.wav", 330.0)
    word_sync = demo_word_sync()
    async with AsyncSessionLocal() as db:
        song = Song(owner_id=SINGLE_HOST_ID, artist="Synthetic demo",
                    title="Quiet light", filename="synthetic-demo.wav", duration=60,
                    status="ready", stems_path=str(stems), lyrics_synced=True)
        db.add(song)
        await db.flush()
        lyrics = LyricsSet(owner_id=SINGLE_HOST_ID, song_id=song.id, source="manual",
                           label="Original synthetic timed words",
                           plain_lyrics="\n".join(segment["text"] for segment in word_sync["segments"]),
                           word_sync_json=json.dumps(word_sync))
        db.add(lyrics)
        await db.flush()
        song.active_lyrics_id = lyrics.id
        await db.commit()


@contextmanager
def runtime_directory(supplied: Path | None = None):
    """Use a new runtime, or the empty private directory owned by the parent."""
    if supplied is None:
        with tempfile.TemporaryDirectory(prefix="karaoke-desktop-") as temporary:
            yield Path(temporary)
        return
    if not supplied.is_absolute() or supplied.is_symlink() or not supplied.is_dir():
        raise RuntimeError("Runtime must be an existing absolute directory, not a symbolic link")
    info = supplied.stat()
    if hasattr(os, "getuid") and (info.st_uid != os.getuid() or info.st_mode & 0o077):
        raise RuntimeError("Runtime must be private and owned by the current user")
    if any(supplied.iterdir()):
        raise RuntimeError("Runtime must be empty")
    try:
        yield supplied.resolve()
    finally:
        shutil.rmtree(supplied, ignore_errors=False)


def run(root: Path | None, demo: bool, runtime_path: Path | None = None, native: Path | None = None,
        processing: Path | None = None, models: Path | None = None, processing_probe: dict | None = None) -> None:
    tree_job = own_process_tree() if native else None
    parent_closed = watch_parent(sys.stdin.fileno(), enforce_timeout=True) if native else None
    identity = validate_native(native) if native else None
    if native and (demo or runtime_path is None):
        raise RuntimeError("Packaged mode requires persistent data and cannot use demo mode")
    if not native:
        root = validate_root(root)
    reject_plugins()
    sys.dont_write_bytecode = True
    sources = () if native else (("karaoke_backend", root / "backend/src"), ("lyricsync", root / "lyricsync/src"))
    for package, source in sources:
        if package in sys.modules:
            raise RuntimeError("Backend packages were imported before isolation")
        sys.path.insert(0, str(source))
        spec = importlib.util.find_spec(package)
        if spec is None or Path(spec.origin).resolve() != (source / package / "__init__.py").resolve():
            raise RuntimeError(f"Cannot load release source for {package}")
    original_cwd = Path.cwd()
    protocol_stdout = sys.stdout
    with (persistent_directory(runtime_path) if native else runtime_directory(runtime_path)) as runtime:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            origin = f"http://127.0.0.1:{listener.getsockname()[1]}"
            password, nonce = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            environment = persistent_environment(runtime, origin, password, native) if native else isolated_environment(runtime, origin, password)
            if native:
                environment.update(processing_environment(runtime, identity, processing, models, processing_probe))
            os.environ.clear()
            os.environ.update(environment)
            if not native:
                shutil.copytree(root / "frontend/dist", runtime / "static", ignore=shutil.ignore_patterns("*.map"))
            os.chdir(runtime)
            try:
                with redirect_stdout(sys.stderr):
                    import uvicorn
                    from fastapi.responses import JSONResponse
                    from starlette.routing import Route
                    from karaoke_backend.main import app, SPAStaticFiles
                    if native:
                        app.router.routes[:] = [route for route in app.router.routes if getattr(route, "name", None) != "static"]
                        app.mount("/", SPAStaticFiles(directory=str(native / "static"), html=True), name="static")

                    async def ready(request):
                        return JSONResponse({"nonce": nonce, **({"identity": identity} if identity else {})}, headers={"Cache-Control": "no-store"})

                    app.router.routes.insert(0, Route("/desktop-ready", ready, methods=["GET"]))
                    # Keep the core's provider-router insertion anchor consistent.
                    app.state.provider_route_anchor += 1
                    if demo:
                        app.state.lifespan_startup_hooks.append(seed_demo)

                    async def announce(app):
                        print(json.dumps({"origin": origin, "password": password, "nonce": nonce, **({"identity": identity} if identity else {})}),
                              file=protocol_stdout, flush=True)

                    app.state.lifespan_startup_hooks.append(announce)
                    if parent_closed is None:
                        parent_closed = watch_parent(sys.stdin.fileno())

                    class ParentBoundServer(uvicorn.Server):
                        async def on_tick(self, counter):
                            return parent_closed.is_set() or await super().on_tick(counter)

                    server = ParentBoundServer(uvicorn.Config(
                        LoopbackOnly(app, origin), host="127.0.0.1", port=0,
                        proxy_headers=False, access_log=False, log_config=None,
                    ))
                    server.run(sockets=[listener])
                    if not server.started:
                        raise RuntimeError("Backend startup failed")
            finally:
                os.chdir(original_cwd)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--root", type=Path)
    modes.add_argument("--native", type=Path, help="Bundled native resource directory")
    modes.add_argument("--durable-replace", nargs=2, type=Path, metavar=("SOURCE", "DESTINATION"),
                       help="Fixed desktop runtime durability helper")
    parser.add_argument("--demo", action="store_true")
    parser.add_argument("--runtime", type=Path, help="Empty private directory created by the parent")
    parser.add_argument("--processing", type=Path, help="Verified installed processing pack selected by the desktop parent")
    parser.add_argument("--models", type=Path, help="Verified upstream model cache selected by the desktop parent")
    parser.add_argument("--processing-probe", type=json.loads, help="Interpreter identity attested by the parent after its fixed runtime probe")
    args = parser.parse_args()
    try:
        if args.durable_replace:
            print(json.dumps(durable_replace(*args.durable_replace)), flush=True)
        else:
            run(args.root, args.demo, args.runtime, args.native, args.processing, args.models, args.processing_probe)
    except Exception as error:
        print(f"Desktop backend failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
    finally:
        if args.native and os.name != "nt" and os.getsid(0) == os.getpid():
            kill_owned_tree()
