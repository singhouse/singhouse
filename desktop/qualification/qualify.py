#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Small, dependency-free helpers for native release evidence."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import platform
import shutil
import subprocess
import sys

RESULTS = {"passed", "failed", "untested", "blocked"}


def run(command: list[str]) -> dict[str, object]:
    try:
        completed = subprocess.run(
            command, check=False, capture_output=True, text=True, timeout=15
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"available": False, "error": str(error)}
    return {
        "available": True,
        "exitCode": completed.returncode,
        "stdout": completed.stdout.strip(),
        "stderr": completed.stderr.strip(),
    }


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inventory(args: argparse.Namespace) -> None:
    artifacts = []
    for value in args.artifact:
        path = pathlib.Path(value).expanduser().resolve()
        if not path.is_file():
            raise SystemExit(f"artifact is not a file: {path}")
        artifacts.append(
            {"name": path.name, "size": path.stat().st_size, "sha256": sha256(path)}
        )

    os_release = {}
    release_path = pathlib.Path("/etc/os-release")
    if release_path.is_file():
        for line in release_path.read_text(encoding="utf-8").splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                os_release[key] = value.strip().strip('"')

    report = {
        "schema": 1,
        "capturedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "candidateRevision": args.candidate_revision,
        "machine": {
            "platform": sys.platform,
            "architecture": platform.machine(),
            "osRelease": os_release,
            "kernel": platform.release(),
            "pageSize": os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else None,
            "cpu": platform.processor() or None,
            "cpuDetails": (
                run(["lscpu"]) if shutil.which("lscpu") else {"available": False}
            ),
            "memory": run(["free", "-b"]) if shutil.which("free") else {"available": False},
            "displaySession": {
                "desktop": os.environ.get("XDG_CURRENT_DESKTOP"),
                "type": os.environ.get("XDG_SESSION_TYPE"),
            },
            "gpu": {
                "nvidiaSmi": (
                    run(
                        [
                            "nvidia-smi",
                            "--query-gpu=name,memory.total,driver_version",
                            "--format=csv,noheader",
                        ]
                    )
                    if shutil.which("nvidia-smi")
                    else {"available": False}
                ),
                "driPresent": pathlib.Path("/dev/dri").is_dir(),
            },
            "tools": {
                name: run(command) if shutil.which(name) else {"available": False}
                for name, command in {
                    "node": ["node", "--version"],
                    "npm": ["npm", "--version"],
                    "python3": ["python3", "--version"],
                    "ffmpeg": ["ffmpeg", "-version"],
                    "ffprobe": ["ffprobe", "-version"],
                }.items()
            },
        },
        "artifacts": artifacts,
        "limitations": args.limitation,
    }
    output = pathlib.Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(output)


def validate(args: argparse.Namespace) -> None:
    path = pathlib.Path(args.matrix)
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("schema") != 1 or not isinstance(value.get("checks"), list):
        raise SystemExit("matrix must have schema 1 and a checks array")
    seen = set()
    errors = []
    for index, check in enumerate(value["checks"]):
        prefix = f"checks[{index}]"
        identifier = check.get("id")
        if not isinstance(identifier, str) or not identifier:
            errors.append(f"{prefix}: missing id")
        elif identifier in seen:
            errors.append(f"{prefix}: duplicate id {identifier}")
        seen.add(identifier)
        if check.get("result") not in RESULTS:
            errors.append(f"{prefix}: result must be one of {sorted(RESULTS)}")
        evidence = check.get("evidence")
        if not isinstance(evidence, list):
            errors.append(f"{prefix}: evidence must be an array")
        if check.get("result") in {"passed", "failed"} and not evidence:
            errors.append(f"{prefix}: executed result requires evidence")
        if check.get("result") == "blocked" and not check.get("blocker"):
            errors.append(f"{prefix}: blocked result requires blocker")
    if errors:
        raise SystemExit("\n".join(errors))
    print(f"valid matrix: {len(value['checks'])} checks")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="command", required=True)
    collect = commands.add_parser("inventory")
    collect.add_argument("--candidate-revision", required=True)
    collect.add_argument("--artifact", action="append", default=[])
    collect.add_argument("--limitation", action="append", default=[])
    collect.add_argument("--output", required=True)
    collect.set_defaults(handler=inventory)
    check = commands.add_parser("validate")
    check.add_argument("matrix")
    check.set_defaults(handler=validate)
    return root


if __name__ == "__main__":
    parsed = parser().parse_args()
    parsed.handler(parsed)
