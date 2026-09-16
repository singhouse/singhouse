# Native release qualification

This directory records repeatable evidence for a Singhouse desktop release.
It does not turn an automated smoke test, virtual machine, or remote desktop
session into physical audio, display, GPU, or clean-machine evidence.

Start a candidate by copying `matrix.template.json` to an evidence directory
outside the source checkout. Keep evidence with the immutable candidate
artifacts and receipts:

```sh
python3 desktop/qualification/qualify.py inventory \
  --candidate-revision "$(git rev-parse HEAD)" \
  --output evidence/machine.json
python3 desktop/qualification/qualify.py validate \
  desktop/qualification/matrix.template.json
```

The matrix uses four result values:

- `passed`: the named check ran on the named candidate and its evidence is
  attached.
- `failed`: the check ran and did not meet its acceptance condition.
- `untested`: no qualifying run exists.
- `blocked`: a run was attempted but a concrete external prerequisite was
  unavailable. The blocker must be recorded.

Never mark a row passed from source inspection alone when the row requires an
installer, inference, audible comparison, physical output, or interruption.
Synthetic media is useful for deterministic plumbing tests and must be labeled
as synthetic evidence.

## Candidate evidence layout

Use one directory per exact source revision and artifact set:

```text
evidence/
  candidate.json
  checksums.txt
  machines/<machine-id>.json
  results/<matrix-row-id>.json
  logs/<matrix-row-id>.log
```

Each result should identify the source revision, artifact SHA-256, machine
inventory, command or manual procedure, start/end time, result, and evidence
files. Do not include model weights, user media, lyrics, secrets, tokens, or
private application data.

## Automated commands

Run the repository suites before native tests:

```sh
npm --prefix desktop test
python3 -m unittest discover -s desktop/test -p 'test_*.py'
python3 -m pytest backend/tests
npm --prefix frontend test -- --run
npm --prefix frontend run build
```

On Linux, exercise the source shell with an available display or Xvfb:

```sh
xvfb-run -a node desktop/test/smoke.mjs
```

For a real packaged Linux executable, use an empty isolated application-data
root through the existing packaged smoke runner:

```sh
xvfb-run -a node desktop/test/packaged-smoke.mjs \
  --executable /absolute/path/to/the/candidate/executable
```

That packaged smoke uses generated media. It proves neither audible output nor
external-display behavior. Real processing qualification additionally needs
the fixed private evaluation corpus, locally available model files, and the
exact candidate runtime pack. Do not fetch new weights merely to run this
harness.

The release matrix and operator procedures are described in
`docs/release-qualification.md`.
