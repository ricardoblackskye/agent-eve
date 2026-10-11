# 0021 — Terminal lifecycle labels are applied by a fail-closed library finalizer

- **Date:** 2026-10-10
- **Status:** Accepted

## Context

The trigger's re-run guard keys "this run has already finished" on the issue
carrying `df:done` or `df:failed` — but no library module wrote either label.
`df:done` was written inline by `scripts/dark-factory-runner.ts` and **only on full
success**; every failure path (architect plan rejected, domain validation
rejected, developer loop failed, push failed) simply threw. So `df:running` was
left in place and `df:failed` was written nowhere. A finished run was
indistinguishable from an abandoned one on the ticket, and the guard had nothing to
key on in production.

The writes also had to be safe to repeat. A webhook re-delivery must not
double-apply, and a transient GitHub failure must not leave a run silently
unlabelled. Inline writes satisfy neither: there is no seam in which to put an
idempotency check, and a write failure is swallowed by the surrounding `throw`.

## Decision

Apply terminal lifecycle labels from one library seam —
`agent/lib/dark-factory/run-finalizer.ts` (`applyTerminalLifecycle`) — which the
runner calls on the success path and on **every** terminal-failure path.

- **`df:done` is gated on the Definition of Done** (#271): it is applied only when
  `isDoneGateSatisfied` passes, so an agent's self-report can never produce the
  label. A DoD-refused run is left in the human-review path with only the in-flight
  labels cleared.
- **Idempotency keys on the finalizer's own marker event**, not on the mere
  presence of a `run.terminal` event. The Definition of Done already appends
  `run.terminal` (`succeeded`) as `dod:<runId>:terminal` *before* the finalizer
  runs, so a presence check would skip every successful run and `df:done` would
  never be written. The failure record deliberately uses a distinct eventId, so a
  run whose label writes failed can still be finalised on a later delivery.
- **Fail-closed**: every `add`/`remove` result is collected and any real failure is
  recorded on the run *and* thrown, never swallowed. An already-absent label (404
  on remove) counts as success — the post-state is what was asked for.
- **Abort is deliberately excluded**: abort is reversible and the re-run guard must
  keep allowing a re-trigger, so the entry point's terminal path stays label-free.

## Consequences

- A finished run is labelled on the ticket for both outcomes, and the trigger's
  re-run guard has a real key. `df:running` no longer leaks on failure paths.
- The runner's four terminal-failure paths each gained a finalizer call before their
  `throw`. A new failure path must remember it, and the reviewer's test is "does this
  terminal path label the run?".
- Label semantics now live in one unit-testable module rather than inline in a
  script, so the five behaviours (success, failure, DoD-refused, re-delivery,
  write-failure) are pinned by tests.
- Cost: the finalizer appends one extra `run.terminal` event per finalised run, and
  the marker `eventId` (`terminal-lifecycle:<runId>`) becomes part of the ledger's
  understood vocabulary.