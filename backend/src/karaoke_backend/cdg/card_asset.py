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
FINGERPRINT = '351b263868a2f6a49db2693f10b212b20f1334a31493371f2a38194f6f45b421'

#: sha256 over the mark geometry extracted from the frontend's brand-mark
#: component. Checked by the test
#: suite, which has the frontend tree; a mismatch means the logo was redrawn
#: and the card needs regenerating.
MARK_FINGERPRINT = '415af91f554fb03f949c3e2f03c4058e3853f40cc335e40a140fda4f9e91451c'

#: The screen as WIDTH*HEIGHT palette indices, zlib'd and base64'd. Decoded by
#: `cdg.card.card_pixels`.
PIXELS_B64 = (
    "eNrtm4GS2yAMBRmNnf//5PbumsSgBxa2k3Bld6bTTA7beIOEcEhKAAAAAAAAAAAAAAAAAAAA"
    "AAAXsiw4iJr6Ag9RU9jqUoWsDlXIipvCVpcqZHWoQlaHKmTtqFpXZEVNfYGtsCpkxVTd/oKs"
    "sKpvWSuyduLvdpOysFVXhaxY/G1sISumClmh+CMOu1UhKxZ/xGG3KmRlqtasAF1dOE5elspU"
    "pU3NnrSaqsjwoQVgtsQhabVVbQcSGb5WVbVNzRmHdVVNUzPKqlVVypRTNpmsnQK0EpRa1jSu"
    "anVUOxCzOJzFlXARSFm5rElcqZIgYCqPw0ldhU1N6aoQoMdXRdbcrnoiEVfCVDW9T+/KmcJV"
    "zZU3RQw281UmCldtV2sBrmqu1ogqXElZC65a+WprasFVzNVPO1ztz4P3Rwm4arkqnufhamk+"
    "SlhwdcjVgqv2IypcHXO14Krp6oaruKsbrg65WnB1OzywcBUfWLiKDyxcxQcWruIDC1fxgYWr"
    "+MDCFa7OuKrJwhWuTrm64eqAK/JVXBauwrKoRY8y+37RLlW4wlXd1XpY1TrhbwGOMuVvTM6p"
    "mum3S6fBFa5whatfIislZKHqallpFhAFAAAAAAAAAAAA8MuxLy4718m2PZ25rNddpq7qYPM0"
    "//5mxf+yNyEV73b107MOWWdc2Z6rrDO7XfqAq/27fJerx1vfL0Zz9ezP613tfzq5q9Hy1daV"
    "3dPFM3Fsk8g2t7kmz1jOb+Qp5v7vcQIR++W4Sr6V3S/0c9LsBJsOFdLl3ZwcV5v7KJ1kb9ea"
    "KFe2jalNO39IsmzMuUuWn5bpPnhX1WYHXWWdfV4iv10XJtkfyw9ZuMpj0KXwcqg+Wll5Onfx"
    "8oIu8aljzrnyKcV8NFWapFS6sm3XhSuXdooRUGY390HJPmhX6nxXu0rle12uitSjcnvRazMx"
    "GB/ZrsgYtT6UruzwvN/IV8mnnzJj+CZ52KTtzaVnyt93tU2/IVfCjnCVVIo758pqIg67ysZW"
    "h6t0sSsxaV04rlolZLWJztP3Gf7lrhoxKJSeqBmsiEF9pY58lbJhH3VlTVdJ9lY3FN07mdvd"
    "9Osn/KyBbqJqhqwACbpy079Q0OptpUPFXHG0ZqiXcLV0KDO+zAJ1V8JCkqWma1U0UAVno2g9"
    "V4tmk0QRDvmqwA8escZJasUiRmTNlV+nlK2KNY5M4H7R5dc473709dHnkzyjxdULnuLiClcA"
    "AAAAAAD/+aJuvlUsruILflzhihj8qCxyO/PgRRnK3NaFcneFaG9+J4z+6kltXlOKrX65kUxZ"
    "vpcl/6pVfitq0lX7EBM50X3DV7vcQKqKrWYmZZlVHEYPabjaO3aYWc/EN+/ZSz0IhCvVTlzM"
    "daHSzk6XMtenY+kqNW6y4mrvkICrJI4dylUSrlwzuQdEv6FOk/pcVdLaOJVn67MvWh9yZS1X"
    "Vq9BxhhY7R1Dfa7UEEoxV6k5gdo4rnTN8F5XSXVlqJkwNWqGN7sqP7jxXCW/P+5TrnytMuYK"
    "zor72HdlQVex3C5qi+FcWaXPe/P6UVeuZdOVjbMwP+PKzFq/3m3VoslvSFWF57j1VcSV3IGr"
    "84tYnVjsNLLkGqtkCOR2vXZuu0qRNXhtoWzDLZ7DNUNRYsRcpb1nO9JM69gBbAXTeLGpf9+V"
    "3qavHhlWfngw1D7S4782+Pfiuiu0flnO8/U5wBWuXlNk4ApXrypeAQAAAAAAAAAAAAAAAM7x"
    "B6pOfvk="
)
