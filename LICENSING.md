# Singhouse Licensing Policy

This document explains how Singhouse is licensed, why contributors are asked to sign a CLA, and how to keep the project structure consistent with the model.

> **Prepared for publication; CLA intake and automated enforcement are not yet active.**

## The model

Singhouse uses an **open core** structure, split across two repositories:

| Component | Where it lives | Licence |
|---|---|---|
| Singhouse Core | this repository | AGPL-3.0-only overall; component exceptions below |
| Premium add-ons | a separate, private repository | Singhouse Commercial License |
| Commercial licence for Core | on request | Singhouse Commercial License |

**The Core** is free software under the GNU Affero General Public License v3.0. Anyone may use, modify, and redistribute it under those terms. The AGPL's network clause (§13) applies: if you run a modified Core and let users interact with it over a network, you must offer those users the corresponding source.

**This repository contains the open source Core, with separately licensed components.** The `lyricsync/` package is additionally available under the MIT licence in `lyricsync/LICENSE`. Vendored third-party material retains its own terms: Signalsmith Stretch uses the MIT licence in `frontend/public/vendor/signalsmith/LICENSE.txt`, and the bundled DejaVu font has its own licence in `backend/src/karaoke_backend/export/fonts/LICENSE`. Preserve those notices. See `THIRD_PARTY_NOTICES.md` and each component's licence for the applicable terms; the repository's overall AGPL licence does not replace them. No proprietary premium code belongs in this repository.

**Premium add-ons** are proprietary and are developed in a separate private repository that is not published. They install alongside the Core and extend it through its documented extension points. Using them requires a paid licence.

**Commercial licences for the Core** are available on request for organizations seeking alternative terms for the code Bones Consulting LLC is authorized to license. Separately licensed components and dependencies retain their applicable terms; a commercial Core licence does not replace them. Contact `jonesy@jonesy.sh`.

## Why the CLA is required

The project requires additional permissions for outside contributions so that Bones Consulting LLC can offer its code under both open source and commercial terms. Contributors retain ownership; the CLA supplies the copyright and patent grants described in the agreements. Those grants cover the contributor's Contributions, not rights belonging to unrelated third parties.

The CLA gate must block uncovered contributions when enabled. Until activation, outside contributions must not be merged. If coverage is missing, resolve it before merging; a check result does not establish ownership or replace review of third-party material.

The [Individual CLA](CLA.md) and [Corporate CLA](CCLA.md) provide those rights. They grant broad copyright and patent licences to Bones Consulting LLC only, with sublicensing rights including the right to relicense commercially. Recipients receive their rights under the applicable distribution licence. Contributors keep their copyright — nothing is assigned — and Section 4 of each agreement commits us to keeping merged contributions licensed to the public under an OSI-approved licence permanently, so the open core cannot quietly be closed.

## Enforcement

The following describes the intended enforcement once CLA intake and the automated check are enabled. The check is currently staged, not active.

1. When enabled, a CLA check runs on every pull request, blocking merge until every commit author is covered. It reads the signature record from the base branch, so a contributor cannot add themselves inside the pull request they need unblocked. Signature-only acceptance and authorized ledger-maintenance PRs use the separate validation paths described in `CONTRIBUTING.md`.
2. Individuals sign by opening a pull request against `CLA-SIGNATURES.json`. Corporations sign the CCLA offline; their Schedule A contributors are then added to the same file by the project owner.
3. **Corporate coverage is matched by named individual, not by email domain.** Schedule A's domain-wide option is valid as a matter of agreement but cannot be enforced automatically — commit author emails are frequently `noreply` addresses and are unverified in any case. Organizations using that option still need their contributors listed individually.
4. Signature records — legal name, account identity, timestamp, agreement version — are retained indefinitely. Keep them: they are the evidence chain for every commercial licence sold, and they outlive the project.
5. Version the agreements. If you amend them, publish a new version number and re-collect signatures rather than editing in place. When enabled, the check enforces this: a signature against a superseded version does not count.

## Keeping the boundary clean

The premium add-ons build on the Core. Keep project code, contribution permissions, and third-party obligations identifiable across the two repositories:

- **Keep proprietary premium source and build artifacts out of this repository.** Premium development belongs in its separate private repository.
- **Follow the source-header policy.** `tools/check_spdx_headers.sh` checks tracked `.py`, `.js`, `.mjs`, `.vue`, `.sh`, and `.css` files: project sources use `SPDX-License-Identifier: AGPL-3.0-only`, while `lyricsync/` uses `MIT`. Vendored frontend files are excluded and retain upstream notices. Documentation, configuration, generated output, and formats without comment syntax are outside this header check. Premium source uses its separate repository's `LicenseRef-Commercial` policy and licence text.
- **`LICENSE`** at this repository's root contains the full AGPL-3.0 text. The commercial terms live with the premium repository, not here.
- **Outside contributions are accepted only into the Core.** Contributions to the premium repository would create licensing questions the CLA is not designed to answer, and it does not accept them.
- **Review third-party material before accepting it.** Do not incorporate outside AGPL/GPL code into code intended for commercial relicensing without separately established permissions sufficient for that use. Section 6 of each CLA requires sufficient rights and disclosure of third-party material; signing does not create missing rights.
- **Review dependencies for the intended distribution.** Record each component's terms and how it is used, linked, bundled, or obtained by the user. Source distributions, frontend bundles, and packaged runtime environments can contain different components. Preserve required notices and satisfy the applicable terms; do not assume that every dependency is permissive or covered by the CLA.

## Contributor FAQ

**Do I lose my copyright?** No. You license it; you keep it, and you can reuse your own code anywhere.

**Will my code end up in a paid product?** Possibly, if a premium add-on builds on the part of the Core you changed. If merged into the Core, it will remain licensed to the public under AGPL-3.0, a later AGPL version, or another OSI-approved licence — Section 4 of the agreement commits us to that.

**Will I be paid?** No. The CLA is explicit about this so nobody is surprised later.

**I don't want to sign.** That is a legitimate choice. You can still open issues, review code, write documentation outside the repository, or fork Singhouse under the AGPL-3.0.

**My employer owns my code.** Ask them to sign the [Corporate CLA](CCLA.md), or contribute on your own time with their written waiver.

**Can I see the premium code?** It is developed in a separate private repository and is not published with the Core.
