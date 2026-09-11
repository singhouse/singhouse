#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Bake the attribution card into a committed indexed bitmap.

The exported .cdg opens with an attribution card: the product mark, the
"created with" sentence, and the product domain. Rendering it needs a vector
rasteriser and a font; the encoder deliberately has neither, and shipping that
dependency chain into the runtime to draw two fixed lines of text would be a
poor trade. So the card is rasterised HERE, at authoring time, and the result
is committed as `karaoke_backend/cdg/card_asset.py` -- a zlib'd palette-indexed
bitmap that the runtime reads with numpy and the standard library alone.

Nothing about the card is hand-drawn or hand-typed:

* the copy comes from `karaoke_backend.branding`, so a rename cannot leave a
  stale card behind (the fingerprint written into the asset is re-derived by
  the test suite and fails if the two drift);
* the mark comes from the frontend's `BrandMark.vue`, parsed rather than
  re-keyed, so there is still exactly one drawing of the logo in the repo.

External tools, none of which are runtime dependencies:

    rsvg-convert       (librsvg)      -- the mark
    magick             (ImageMagick)  -- the text
    woff2_decompress   (woff2)        -- the brand font, shipped as woff2

Usage:

    python backend/scripts/gen-card-asset.py [--repo-root PATH] [--preview OUT.png]

`--preview` writes a magnified PNG of exactly what will be encoded, which is
the only honest way to review a change to this file.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import zlib
from pathlib import Path
from typing import NamedTuple

import numpy as np

# --- geometry ---------------------------------------------------------------
#
# The CD+G screen, and the card's stack within it. Everything here feeds the
# fingerprint, so a layout tweak invalidates a stale asset the same way a
# rename does.

SCREEN_W, SCREEN_H = 300, 216

#: Supersampling factor. The card is hard-edged 1-bit-per-plane art -- CD+G has
#: no alpha and no intermediate shades -- so anti-aliased output is rendered
#: large and area-averaged down to a coverage fraction, then thresholded.
SS = 4

#: Coverage at or above which a supersampled pixel counts as ink. Below 0.5 on
#: purpose: at this scale a stem that lands between pixel centres otherwise
#: drops out entirely, and a slightly heavy glyph survives a CRT better than a
#: broken one.
THRESHOLD = 0.42

LAYOUT = {
    "mark_px": 96,  # the mark is square; 96 = 16x8 tiles
    "gap_mark_text": 12,
    "gap_text_text": 10,
    "title_pt": 88,  # point sizes are at SS scale, so 88 -> 22px
    "title_stroke": 4,  # synthetic weight: the variable font defaults to Light
    "url_pt": 136,
    "url_stroke": 5,
    "threshold": THRESHOLD,
    "supersample": SS,
}

#: Palette indices the card adds. 0-3 belong to the lyric renderer and are left
#: exactly as they are, so the card and the lyrics share one CLUT load.
INK_BASE = 4

# --- mark extraction --------------------------------------------------------

MARK_SOURCE = Path("frontend/src/components/BrandMark.vue")

#: The mark's colour planes, in palette order, keyed by the CSS custom property
#: the component uses for each. The mark is a fill-based drawing whose planes
#: interleave (the ink field sits under the cream mic ball, the ink grille sits
#: over it), so it is NOT separable into ordered groups: each plane is instead
#: the set of pixels whose FINAL colour is that plane's, obtained by rendering
#: the whole mark with that colour white and every other colour black.
MARK_COLORS = ("brand-cherry", "brand-cream", "brand-ink")

_COLOR_RE = re.compile(r'var\(--([\w-]+),\s*(#[0-9a-fA-F]{6})\)')
_VIEWBOX_RE = re.compile(r'viewBox="([^"]+)"')
#: The drawing itself: everything between the wrapper <svg ...> and </svg>,
#: Vue bindings (`:role`, `:aria-*`) excluded by the parse below.
_BODY_RE = re.compile(r'<svg\b[^>]*>(.*?)</svg>', re.DOTALL)


class GenError(RuntimeError):
    pass


def require(tool: str) -> str:
    path = shutil.which(tool)
    if path is None:
        raise GenError(
            f"{tool!r} is not on PATH. This script needs rsvg-convert, magick "
            "and woff2_decompress; none of them are runtime dependencies -- "
            "the generated asset is committed."
        )
    return path


class Mark(NamedTuple):
    """The brand mark as the generator needs it, all of it read from source."""

    viewbox: str
    body: str  # the SVG drawing, colours left as var(--name, #fallback)
    colors: list[tuple[str, tuple[int, int, int]]]  # name, RGB, palette order


