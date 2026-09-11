# SPDX-License-Identifier: MIT
"""
Compare a word_data JSON against a reference word_data JSON.

Both files share the catalog_word_data shape:
  { "lines": [ [ {"word", "start", "end"}, ... ], ... ], ... }

Words are flattened, normalized, and aligned with Needleman-Wunsch
on text equality. Reports recall, precision, timing offsets, and
within-tolerance percentages for matched words.

Usage:
    python eval.py REFERENCE.json CANDIDATE.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple


_NORMALIZE_RE = re.compile(r"[^a-z0-9']+")

# Fold typographic apostrophes to ASCII before stripping. Without this,
# "can't" and "can’t" normalize differently and silently fail to pair —
# heart-vad-none is the only arm that emits curly apostrophes, so the drift
# was one-sided against the baseline (review 2026-07-22, finding C1).
_APOSTROPHES = str.maketrans({"‘": "'", "’": "'", "ʼ": "'"})


def normalize(word: str) -> str:
    return _NORMALIZE_RE.sub("", word.translate(_APOSTROPHES).lower()).strip("'")


@dataclass
class Word:
    text: str
    norm: str
    start: float
    end: float
    line_idx: int


def load_words(path: Path) -> List[Word]:
    data = json.loads(path.read_text())
    out: List[Word] = []
    for li, line in enumerate(data.get("lines", [])):
        for w in line:
            text = w.get("word") or w.get("text") or ""
            n = normalize(text)
            if not n:
                continue
            out.append(Word(text=text, norm=n, start=float(w["start"]),
                            end=float(w["end"]), line_idx=li))
    return out


def align(ref: List[Word], cand: List[Word],
          gap: float = -1.0, match: float = 2.0,
          mismatch: float = -1.0) -> List[Tuple[Optional[int], Optional[int]]]:
    """Needleman-Wunsch on normalized text equality. Returns list of
    (ref_idx, cand_idx) pairs; either side may be None (gap).

    Among alignments with equal text score, prefers the one minimizing the
    summed |ref.start - cand.start| over matched pairs. Pure-text NW is
    massively degenerate on repeated lyrics (a chorus sung four times admits
    many optimal alignments) and the old traceback resolved ties toward the
    LATEST same-text ref instance, inflating candidates' timing error on
    exactly the repetition axis the eval stratifies on (review 2026-07-22,
    finding C2). The time term is a tie-break only — it never trades away
    text-alignment quality.
    """
    n, m = len(ref), len(cand)
    # score[i][j] = best text score aligning ref[:i] with cand[:j]
    # tcost[i][j] = min summed |dstart| over matched pairs among score-optimal
    score = [[0.0] * (m + 1) for _ in range(n + 1)]
    tcost = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        score[i][0] = i * gap
    for j in range(1, m + 1):
        score[0][j] = j * gap
    for i in range(1, n + 1):
        ri = ref[i - 1]
        row_s, row_t = score[i], tcost[i]
        prev_s, prev_t = score[i - 1], tcost[i - 1]
        for j in range(1, m + 1):
            cj = cand[j - 1]
            hit = ri.norm == cj.norm
            s = match if hit else mismatch
            bs = prev_s[j - 1] + s
            bt = prev_t[j - 1] + (abs(ri.start - cj.start) if hit else 0.0)
            us, ut = prev_s[j] + gap, prev_t[j]
            if us > bs or (us == bs and ut < bt):
                bs, bt = us, ut
            ls, lt = row_s[j - 1] + gap, row_t[j - 1]
            if ls > bs or (ls == bs and lt < bt):
                bs, bt = ls, lt
            row_s[j], row_t[j] = bs, bt

    # Traceback (recomputes the same candidate tuples, so equality is exact)
    pairs: List[Tuple[Optional[int], Optional[int]]] = []
    i, j = n, m
    while i > 0 and j > 0:
        hit = ref[i - 1].norm == cand[j - 1].norm
        s = match if hit else mismatch
        ds = score[i - 1][j - 1] + s
        dt = tcost[i - 1][j - 1] + (abs(ref[i - 1].start - cand[j - 1].start)
                                    if hit else 0.0)
        if score[i][j] == ds and tcost[i][j] == dt:
            pairs.append((i - 1, j - 1) if hit else (i - 1, None))
            if not hit:
                # treat mismatch as a ref-deletion + cand-insertion for cleanliness
                pairs.append((None, j - 1))
            i -= 1
            j -= 1
        elif score[i][j] == score[i - 1][j] + gap and tcost[i][j] == tcost[i - 1][j]:
            pairs.append((i - 1, None))
            i -= 1
        else:
            pairs.append((None, j - 1))
            j -= 1
    while i > 0:
        pairs.append((i - 1, None))
        i -= 1
    while j > 0:
        pairs.append((None, j - 1))
        j -= 1
    pairs.reverse()
    return pairs


def evaluate(ref_path: Path, cand_path: Path, label: str = "") -> dict:
    ref = load_words(ref_path)
    cand = load_words(cand_path)
    pairs = align(ref, cand)

    matched: List[Tuple[Word, Word]] = []
    missing: List[Word] = []
    extra: List[Word] = []
    for ri, ci in pairs:
        if ri is not None and ci is not None:
            matched.append((ref[ri], cand[ci]))
        elif ri is not None:
            missing.append(ref[ri])
        elif ci is not None:
            extra.append(cand[ci])

    n_ref, n_cand, n_match = len(ref), len(cand), len(matched)
    recall = n_match / n_ref if n_ref else 0.0
    precision = n_match / n_cand if n_cand else 0.0

    start_offsets = [abs(c.start - r.start) for r, c in matched]
    end_offsets = [abs(c.end - r.end) for r, c in matched]

    def pct_within(offsets: List[float], tol: float) -> float:
        if not offsets:
            return 0.0
        return 100.0 * sum(1 for o in offsets if o <= tol) / len(offsets)

    def median(xs: List[float]) -> float:
        if not xs:
            return 0.0
        s = sorted(xs)
        n = len(s)
        return s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])

    summary = {
        "label": label or cand_path.stem,
        "ref_words": n_ref,
        "cand_words": n_cand,
        "matched": n_match,
        "missing": len(missing),
        "extra": len(extra),
        "recall": recall,
        "precision": precision,
        "f1": 2 * recall * precision / (recall + precision) if (recall + precision) else 0.0,
        "start_offset_mean_ms": 1000 * (sum(start_offsets) / len(start_offsets) if start_offsets else 0),
        "start_offset_median_ms": 1000 * median(start_offsets),
        "end_offset_mean_ms": 1000 * (sum(end_offsets) / len(end_offsets) if end_offsets else 0),
        "within_100ms": pct_within(start_offsets, 0.100),
        "within_250ms": pct_within(start_offsets, 0.250),
        "within_500ms": pct_within(start_offsets, 0.500),
    }
    return summary


def format_summary(s: dict) -> str:
    return (
        f"{s['label']:<28}  "
        f"R={s['recall']*100:5.1f}%  "
        f"P={s['precision']*100:5.1f}%  "
        f"F1={s['f1']*100:5.1f}%  "
        f"start mean={s['start_offset_mean_ms']:6.0f}ms  "
        f"med={s['start_offset_median_ms']:5.0f}ms  "
        f"<100ms={s['within_100ms']:5.1f}%  "
        f"<250ms={s['within_250ms']:5.1f}%  "
        f"<500ms={s['within_500ms']:5.1f}%  "
        f"({s['matched']}/{s['ref_words']} matched, {s['extra']} extra)"
    )


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("reference", type=Path)
    p.add_argument("candidate", type=Path)
    p.add_argument("--label", default="")
    p.add_argument("--json", action="store_true", help="emit JSON instead of formatted line")
    args = p.parse_args()

    s = evaluate(args.reference, args.candidate, label=args.label)
    if args.json:
        print(json.dumps(s, indent=2))
    else:
        print(format_summary(s))
    return 0


if __name__ == "__main__":
    sys.exit(main())
