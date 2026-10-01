# SPDX-License-Identifier: AGPL-3.0-only
"""Package an already-built, hash-locked processing environment without executing it.

The payload includes a relocatable standalone Python plus installed wheels. Build
that payload on its target runner; this tool never resolves dependencies, runs pip,
downloads models, or claims that a declared target is qualified.

By default the pack is delivered as one `concat-gzip-v1` archive split into
parts: the uncompressed stream is every locked file's bytes concatenated in lock
order (no paths or headers), gzip-compressed deterministically. The installer
takes all layout from the manifest. `--blobs` (or `--base-url`) instead writes
one content-addressed blob per file with a per-file URL.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
from urllib.parse import urlparse
import zlib


EXCLUDED_PACKAGES = {
    "diffq": "Excluded from release packs: selected separation models are non-quantized and CC BY-NC code is not redistributed.",
    "diffq-fixed": "Excluded from release packs: selected separation models are non-quantized and CC BY-NC code is not redistributed.",
}

ARCHIVE_FORMAT = "concat-gzip-v1"
DEFAULT_PART_SIZE = 1900 * 1024 * 1024
MAX_PART_SIZE = 2 ** 31 - 1
MAX_PARTS = 64
COMPRESSION_LEVEL = 6
CHUNK = 1024 * 1024
# Fixed gzip header: deflate, no optional fields, zero mtime, XFL 0, OS unknown.
GZIP_HEADER = b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff"


def normalized(value):
    return re.sub(r"[-_.]+", "-", value).lower()


def excluded_path(value):
    for part in value.split("/"):
        lowered = part.lower().replace("_", "-")
        if (lowered in EXCLUDED_PACKAGES
                or any(lowered.startswith(name + ".") for name in EXCLUDED_PACKAGES)
                or any(lowered.startswith(name + "-") and lowered.endswith(".dist-info")
                       for name in EXCLUDED_PACKAGES)):
            return True
    return False


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


REQUIRED_MODULES = {
    "transcription": ["faster_whisper", "lyricsync.transcription.heart", "karaoke_backend.workers.heart_transcriptor"],
    "separation": ["demucs.separate", "audio_separator.separator"],
}


def path_identity(lock):
    return (lambda name: name) if lock['platform'] == 'linux' else str.lower


def validate_lock(lock):
    """Every check that needs only the lock itself; payload checks are separate."""
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
    if lock.get("excludedPackages") != EXCLUDED_PACKAGES:
        raise ValueError("Input lock must declare the exact diffq exclusion policy")
    notice_paths = set()
    for package in packages:
        if not all(isinstance(package.get(key), str) and package[key] for key in ("name", "version", "license", "sourceUrl")):
            raise ValueError("Each package needs version, license and upstream provenance")
        if not re.fullmatch(r"[a-f0-9]{64}", package.get("sha256", "")) or urlparse(package["sourceUrl"]).scheme != "https":
            raise ValueError("Each package needs its locked upstream artifact digest")
        if normalized(package["name"]) in EXCLUDED_PACKAGES:
            raise ValueError("Excluded non-commercial dependency in processing package provenance")
        notices = package.get("notices")
        if not isinstance(notices, list) or not notices or any(not relative(path) for path in notices):
            raise ValueError("Each package needs a non-empty locked notice inventory")
        notice_paths.update(notices)
    files = lock.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError("A complete hashed file inventory is required")
    names = set()
    identity = path_identity(lock)
    for record in files:
        name = record.get("path")
        if not relative(name) or identity(name) in names or name == "manifest.json" or name.endswith(".partial"):
            raise ValueError("Invalid or duplicate input path")
        if excluded_path(name):
            raise ValueError("Processing input contains excluded diffq code, metadata, or notices")
        names.add(identity(name))
        if (not isinstance(record.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", record["sha256"])
                or type(record.get("size")) is not int or record["size"] < 0):
            raise ValueError(f"Input record needs its size and digest: {name}")
        if not isinstance(record.get("executable"), bool):
            raise ValueError("Each file must declare executable mode")
    if not notice_paths <= {record["path"] for record in files}:
        raise ValueError("Package notices must be retained in the payload inventory")
    if not any(record["path"] == lock.get("python") and record["executable"] for record in files):
        raise ValueError("The managed Python executable must be in the lock")
    capabilities = lock.get("capabilities")
    if (not isinstance(capabilities, list) or not capabilities
            or len(set(capabilities)) != len(capabilities)
            or not set(capabilities) <= set(REQUIRED_MODULES)
            or not isinstance(lock.get("models"), list)
            or any(not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9._+-]{1,128}", model) for model in lock["models"])
            or len(set(lock["models"])) != len(lock["models"])):
        raise ValueError("Declare processing capabilities and model requirements")
    model_capabilities = lock.get("modelCapabilities")
    if (not isinstance(model_capabilities, dict) or set(model_capabilities) != set(lock["models"])
            or any(capability not in capabilities for capability in model_capabilities.values())):
        raise ValueError("Every model must identify one declared capability")
    modules = sorted({module for capability in capabilities for module in REQUIRED_MODULES[capability]})
    probe = lock.get("probe", {"schema": 1, "type": "python-imports-v1", "modules": modules})
    if probe not in ({"schema": 1, "type": "python-imports-v1", "modules": modules},
                     {"schema": 2, "type": "python-functional-v1", "modules": modules}):
        raise ValueError("Probe must bind the exact required capability modules")
    return probe


def check_payload(payload, lock):
    """Reject missing, extra, unsafe, or changed payload files."""
    identity = path_identity(lock)
    for record in lock["files"]:
        name = record["path"]
        source = payload / name
        if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(payload):
            raise ValueError(f"Missing or unsafe input: {name}")
        if source.stat().st_size != record["size"] or digest(source) != record["sha256"]:
            raise ValueError(f"Input does not match its lock: {name}")
    actual = set()
    for path in payload.rglob("*"):
        if path.is_symlink():
            raise ValueError("Processing inputs must not contain symbolic links")
        if path.is_file():
            actual.add(identity(path.relative_to(payload).as_posix()))
    if actual != {identity(record["path"]) for record in lock["files"]}:
        raise ValueError("Input lock must enumerate the entire payload")


def base_manifest(lock, lock_bytes, lock_text, probe):
    manifest = {key: lock[key] for key in ("appVersion", "backendVersion", "lyricsyncVersion", "pythonVersion", "platform", "arch", "accelerator", "python", "capabilities", "models", "modelCapabilities", "excludedPackages")}
    manifest.update(schema=1, kind="processing", provenance={
        "sourceCommit": lock["sourceCommit"], "lockSha256": hashlib.sha256(lock_bytes).hexdigest(),
        "inputLock": lock_text,
        "packages": lock["packages"], "qualification": "UNTESTED: native execution and hardware qualification required",
    })
    manifest["probe"] = probe
    return manifest


def read_lock(lock_bytes):
    # Hash, embed, and retain one exact byte snapshot. Text-mode reads normalize
    # CRLF on Windows and would invalidate the embedded lock's trusted digest.
    lock_text = lock_bytes.decode("utf-8")
    return json.loads(lock_text), lock_text


def delivery(base_url=None, blobs=None, archive_base_url=None, archive_part_size=None, archive_name=None):
    """Resolve the output form. Blob options and archive options never mix."""
    archive_options = (archive_base_url, archive_part_size, archive_name)
    blobs = bool(blobs) or base_url is not None
    if blobs and any(option is not None for option in archive_options):
        raise ValueError("Blob output (--blobs/--base-url) and archive options are mutually exclusive")
    if blobs:
        return {"form": "blobs", "baseUrl": base_url}
    part_size = DEFAULT_PART_SIZE if archive_part_size is None else archive_part_size
    if type(part_size) is not int or not 1 <= part_size <= MAX_PART_SIZE:
        raise ValueError("Archive part size must be between 1 byte and 2 GiB - 1")
    if archive_name is not None and (not re.fullmatch(r"[A-Za-z0-9._-]{1,200}", archive_name) or archive_name in {".", ".."}):
        raise ValueError("Archive name must be a flat name of letters, digits, '.', '_' or '-'")
    if archive_base_url is not None:
        parsed = urlparse(archive_base_url)
        if (parsed.scheme not in {"https", "file"} or not archive_base_url.endswith("/")
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or "?" in archive_base_url or "#" in archive_base_url
                or (parsed.scheme == "file" and parsed.hostname not in {None, "", "localhost"})):
            raise ValueError("Archive base URL must be a credential-free HTTPS or local directory URL ending in '/' without query or fragment")
    return {"form": "archive", "baseUrl": archive_base_url, "partSize": part_size, "name": archive_name}


class PartWriter:
    """Split one byte stream into consecutive files of at most part_size bytes."""

    def __init__(self, directory, name, part_size):
        self.directory, self.name, self.part_size = directory, name, part_size
        self.parts, self.stream, self.hash, self.size = [], None, None, 0

    def write(self, data):
        view = memoryview(data)
        while view:
            if self.stream is None:
                if len(self.parts) == MAX_PARTS:
                    raise ValueError(f"Archive needs more than {MAX_PARTS} parts; increase the part size")
                filename = f"{self.name}.{len(self.parts) + 1:03d}"
                self.stream = (self.directory / filename).open("xb")
                self.hash, self.size = hashlib.sha256(), 0
                self.parts.append({"name": filename})
            take = min(len(view), self.part_size - self.size)
            self.stream.write(view[:take])
            self.hash.update(view[:take])
            self.size += take
            view = view[take:]
            if self.size == self.part_size:
                self.close()

    def close(self):
        if self.stream is not None:
            self.stream.close()
            self.parts[-1].update(sha256=self.hash.hexdigest(), size=self.size)
            self.stream = None


def checked_chunks(record, source):
    """Yield the source's bytes, failing unless they match the record exactly."""
    hashed, size = hashlib.sha256(), 0
    with source.open("rb") as stream:
        while chunk := stream.read(CHUNK):
            hashed.update(chunk)
            size += len(chunk)
            if size > record["size"]:
                break
            yield chunk
    if size != record["size"] or hashed.hexdigest() != record["sha256"]:
        raise ValueError(f"Input changed while packaging: {record['path']}")