def extract_mark(source: Path) -> Mark:
    """Pull the mark's viewBox, drawing and colour planes out of the brand
    mark component.

    Parsed rather than duplicated so the repo keeps one drawing of the logo.
    The parse is deliberately strict -- every colour named in `MARK_COLORS`
    must appear with exactly one literal fallback, and no other colour may
    appear at all -- because the failure mode of a loose parse is a silently
    wrong card that still encodes and still plays.
    """
    text = source.read_text(encoding="utf-8")
    body_m = _BODY_RE.search(text)
    viewbox = _VIEWBOX_RE.search(text)
    if body_m is None or viewbox is None:
        raise GenError(f"{source}: no <svg> drawing or no viewBox found")
    body = body_m.group(1)

    fallbacks: dict[str, set[str]] = {}
    for name, hex_color in _COLOR_RE.findall(body):
        fallbacks.setdefault(name, set()).add(hex_color.upper())
    missing = [c for c in MARK_COLORS if c not in fallbacks]
    extra = sorted(set(fallbacks) - set(MARK_COLORS))
    ambiguous = {c: v for c, v in fallbacks.items() if len(v) != 1}
    if missing or extra or ambiguous:
        raise GenError(
            f"{source}: colour planes changed (missing={missing}, "
            f"unexpected={extra}, inconsistent fallbacks={ambiguous}). Update "
            "MARK_COLORS, re-review the rendering, and regenerate."
        )
    if "<text" in body or "url(" in body and "clip-path" not in body:
        raise GenError(f"{source}: unsupported SVG features in the mark")
    colors = []
    for name in MARK_COLORS:
        hex_color = next(iter(fallbacks[name]))
        colors.append((name, tuple(int(hex_color[i : i + 2], 16) for i in (1, 3, 5))))
    return Mark(viewbox=viewbox.group(1).strip(), body=body, colors=colors)


def render_mark_plane(
    mark: Mark, name: str, size: int, tmp: Path, tag: str
) -> np.ndarray:
    """Rasterise one colour plane of the mark to a 1-bit `size` x `size` mask:
    the whole drawing with `name` painted white and every other colour black."""

    def paint(m: re.Match) -> str:
        return "#ffffff" if m.group(1) == name else "#000000"

    inner = _COLOR_RE.sub(paint, mark.body)
    svg = tmp / f"mark-{tag}.svg"
    svg.write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{mark.viewbox}">'
        f"{inner}</svg>",
        encoding="utf-8",
    )
    png = tmp / f"mark-{tag}.png"
    run(
        [
            require("rsvg-convert"),
            "-w",
            str(size * SS),
            "-h",
            str(size * SS),
            "-b",
            "black",
            str(svg),
            "-o",
            str(png),
        ]
    )
    return threshold(gray_of(png, tmp, f"mark-{tag}"))


# --- text -------------------------------------------------------------------

#: The brand font, as vendored by the frontend. Only ever read, never copied
#: into the backend or into the generated asset: what ships is rendered pixels,
#: which no font licence reaches.
FONT_SOURCE = Path(
    "frontend/node_modules/@fontsource-variable/space-grotesk/files/"
    "space-grotesk-latin-wght-normal.woff2"
)


def prepare_font(repo_root: Path, tmp: Path, override: Path | None) -> Path:
    src = override or (repo_root / FONT_SOURCE)
    if not src.is_file():
        raise GenError(
            f"{src} not found. Run `npm install` in frontend/ first, or pass "
            "--font: the card is set in the brand font, and the font is "
            "vendored by the frontend rather than duplicated here."
        )
    if src.suffix == ".ttf":
        return src
    work = tmp / src.name
    work.write_bytes(src.read_bytes())
    run([require("woff2_decompress"), str(work)])
    ttf = work.with_suffix(".ttf")
    if not ttf.is_file():
        raise GenError(f"woff2_decompress produced no {ttf}")
    return ttf


def render_text(text: str, font: Path, pt: int, stroke: int, tmp: Path, tag: str):
    """Rasterise one line to a 1-bit mask, trimmed to its own ink."""
    png = tmp / f"text-{tag}.png"
    run(
        [
            require("magick"),
            "-font",
            str(font),
            "-pointsize",
            str(pt),
            "-background",
            "black",
            "-fill",
            "white",
            # The vendored font is variable and defaults to Light, which at
            # this resolution thins to a one-pixel stem that shimmers on an
            # interlaced display. ImageMagick cannot set a variable axis, so
            # the weight is added as an explicit stroke instead -- deterministic,
            # unlike `-weight`'s synthetic embolden.
            "-stroke",
            "white",
            "-strokewidth",
            str(stroke),
            f"label:{text}",
            "-trim",
            "+repage",
            str(png),
        ]
    )
    return threshold(gray_of(png, tmp, f"text-{tag}"))


