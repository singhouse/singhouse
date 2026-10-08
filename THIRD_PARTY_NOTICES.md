# Third-Party Notices

This project builds on third-party software. This file records what those
components are, how they reach you, and under what terms.

**Read the "how it reaches you" column first.** The source checkout,
compiled frontend, and a packaged application contain different components.
Installing a dependency locally does not by itself put it in the frontend
bundle; packaging an environment can redistribute dependencies that a source
checkout does not include.

| Group | Meaning |
|---|---|
| **A. In this repository** | Files committed here. You get these when you clone. |
| **B. In the built frontend** | Additional components embedded by the default frontend build. |
| **C. Installed dependencies and model downloads** | Obtained separately when setting up the source checkout. A packaged environment may also include installed dependencies. |

The built frontend, Python environments, and model files are excluded from
the source repository. The frontend build serves bundled JavaScript and fonts
to connected browsers. Native desktop assembly generates an exact dependency
inventory and collects the corresponding license files under `notices/` in
the payload; optional processing packs do the same for their own contents.
Any other release image or archive must account for the dependencies and
license texts it actually contains.

---

## This project's own licensing

The project as a whole is licensed **AGPL-3.0-only** — GNU Affero General
Public License, version 3, **without** the "or (at your option) any later
version" option. The full text is in [`LICENSE`](LICENSE). That file is the
Free Software Foundation's unmodified license text and, like every copy of it,
contains an appendix showing how a project *could* offer the "or later" term.
This project does not. Version 3 is the only version under which the project
is offered.

**Exception — the `lyricsync` package.** [`lyricsync/`](lyricsync/) is
additionally available under the **MIT License**
([`lyricsync/LICENSE`](lyricsync/LICENSE)). It is an alignment library with no
dependency on the rest of the project, and it is offered separately so it can
be used without the AGPL's obligations. You may use `lyricsync` under either
MIT or AGPL-3.0-only, at your option.

---

## A. Components in this repository

The following third-party components are committed to this repository.

### Signalsmith Stretch

- **What it is:** time-stretch / pitch-shift audio processing, compiled to
  WebAssembly.
- **Where:** `frontend/public/vendor/signalsmith/SignalsmithStretch.mjs`
- **License:** MIT — Copyright (c) 2022 Geraint Luff / Signalsmith Audio Ltd.
- **Full text:** `frontend/public/vendor/signalsmith/LICENSE.txt`
- **Upstream:** https://github.com/Signalsmith-Audio/signalsmith-stretch

This is the official upstream web release build, unmodified.
`frontend/public/vendor/signalsmith/PROVENANCE.txt` records the source and a
SHA-256 of the file as vendored, so the copy here can be checked against
upstream's release.

### DejaVu Sans Bold (font)

- **What it is:** the glyph font used by the backend CD+G export rasteriser.
- **Where:** `backend/src/karaoke_backend/export/fonts/DejaVuSans-Bold.ttf`
- **License:** Bitstream Vera font license with DejaVu additions; DejaVu
  changes are in the public domain. The accompanying license also contains
  the notices for Arev glyphs, Copyright (c) 2006 Tavmjong Bah.
- **Copyright:** Copyright (c) 2003 by Bitstream, Inc. All Rights Reserved.
- **Full text:** [`backend/src/karaoke_backend/export/fonts/LICENSE`](backend/src/karaoke_backend/export/fonts/LICENSE)
- **Upstream:** https://dejavu-fonts.github.io/

The font is vendored unmodified and included in the backend's package data.
The adjacent `PROVENANCE.txt` records its source package and SHA-256. Keep the
copyright and license notices with redistributed copies of the font; the
license text records the conditions for modifications and standalone sale.

---

## B. Additional components in the built frontend

These components are installed from npm and embedded in the default frontend
output, in addition to the vendored Signalsmith files from group A.

### Space Grotesk (font)

- **License:** SIL Open Font License 1.1 (OFL-1.1)
- **Copyright:** Copyright 2020 The Space Grotesk Project Authors
- **Upstream:** https://github.com/floriankarsten/space-grotesk
- **Distributed via:** the `@fontsource-variable/space-grotesk` npm package;
  the built frontend embeds three `.woff2` files (latin, latin-ext,
  vietnamese) and serves them to browsers.