def write_output(output, manifest, lock_bytes, files, source_for, form):
    """The one writer shared by fresh assembly and legacy pack conversion."""
    output = output.absolute()
    if form["form"] == "blobs":
        base_url = form["baseUrl"] or (output / "blobs").as_uri() + "/"
        if urlparse(base_url).scheme not in {"https", "file"} or not base_url.endswith("/"):
            raise ValueError("Artifact base URL must be an HTTPS or local directory URL")
        (output / "blobs").mkdir(parents=True)
        manifest["files"] = []
        for record in files:
            with (output / "blobs" / record["sha256"]).open("wb") as target:
                for chunk in checked_chunks(record, source_for(record)):
                    target.write(chunk)
            manifest["files"].append({**record, "url": base_url + record["sha256"]})
    else:
        base_url = form["baseUrl"] or (output / "archive").as_uri() + "/"
        name = form["name"] or "singhouse-processing-{}-{}-{}-{}.pack.gz".format(
            manifest["platform"], manifest["arch"], manifest["accelerator"], manifest["provenance"]["lockSha256"][:16])
        (output / "archive").mkdir(parents=True)
        writer = PartWriter(output / "archive", name, form["partSize"])
        writer.write(GZIP_HEADER)
        compressor = zlib.compressobj(COMPRESSION_LEVEL, zlib.DEFLATED, -zlib.MAX_WBITS, 8, zlib.Z_DEFAULT_STRATEGY)
        crc, total = 0, 0
        for record in files:
            for chunk in checked_chunks(record, source_for(record)):
                crc = zlib.crc32(chunk, crc)
                total += len(chunk)
                writer.write(compressor.compress(chunk))
        writer.write(compressor.flush())
        writer.write(struct.pack("<II", crc & 0xFFFFFFFF, total & 0xFFFFFFFF))
        writer.close()
        manifest["files"] = [dict(record) for record in files]
        manifest["archive"] = {"format": ARCHIVE_FORMAT, "parts": [
            {"url": base_url + part["name"], "sha256": part["sha256"], "size": part["size"]} for part in writer.parts]}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (output / "input-lock.json").write_bytes(lock_bytes)
    return manifest


