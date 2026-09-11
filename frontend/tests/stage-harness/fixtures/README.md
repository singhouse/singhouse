# Fixtures

All lyrics are original synthetic nonsense written for these tests. No real
song lyrics, titles, or artists appear anywhere in this package.

## Stage-model fixtures (`stage/`) — paired with `goldens/<name>.json`

| Fixture | Exercises |
|---|---|
| `basic-page-fades.json` | One page through all five visibility phases: hidden, fade-in ramp, fully visible, fade-out ramp, hidden again. Leading silence before the page. |
| `wipe-progression.json` | Active-wipe states across one line: before first syllable, mid-syllable interpolation, between syllables (boundary), and full after the last syllable. Also pins the 16:9 pillarbox transform (1920x1080 viewport). |
| `two-word-space.json` | Two multi-syllable words with an inter-word gap: the boundary state while the reveal sits in the space, then the second word's first syllable. Centered line. Non-integer-scale viewport (800x480). |
| `overlapping-pages.json` | Two pages overlapping in time: both must render, each with its own opacity and wipe state, in model order. |
| `countdown-bar.json` | A valid countdown bar (fade-in ramp, half fill, fade-out ramp, hidden at `end`) plus two invalid bars (`end <= start`, `step <= 0`) that must be ignored. |
| `lead-in.json` | Lead-in indicator: hidden before `leadIn.start`, progress at 25%/75%, hidden the instant the first syllable begins. |
| `degenerate.json` | Zero-duration fades (immediate transitions), an instant syllable (`end == start`), an empty word, a null-start syllable and a text-less syllable (both skipped), and syllable indexing after skips. |
| `empty-model.json` | A model with no pages and no silences renders nothing and does not crash. |
| `sing-window-ignored.json` | Adversarial `singStart`/`singEnd` (one window opening before `fadeInStart`, one closing mid-visibility, one spanning past fade-out): visibility, opacity, and reveal follow only the fade fields and syllable timing. |
| `mode-ignored.json` | `mode` and `availableModes` set, with `mode` deliberately mismatching the page's `trackId`: output identical to what the fade/syllable rules alone dictate. |
| `countdown-numeral.json` | The normative numeral: `null` before the final `count * step` window, `ceil((end - now) / step)` clamped to `[1, count]` inside it, half-open `k` → `k - 1` boundaries, plus a bar whose `count * step` exceeds its span (window clamps to the whole bar). |
| `syllable-empty-text.json` | A mid-word empty-string syllable is invalid: skipped with no glyphs, no timing, and no index in the valid-syllable flattening; a whitespace-only syllable stays valid. |
| `malformed-page-clamp.json` | `fadeOutStart < fadeInStart`: effective fade-out start clamps up to `fadeInStart`, the visibility window uses the clamped value, and overlapping fade ramps take the minimum opacity. |

## Word-sync fixtures (`wordsync/`) — checked structurally by the harness

| Fixture | Exercises |
|---|---|
| `v2-paged.json` | Version 2 input: `syl` arrays map verbatim to stage syllables; explicit page grouping and fade windows honored; `count_in` becomes a countdown bar; `lead_ins` attach to the right line. |
| `v1-lines.json` | Version 1 with `lines` of words: each word becomes exactly one syllable spanning the word's `start`–`end`. |
| `v1-segments.json` | Version 1 with flat `segments`: empty filler token discarded; order/timing preserved; a >3 s gap produces a line/page break; synthesized pages have sane fade windows and stay inside the 640x480 stage. |
