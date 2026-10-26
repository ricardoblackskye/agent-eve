# #472 (part 2) — hermetic model verification, with a live check that is opt-in

## Goal

The default unit suite must be **hermetic**: it must assert something real without
reaching the network. The live provider check moves behind an explicit opt-in, and it still
runs in CI on every push so upstream drift is not lost. A **receipt** records which model
ids have actually been verified against the provider, so an id cannot be shipped without
someone having checked it.

## Decisions (taken by the maintainer, recorded here so the plan is not re-litigated)

| # | Decision                                   | Choice                                                    |
|---|--------------------------------------------|-----------------------------------------------------------|
| 1 | Does the offline assertion need to be real | Yes — not a visible skip                                  |
| 2 | Assertion basis                            | B1: a **verification receipt**, not a full catalog mirror |
| 3 | Where the live check runs                  | L2: in the normal CI unit job, via an env flag            |
| 4 | Staleness policy                           | Warn only for now; revisit if it proves noisy             |

Why B1 rather than a full catalog snapshot: a snapshot turns every legitimate model swap
into a red offline test, because a newly valid id is absent from a snapshot taken before it
existed. The pressure that creates is to re-record whatever the provider returns, which
degrades the guard into a rubber stamp. A receipt inverts that — a swapped id simply has no
receipt, so the test fails until someone genuinely verifies it. It is also a far smaller file.

## Context the change must respect

The live check **already runs in CI today**: CI runners have network, so the contract test
verifies on every push. Making the live path opt-in therefore removes detection unless the
workflow sets the flag. That is exactly what decision 3 does, and it is the reason the flag
is set in CI rather than left to a developer's memory.

## Design

### The receipt

A committed JSON file recording what has been verified, not what the provider currently
serves:

- `verifiedAt` — ISO date of the verification run
- `source` — the endpoint that was read
- `models` — the ids that were confirmed present

### The hermetic default test

For every model id the repo declares (`DEFAULT_MODEL_ID`, `FALLBACK_MODEL_ID` from
`agent/model-config.ts`), assert that a receipt entry exists. This runs with no network and
is the assertion that has to be real.

- Missing receipt for a declared id → **FAIL**, worded as *unverified model id*, naming the
  id and the command that fixes it.
- Receipt older than the TTL (default 90 days, a named constant) → **WARN** only, printing
  the age. It must not fail at this stage.

### The live opt-in test

The existing availability contract test becomes opt-in behind `LIVE_CONTRACT=1`, keeping
part 1's semantics exactly: `verified` asserts membership, `unverifiable` skips with the
reason. It does not run by default, so a local run stays hermetic.

### The verify command

A script (reusing the shared catalog lookup) that fetches the live catalog, checks the
declared ids, and rewrites the receipt. It fails loudly if a declared id is not in the live
catalog, so the receipt can never be written for an id that is absent.

### CI

Set the opt-in flag in the unit-test job's `env` block, next to the existing gate variables.
Detection on every push is preserved and the local default becomes hermetic.

## Sequencing and PR shape — needs one answer

Part 1 is complete, verified and pushed on `fix/model-availability-offline-skip-472`.
Part 2's implementation imports part 1's catalog lookup, so it must sit on top of it.

- **Default: one branch, one PR for #472** (append part 2 to the existing branch). Simplest,
  no rebase work, one review.
- **Alternative: split.** Open the part 1 PR now and merge it, then cut part 2 onto a fresh
  branch from main. Cleaner history per change, but means two review cycles and a rebase.

Confirm the default or ask for the split before implementation starts, because the branch
shape decides where the work lands.

## Tasks (TDD)

1. RED — receipt helpers: a declared id with no entry is unverified; an entry satisfies it;
   an old receipt warns but does not fail; a malformed receipt is a distinct, loud failure
   rather than a silent pass.
2. RED — the hermetic test fails on a missing receipt (prove it by removing an entry).
3. GREEN — implement the receipt helpers and the hermetic test; write the receipt.
4. GREEN — make the live check opt-in; prove the default run touches no network.
5. GREEN — the verify command; prove it writes a receipt and refuses a missing id.
6. GREEN — the CI env flag.
7. Full suite, type-check, local lint gate.

## Files likely to change

- `tests/support/openrouter-model-receipt.ts` (new — pure helpers)
- `tests/support/openrouter-model-receipt.json` (new — the receipt)
- `tests/model-receipt.test.ts` (new — hermetic, the real assertion)
- `tests/model-availability.contract.test.ts` (made opt-in)
- `scripts/openrouter-verify-models.ts` (new) plus an npm script
- `.github/workflows/ci.yml` (one env entry)
- `docs/adr/0067-...md` (new) plus the ADR index

## Validation

- Default run is hermetic: no test in the suite reaches the network. Prove it by showing the
  live test reports skipped when the opt-in is absent.
- Removing a receipt entry makes the hermetic test FAIL with an *unverified model id* message.
- An aged receipt produces a warning and a green run.
- The verify command refuses to write a receipt for an id the live catalog does not contain.
- CI still verifies live (the opt-in flag is set) — confirm in the job log.
- Full suite, type-check and the local lint gate are clean.

## Risks / open questions

- **A receipt can still rot.** Warn-only means nobody is forced to re-verify; the mitigation
  is the TTL warning plus the live check running in CI. Revisit if it proves quiet.
- **The receipt is only as good as the command that writes it.** If the verify command ever
  writes without reading the live catalog, the guard becomes theatre — so it must fail, not
  warn, when a declared id is missing upstream.
- **CI parity.** The live check only runs where the network is available. Locally it will
  report skipped; that is intended, and it is why the hermetic test exists.
- **Workflow pushes need the fine-grained credential.** A change under `.github/workflows/`
  is rejected for a classic token, so the CI edit has to be pushed with the fine-grained PAT.

## ADR

One: the default suite is hermetic and a committed receipt records what was verified, while
the live check is opt-in and runs in CI. This concludes the deferral recorded in ADR 0066
(whose skip-versus-pass decision is unaffected and stays Accepted).
