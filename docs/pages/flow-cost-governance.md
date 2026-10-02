# Cost and usage governance

The recursive self-improvement loop is only safe if something stops it from
spending without bound. This page covers the **policy, ledger, budgets, and
reserve/settle** machinery. The tenant-attribution half of "who pays" is a
separate page: [tenant attribution and reporting](flow-tenant-attribution.md).

## Opt-in by default

Cost governance is **opt-in**. An unset driver means in-memory only — the factory
does not record or bill anything it was not explicitly told to. This is the same
fail-closed posture as the rest of the control plane
([ADR 0007](../../docs/adr/0007-control-state-is-db-backed.md)): absence of
configuration is never silently interpreted as "track everything".

## The circuit breaker is the hard ceiling

[`circuit-breaker.ts`](../../agent/lib/dark-factory/circuit-breaker.ts) tracks,
per PBI, cumulative worker-minutes and failed self-correct cycles, and trips on
either of two independent thresholds (`DF_MAX_WORKER_MINUTES_PER_PBI`,
`DF_MAX_FAILED_SELFCORRECT`). A tripped PBI stays halted so no further minutes are
counted. The breaker is independent of and additive to the per-task retry/iteration
bounds — it reads the same worker-activity stream but never mutates agent-internal
state.

## The ledger and budgets

[`usage-ledger.ts`](../../agent/lib/dark-factory/usage-ledger.ts) records metered
usage; [`cost-governor.ts`](../../agent/lib/dark-factory/cost-governor.ts) enforces
budgets, and the budget surface is exposed through
[`app/api/dark-factory/cost-budgets/route.ts`](../../app/api/dark-factory/cost-budgets/route.ts)
and the
[`cost-budgets-panel.tsx`](../../app/dark-factory/ui/cost-budgets-panel.tsx) UI.
Reserve/settle semantics live behind the provider seam
([ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)); the storage driver is
chosen by `DF_*` env, never hardcoded to a vendor.

## Honest measurement

An unmeasured value is **never** reported as zero
([ADR 0003](../../docs/adr/0003-unmeasured-is-never-zero.md)). Absent latency or
cost stays absent; an explicitly measured zero is preserved. The UI renders `—`
rather than `0` so an operator never mistakes "we didn't measure it" for "it cost
nothing".

## Status relative to #214

The customer-use tracking epic (#214) — tenant usage aggregation (R2) and the
billing/settle legs (R3) — is the source of truth for *how* multi-tenant cost is
rolled up and charged. This page describes the shape the factory already enforces;
the #214 legs extend the ledger with tenant-scoped aggregation and the settle
workflow. Track #214 / #215 for that work rather than assuming it is implemented
here.
