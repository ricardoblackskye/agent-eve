# 0019 — The orchestration handler sequences the factory pipeline

- **Date:** 2026-10-08
- **Status:** Accepted

## Context

`agent/lib/dark-factory/dispatch.ts` provides a `Dispatcher` that already owns
retry/backoff, at-most-once delivery, human-parking (`ParkedRunError` → `blocked`),
per-run status persistence, the control gate and a per-invocation deadline. What it
did **not** provide is the *pipeline*: nothing ran the Developer Agent, the Tester
gate and the PR step in sequence. #268 (epic #267, P0) exists to close that gap — it
was the UAT blocker, because nothing ran the factory end-to-end.

The obvious alternative — fold the sequence into the `Dispatcher` (or into the worker
runtime) — was rejected: the Dispatcher is provider-neutral and its tests pin the
control semantics. Coupling it to a concrete dev→tester→pr agent roster would make both
harder to test and let control behaviour diverge from the pipeline.

## Decision

The pipeline is a **thin, injected `DispatchHandler`**
(`dispatch-handler.ts`, `createDispatchHandler`). It:

- runs the stages **developer → tester → pr** in order, invoking the cooperative
  `checkpoint` before each;
- lets a stage **return** to continue (a clean finish records `succeeded`);
- lets a stage **throw a plain `Error`** to be **retried** — the Dispatcher applies
  `DEFAULT_RETRY_POLICY`;
- turns `{ passed: false, parked: true }` from the tester gate into a
  **`ParkedRunError`** (`blocked`: no retry, no backoff burn — #162).

It owns **sequence and translation only**. All retry, backoff, parking, status,
dedup, control-gating and the deadline stay in the `Dispatcher`, unchanged. Stages are
injected so the handler is unit-testable without GitHub, an LLM, or the network; the
real stage wiring is composed separately and exercised by the end-to-end pipeline test
(#269).

## Consequences

- Control semantics live in exactly one place (the `Dispatcher`), so a change to
  retry or parking cannot silently diverge between the pipeline and the mechanics.
- The pipeline is trivially unit-testable with fake stages, and the handler stays small.
- A concrete cost: the handler is only as good as the injected stages. Wiring the real
  agents (Developer/Tester/PR) is a separate change (#269) that must satisfy this seam.
