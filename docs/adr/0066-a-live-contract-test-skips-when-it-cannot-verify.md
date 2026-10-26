# 0066 — A live contract test that cannot verify reports skipped, never passed

- **Date:** 2026-10-26
- **Status:** Accepted

## Context

Issue #472 exposed three defects in one test — `tests/model-availability.contract.test.ts`,
the live guard that proves a resolved model id is real in OpenRouter's catalog.

Its helper returned `null` for every failure, collapsing "we could not ask" into one signal,
and the call sites then asserted `expect(true).toBe(true)` and returned. An offline run
therefore reported **2 passed** while verifying nothing: a coverage hole wearing a green badge.
A blocked or proxied response was worse — a `200` carrying an error envelope or a captive
portal produced an **empty** set rather than `null`, so the assertion failed claiming the
model was **absent**, conflating "cannot verify" with "verified absent".

The reported symptom was environmental: the helper aborted at **8000 ms** while
`vitest.config.ts` sets no `testTimeout`, so the runner's **5000 ms** default killed the test
first and the skip branch was never reached at all. A fast DNS refusal hid this — it returned
`null` and fake-passed — so it only surfaced where the network hangs: a proxy, a firewall, a
captive portal.

## Decision

A live contract test has exactly three outcomes, and the first two must never be confused:

- **verified** — the catalog was read; an absent id is a real regression, and the test fails
  with the words *verified absent*.
- **unverifiable** — we could not ask. The caller **skips** with a reason. It never passes,
  and never fails.
- **absent** — meaningful only inside a verified result.

Concretely:

- `fetchCatalogIds()` returns a discriminated result — `{ kind: "verified", ids }` or
  `{ kind: "unverifiable", reason }` — never `null`, so no caller can silently absorb a
  failure. The reason is carried into the skip message.
- A response that is not ok, is not JSON, carries no catalog array, or yields **no ids** is
  **unverifiable**. An empty catalog is indistinguishable from a broken one, so it must not
  be treated as a verified empty set.
- The lookup's own deadline (**3000 ms**) sits deliberately **below** vitest's default test
  timeout, so the skip branch is reachable; the test also sets an explicit timeout above it.
- Callers use the runner's skip API, so the suite reports **skipped** rather than **passed**.

## Consequences

- A local full-suite run is honest: an unreachable catalog now shows as skipped with the
  reason (`HTTP 403`, `timeout after 3000ms`, `response contained no catalog array`), instead
  of an unearned green or a confusing environmental red.
- A red result from this test now means one thing only — the catalog was read and the model is
  genuinely gone — which is the signal the guard was written to provide.
- The skip is a **visible** coverage hole rather than a hidden one. Coverage is still lost
  when offline, and that is the trade-off being accepted here.
- The suite still reaches the network on every default run. Asserting against a committed
  catalog snapshot, with the live check behind an explicit opt-in, would make it hermetic and
  restore offline coverage; that is a separate decision and is deliberately deferred.
- Any future live contract test should use this helper rather than re-implement the
  offline branch. `tests/model-price-ceiling.contract.test.ts` still carries the old
  fake-pass pattern and is tracked separately.
