# Contributing to Singhouse

> Contributor intake is not active yet. Do not submit signatures or code
> contributions until the project announces that intake is open.

Thanks for wanting to help. This document covers what the project will and
won't accept, and the one piece of paperwork required before code can be
merged.

## Before you write code

Please open an issue first for anything beyond a small fix. It's a small
project with a specific scope, and it's much better to find out that an idea
is out of bounds before you've built it than after.

## Scope — what will and won't be accepted

Some things are outside this project's boundaries by design, not by
oversight. Pull requests implementing them will be declined regardless of how
well they're written:

- **Anything that finds, downloads, or rips music.** No search integrations,
  no downloaders, no ripping. Singhouse works with your existing audio files,
  including files on a media server you run.
- **A bundled or hosted catalog.** The project ships no song catalog and no
  index. Core may include adapters that enumerate your own collection on a
  media server you run. Neither core nor premium accepts providers that
  acquire songs from someone else's catalog.
- **A bundled lyrics database.** The optional lrclib.net lookup stays opt-in
  and off by default. Contributions that turn it on by default, or that add a
  second lyrics source without the same treatment, will be declined.
- **Hosting or transmitting user content on project-controlled
  infrastructure.** No uploading of audio, stems, lyrics, or timings to
  infrastructure the project controls. Separation runs locally by default;
  optional Modal processing uses your own deployment.
- **Stem or lyric sharing between installs.**

Separately: the rotation queue, the overlays, venue-based show history, and
custom branding are part of the paid Singhouse product. They are developed in
a **separate, private repository**. The project as a whole is
AGPL-3.0-only; `lyricsync` is also available under MIT, and third-party
components retain their own licences. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the component licence files.

## The Contributor License Agreement

**Before your first contribution can be merged, you need to be covered by a
CLA.** Once contributor intake opens, the required `CLA signed` check will
enforce recorded coverage on pull requests. Intake and automated enforcement
are not active yet; the signing instructions below describe the prepared
process.

- Contributing on your own behalf: sign the
  [Individual CLA](CLA.md).
- Contributing as part of your job: ask your employer to sign the
  [Corporate CLA](CCLA.md) instead, which covers everyone it names.
- The full reasoning, and what the project commits to in return, is in
  [LICENSING.md](LICENSING.md).

### Why there's a CLA

Being straight with you, because a CLA on an open-source project is often —
fairly — read as a company keeping the option to take the project closed.

Singhouse is open core: this repository is AGPL-3.0, and a separately
developed paid product is what funds the work. Bones Consulting LLC needs
sufficient rights to offer contributed code under commercial terms alongside
its open-source licence. The CLA supplies those grants for contributions it
covers. Third-party components remain subject to their own licence terms;
the CLA does not grant rights over material its signer cannot license.

The CLA closes that gap, and it is a licence, not an assignment — **you keep
ownership of what you write**, and nothing stops you using your own code
anywhere else. In return, **Section 4 of both agreements is a binding
commitment that anything merged into the core stays licensed to the public
under AGPL-3.0 or another OSI-approved licence, permanently.** The core cannot
quietly be closed; that is written into the agreement you're being asked to
sign, not just promised in a README.

If you'd rather not sign, that's a legitimate position and no hard feelings.
Bug reports, reproductions, and design discussion are welcome without an
agreement when they are not proposed as project material. Contributions also
include documentation, designs, translations, artwork, test data, and
configuration; see the definition in Section 1 of the Individual CLA. Code pasted
into an issue or discussion by someone who isn't covered can't be merged —
or transcribed into a commit — no matter how small. If it's code, it needs
to arrive as a pull request from its author.

### How to sign — individuals

1. Read [CLA.md](CLA.md).
2. Find your numeric GitHub account id at
   `https://api.github.com/users/YOUR_LOGIN` — the top-level `id` field. The
   check matches on that, not on your login, because logins can change and
   get reused.
3. Open a pull request that adds **one entry for yourself** to the
   `signatures` array in `CLA-SIGNATURES.json`, and **changes nothing else**:

   ```json
   {
     "login": "your-github-login",
     "id": 12345678,
     "name": "Your Full Legal Name",
     "email": "you@example.com",
     "cla_version": "1.0",
     "signed_at": "2026-01-31",
     "reference": ""
   }
   ```

   Use your full legal name — the agreement is with a person, not an
   account. If an employer or client has rights in your work and has
   authorized your contributions (Section 6(c) of the agreement), add an
   `"employer"` field naming them. Use whatever `cla_version` currently
   sits at the top of that file. Leave `reference` empty; the project
   owner fills it in with this pull request's URL in a follow-up commit
   after merge, so your signed commit stays exactly yours.

4. Use this exact sentence as the commit message:

   ```
   I have read the Singhouse Contributor License Agreement and I hereby agree to it.
   ```

That commit, submitted through your GitHub account and merged by the project
owner, records your acceptance under Section 13(a) of the agreement. GitHub
retains the pull request and merge events alongside the acceptance commit.
The check accepts a signature pull request only when it appends one valid
entry for the pull request author, changes no existing ledger data, and has
one commit with the exact acceptance sentence above. The Owner reviews and
merges that record. Ledger maintenance and offline signatures are recorded
through separate ledger-only pull requests opened by an authorized company
representative.

Once it is merged, update your other pull requests to the current base branch
and rerun the check so it reads the accepted record. If an
agreement is ever materially revised, its version gets bumped and everyone
re-signs; you won't be held to wording that changed after you agreed to it.

If you can't sign by pull request, the signature block at the bottom of
[CLA.md](CLA.md) can be completed and emailed instead — see the contact
address there. The project owner then records your entry in
`CLA-SIGNATURES.json` for you.

### How to sign — organizations

The Corporate CLA is executed on paper or by email rather than through a pull
request — see the contact address in [CCLA.md](CCLA.md). Once it's signed, the
project owner adds the organization and its Schedule A contributors to
`CLA-SIGNATURES.json`, and the check passes for everyone named.

If your organization used Schedule A's domain-wide option rather than naming
individuals, the people contributing still need to be listed in that file:
the check can't act on email domains, because commit author emails are
frequently GitHub `noreply` addresses and aren't verified in any case.

## Pull requests

- Branch from `main`, keep the change focused, and describe what it does and
  why in the PR body.
- Add or update tests for behaviour changes. Setup for the backend and
  frontend suites is in [README.md](README.md).
- Match the surrounding code — its naming, its structure, and its comment
  style. Comments here tend to explain *why*, not *what*.
- Don't reformat unrelated code in the same PR.
- Don't incorporate third-party code under terms that conflict with the CLA
  grants. Section 6 of both agreements requires sufficient rights, not
  ownership of every line. Submit third-party material separately, identify
  its source and licence terms (including associated patents, trademarks, or
  licence agreements), and mark it **"Submitted on behalf of a third party:
  [name]"**, as the agreements require. Disclosing a licence does not resolve
  a conflict with the required grants.

## Reporting bugs and security issues

For ordinary bugs, open an issue with what you did, what happened, and what
you expected, plus your OS, GPU, and Python version.

For anything with a security impact, please **don't** open a public issue —
see [SECURITY.md](SECURITY.md) if present, or contact the owner directly.

## Licence

By contributing, you agree that your contributions are licensed under
AGPL-3.0-only for the project as a whole, with the applicable component
licences described in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), on the
additional terms set out in [CLA.md](CLA.md) or [CCLA.md](CCLA.md).