- **Full text:** installed with the package at
  `frontend/node_modules/@fontsource-variable/space-grotesk/LICENSE`; native
  assembly copies it to `notices/frontend/_fontsource-variable_space-grotesk/`
  and beside the emitted fonts as `static/assets/SpaceGrotesk-LICENSE.txt`.

The native assembler fails if the package license is absent and copies the
OFL text into the packaged payload. The font is used unmodified and under its
original name, and is not sold on its own.

### Frontend runtime libraries

The following directly imported runtime libraries are compiled into the
default frontend JavaScript bundle. All are MIT-licensed. This table is not
a transitive dependency inventory.

| Component | Copyright | Upstream |
|---|---|---|
| Vue 3 | Copyright (c) 2018-present, Yuxi (Evan) You | https://github.com/vuejs/core |
| Vue Router | Copyright (c) 2019-present Eduardo San Martin Morote | https://github.com/vuejs/router |
| Pinia | Copyright (c) 2019-present Eduardo San Martin Morote | https://github.com/vuejs/pinia |
| Axios | Copyright (c) 2014-present Matt Zabriskie & collaborators | https://github.com/axios/axios |

`vuedraggable` remains declared in the frontend manifest and installs
SortableJS, but neither is imported by the default frontend source or included
in its bundle. Their presence in `node_modules` is not evidence of inclusion
in that artifact.

Build-time-only packages — bundlers, test runners and the like — are not listed
individually here. Serving only the compiled frontend does not distribute the
entire `node_modules` directory. Where a build tool
emits its own content into that output, the emitted content is covered by the
tool's license; Tailwind CSS, whose base styles are written into the shipped
stylesheet, is MIT.

### If Python is ever packaged with the application

A packaged build that embeds the Python runtime environment would also
redistribute its installed distributions, including components from group C.
Its inventory and license delivery must reflect that environment. The entries
there highlight some copyleft and non-commercial terms; permissive components
also have notice requirements.

---

## C. Installed dependencies and model downloads

For a source installation, these components are obtained separately through
`pip`, `npm`, an OS package manager, or the model upstream. They are not
included in the source checkout. An image or other packaged environment
containing them must account for their redistribution terms.

### Audio and media

| Component | License | Notes |
|---|---|---|
| FFmpeg / ffprobe | varies by build | Invoked as an external program found on your `PATH`. Not bundled, not installed by this project. Licensing depends entirely on the build your system provides. |
| PyAV (`av`) | BSD-3-Clause | Pulled in indirectly by `faster-whisper`. Its binary wheels bundle a pre-built FFmpeg, which carries its own terms (LGPLv3 in the wheels published at the time of writing) separate from PyAV's. If you redistribute an environment containing those wheels, review the bundled libraries' terms as well. |
| Demucs | MIT | Music source separation. Runs in a separate Python environment you create. |
| audio-separator | MIT | Runs the RoFormer separation models. |
| lameenc | **LGPL-3.0** | MP3 encoding. A required dependency of Demucs. Copyleft — packaging it into a redistributed build carries notice and relinking obligations. |
| soxr | **LGPL-2.1-or-later** | Sample-rate conversion, via librosa. Same consideration as `lameenc`. |
| diffq / diffq-fixed | **CC BY-NC 4.0** | Declared by `audio-separator` for quantized Demucs state. Release processing packs use only the non-quantized `mdx_extra` and RoFormer routes and fail the build if either package, its distribution metadata, or its notices enter the payload. They are not redistributed in release packs. A user-created environment that selects quantized models must evaluate the non-commercial terms separately. |

### Speech recognition and alignment

