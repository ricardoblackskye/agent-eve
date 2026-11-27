# Lock the license posture down: remove the MIT grant, then guard against drift

**Issues:** #797 (the change) · #798 (the guard) · visibility decision recorded on #796 (stays public)
**Branches:** `chore/license-notice` (R1) then `chore/license-guard` (R2)

## Why we are doing this

The README ends with a `## License` section whose entire content is `MIT# Last rebuilt: 2026-08-24T17:35:32Z`. That reads
as an MIT grant, in a public repository, and it has been there since the README was first written. Meanwhile there is no
`LICENSE` file and no `license` field in `package.json`, so GitHub's own detection reports no license at all. Readers
have been granted MIT; the tooling never noticed.

The decision is to keep the repository public and state all rights reserved. That combination is why this is urgent
rather than tidy: **an MIT grant is irrevocable for anyone who obtained the code while it stood.** Every day the line
stays, more readers are granted rights that cannot be taken back. What we can do is stop granting — which means fixing
the notice now and putting a check in place so it cannot silently recur.

This plan covers both halves. The first corrects the notice and proves the correction holds. The second adds a guard
that fails if the posture ever drifts again, so that the failure mode is not "nobody was checking" a second time. It
grants nothing, revokes nothing retroactively, and does not change repository visibility.

## What we know, from reading rather than assuming

