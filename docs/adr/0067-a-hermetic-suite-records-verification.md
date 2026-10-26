# 0067 — The default suite is hermetic, and a receipt records what was verified

- **Date:** 2026-10-26
- **Status:** Accepted

## Context

ADR 0066 settled *how* a live contract test reports a failure — it skips when it cannot
verify — but recorded that the test still reached the network on every default run, and
deferred the question of making the suite hermetic.

That gap has two costs. A run without network cannot verify anything, so the assertion
disappears exactly when a developer is offline; and because CI runners *do* have network, the
check was only ever running in CI and on a connected machine, never as part of a hermetic
unit run.

The obvious fix — commit a snapshot of the provider's whole catalog — was rejected. A
snapshot makes every legitimate model swap a red offline test, because a newly valid id is
absent from a snapshot taken before it existed. The pressure that creates is to regenerate
the snapshot from whatever the provider returns, which is a rubber stamp: the guard stops
checking anything while still going green.

## Decision

The default unit suite is **hermetic**, the live check is **opt-in**, and a committed
**receipt** records what was actually verified.

- A receipt at `tests/support/openrouter-model-receipt.json` records the ids confirmed
  present, the endpoint read, and the date. It is what was *seen*, not a mirror of the
  catalog.
- The hermetic test (`tests/model-receipt.test.ts`) asserts that every declared id has a
  receipt entry. A missing entry **fails**, naming the id and the fix. It touches no network.
- `npm run models:verify` writes the receipt. It **refuses** — exit 1, nothing written — when
  the catalog cannot be read, or when any declared id is absent upstream. It must fail rather
  than warn: a receipt written for an id that was not seen turns the guard into theatre.
- The live check is opt-in behind `LIVE_CONTRACT=1`, and **CI sets that flag** in the unit
  job. CI is the only place it can run dependably, so the flag is the mechanism that keeps
  the drift detection rather than a developer's memory.
- Staleness is a **warning** past a 90-day TTL, not a failure. Revisit if it proves quiet.

## Consequences

- A local run is hermetic and still asserts something real: a swapped model id fails until
  someone runs the verify command against the provider.
- Editing the receipt to make a red test pass is a deliberate act that no longer looks like
  routine maintenance, which is the point of preferring a receipt over a snapshot.
- Upstream drift is still caught on every push, but only because the workflow sets the flag.
  **Deleting that line removes the detection silently** — nothing fails, the check simply
  stops running. The workflow comments say so.
- Warn-only TTL means a stale receipt does not force re-verification. The mitigation is the
  warning plus the live check in CI; this is knowingly the weaker of the two options.
- `tests/model-price-ceiling.contract.test.ts` still carries the older fake-pass pattern and
  does not use this receipt; it is tracked separately.