# --- raster plumbing --------------------------------------------------------


def run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise GenError(f"{cmd[0]} failed: {proc.stderr.strip() or proc.returncode}")


def gray_of(png: Path, tmp: Path, tag: str) -> np.ndarray:
    """Read a PNG as an 8-bit grayscale array, via ImageMagick.

    Going through a raw dump keeps Pillow out of the picture: the generator
    already needs ImageMagick for the text, and adding an imaging library for
    one file read would be the dependency this whole script exists to avoid.
    """
    raw = tmp / f"{tag}.gray"
    dims = subprocess.run(
        [require("magick"), str(png), "-format", "%w %h", "info:"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    w, h = int(dims[0]), int(dims[1])
    run([require("magick"), str(png), "-colorspace", "Gray", "-depth", "8",
         f"gray:{raw}"])
    return np.frombuffer(raw.read_bytes(), dtype=np.uint8).reshape(h, w)


def threshold(a: np.ndarray) -> np.ndarray:
    """Area-average an SS-supersampled plane down and threshold it to 0/1."""
    h, w = a.shape
    a = np.pad(a, ((0, -h % SS), (0, -w % SS)))
    cov = a.reshape(a.shape[0] // SS, SS, a.shape[1] // SS, SS).mean(axis=(1, 3))
    return (cov / 255.0 >= THRESHOLD).astype(np.uint8)


# --- composition ------------------------------------------------------------


def compose(planes, title: np.ndarray, url: np.ndarray) -> np.ndarray:
    """Stack mark, title and URL into one centred palette-indexed screen."""
    canvas = np.zeros((SCREEN_H, SCREEN_W), dtype=np.uint8)

    def blit(mask: np.ndarray, x: int, y: int, index: int) -> None:
        h, w = mask.shape
        if x < 0 or y < 0 or x + w > SCREEN_W or y + h > SCREEN_H:
            raise GenError(
                f"element {w}x{h} at ({x},{y}) does not fit the "
                f"{SCREEN_W}x{SCREEN_H} screen"
            )
        canvas[y : y + h, x : x + w][mask == 1] = index

    mark = LAYOUT["mark_px"]
    total = (
        mark
        + LAYOUT["gap_mark_text"]
        + title.shape[0]
        + LAYOUT["gap_text_text"]
        + url.shape[0]
    )
    y = (SCREEN_H - total) // 2
    for offset, plane in enumerate(planes):
        blit(plane, (SCREEN_W - mark) // 2, y, INK_BASE + offset)
    y += mark + LAYOUT["gap_mark_text"]
    blit(title, (SCREEN_W - title.shape[1]) // 2, y, 2)  # spec.TEXT
    y += title.shape[0] + LAYOUT["gap_text_text"]
    blit(url, (SCREEN_W - url.shape[1]) // 2, y, 2)
    return canvas


def to444(rgb: tuple[int, int, int]) -> tuple[int, int, int]:
    """8-bit-per-channel down to the CLUT's 4 bits per channel."""
    return tuple(c >> 4 for c in rgb)


def write_preview(canvas: np.ndarray, palette, out: Path, scale: int = 3) -> None:
    colors = {0: (0x00, 0x00, 0x77), 2: (0xFF, 0xFF, 0xFF)}
    colors.update({i: tuple(c * 17 for c in rgb) for i, rgb in palette.items()})
    rgb = np.zeros((*canvas.shape, 3), dtype=np.uint8)
    for index, color in colors.items():
        rgb[canvas == index] = color
    big = np.repeat(np.repeat(rgb, scale, 0), scale, 1)
    with tempfile.TemporaryDirectory() as td:
        raw = Path(td) / "preview.rgb"
        raw.write_bytes(big.tobytes())
        run([require("magick"), "-size", f"{big.shape[1]}x{big.shape[0]}",
             "-depth", "8", f"rgb:{raw}", str(out)])


# --- emission ---------------------------------------------------------------

TEMPLATE = '''\
# SPDX-License-Identifier: AGPL-3.0-only
"""Baked attribution card. GENERATED -- do not edit by hand.

Regenerate with `python backend/scripts/gen-card-asset.py`, which is also where
the layout, the source of the copy and the source of the mark are documented.

No brand string appears here on purpose: the copy is fingerprinted rather than
repeated, so this file stays inside the neutrality gate's rule that brand
literals live only in `karaoke_backend.branding`. `cdg.card` re-derives
`FINGERPRINT` from the live branding module, and the test suite fails if a
rename has left these pixels stale.
"""

from __future__ import annotations

WIDTH = {width}
HEIGHT = {height}

#: Palette entries the card adds, as 4-bit-per-channel RGB. Indices 0-3 are the
#: lyric renderer's and are untouched, so one CLUT load serves both.
PALETTE: dict[int, tuple[int, int, int]] = {palette}

#: Layout and rasterisation parameters, carried so `FINGERPRINT` covers a
#: layout change and not only a copy change.
LAYOUT: dict[str, float] = {layout}

#: sha256 over the card's copy and `LAYOUT`. See `cdg.card.check_fingerprint`.
FINGERPRINT = {fingerprint!r}

#: sha256 over the mark geometry extracted from the frontend's brand-mark
#: component. Checked by the test
#: suite, which has the frontend tree; a mismatch means the logo was redrawn
#: and the card needs regenerating.
MARK_FINGERPRINT = {mark_fingerprint!r}

#: The screen as WIDTH*HEIGHT palette indices, zlib'd and base64'd. Decoded by
#: `cdg.card.card_pixels`.
PIXELS_B64 = (
{pixels}
)
'''


def emit(canvas: np.ndarray, palette, fingerprint: str, mark_fingerprint: str) -> str:
    blob = base64.b64encode(zlib.compress(canvas.tobytes(), 9)).decode("ascii")
    wrapped = "\n".join(
        f'    "{chunk}"' for chunk in textwrap.wrap(blob, 72)
    )
    return TEMPLATE.format(
        width=SCREEN_W,
        height=SCREEN_H,
        palette="{\n"
        + "".join(f"    {i}: {rgb},\n" for i, rgb in sorted(palette.items()))
        + "}",
        layout="{\n"
        + "".join(f"    {k!r}: {v!r},\n" for k, v in sorted(LAYOUT.items()))
        + "}",
        fingerprint=fingerprint,
        mark_fingerprint=mark_fingerprint,
        pixels=wrapped,
    )


def fingerprint_copy(title: str, url: str) -> str:
    parts = [title, url] + [f"{k}={LAYOUT[k]!r}" for k in sorted(LAYOUT)]
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def fingerprint_mark(mark: Mark) -> str:
    """Hash everything about the mark that changes how it rasterises."""
    parts = [f"viewBox:{mark.viewbox}", f"body:{' '.join(mark.body.split())}"] + [
        f"{name}:{rgb}" for name, rgb in mark.colors
    ]
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def main() -> int:
    here = Path(__file__).resolve()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repo-root", type=Path, default=here.parents[2])
    ap.add_argument("--preview", type=Path)
    ap.add_argument(
        "--font",
        type=Path,
        help="woff2/ttf to set the card in, overriding the frontend copy",
    )
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()

    root: Path = args.repo_root
    sys.path.insert(0, str(root / "backend" / "src"))
    from karaoke_backend.branding import ATTRIBUTION_CARD_TEXT, PRODUCT_URL

    out = args.out or (
        root / "backend/src/karaoke_backend/cdg/card_asset.py"
    )

    mark = extract_mark(root / MARK_SOURCE)
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        planes = [
            render_mark_plane(mark, name, LAYOUT["mark_px"], tmp, name)
            for name, _ in mark.colors
        ]
        font = prepare_font(root, tmp, args.font)
        title = render_text(
            ATTRIBUTION_CARD_TEXT, font, LAYOUT["title_pt"],
            LAYOUT["title_stroke"], tmp, "title",
        )
        url = render_text(
            PRODUCT_URL, font, LAYOUT["url_pt"], LAYOUT["url_stroke"], tmp, "url"
        )
        canvas = compose(planes, title, url)
        palette = {
            INK_BASE + i: to444(rgb) for i, (_, rgb) in enumerate(mark.colors)
        }
        if args.preview:
            write_preview(canvas, palette, args.preview)

    out.write_text(
        emit(
            canvas,
            palette,
            fingerprint_copy(ATTRIBUTION_CARD_TEXT, PRODUCT_URL),
            fingerprint_mark(mark),
        ),
        encoding="utf-8",
    )
    ink = int((canvas != 0).sum())
    print(f"wrote {out} ({ink} ink pixels, {len(palette)} added colours)")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GenError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2) from None
