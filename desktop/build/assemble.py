# SPDX-License-Identifier: AGPL-3.0-only
"""Assemble pinned native payloads; cross-target payloads require native validation."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from notices import collect as collect_notices
from assembly_metadata import WHEEL_EPOCH, normalize_installation, upstream_record_omissions

ROOT = Path(__file__).resolve().parents[2]
DESKTOP = ROOT / "desktop"
LOCKS = DESKTOP / "locks"


def run(*args, cwd=ROOT, env=None):
    subprocess.run([str(a) for a in args], cwd=cwd, env=env, check=True)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def canonical_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def assembly_descriptor(files, edition="core", paired_core_release_id=None):
    if edition not in {"core", "premium"}:
        raise ValueError("Edition must be core or premium")
    if edition == "premium" and not re.fullmatch(r"[0-9a-f]{64}", paired_core_release_id or ""):
        raise ValueError("Premium assembly requires an exact paired core release ID")
    if edition == "core" and paired_core_release_id is not None:
        raise ValueError("Core assembly cannot declare a paired core release")
    descriptor = {
        "schema": 1,
        "kind": "singhouse-assembly",
        "edition": edition,
        "payloadDigest": canonical_digest(files),
    }
    if paired_core_release_id is not None:
        descriptor["pairedCoreReleaseId"] = paired_core_release_id
    return descriptor


def fetch(record, cache):
    """Only lockfile URLs are accepted; verify cached and fresh bytes alike."""
    if not record["url"].startswith("https://"):
        raise ValueError("Native inputs require HTTPS")
    destination = cache / record["sha256"]
    if not destination.exists():
        temporary = destination.with_suffix(".partial")
        # Identify this build client; some upstream distributors reject the
        # generic Python-urllib user agent. Artifact hashes still bind bytes.
        request = urllib.request.Request(record["url"], headers={"User-Agent": "Singhouse-native-builder/0.1"})
        with urllib.request.urlopen(request, timeout=120) as source:
            with temporary.open("wb") as target:
                shutil.copyfileobj(source, target)
        if digest(temporary) != record["sha256"]:
            temporary.unlink()
            raise ValueError("Native input checksum mismatch")
        temporary.replace(destination)
    if digest(destination) != record["sha256"]:
        raise ValueError("Cached native input checksum mismatch")
    return destination


def unpack_executable(archive_path, record, executable):
    """Unpack only the named executable, never arbitrary archive paths."""
    archive_format = record.get("archive", "gzip")
    if archive_format == "zip":
        member = record.get("member")
        if member != executable.name:
            raise ValueError("Native ZIP member must match the executable basename")
        with zipfile.ZipFile(archive_path) as archive:
            if archive.namelist() != [member]:
                raise ValueError("Native executable ZIP has an unexpected layout")
            with archive.open(member) as source, executable.open("wb") as target:
                shutil.copyfileobj(source, target)
    elif archive_format == "gzip":
        with gzip.open(archive_path, "rb") as source, executable.open("wb") as target:
            shutil.copyfileobj(source, target)
    else:
        raise ValueError("Unsupported native executable archive format")
    executable.chmod(0o755)


def host_target():
    arch = {"x86_64": "x64", "AMD64": "x64", "arm64": "arm64", "aarch64": "arm64"}[platform.machine()]
    return f"{sys.platform}-{arch}"


PLATFORMS = {
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "darwin-arm64": "aarch64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc",
}


def python_path(root, target):
    return root / "python" / ("python.exe" if target.startswith("win32-") else "bin/python3")


def site_packages(root, target, version):
    relative = "Lib/site-packages" if target.startswith("win32-") else f"lib/python{'.'.join(version.split('.')[:2])}/site-packages"
    return root / "python" / relative


def metadata(directory):
    # Read dist-info only: never import or execute a target-architecture module.
    return dict(sorted((distribution.metadata["Name"], distribution.version)
                       for distribution in importlib.metadata.distributions(path=[str(directory)])))


def assembly_environment(cache):
    return dict(os.environ, UV_CACHE_DIR=str(cache / "uv"), UV_PYTHON_DOWNLOADS="never",
                SOURCE_DATE_EPOCH=str(WHEEL_EPOCH), PYTHONHASHSEED="0",
                PYTHONDONTWRITEBYTECODE="1")


def install_dependencies(output, cache, lock, target, env, upstream_omissions):
    host = host_target()
    host_input = lock["targets"][host]["python"]
    wheels = Path(tempfile.mkdtemp(prefix=f"wheels-{target}-", dir=cache))
    with tempfile.TemporaryDirectory(prefix="host-toolchain-", dir=cache) as temporary:
        build_root = Path(temporary)
        with tarfile.open(fetch(host_input, cache), "r:gz") as archive:
            archive.extractall(build_root, filter="data")
        host_python = python_path(build_root, host)
        run("uv", "pip", "install", "--python", host_python, "--require-hashes",
            "-r", LOCKS / "build.txt", env=env)
        for package in ("lyricsync", "backend"):
            run("uv", "build", "--wheel", "--no-build-isolation", "--python", host_python,
                "--out-dir", wheels, ROOT / package, env=env)
        artifacts = sorted(wheels.glob("*.whl"))
        if len(artifacts) != 2 or any(not artifact.name.endswith("-none-any.whl") for artifact in artifacts):
            raise SystemExit("Expected exactly two pure application wheels")
        for artifact in artifacts:
            with zipfile.ZipFile(artifact) as wheel:
                if any("/remote_runtime/" in name or name.endswith("/workers/remote.py") for name in wheel.namelist()):
                    raise SystemExit("Application wheel contains an excluded compute dispatcher")
        destination = site_packages(output, target, lock["pythonVersion"])
        # Source builds (MetaPhone is pure Python) use only the pinned host
        # toolchain. Platform-specific dependencies resolve as target wheels.
        selection = ["--python", host_python, "--target", destination,
                     "--python-platform", PLATFORMS[target], "--python-version", lock["pythonVersion"]]
        run("uv", "pip", "install", *selection, "--require-hashes", "--no-build-isolation",
            "-r", LOCKS / "base.txt", env=env)
        run("uv", "pip", "install", *selection, "--no-deps", *artifacts, env=env)
        launcher_base = fetch(lock["targets"][target]["consoleLauncher"], cache) if target == "win32-x64" else None
        normalization = normalize_installation(output, destination, host_python, target, artifacts,
                                              upstream_omissions, windows_launcher_base=launcher_base)
    if target == host:
        run("uv", "pip", "check", "--python", python_path(output, target), env=env)
    return artifacts, host_input, normalization


def inspect_executable(executable, cross):
    if not cross:
        version = subprocess.check_output([str(executable), "-version"], text=True)
        if "--enable-nonfree" in version:
            raise SystemExit("Non-redistributable FFmpeg configuration")
        return {"status": "EXECUTED", "version": version}
    # Configuration text is ordinarily embedded in these static executables.
    # Absence is not proof of redistributability or a working target binary.
    with executable.open("rb") as stream:
        tail = b""
        while block := stream.read(1024 * 1024):
            combined = tail + block
            if b"--enable-nonfree" in combined:
                raise SystemExit("Non-redistributable FFmpeg configuration detected in cross binary")
            tail = combined[-32:]
    return {"status": "UNTESTED", "staticNonfreeScan": "flag-not-found",
            "nativeExecutionRequired": True}


def source_provenance(source_commit=None):
    if source_commit is not None and not re.fullmatch(r"[0-9a-fA-F]{40}", source_commit):
        raise SystemExit("--source-commit must contain exactly 40 hexadecimal characters")
    if (ROOT / ".git").exists():
        return {
            "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
            "sourceDirty": bool(subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=all"], cwd=ROOT)),
            "sourceExport": False,
        }
    if source_commit is None:
        raise SystemExit("Source exports without .git require --source-commit <40hex>")
    return {"sourceCommit": source_commit.lower(), "sourceDirty": None, "sourceExport": True}


def copy_launcher_notices(inputs, notices):
    records = inputs.get("consoleLauncher", {}).get("notices", {})
    if "consoleLauncher" in inputs and not records:
        raise ValueError("Pinned Windows launcher notices are missing")
    sources = []
    for name, record in sorted(records.items()):
        if not re.fullmatch(r"uv-[A-Za-z0-9_.-]+", name):
            raise ValueError("Invalid launcher notice filename")
        source = DESKTOP / "licenses" / name
        if source.is_symlink() or not source.is_file() or digest(source) != record["sha256"]:
            raise ValueError("Pinned Windows launcher notice checksum mismatch")
        sources.append((source, notices / name))
    for source, destination in sources:
        shutil.copyfile(source, destination)


def validate_assembly_target(target):
    if target.startswith("win32-"):
        if target != "win32-x64" or host_target() != "win32-x64":
            raise SystemExit("Windows x64 assembly requires a native Windows x64 host")
        from windows_launcher import WindowsResourceAPI
        WindowsResourceAPI()  # Check required APIs before any fetch/output/build.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DESKTOP / "native")
    parser.add_argument("--cache", type=Path, default=DESKTOP / ".build-cache")
    parser.add_argument("--target", choices=sorted(PLATFORMS), help="Target payload platform (default: host)")
    parser.add_argument("--source-commit", help="Recorded Git commit for an exported source tree without .git")
    parser.add_argument("--edition", choices=("core", "premium"), default="core")
    parser.add_argument("--paired-core-release-id", help="Exact core release ID required by a premium assembly")
    args = parser.parse_args()
    target = args.target or host_target()
    validate_assembly_target(target)
    source_info = source_provenance(args.source_commit)
    output, cache = args.output.resolve(), args.cache.resolve()
    if output.exists():
        raise SystemExit(f"Output already exists; choose a new build directory: {output}")
    lock = json.loads((LOCKS / "native.json").read_text())
    if subprocess.check_output(["uv", "--version"], text=True).split()[1] != lock["uvVersion"]:
        raise SystemExit(f"Build requires uv {lock['uvVersion']}")
    cross = target != host_target()
    inputs = lock["targets"][target]
    cache.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True)
    env = assembly_environment(cache)
    # Archive contains a relocatable python/ prefix, not a host-bound venv.
    with tarfile.open(fetch(inputs["python"], cache), "r:gz") as archive:
        archive.extractall(output, filter="data")
    python = python_path(output, target)
    if not python.is_file():
        raise SystemExit("Pinned Python archive has an unexpected layout")
    # The pinned stripped Python archive can retain blank RECORD references to
    # bytecode it does not ship. Capture only those preexisting omissions before
    # any dependency installation; do not excuse later missing installed files.
    upstream_omissions = upstream_record_omissions(site_packages(output, target, lock["pythonVersion"]))
    artifacts, host_input, normalization = install_dependencies(output, cache, lock, target, env, upstream_omissions)
    ffbin = output / "ffmpeg/bin"
    ffbin.mkdir(parents=True)
    notices = output / "notices"
    notices.mkdir()
    copy_launcher_notices(inputs, notices)
    versions = {}
    for name in ("ffmpeg", "ffprobe"):
        executable = ffbin / (name + (".exe" if target.startswith("win32-") else ""))
        unpack_executable(fetch(inputs[name], cache), inputs[name], executable)
        versions[name] = inspect_executable(executable, cross)
    for name in ("ffmpegLicense", "ffmpegReadme"):
        shutil.copyfile(fetch(inputs[name], cache), notices / name)
    shutil.copyfile(ROOT / "THIRD_PARTY_NOTICES.md", notices / "THIRD_PARTY_NOTICES.md")
    shutil.copyfile(DESKTOP / "NATIVE_NOTICES.md", notices / "NATIVE_NOTICES.md")
    shutil.copyfile(ROOT / "LICENSE", notices / "LICENSE")
    # Build from the npm lockfile; never use a developer's existing dist tree.
    npm = "npm.cmd" if sys.platform == "win32" else "npm"
    run(npm, "ci", "--cache", cache / "npm", cwd=ROOT / "frontend", env=env)
    run(npm, "run", "build", cwd=ROOT / "frontend", env=env)
    shutil.copytree(ROOT / "frontend/dist", output / "static", ignore=shutil.ignore_patterns("*.map"))
    collect_notices(ROOT / "frontend", output)
    shutil.copyfile(DESKTOP / "backend.py", output / "backend.py")
    shutil.copyfile(DESKTOP / "modal_check.py", output / "modal_check.py")
    shutil.copyfile(DESKTOP / "modal_runtime.py", output / "modal_runtime.py")
    shutil.copyfile(DESKTOP / "private_config.py", output / "private_config.py")
    if (DESKTOP / "modal-contract.json").is_file():
        shutil.copyfile(DESKTOP / "modal-contract.json", output / "modal-contract.json")
    # Backend admission reads these beside backend.py. Include them in the
    # native inventory so direct native boot and installer boot use one policy.
    for policy in ("models.json", "processing-locks.json"):
        shutil.copyfile(DESKTOP / policy, output / policy)
    shutil.copyfile(ROOT / "frontend/src/brand.js", output / "brand.mjs")
    for source in DESKTOP.glob("runtime*.py"):
        shutil.copyfile(source, output / source.name)
    packages = metadata(site_packages(output, target, lock["pythonVersion"]))
    forbidden = {"torch", "torchaudio", "torchcodec", "faster-whisper", "ctranslate2", "diffq", "demucs", "audio-separator"}
    if forbidden.intersection(name.lower() for name in packages):
        raise SystemExit("Heavy processing dependencies leaked into the show runtime")
    provenance = {
        **source_info,
        "inputs": inputs, "packages": packages, "executables": versions,
        "buildHost": host_target(), "target": target, "crossAssembled": cross,
        "validation": "UNTESTED: native installation and execution required" if cross else "Native Python dependency and FFmpeg checks executed; installer validation separate",
        "hostPythonInput": host_input, "uvVersion": lock["uvVersion"],
        "wheels": {p.name: digest(p) for p in artifacts},
        "installationNormalization": normalization,
        "locks": {p.name: digest(p) for p in sorted(LOCKS.iterdir()) if p.is_file()},
    }
    (output / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    # Content identity binds installed code, native binaries and frontend.
    files = {str(p.relative_to(output)).replace(os.sep, "/"): digest(p)
             for p in sorted(output.rglob("*")) if p.is_file() and not p.is_symlink()}
    (output / "files.json").write_text(json.dumps(files, indent=2) + "\n")
    descriptor = assembly_descriptor(files, args.edition, args.paired_core_release_id)
    (output / "assembly.json").write_text(json.dumps(descriptor, indent=2) + "\n")
    identity = {
        "schema": 1, "appVersion": json.loads((DESKTOP / "package.json").read_text())["version"],
        "backendVersion": packages["karaoke-backend"], "lyricsyncVersion": packages["lyricsync"],
        "pythonVersion": lock["pythonVersion"], "platform": target.split("-", 1)[0],
        "arch": target.split("-", 1)[1], "runtimeId": digest(output / "files.json"),
    }
    (output / "manifest.json").write_text(json.dumps(identity, indent=2) + "\n")
    print(json.dumps({"payload": str(output), "identity": identity}, indent=2))


if __name__ == "__main__":
    main()
