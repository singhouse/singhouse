# HEART output normalization and evaluation

HEART word timestamps come from the Hugging Face speech recognition pipeline's
`return_timestamps="word"` chunks. The managed worker loads both the model and
`WhisperProcessor` from the same local checkpoint; the processor supplies the
tokenizer. The bundled library runner also loads its processor from the supplied
checkpoint. Neither runner tokenizes the output with an application word splitter.

Both runners already request `task="transcribe"` and pass the requested language
to generation (the command-line default is `en`). The reported result language is
that request, not an independently detected language or a guarantee about output.
An English decode hint therefore does not prove that unexpected Hangul originates
in rendering, and adding the same hint again would not fix it.

The typed HEART adapters normalize fullwidth apostrophes and join timestamp
fragments for common contractions, for example `don`, `'`, `t`. Joining is limited
to ASCII-letter bases and known suffixes, within one segment, with no inter-chunk
pause over 100 ms and nondecreasing starts. Merged words retain the earliest start
and latest end, including overlapping chunk timings. Curly apostrophes, accented
letters, Hangul and other scripts are preserved. Segment text and `full_text` retain the decoder's spacing and punctuation apart
from fullwidth apostrophe normalization; joining word chunks into display text
would introduce incorrect spaces in scripts such as Japanese. Local and user-configured Modal adapters
use the same normalization. Existing stored transcriptions are not rewritten.

`tests/test_heart_words.py` evaluates synthetic no-reference timestamp output,
including subprocess JSON parsing, split and attached suffixes, overlapping
intervals, pauses, segment boundaries, and multilingual preservation. These tests
do not establish acoustic transcription accuracy or native model qualification.

Unexpected-script output remains a model evaluation question. A useful next
experiment needs licensed or original audio with known language content, the
exact checkpoint/tokenizer and runtime versions, raw decoded text and word
chunks, requested language, and decode settings. Compare greedy no-reference
output against a human transcript, counting substitutions and unexpected-script
spans separately from punctuation. Include genuinely multilingual controls;
script membership alone is not a hallucination label. No non-ASCII filtering,
script-based deletion, new language restriction, or claim of resolved language
hallucination is warranted by the synthetic tests.