def assemble(payload: Path, lock_path: Path, output: Path, base_url: str | None = None, *, blobs=None,
             archive_base_url=None, archive_part_size=None, archive_name=None):
    """Copy precisely the lock inventory; reject missing, extra, or changed bytes."""
    form = delivery(base_url, blobs, archive_base_url, archive_part_size, archive_name)
    lock_bytes = lock_path.read_bytes()
    lock, lock_text = read_lock(lock_bytes)
    payload = payload.resolve(strict=True)
    if output.exists():
        raise ValueError("Output exists; choose a fresh output directory")
    probe = validate_lock(lock)
    check_payload(payload, lock)
    manifest = base_manifest(lock, lock_bytes, lock_text, probe)
    return write_output(output, manifest, lock_bytes, lock["files"], lambda record: payload / record["path"], form)


def from_pack(pack: Path, output: Path, *, archive_base_url=None, archive_part_size=None, archive_name=None):
    """Re-package a legacy blob pack into archive form without the original payload."""
    form = delivery(None, None, archive_base_url, archive_part_size, archive_name)
    pack = pack.resolve(strict=True)
    if output.exists():
        raise ValueError("Output exists; choose a fresh output directory")
    lock_bytes = (pack / "input-lock.json").read_bytes()
    lock, lock_text = read_lock(lock_bytes)
    legacy = json.loads((pack / "manifest.json").read_text(encoding="utf-8"))
    provenance = legacy.get("provenance") or {}
    if (provenance.get("lockSha256") != hashlib.sha256(lock_bytes).hexdigest()
            or provenance.get("inputLock") != lock_text):
        raise ValueError("Pack manifest is not bound to its input-lock.json")
    probe = validate_lock(lock)
    manifest = base_manifest(lock, lock_bytes, lock_text, probe)
    files = legacy.get("files")
    if ("archive" in legacy or not isinstance(files, list)
            or any(not isinstance(record, dict) or "url" not in record for record in files)
            or [{key: value for key, value in record.items() if key != "url"} for record in files] != lock["files"]
            or {key: value for key, value in legacy.items() if key != "files"} != manifest):
        raise ValueError("Pack manifest differs from a fresh assembly of its input lock")
    blobs = pack / "blobs"
    if blobs.is_symlink() or not blobs.is_dir():
        raise ValueError("Pack has no blob directory")

    def source_for(record):
        # Blob names come from the lock's validated digests, never from pack contents.
        blob = blobs / record["sha256"]
        if blob.is_symlink() or not blob.is_file() or blob.stat().st_size != record["size"]:
            raise ValueError(f"Missing, unsafe, or changed blob for {record['path']}")
        return blob
    # Bytes are re-verified (size and sha256) as they stream into the archive.
    return write_output(output, manifest, lock_bytes, lock["files"], source_for, form)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--payload", type=Path)
    parser.add_argument("--lock", type=Path)
    parser.add_argument("--from-pack", type=Path, help="Convert an existing blob pack directory (manifest.json, input-lock.json, blobs/) to archive form")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--blobs", action="store_true", help="Write the per-file blob form instead of an archive")
    parser.add_argument("--base-url", help="Blob form: explicit blob publication directory URL (implies --blobs); omission produces local file URLs")
    parser.add_argument("--archive-base-url", help="Archive part publication directory URL ending in '/'; omission produces local file URLs")
    parser.add_argument("--archive-part-size", type=int, help=f"Maximum bytes per archive part (default {DEFAULT_PART_SIZE})")
    parser.add_argument("--archive-name", help="Archive part file name stem; parts are <name>.001, <name>.002, ...")
    args = parser.parse_args(argv)
    archive = dict(archive_base_url=args.archive_base_url, archive_part_size=args.archive_part_size, archive_name=args.archive_name)
    try:
        if args.from_pack is not None:
            if args.payload is not None or args.lock is not None or args.blobs or args.base_url is not None:
                raise ValueError("--from-pack produces archive form only; it excludes --payload, --lock, --blobs and --base-url")
            from_pack(args.from_pack, args.output, **archive)
        else:
            if args.payload is None or args.lock is None:
                raise ValueError("--payload and --lock are required unless --from-pack is given")
            assemble(args.payload, args.lock, args.output, args.base_url, blobs=args.blobs or None, **archive)
    except ValueError as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
