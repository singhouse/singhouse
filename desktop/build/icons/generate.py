#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Regenerate desktop icons and the macOS disk image background from SVG sources.

Requires librsvg's rsvg-convert. Run from any directory; output is deterministic for a given librsvg version
because neither source uses installed fonts.
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


BACKGROUND = ICONS / "dmg-background.svg"
BACKGROUND_SIZE = (540, 380)


def png(size):
    return subprocess.check_output(
        ["rsvg-convert", "--width", str(size), "--height", str(size), str(SOURCE)]
    )


def background(scale):
    width, height = (value * scale for value in BACKGROUND_SIZE)
    return subprocess.check_output(
        ["rsvg-convert", "--width", str(width), "--height", str(height), str(BACKGROUND)]
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
    (ICONS / "dmg-background.png").write_bytes(background(1))
    (ICONS / "dmg-background@2x.png").write_bytes(background(2))


if __name__ == "__main__":
    main()