| fact                              | evidence                                                                                   |
|:----------------------------------|:-------------------------------------------------------------------------------------------|
| the MIT line is live              | `README.md:1159-1161` — `## License`, blank, `MIT# Last rebuilt: 2026-08-24T17:35:32Z`     |
| no license file exists            | no `LICENSE` / `COPYING` / `NOTICE` in the tree                                            |
| `package.json` is silent          | no `license`, no `private`, no `author` field                                              |
| GitHub agrees there is no license | API `license=NONE` for agent-eve, local-promotion-site, WebFeedPOC; `/license` returns 404 |
| MIT has been public a long time   | `git log -S"## License"` → `5a5653d` (the original README commit)                          |
| the corruption is a single line   | `0f09f0f` (Next.js web UI, #7) changed `README.md` +1 −1                                   |
| **no writer exists**              | tree-wide `grep` for `Last rebuilt` returns only the README line itself                    |
| the only other license text       | `vendor/opensandbox-charts/**` — Apache-2.0, Copyright The OpenSandbox Authors             |

**The "no writer" row is the one that changed this plan.** An earlier revision asserted a build step writes that line and
would silently revert the fix. It does not appear to exist. So the plan asserts the license text directly, and replaces
the mechanism claim with an empirical check: does the correction survive a rebuild.

**The vendor row is a hazard, not a detail.** `vendor/**` carries third-party Apache-2.0 notices. Any work touching
license text is the most likely thing in this repository to delete someone else's license by accident, and removing those
notices would breach their terms rather than protect ours.

## Release split

Two branches, because the fix and the lock should be reviewable separately: a reviewer who disagrees with the guard
should still be able to take the notice correction.

| release | branch                 | issue | ships                                                           |
|:--------|:-----------------------|:------|:----------------------------------------------------------------|
| **R1**  | `chore/license-notice` | #797  | the README notice, the `package.json` fields, the rebuild proof |
| **R2**  | `chore/license-guard`  | #798  | the guard, its scoping exclusion, gate wiring                   |

R2 depends on R1: the guard asserts the state R1 creates. R2 does not need to wait for R1 to merge if it is written
against the R1 branch, but it must not be reviewed as if the state already existed.

## R1 — the change (#797)

### Task 1 — the README notice

Replace the whole `## License` section (lines 1159-1161) with a statement that says what strangers may and may not do.

- Head the section `## License` (keep the heading the file already uses) — **pick one and use it in the guard too**, since a mismatched
  heading is exactly the kind of drift this work exists to stop.
- Body: the code is proprietary, all rights reserved, publication grants no license, with the line
  `All rights reserved - copyright BlackSkye` in the user's wording.
- **Remove the `MIT# Last rebuilt: ...` line entirely**, including the stray `#` and the timestamp — it is the
  corruption being fixed, not documentation.

*Completion:* reading the section as a stranger answers "may I use this?" without ambiguity.

### Task 2 — `package.json`

Add `"license": "UNLICENSED"` and `"private": true`.

`"private": true` here is a **different private** — it blocks an accidental `npm publish` and has nothing to do with
repository visibility. Both fields are pinned by the guard, so both belong in the same commit as the notice.

*Completion:* both fields present; `UNLICENSED` makes GitHub's detection continue to report no open license, which is the
intended state.

### Task 3 — prove it survives a rebuild

Deploy or rebuild, then re-read `README.md`'s license section.

- If something outside the repository rewrites it, this catches it — and that becomes a real finding.
- If nothing does, that is the evidence the withdrawn mechanism claim never had.

*Completion:* the notice is still there after a rebuild, and the outcome is recorded on #797 either way. A stated
mechanism that was never verified is not evidence.

### Task 4 — prove `vendor/**` is untouched

Diff the branch and confirm **no file under `vendor/**` changed**. This is a negative assertion, and it is the one most
likely to catch a real regression in this work.

*Completion:* `git diff --stat origin/main...HEAD -- vendor/` is empty, recorded in the PR body.

## R2 — the guard (#798)

### Task 5 — the assertions

A doc-code-sync check asserting:

1. The README's license section states all rights reserved — **positively about what it is**, not merely absent of "MIT".
2. `package.json`: `license === "UNLICENSED"` and `private === true`.
3. **No first-party tracked file grants an open license** — scan for grant language (`licensed under`, `MIT License`, an
   SPDX identifier in a manifest).
4. **Every `vendor/**` file still carries its upstream notice** — the negative assertion.
5. The license heading matches the heading Task 1 chose.

### Task 6 — the scoping exclusion

A naive repo-wide scan matches `.hermes/plans/2026-10-15_df-author-preservation-361.md`, which legitimately describes an
MIT notice on vendored upstream code. Exclude `vendor/**` and `.hermes/**` deliberately, **and write down why** — an
unexplained exclusion is how a guard becomes decorative.

### Task 7 — prove it fails

The acceptance, and not optional: break the README license line, watch the guard go red, restore it, watch it pass.
Then remove a notice from one `vendor/**` file in a scratch branch and watch the negative half fire.

*A check you have not seen fail is a check you do not know works* — and this guard exists precisely because a license
statement sat unchecked for the entire life of the repository.

### Task 8 — wire it into the gate

Run it with the other doc-code-sync checks on every PR, not only when someone remembers.

## What this does not change

- **Repository visibility.** #796 records staying public; this work is orthogonal to it.
- **The past.** No merge, deploy or history rewrite makes the MIT grant un-happen, and the text stays readable in the git
  history. This stops *future* grants only.
- **Runtime behaviour.** Documentation and metadata. No application code is touched, which is why both issues are `chore`
  and carry no `dark-factory` label.
- **Third-party obligations.** `vendor/**` notices stay exactly as they are.
- **The license choice itself.** Whether all-rights-reserved is right versus a source-available license (e.g. BUSL-1.1)
  is a product decision needing legal input, not a docs change.

## Gates

cspell clean · markdownlint 0 non-MD013 · pinned markdown-table-formatter last · `tsc --noEmit --incremental false` 0 ·
`npm run coverage:ratchet` exit 0 · the full suite on a quiet `darkfactory_test` (never two suites at once).

**One spelling note:** the user's wording `BlackSkye` is a proper noun and may trip cspell. If it does, add it to
`.cspell.json` — the word is going into the repository, so the dictionary needs it either way.

## Risks

| risk                                                         | mitigation                                                      |
|:-------------------------------------------------------------|:----------------------------------------------------------------|
| the fix reverts behind a rebuild                             | Task 3 checks empirically instead of assuming a mechanism       |
| a `vendor/**` notice is deleted                              | Task 4 before, Task 5's negative assertion after                |
| the guard is decorative (passes, checks nothing)             | Task 7 requires seeing it fail on both halves                   |
| the guard fails on the plan file's legitimate mention of MIT | Task 6's documented exclusion                                   |
| someone reads this as protecting IP that is already granted  | the "What this does not change" section, and #797's own comment |
