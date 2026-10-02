# Glossary

The private vocabulary of the Agent Eve Dark Factory. These terms cannot be
derived from code alone — they are the shared language used across the
documentation, the ADRs, and the codebase. If a term you meet in the docs is not
here, that is a documentation bug.

## Terms

### Dark Factory
The subsystem that turns Eve from a stateless agent (input → output) into the
manager of a delivery loop: it remembers what it is working on, dispatches CI
failures back to a worker, and records the metrics that drive recursive
self-improvement. See [Dark Factory (R1)](dark-factory.md) and
[Dark Factory operations](dark-factory-operations.md).

### PBI
Product Backlog Item — the unit of work the factory picks up (an issue or story).
A PBI is what a run is trying to resolve; the circuit breaker caps how much a
single PBI may cost.

### Tenant
The customer/organization that owns a run. Attribution to a tenant is
[write-once](../../docs/adr/0001-tenant-attribution-is-write-once.md); the tenant
registry is owned by the factory while CRM-style customer data is a bought system
([ADR 0008](../../docs/adr/0008-tenant-registry-is-ours-crm-is-bought.md)).

### Run
One execution of the factory for a trigger — from acceptance to a terminal
outcome. Identified by an opaque run ID, deduplicated by the GitHub delivery ID,
and tracked through lifecycle event IDs. Walked end to end in
[Dark Factory (R1)](dark-factory.md).

### Dispatch
The act of handing a CI failure (or a queued task) to the worker loop, including
deduplication, retry, and terminal-state transition. See
[`dispatch.ts`](../../agent/lib/dark-factory/dispatch.ts) and
[Dark Factory (R1)](dark-factory.md).

### Control plane
The layer that decides whether a run's outcome is allowed to proceed (open the PR,
publish the story). Separate from the worker (which only executes) and from run
history (which only records). See the control-state seam
See the control-state seam ([`control.ts`](../../agent/lib/dark-factory/control.ts)).

### Seam
A canonical payload + provider interface that a vendor/adapter plugs into
([ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)). Every Dark Factory
capability (state, dispatch, metrics, control, tenant, usage) is a seam so any
Vercel/provider bit can be swapped in config.

### Adapter
A concrete implementation of a seam for a specific driver — `sqlite`, `postgres`,
or an in-memory `console`. Selected at runtime by `DF_*_DRIVER`.

### Driver
The configuration value (`DF_*_DRIVER`) that selects an adapter. An unset or
unknown driver fails closed, refusing, rather than silently degrading.

### Gate
A control decision that must be explicitly allowed before a run's effect leaves
the factory (e.g. a published story). Gating is never the worker's job. See
[gated outcomes](#gated-outcome).

### Gated outcome
A run result that the control plane must permit before it is released. Story
publish is the canonical example and is fail-closed behind
[`STORY_ALLOWED_REPOS`](../../docs/adr/0004-story-publish-is-fail-closed.md).

### R1 / R2 / R3
The Dark Factory's delivery releases. R1 ships the three foundation seams
(state, dispatch, metrics) with no workers. R2 gives the factory hands (worker
sandbox + credential broker) but refuses to run anything it is not configured for
([ADR 0002](../../docs/adr/0002-r1-records-r2-refuses.md)). R3 adds the circuit
breaker / cost guard.

### Attribution
The write-once recording of which tenant owns a run
([`run-attribution.ts`](../../agent/lib/dark-factory/run-attribution.ts),
[ADR 0001](../../docs/adr/0001-tenant-attribution-is-write-once.md)).

### Worker
The sandbox that executes a task (the Developer/Tester agent). It may hold only an
opaque credential lease, never the operator's token
([`worker-env.ts`](../../agent/lib/dark-factory/worker-env.ts)).

### Circuit breaker
The cross-task guard that trips a PBI once it crosses a cost or failed-cycle
threshold, halting further work
([`circuit-breaker.ts`](../../agent/lib/dark-factory/circuit-breaker.ts)).

### Lease
The opaque, TTL-bounded credential the broker issues to a worker — a repo
allow-list plus a short lifetime. Issuance is deliberately not routable, so a
sandbox can never mint its own credential
([`credentials.ts`](../../agent/lib/dark-factory/credentials.ts)).

### Optimistic concurrency
Control actions carry the expected prior state of a run; adapters reject a write
whose prior state does not match, so two concurrent decisions cannot both win a
transition ([`control.ts`](../../agent/lib/dark-factory/control.ts)).

### Delivery ID / Run ID / Event ID
The three identities the ledger keeps distinct: the GitHub delivery ID
(deduplicates redelivery), the opaque run ID (identifies the execution), and the
stable event ID (identifies each lifecycle transition)
([`run-history.ts`](../../agent/lib/dark-factory/run-history.ts)).

### Fail-closed
The default posture: when configuration is missing or ambiguous, refuse rather
than allow. Every seam, gate, and control decision defaults to fail-closed.

### Dry-run
A non-destructive execution mode (e.g. the default `console` provider, or a
dry-run worker) that reports what would happen without performing the side effect.

### Console provider
The in-memory default adapter for a seam; it refuses rather than persisting, so an
unconfigured deployment fails closed instead of silently claiming success.
