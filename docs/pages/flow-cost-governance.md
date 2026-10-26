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

## Managing a spent cap

The ceiling the gate enforces is the budget **row** (`df_cost_budgets.cap_usd`), not the
`DF_COST_BUDGET_*_USD` env var: the env only **seeds** a row when it is first created, so
changing it on a running deployment does not move an existing ceiling. When a period is spent
— the gate refuses with `budget_exceeded` — raise the ceiling at the row:

```bash
npm run df:cost-budget -- show                                   # the global rows for the period
npm run df:cost-budget -- add --category orchestrator --amount 50 # top up by $50
npm run df:cost-budget -- set --category orchestrator --cap 100   # or set an absolute ceiling
```

The driver comes from `DF_COST_BUDGET_DRIVER`, so the same command drives local SQLite or the
deployed Postgres (`DF_COST_BUDGET_DATABASE_URL`). A top-up changes `cap_usd` only and
**preserves** `spent_usd` / `reserved_usd` / `call_count`, so the period's accounting survives
([ADR 0065](../../docs/adr/0065-a-spent-cap-is-topped-up-at-the-row-the-gate-reads.md)).

The command is [`df-cost-budget.ts`](../../scripts/df-cost-budget.ts); the decisions it makes
live in [`cost-budget-admin.ts`](../../agent/lib/dark-factory/cost-budget-admin.ts), and the
write itself is `setBudgetCap` on
[`cost-budget-store.ts`](../../agent/lib/dark-factory/cost-budget-store.ts).

## Honest measurement

An unmeasured value is **never** reported as zero
([ADR 0003](../../docs/adr/0003-unmeasured-is-never-zero.md)). Absent latency or
cost stays absent; an explicitly measured zero is preserved. The UI renders `—`
rather than `0` so an operator never mistakes "we didn't measure it" for "it cost
nothing".

## Advisory plan estimates

[`plan-cost-estimate.ts`](../../agent/lib/dark-factory/plan-cost-estimate.ts)
answers a different question from the gate above: not "may this call proceed",
but "what is this plan likely to cost". It returns a **band with a cost class
and a confidence label**, never a single number, because run-to-run variance for
the same task is large enough that a point estimate would imply precision we do
not have ([ADR 0069](../../docs/adr/0069-plan-cost-estimates-are-advisory-bands.md)).

It is **advisory only**: it never blocks, refuses or gates anything, and the hard
ceilings above are unaffected. Prices come from the same `resolvePrice` the
governor reserves against, so a plan estimate cannot disagree with a reservation,
and an unknown model is costed at the dearest known rate rather than at zero —
understating would make an expensive run look free.

The model is input-token-centric: it counts the files a run must read, bounded
exactly as the Architect's bounded reader bounds them, and reuses the runner's
`chars/4` token convention so estimator and governor count the same way. A cold
start — no prior runs — still produces a band, marked low confidence. Calibrating
the band against measured actual cost is tracked separately (#490).

## Status relative to #214

The customer-use tracking epic (#214) — tenant usage aggregation (R2) and the
billing/settle legs (R3) — is the source of truth for *how* multi-tenant cost is
rolled up and charged. This page describes the shape the factory already enforces;
the #214 legs extend the ledger with tenant-scoped aggregation and the settle
workflow. Track #214 / #215 for that work rather than assuming it is implemented
here.
