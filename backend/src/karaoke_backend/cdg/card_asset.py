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

WIDTH = 300
HEIGHT = 216

#: Palette entries the card adds, as 4-bit-per-channel RGB. Indices 0-3 are the
#: lyric renderer's and are untouched, so one CLUT load serves both.
PALETTE: dict[int, tuple[int, int, int]] = {
    4: (14, 3, 5),
    5: (15, 14, 12),
    6: (1, 1, 2),
}

#: Layout and rasterisation parameters, carried so `FINGERPRINT` covers a
#: layout change and not only a copy change.
LAYOUT: dict[str, float] = {
    'gap_mark_text': 12,
    'gap_text_text': 10,
    'mark_px': 96,
    'supersample': 4,
    'threshold': 0.42,
    'title_pt': 88,
    'title_stroke': 4,
    'url_pt': 136,
    'url_stroke': 5,
}

#: sha256 over the card's copy and `LAYOUT`. See `cdg.card.check_fingerprint`.
FINGERPRINT = '9ffa160132e3b0f1c92d16c0ff2549fb8085b44c7d34305a3911e0f6ccbce85d'

#: sha256 over the mark geometry extracted from the frontend's brand-mark
#: component. Checked by the test
#: suite, which has the frontend tree; a mismatch means the logo was redrawn
#: and the card needs regenerating.
MARK_FINGERPRINT = '415af91f554fb03f949c3e2f03c4058e3853f40cc335e40a140fda4f9e91451c'

#: The screen as WIDTH*HEIGHT palette indices, zlib'd and base64'd. Decoded by
#: `cdg.card.card_pixels`.
PIXELS_B64 = (
    "eNrtm4typCAQAKkp3f//5LtcsllgHg5qLiR0V10lt0GEFobB1VIAAAAAAAAAAAAAAAAAAAAA"
    "AG5k23CQNfUGHrKmsDWkClkDqpCVN4WtIVXIGlCFrAFVyDpQte/Iypp6A1tpVcjKqXr8BVlp"
    "Vf9k7cg6mH+PhykLW74qZOXmX2ULWTlVyErNP+bhsCpk5eYf83BYFbIaVXuTgO5qOi6elpqh"
    "yja1etAKVRHhUxvAZotD0IpV1QOJCO9lVbGpNeehryo0taIsL6uyTClli8k6SECdSWnLWsaV"
    "l0fFE7GZh6u4MlwkQlYraxFXVkqQMNXOw0VdpU0t6aoTYI8vR9barkZmIq4MU254X96VMoUr"
    "z5U2xRwM41UjClexq70DV56rPaMKV6asDVdRvKpNbbjKuXovh6vjdfB5KwFXkavufh6utvBW"
    "woarU642XMW3qHB1ztWGq9DVA1d5Vw9cnXK14epxemDhKj+wcJUfWLjKDyxc5QcWrvIDC1f5"
    "gYUrXF1x5cnCFa4uuXrg6oQr4lVeFq7SsshFz7L686JDqnCFK9/VflrVvuC7AGdZ8h2Ta6pW"
    "enfpMrjCFa5w9UNklYIsVN0tq6wCogAAAAAAAAAAAAB+OvLGbXV9Tdn7Dz9tasBWWDCs5uNv"
    "0v08U9X3uHrXNCDriiv58a5yTcPVq0Vf7+rs1ZnRlTyD1yuM1SGtjm2qyGsut115iXn++6zA"
    "nPt17UWXkedp3guI8bdao9/QG8ZV1Y/eSfOxV8RyJdWFqGsQY1WpPlEn7K+V8zftymzoJVel"
    "6lp1kra71QF1kbpRbc29q3YO1hUbp/0sI31l6tSla3g7V5y+XHWlQ4ro2eQU0f1++TBju3SB"
    "py7RVNx20fhf1QLblVXf/a5K/9mQq8+f/jpYNcFwXap418cLrwVq7N+yrqjzFx1++rigi7QL"
    "RKm7V14hP+dKrHFguzLsOK6CuHphHbREnHbVjK2Mq3bNvcmVuZDfOK6iFNIt0ruSl6uScqVm"
    "1YArdw62ld6RX0k3B+1zDcSr0lzLrCtpzQQh23XlNe5ybFcLsLN4FyfP83OGJgHJuxJ/XB21"
    "1WqVqEqbzly5z9Bm6mqOSz9cwpjpuzI8qPNaZbqGGMl5mLRezEXbZaK7xI05PXisrUPnypq9"
    "JXBVonVQ73HsAF7sK2l0bI27k9yhxdUX3MPFFa4AAAAAAAB++65uvW0srvI7flzhijn4rbKI"
    "7ayDN0UoUU8uqMcrdPneTf2URHSK7kj9hZZx7Eymmu8Muz+I9aVo+2DkZ6fjQ8SIif0jme7p"
    "JlLVPWkmpiwRx2H2kMDV0bHTrHpifPHe/GoPAsOVVc44mWqCU04upzL3h2PTVQk66bg6OiTh"
    "qhjHTuWqGK5UMfMREPsDq5oy5soJa/NkntG170qfciWRK/FzkDkGVvzA0JgrawiVnKsSLqAy"
    "jys7Z/i/rorVlKlWwhLkDP/ZVX/h5nNV9Msa3+VK5ypz7uCk68exK0m6ysV2I7eYzpU4bT5a"
    "18+6UiVDVzLPxvyKqybE+TtiKxct1qtsOvGcN7/KuDIfwLXji7E7kVw1Zso1V8qQiO323jl2"
    "VTJ7cG+jLNNtntM5Q5di5FyVo3s7ppno2AlsJcN494bpsSv7OX3rlmHwQus0K+L5NzM+frnv"
    "DEbBX3Frmu8icIWr704ycIWrr0peAQAAAAAAAAAAAAAAAK7xB6c4fq8="
)
