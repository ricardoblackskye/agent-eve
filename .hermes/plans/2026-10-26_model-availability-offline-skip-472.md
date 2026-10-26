# #472 — a live contract test must SKIP, never fake-pass, when it cannot verify

## Goal

A full local suite run must be readable and honest. When the OpenRouter catalog cannot be
reached — or answers with something that is not a catalog — the availability contract test
must report **skipped** with a reason, and must never report **passed** while asserting
nothing, nor **failed** for a purely environmental reason.

## Root cause (verified, not hypothesized)

Three separate defects in `tests/model-availability.contract.test.ts`:

1. **The offline branch is unreachable on a hanging network.** The fetch aborts at 8000 ms
   (line 22) but `vitest.config.ts` sets no `testTimeout`, so vitest's 5000 ms default kills
   the test first and the `catch` that returns `null` never runs. A fast DNS refusal hides
   this — it returns `null` and fake-passes — so it only bites where the network hangs: a
   proxy, a firewall, a captive portal.
2. **When the branch is reached, it lies green.** Both cases do `expect(true).toBe(true)`
   and return, which reports **passed** while asserting nothing.
3. **A blocked or proxied response is misreported as "model does not exist".** A 200 with a
   non-catalog body (captive portal, auth wall, error envelope) yields an EMPTY set rather
   than null, so the assertion fails claiming the model is absent — conflating *cannot
   verify* with *verified absent*.

## Evidence

| Condition        | Observed         | Correct                      |
|------------------|------------------|------------------------------|
| online           | 2 passed         | genuine                      |
| offline flag set | 2 passed         | asserts nothing              |
| fetch hangs      | fails at 5021 ms | should reach the skip branch |

The third row was proven with a throwaway probe replicating the structure: a hanging fetch
failed with `Test timed out in 5000ms`, so the abort never fired first.

## Intended fix (option A — honest skip)

- Return a discriminated result instead of `null`: verified with the id set, or unverifiable
  with a reason string.
- Treat a response as unverifiable unless it carries a real catalog array. This is what
  separates *cannot verify* from *verified absent*.
- Lower the abort below vitest's default test timeout so the skip branch is reachable, and
  give the test an explicit timeout above it.
- On unverifiable, call the runner's skip API with the reason, so the suite reports skipped
  rather than passed.
- On verified, assert membership, and word the failure as *verified absent from the catalog*.

The decision logic moves into a small test-support module so it can be unit-tested against a
stubbed fetch — a hanging network cannot be exercised against the real one.

## Deliberately not in this change

- **Option B (separate review).** Making the default suite hermetic: assert model ids against
  a committed catalog snapshot, and move the live check behind an explicit opt-in. That
  trades snapshot staleness for offline coverage, and is its own design decision.
- **The sibling defect.** `tests/model-price-ceiling.contract.test.ts` carries the same
  fake-pass pattern. It is not broken by the timeout bug (it sets a 30 s test timeout), so it
  is tracked separately rather than widened into this change.

## Tasks (TDD)

0. Branch off origin/main; push this plan (GATE 1).
1. RED — support-module tests: offline flag, hanging fetch, non-ok response, a 200 without a
   catalog array, and a valid catalog. The middle and last pair pin *cannot verify* against
   *verified absent*. Confirm each fails for the right reason.
2. RED — contract test rewired to the new API; still passes online.
3. GREEN — implement the support module; rewire the contract test.
4. GREEN — confirm an offline run now reports skipped, and that a hanging fetch skips well
   inside the test timeout.
5. Full suite, type-check, and the local lint gate.

## Files likely to change

- `tests/support/openrouter-catalog.ts` (new)
- `tests/openrouter-catalog.support.test.ts` (new)
- `tests/model-availability.contract.test.ts` (rewired)
- `docs/adr/0066-a-live-contract-test-skips-when-it-cannot-verify.md` (new) plus the ADR index

## Validation

- The support-module tests pass, including the hanging-fetch case finishing well inside the
  test timeout.
- The contract test reports skipped with a reason when offline, and still passes online.
- The full suite shows no new failures, and no test reports passed while asserting nothing.
- Type-check and the local lint gate are clean on every changed file.

## Risks / open questions

- Lowering the abort may skip a genuinely slow but working network. The reason string names
  the cause, so the trade-off is visible rather than silent.
- The suite still touches the network on every default run. Option B is what would change
  that, and it is explicitly deferred.

## ADR

One decision needs recording: a live contract test that cannot reach its dependency reports
skipped, never passed, and never conflates an unverifiable answer with a verified absence.
