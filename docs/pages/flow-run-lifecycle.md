# End-to-end run lifecycle

This page follows **one Dark Factory run** from the moment a trigger is accepted
to its terminal outcome. It is the narrative companion to the mechanic catalog in
[`dark-factory.md`](dark-factory.md) and the operation notes in
[`dark-factory-operations.md`](dark-factory-operations.md). Read those for the
per-file detail; read this to see how the pieces hand off.

## 1. Acceptance

A run begins with a **trigger** — a GitHub webhook (issue opened, PR updated,
review requested) delivered to the API proxy and routed by
[`agent/lib/dark-factory/trigger.ts`](../../agent/lib/dark-factory/trigger.ts).
The trigger is normalised into a canonical event; the factory refuses anything it
cannot map rather than guessing. Acceptance also runs the work through the
[definition of done](../../agent/lib/dark-factory/definition-of-done.ts) and the
plan validator before any worker is touched — a run that cannot be accepted is
rejected early, which keeps the worker boundary clean
([ADR 0002](../../docs/adr/0002-r1-records-r2-refuses.md): R1 records and reports;
R2 refuses).

## 2. Attribution

Before dispatch, the run is **attributed** exactly once to the tenant that owns
it ([`run-attribution.ts`](../../agent/lib/dark-factory/run-attribution.ts)).
Attribution is write-once by design — see
[ADR 0001](../../docs/adr/0001-tenant-attribution-is-write-once.md) — so a later
replay can never re-credit or re-blame a tenant. The identity used for
deduplication is the GitHub delivery ID; the opaque run ID identifies the
execution; the event ID identifies each lifecycle transition
([`run-history.ts`](../../agent/lib/dark-factory/run-history.ts)).

## 3. Dispatch

[`dispatch.ts`](../../agent/lib/dark-factory/dispatch.ts) reads the run's control
state first. Any existing in-flight or terminal record means the delivery is a
duplicate, so the handler is never invoked twice and a re-delivered webhook cannot
double-dispatch work. State is written through the state seam
(`pending` → `retrying` → `succeeded`/`failed`) so retries survive a process
restart. Retry is a pure function, `nextRetry`, which returns the next attempt and
its exponential backoff or `null` once the budget is exhausted. The full route
inventory is generated from `app/api/**/route.ts` — see
[`app/documentation/reference/generators.ts`](../../app/documentation/reference/generators.ts).

## 4. Worker

A dispatched CI event becomes a worker run via
[`worker-env.ts`](../../agent/lib/dark-factory/worker-env.ts). `withWorker` owns
the lifecycle: it refuses a repo outside `DF_WORKER_ALLOWED_REPOS` **before**
provisioning, pushes the skeletal file map and PBI data, executes the task (the
Developer/Tester agent), then tears the environment down on every path — success,
thrown error, or failed context push — revoking the credential lease alongside it.
What the worker may and may not hold is its own page:
[worker sandbox and credential boundary](flow-worker-sandbox.md).

## 5. Self-correction

A CI failure does not end the run. `dispatch` re-dispatches within the retry
budget, and the cross-task
[circuit breaker](../../agent/lib/dark-factory/circuit-breaker.ts) caps how much a
single PBI may cost before a human is pulled in. A tripped PBI stays halted, so no
further minutes are counted. Self-correction is bounded, not infinite.

## 6. Outcome

When the loop settles, the terminal outcome is recorded in
[run history](../../agent/lib/dark-factory/run-history.ts) (SQLite locally,
PostgreSQL in deployed runtimes —
[ADR 0005](../../docs/adr/0005-sqlite-is-local-only.md)), the
[definition of done](../../agent/lib/dark-factory/dod-presentation.ts) is
computed, and a PR is opened by
[`pr-writer.ts`](../../agent/lib/dark-factory/pr-writer.ts) when the work passes.
The control plane's **gated outcomes** sit between "the loop settled" and "the PR
ships" — see [control plane and gates](flow-control-plane.md).

> A developer new to the repo should be able to trace a run through these six
> steps using only this page and its links. If a step is unclear, that is a docs
> bug, not a code bug.
