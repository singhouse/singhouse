# SPDX-License-Identifier: AGPL-3.0-only
"""Allowlist of Pass-2 lead/backing separation models an uploader may pick.

Pass 2 splits the Pass-1 vocal stem into ``lead_vocals`` and
``backing_vocals``. One model is not best for every track: the Roformer
karaoke model wins on ordinary mixes, but when one singer is multi-tracked
against themselves it tends to keep the doubles with the lead, and the
MDX-Net karaoke model separates those better. So the choice is per upload.

The wire carries an ID from ``CHOICES``, never a filename — a filename from a
request would be a path handed to a subprocess and a download URL handed to
audio-separator. Resolution happens server-side, in :func:`resolve`.

``roformer`` maps to ``None`` on purpose. It means "whatever this server is
configured to use", i.e. the ``KARAOKE_MODEL`` environment variable, whose
own default is the Roformer checkpoint. That keeps the env override working
exactly as it did and makes an unset choice byte-for-byte the old behaviour.
"""

from __future__ import annotations

from typing import Optional

# ID → model filename, or None meaning "the server-configured KARAOKE_MODEL".
# Every filename here must be one audio-separator knows, since it downloads by
# name on first use. Both entries declare stems [vocals, instrumental] with
# vocals as the target, so the "(Vocals)=lead / (Instrumental)=backing" naming
# the workers match on holds for both — verified against audio-separator
# 0.41.1's model index on 2026-08-24.
CHOICES: dict[str, Optional[str]] = {
    "roformer": None,
    "mdxnet_kara2": "UVR_MDXNET_KARA_2.onnx",
}

DEFAULT_CHOICE = "roformer"


def is_valid(choice: Optional[str]) -> bool:
    """True when ``choice`` is unset (meaning the default) or a known ID."""
    return not choice or choice in CHOICES


def resolve(choice: Optional[str], configured: str) -> str:
    """Return the model filename for ``choice``.

    ``configured`` is the caller's own ``KARAOKE_MODEL`` value — each worker
    reads that env at import, and they are not required to agree, so the
    fallback is passed in rather than read here. An unknown ID resolves to
    ``configured`` too: a bad choice degrades to the server default rather
    than failing a job that has already spent GPU minutes on Pass 1. The API
    refuses unknown IDs up front, so reaching that branch means a payload
    written by an older or hand-edited enqueue.
    """
    return CHOICES.get(choice or DEFAULT_CHOICE) or configured
