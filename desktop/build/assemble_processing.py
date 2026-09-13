# SPDX-License-Identifier: AGPL-3.0-only
"""Package an already-built, hash-locked processing environment without executing it.

The payload includes a relocatable standalone Python plus installed wheels. Build
that payload on its target runner; this tool never resolves dependencies, runs pip,
downloads models, or claims that a declared target is qualified.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
from urllib.parse import urlparse


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def relative(value):
    return isinstance(value, str) and len(value) < 512 and all(
        re.fullmatch(r"[A-Za-z0-9._+() -]+", part)
        and part == part.strip() and not part.endswith('.')
        and part not in {".", ".."}
        and not re.fullmatch(r"(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", part)
        for part in value.split("/"))


def assemble(payload: Path, lock_path: Path, output: Path, base_url: str | None = None):
    """Copy precisely the lock inventory; reject missing, extra, or changed bytes."""
    lock = json.loads(lock_path.read_text())
    payload = payload.resolve(strict=True)
    if output.exists():
        raise ValueError("Output exists; choose a fresh output directory")
    if lock.get("schema") != 1 or lock.get("kind") != "processing-input":
        raise ValueError("Unsupported processing input lock")
    for key in ("appVersion", "backendVersion", "lyricsyncVersion", "pythonVersion", "platform", "arch"):
        if not re.fullmatch(r"[A-Za-z0-9._+-]{1,128}", lock.get(key, "")):
            raise ValueError(f"Missing compatibility identity: {key}")
    if lock.get("accelerator") not in {"cpu", "cuda", "metal"}:
        raise ValueError("Declare one accelerator per pack")
    if not re.fullmatch(r"[0-9a-f]{40}", lock.get("sourceCommit", "")):
        raise ValueError("A source commit is required")
    packages = lock.get("packages")
    if not isinstance(packages, list) or not packages:
        raise ValueError("Package provenance is required")
    notice_paths = set()
    for package in packages:
        if not all(isinstance(package.get(key), str) and package[key] for key in ("name", "version", "license", "sourceUrl")):
            raise ValueError("Each package needs version, license and upstream provenance")
        if not re.fullmatch(r"[a-f0-9]{64}", package.get("sha256", "")) or urlparse(package["sourceUrl"]).scheme != "https":
            raise ValueError("Each package needs its locked upstream artifact digest")
        notices = package.get("notices")
        if not isinstance(notices, list) or not notices or any(not relative(path) for path in notices):
            raise ValueError("Each package needs a non-empty locked notice inventory")
        notice_paths.update(notices)
    files = lock.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError("A complete hashed file inventory is required")
    names = set()
    for record in files:
        name = record.get("path")
        if not relative(name) or name.lower() in names or name == "manifest.json" or name.endswith(".partial"):
            raise ValueError("Invalid or duplicate input path")
        names.add(name.lower())
        source = payload / name
        if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(payload):
            raise ValueError(f"Missing or unsafe input: {name}")
        if source.stat().st_size != record.get("size") or digest(source) != record.get("sha256"):
            raise ValueError(f"Input does not match its lock: {name}")
        if not isinstance(record.get("executable"), bool):
            raise ValueError("Each file must declare executable mode")
    actual = set()
    for path in payload.rglob("*"):
        if path.is_symlink():
            raise ValueError("Processing inputs must not contain symbolic links")
        if path.is_file():
            actual.add(path.relative_to(payload).as_posix().lower())
    if actual != names:
        raise ValueError("Input lock must enumerate the entire payload")
    if not notice_paths <= {record["path"] for record in files}:
        raise ValueError("Package notices must be retained in the payload inventory")
    if not any(record["path"] == lock.get("python") and record["executable"] for record in files):
        raise ValueError("The managed Python executable must be in the lock")
    capabilities = lock.get("capabilities")
    required_modules = {
        "transcription": ["faster_whisper", "lyricsync.transcription.heart", "karaoke_backend.workers.heart_transcriptor"],
        "separation": ["demucs.separate", "audio_separator.separator"],
    }
    if (not isinstance(capabilities, list) or not capabilities
            or len(set(capabilities)) != len(capabilities)
            or not set(capabilities) <= set(required_modules)
            or not isinstance(lock.get("models"), list)
            or any(not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9._+-]{1,128}", model) for model in lock["models"])
            or len(set(lock["models"])) != len(lock["models"])):
        raise ValueError("Declare processing capabilities and model requirements")
    model_capabilities = lock.get("modelCapabilities")
    if (not isinstance(model_capabilities, dict) or set(model_capabilities) != set(lock["models"])
            or any(capability not in capabilities for capability in model_capabilities.values())):
        raise ValueError("Every model must identify one declared capability")
    output = output.absolute()
    base_url = base_url or (output / "blobs").as_uri() + "/"
    if urlparse(base_url).scheme not in {"https", "file"} or not base_url.endswith("/"):
        raise ValueError("Artifact base URL must be an HTTPS or local directory URL")
    (output / "blobs").mkdir(parents=True)
    manifest = {key: lock[key] for key in ("appVersion", "backendVersion", "lyricsyncVersion", "pythonVersion", "platform", "arch", "accelerator", "python", "capabilities", "models", "modelCapabilities")}
    manifest.update(schema=1, kind="processing", provenance={
        "sourceCommit": lock["sourceCommit"], "lockSha256": digest(lock_path),
        "inputLock": lock_path.read_text(),
        "packages": packages, "qualification": "UNTESTED: native execution and hardware qualification required",
    })
    modules = sorted({module for capability in capabilities for module in required_modules[capability]})
    probe = lock.get("probe", {"schema": 1, "type": "python-imports-v1", "modules": modules})
    if probe not in ({"schema": 1, "type": "python-imports-v1", "modules": modules},
                     {"schema": 2, "type": "python-functional-v1", "modules": modules}):
        raise ValueError("Probe must bind the exact required capability modules")
    manifest["probe"] = probe
    manifest["files"] = []
    for record in files:
        shutil.copyfile(payload / record["path"], output / "blobs" / record["sha256"])
        manifest["files"].append({**record, "url": base_url + record["sha256"]})
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    shutil.copyfile(lock_path, output / "input-lock.json")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload", type=Path, required=True)
    parser.add_argument("--lock", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base-url", help="Explicit blob publication directory URL; omission produces local file URLs")
    args = parser.parse_args()
    assemble(args.payload, args.lock, args.output, args.base_url)


if __name__ == "__main__":
    main()
