#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Regenerate desktop icons from the existing singhouse SVG brand mark.

Requires librsvg's rsvg-convert. Run from any directory; output is deterministic.
"""

from pathlib import Path
import struct
import subprocess


ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "frontend/public/favicon.svg"
ICONS = Path(__file__).resolve().parent
SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)
LINUX_SIZES = (16, 24, 32, 48, 64, 128, 256, 512)
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
ICNS_TYPES = {16: b"icp4", 32: b"icp5", 64: b"icp6", 128: b"ic07",
              256: b"ic08", 512: b"ic09", 1024: b"ic10"}


def png(size):
    return subprocess.check_output(
        ["rsvg-convert", "--width", str(size), "--height", str(size), str(SOURCE)]
    )


def ico(images):
    header = struct.pack("<HHH", 0, 1, len(ICO_SIZES))
    entries = []
    offset = 6 + 16 * len(ICO_SIZES)
    for size in ICO_SIZES:
        data = images[size]
        entries.append(struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0,
                                   1, 32, len(data), offset))
        offset += len(data)
    return header + b"".join(entries) + b"".join(images[size] for size in ICO_SIZES)


def icns(images):
    chunks = []
    for size, kind in ICNS_TYPES.items():
        data = images[size]
        chunks.append(kind + struct.pack(">I", len(data) + 8) + data)
    body = b"".join(chunks)
    return b"icns" + struct.pack(">I", len(body) + 8) + body


def main():
    images = {size: png(size) for size in SIZES}
    linux = ICONS / "linux"
    linux.mkdir(exist_ok=True)
    for size in LINUX_SIZES:
        (linux / f"{size}x{size}.png").write_bytes(images[size])
    (ICONS / "singhouse.ico").write_bytes(ico(images))
    (ICONS / "singhouse.icns").write_bytes(icns(images))


if __name__ == "__main__":
    main()
