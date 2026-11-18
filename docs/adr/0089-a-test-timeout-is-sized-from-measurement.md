# 0089 — A test timeout is sized from measurement

- **Status:** Accepted
- **Date:** 2026-11-18
- **Issue:** #690

## Context

The pre-push gate went red and then green on identical input: three runs of the same suite gave
`3690 passed`, `6 failed`, `3694 passed`, with every failure a timeout and **zero assertion failures**.

The run's JSON report carries per-test durations, which replaced "probably the machine" with a list.
The seven slowest tests in all 3712 were **exactly** the set that failed, and the slowest of them
measured 5116ms against the 5000ms bar. The next six sat at 2.0-2.8s; nothing else was within 2x.

The load factor is real but modest, and measurable from the same files: 5678ms to 9863ms (~1.7x) for
one Postgres file, and 1618ms to 5116ms (~3.2x) for the vault-proof suite. A test at 2.5s was
therefore inside the bar by less than the load factor.

The 5000ms was never a decision. It is Vitest's default, inherited rather than chosen, and it was
failing healthy tests.

## Decision

**The per-test timeout is sized from measurement: `testTimeout: 20_000`, seven times the slowest test
that survives the cost fix.**

1. The bar is a **safety net, not a latency budget.** Its job is to fail a hung or deadlocked test,
   and at 5s it was failing tests that were merely competing for the CPU.
2. The **multiple is tied to a measurement** - the worst surviving test, `run-history-postgres` at
   2798ms - rather than to a round number, so the value can be re-derived instead of guessed.
3. The **avoidable cost is removed first.** The vault-proof suite spawned three child processes per
   test to obtain one probe result that three tests read; resolving the interpreter once and running
   the probe once took that file's test time from 3969ms to 10ms. Raising the bar without that change
   would have made the gate green while leaving tests spending most of their time in process creation.
4. **Serializing the Postgres suites is not the answer.** ADR 0052 designed serialization out
   deliberately and `pg-suite-isolation.test.ts` guards the fast path, so doubling the suite's wall
   time to hide contention would undo a recorded decision.

## Consequences

- A genuinely hung test now takes up to 20s to fail instead of 5s. That is the price, stated plainly.
- The remaining exposure is the Postgres suites' **own** cost, deliberately left alone: they clear the
  new bar rather than being made cheaper. If that cost grows, it will surface as a test approaching a
  measured bar instead of as an unexplained red gate.
- The measurement, not the value, is the durable part. A future change that slows the suite has a
  number to compare against, and the comment in `vitest.config.ts` carries the arithmetic.
- A per-file override was rejected: it would have to be repeated per slow suite and would drift out of
  step with the next one.
