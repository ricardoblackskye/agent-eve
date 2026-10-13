# 0032 — sandbox lifecycle is the runner's responsibility, force-disposed

**Date:** 2026-10-13
**Status:** Accepted

## Context

The runner created the execution sandbox once per run but never disposed it — there was no `finally`, so
a successful run left the sandbox running. Closing the OpenSandbox SDK client does NOT terminate a
sandbox, so a missing `dispose()` is a leak and spend, and a client timeout during `create` leaks one the
caller never saw.

## Decision

`runCodingPhase(provider, workspaceDir, phase)` creates one sandbox, runs the coding loop, and calls
`provider.dispose?.()` in a `finally` — on success AND on throw. The runner owns the lifecycle; a
recording double proves the order (create -> phase -> dispose, exactly one create, dispose always fires).
Label-based reaping (T5b/B4) is defense in depth, not the primary release mechanism.

## Consequences

- A run cannot leave a sandbox running, regardless of how it exits.
- The lifecycle test is a guard: reverting `dispose` (or re-inlining `create`) fails CI, so the wiring
  cannot be quietly undone.
- `dispose` is idempotent and never throws, so it cannot mask an upstream error in the `finally`.