| Component | License | Notes |
|---|---|---|
| faster-whisper | MIT | Whisper inference with word-level timestamps. |
| CTranslate2 | MIT | Inference engine behind faster-whisper. |
| ONNX Runtime | MIT | |
| RapidFuzz | MIT | String similarity. Replaced a GPL-licensed predecessor; the extra that installs it keeps its historical name for compatibility. |
| Metaphone | BSD-3-Clause | Phonetic matching. |
| PyTorch | BSD-3-Clause | Separate environment. |
| torchaudio | BSD-2-Clause | Separate environment. Its installed metadata carries only a generic "BSD License" classifier; the two-clause form is per upstream. |
| Transformers | Apache-2.0 | Separate environment. |
| NumPy | BSD-3-Clause and others | Bundles several separately-licensed components (0BSD, MIT, Zlib, CC0-1.0); its own distribution carries their texts. |
| SciPy | BSD-3-Clause | Separate environment. |
| phonemizer | **GPL-3.0-or-later** | Optional, separate environment. Used only by the optional phoneme voter of the acoustic re-timing stage, through the Transformers phoneme tokenizer; when it is absent that voter is skipped. Not installed or bundled by this project. |
| eSpeak NG | **GPL-3.0-or-later** | Optional system program, the backend phonemizer drives. Same consideration as phonemizer. |

### Web service

| Component | License |
|---|---|
| FastAPI, Pydantic, SQLAlchemy, Alembic, aiosqlite, slowapi | MIT |
| Starlette, Uvicorn, httpx, itsdangerous | BSD-3-Clause |
| bcrypt, python-multipart | Apache-2.0 |
| greenlet | MIT AND PSF-2.0 |
| email-validator | Unlicense |
| certifi | MPL-2.0 |
| tqdm | MPL-2.0 AND MIT |

### GPU support

If you install GPU-accelerated builds, `pip` will pull NVIDIA CUDA runtime
components (cuBLAS, cuDNN and related packages). These are **proprietary**,
licensed by NVIDIA directly to you under their own terms, and are not
redistributable by this project. Review NVIDIA's license before packaging or
redeploying an environment that contains them.

### Model weights

Model files are **downloaded by you, at your initiative, from their
upstreams**. This project does not host, mirror, bundle, or redistribute any
model weight.

**Mel-band RoFormer (vocal separation)** — two distinct things share this
name, and their terms differ:

- *The architecture implementation* — BS-RoFormer, by Phil Wang. **MIT**,
  Copyright (c) 2023 Phil Wang.
  https://github.com/lucidrains/BS-RoFormer — reached indirectly through
  `audio-separator`.
- *The default trained checkpoint* —
  `mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt`, credited to
  **aufr33 and viperx** in the Ultimate Vocal Remover ecosystem, with thanks
  to **Anjok07** and the UVR project. We have located **no published license
  terms** for this weight file. Phil Wang's architecture-code license does
  not establish a license for separately trained weights. This project
  asserts none on their authors' behalf and never redistributes the file;
  it is fetched from upstream for your installation. If you select a
  different checkpoint or redistribute weights yourself, establish the
  terms for that specific file first.

**CTC alignment models (optional acoustic re-timing stage)** — fetched on
first use into your processing environment's torch hub and Hugging Face
caches:

- `torchaudio.pipelines.HUBERT_ASR_LARGE`, `HUBERT_ASR_XLARGE` and
  `WAV2VEC2_ASR_LARGE_LV60K_960H` — originally published by the HuBERT and
  wav2vec 2.0 authors under the **MIT** license and redistributed by
  torchaudio under the same license (per the torchaudio documentation).
- `facebook/wav2vec2-lv-60-espeak-cv-ft` (phoneme voter, Hugging Face) —
  check the terms on its model card before use or redistribution.

The MMS forced-alignment weights (`torchaudio.pipelines.MMS_FA`, CC-BY-NC)
are deliberately not used.

**Demucs models** — the Demucs *code* is MIT (Meta Platforms, Inc. and
affiliates). Terms for the pre-trained weight files are published separately
from the code, and vary by model version. Check the terms for the specific
model you use, particularly for commercial use.

### Lyrics

**LRCLIB** (https://lrclib.net) — an optional, clearly-labeled,
**off-by-default** integration for retrieving synchronized lyrics. It is
disabled unless you turn it on. LRCLIB's data terms are LRCLIB's; this project
neither bundles a lyrics database nor stores, hosts, or transmits lyrics on
infrastructure it controls.

---

## Corrections

If a component is missing, misattributed, or wrongly licensed here, please open
an issue. Notices are meant to be accurate; corrections are welcome and will be
applied.
