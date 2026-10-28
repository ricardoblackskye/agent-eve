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

The band is surfaced where the decision actually happens: the plan comment posted on the ticket before
approval ([`plan-comment.ts`](../../agent/lib/dark-factory/plan-comment.ts)) renders it directly under the
comment's marker as a `$low – $high` band with its cost class and confidence, and says in as many words that
the figure is advisory and does not block approval. The middle figure is deliberately NOT rendered — a single
number reads as a quote, and this is a forecast. A plan that was never priced renders **no section at all**:
the absence of a band is the only honest rendering of an absence, because a placeholder ("unknown", `$0`) reads
as a measurement and a reader cannot tell a placeholder from a real zero. The section's own cost is fixed — it
renders three short facts and never the plan — so it does not grow with the plan. The comment's TOTAL size is a
separate, pre-existing limit for a plan at the Architect's output budget, where the body carries the plan twice
(the rendering plus the machine-readable block); that is tracked in #518 rather than fixed here.

## The reservation price has a floor

The reserved price is the higher of the shipped ceiling and a floor of the dearest rate we have
actually verified ([`model-price-floor.ts`](../../agent/lib/dark-factory/model-price-floor.ts)). The
ceiling is hand-maintained and fell behind reality — the dearest output rate for the default model
climbed by a factor of 3.8 in a single day while the table held its old value — so a constant that
nobody re-derived could under-reserve every call, and the breach only surfaced at settle.

The floor can only ever raise the reserved number. It is inert while the table carries headroom, and
protective the moment the table falls behind, which is the direction that costs money. An operator
who knows the provider in use can still override it exactly, because pinning a cheaper provider is a
legitimate deliberate act; the floor guards the shared table, not that.

The observation has one home, the generated
[`model-price-floor-data.ts`](../../agent/lib/dark-factory/model-price-floor-data.ts), which the
reservation reads and the guard checks. `npm run prices:check -- --write` refreshes it and
**refuses** while any ceiling sits below the observed rate, so correcting the number and recording
the reading are one act rather than two that can drift apart. The live comparison itself runs on a
schedule, not in the unit suite: a unit test asserting our constant against the provider's changing
number goes red for reasons no pull request can fix. Staleness is reported as a warning rather than
halting runs, and a commit-time guard fails the build if a shipped ceiling drops below the recorded
rate. See ADR 0071.

## Persisted plans and estimates

An advisory estimate is only useful if it can be compared with what the run actually cost, and that
comparison has to be answerable in SQL rather than by parsing application output. The plan ledger
([`plan-ledger.ts`](../../agent/lib/dark-factory/plan-ledger.ts)) stores two things, deliberately
apart:

- **`df_plans`** — one row per plan *revision*. A run can produce several: an amendment re-plans from
  human review feedback, so `UNIQUE (run_id, plan_revision)` makes a re-plan explicit instead of
  silently overwriting the earlier band.
- **`df_plan_estimates`** — one row per priced plan. The band, cost class, confidence, revision
  factor, token counts and file counts are **typed columns**, so grouping by cost class or period is
  a plain aggregate. The open-ended feature vector stays JSON, so the estimator can grow it without a
  migration.

Three details are load-bearing:

1. **`estimator_version`** is stamped on every row. When the band multipliers are tuned, older rows
   were produced by a different model; without the stamp a bias analysis would average the two
   together and the resulting correction would be meaningless.
2. **Absent is not zero.** A plan that was never priced has no estimate row at all — never a
   zero-filled one, which would read as "priced at nothing" and poison the variance maths.
3. **No prose is stored.** The plan is the structured `ExecutionPlan`; `comment_ref` points at the
   GitHub comment that holds the human-readable text. Issue bodies and prompts are never persisted
   here, the same rule the run ledger enforces.

The rollup itself is a view:

```sql
SELECT period, cost_class, estimator_version,
       expected_usd, actual_usd, signed_error_usd
FROM   df_plan_estimate_accuracy;
```

The error is **signed** on purpose: a forecast that came in under the actual cost is the bias worth
correcting, and an absolute error would hide its direction.

Both tables are created by the adapters' runtime DDL on first use, so no manual step is needed to
bring them into existence. Row-level security is **not** runtime DDL, however: it is applied by
[`010_df_plan_ledger_rls.sql`](../../db/migrations/010_df_plan_ledger_rls.sql), which must be run
against the database. An estimate row carries per-run and per-tenant cost figures, so an
anon-readable row would leak commercial pricing about a customer's work.

The estimate is written by the **architect flow**, and the order there is deliberate:
[`plan-estimate-recorder.ts`](../../agent/lib/dark-factory/plan-estimate-recorder.ts) persists the plan
row after the plan comment is posted and before the run parks for approval. The comment comes first
because the plan row carries the comment's id and the ledger is write-once, so recording before the
post would leave `comment_ref` permanently null; the persistence still lands before the park, so the
numbers are durable before a human is told the plan is ready to review. Only a NEW plan is recorded — a
fresh dispatch or a revision round. A plain resume reuses the plan recorded when it was first posted,
so it records nothing, and the write-once constraint refuses a duplicate revision as the second line of
defence. Recording is best-effort throughout: the estimate is an observation about a run rather than a
control over it, so a ledger outage is logged and the run proceeds, which is the opposite posture to the
plan revision cap that fails closed.

## Status relative to #214

The customer-use tracking epic (#214) — tenant usage aggregation (R2) and the
billing/settle legs (R3) — is the source of truth for *how* multi-tenant cost is
rolled up and charged. This page describes the shape the factory already enforces;
the #214 legs extend the ledger with tenant-scoped aggregation and the settle
workflow. Track #214 / #215 for that work rather than assuming it is implemented
here.
