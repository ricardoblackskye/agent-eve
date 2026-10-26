# 0068 — E2E compile cost is paid in setup, never inside an assertion

- **Date:** 2026-10-26
- **Status:** Accepted

## Context

`next dev` compiles a route on first touch. On a genuinely cold tree — no `.next`, `npm ci`
complete, server started fresh — that measured 25–37 s per route, while the application code
behind it answered in 149–355 ms. The E2E specs budget 15 s for an `expect` and 60 s for a
test, both sized for CI where compilation is far quicker.

The result was that four specs in `e2e/dark-factory-runs.spec.ts` failed on a cold local run at
their ledger assertions, before any product behaviour was exercised. They looked like product
regressions and were only a compiler. `test.slow()` did not help: the test still died at the
configured 60 s budget, so a longer `expect` timeout was never reached.

Widening the assertion timeouts was rejected. It hides the real signal, and it slows every run
including CI, which never had the problem.

## Decision

The compile cost is paid **once, in a Playwright setup project**, before any assertion runs.

- A `setup` project matches only `e2e/warmup.setup.ts`, and the browser project declares
  `dependencies: ["setup"]`. That is chosen over `globalSetup` because a setup project is
  ordered after `webServer` is ready and before every dependent project, and over a per-file
  `beforeAll` because it runs **once** for the whole run — `fullyParallel` would otherwise let
  each worker re-race the compiler.
- The warming rules live in `tests/support/warm-routes.ts` behind an injected request function,
  so they are **unit-tested** rather than re-derived inside a spec. This follows #376, where a
  defect survived precisely because it lived in an entry point no test could call.
- **A status below 500 counts as warmed, including 404.** The unknown-run-id route is supposed
  to 404 and still proves the route compiled; treating it as a failure would make the warm-up
  report a lie.
- **A 5xx does not count.** It is retried a bounded number of times, then the warm-up **throws**
  naming the route. A warm-up that gives up quietly leaves the race it was meant to remove while
  looking fixed.

No assertion budget was changed. The specs keep their 15 s `expect` timeout; the compiler is
simply no longer on their critical path.

## Consequences

- A cold local E2E run is trustworthy: a failure means a failure, not a slow compile.
- Each run pays a few extra seconds of warm-up. It buys determinism and weakens nothing.
- **The `dependencies: ["setup"]` entry is load-bearing.** Removing it silently restores the
  cold-run failures; nothing fails to warn you, the phantom regressions simply come back.
- Only the routes the specs use are warmed. A new spec touching a new route must add it, or it
  re-introduces the race for that spec alone.
- This removes a compiler from the critical path; it does not make a genuinely slow route fast.
  Real latency still shows up.
