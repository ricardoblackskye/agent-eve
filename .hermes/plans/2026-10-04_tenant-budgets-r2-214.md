# #214 — Dark Factory per-customer LLM budget enforcement (Epic #212, Release 2 of 3)

- Epic: [#212](https://github.com/ricardoblackskye/agent-eve/issues/212) — Customer Use Tracking
- Release issue: [#214](https://github.com/ricardoblackskye/agent-eve/issues/214) — **R2 of 3**
- Branch: `feat/df-tenant-budgets-212b`
- Delivery: **one release PR** closing #229, #230, #231, #218, #219 and #214 (plus #211 — see Leg 0).
  **#212 stays open**: R3 (#215, tenant-scoped customer access) still follows.

**Status (implemented):** all five legs + #211 are done, each RED→GREEN, plus ADRs 0014/0015.
Full suite **1721 passed / 23 skipped** (the 23 are the gated Postgres integration tests, now run in CI);
`tsc` clean; doc-drift + ADR-integrity guards green. Branch `feat/df-tenant-budgets-212b` pushed.

## Goal

Prevent a customer tenant from exceeding its configured monthly LLM-spend cap —
including when calls run concurrently — and make budget exhaustion,
store-unavailable and unpriced states visible to the operator.

## Architecture (what already exists — do not fork)

- `cost-budget.ts` — canonical types (`CostBudget{category,period,capUsd,spentUsd,callCount,reservedUsd?}`,
  `COST_CATEGORIES`), versioned price source (`modelPriceTable`/`resolvePrice`) and `estimateCost`.
- `cost-budget-store.ts` — the `CostBudgetStore` seam (`listBudgets`/`ensureBudget`/`reserve`/`settle`),
  `costBudgetId(period,category)`, fail-closed `ConsoleCostBudgetProvider`, in-memory + SQLite + Postgres adapters.
- `cost-governor.ts` — `createCostGovernor(store, env)`: `admit()` (price → ensure → reserve), `settle()`, `status()`;
  refusals `not_configured | unpriced_model | budget_exceeded | budget_unavailable`; `utcMonth()`.
- Enforcement seams: `agent/orchestrator-gate.ts` (#217 `defineDynamic` gate), `agent/lib/dark-factory/governed-llm-call.ts`
  (`runGovernedLlmCall`), `scripts/pr-reviewer-budget.ts`, `agent/lib/dark-factory/worker-cost-env.ts` (#218 contract).
- `tenant-store.ts` (#213) — the tenant registry: `resolveTenantForRepo`, `getTenant`, `listTenants`; tenants persist
  `tenant_id` immutably on runs/usage (migrations 004/005).
- Migrations `db/migrations/001…005` — RLS is already enabled on `df_cost_budgets`, `df_cost_reservations`,
  `df_usage_events`, `df_tenants`, `df_tenant_repos`.

## Legs (dependency order)

| Leg | Issue | Outcome                                                              | Proposed sub-branch (if split)          |
|-----|-------|----------------------------------------------------------------------|-----------------------------------------|
| 0   | #211  | RLS on the four `df_run_*` tables + source-controlled DB scripts     | `feat/df-run-rls-211`                   |
| 1   | #229  | Tenant-scoped budget model + store; concurrency proven               | `feat/df-tenant-budgets-212b1`          |
| 2   | #230  | Enforcement on orchestrator + PR-review; tenant-attributable refusal | `feat/df-tenant-budgets-212b2-surfaces` |
| 3   | #218  | Worker-side reserve/settle client (opt-in; adjudicated)              | `feat/df-tenant-budgets-212b3-worker`   |
| 4   | #231  | Per-tenant budget state in run outcome + operator UI                 | `feat/df-tenant-budgets-212b4-ui`       |
| 5   | #219  | Postgres integration coverage in CI                                  | `feat/df-tenant-budgets-212b5-pg-ci`    |

All legs land on the single release branch `feat/df-tenant-budgets-212b` as separate reviewable commits.

## Leg 0 — RLS on the run-history tables (#211)

**Finding:** the Supabase DB linter flagged `df_run_summaries`, `df_run_events`, `df_run_deliveries`,
`df_run_control_receipts` — RLS is enabled on the cost/usage/tenant tables but **not** these four.
The requested "database scripts folder" already exists as `db/migrations/`.

- **RED:** a guard test asserting every `df_*` table created by a migration also has
  `ALTER TABLE … ENABLE ROW LEVEL SECURITY` — it fails today for the four run-history tables.
- **GREEN:** `db/migrations/006_df_run_rls.sql` mirroring the 001/003 pattern; extend the existing
  migration/RLS guard.
- **Files:** `db/migrations/006_df_run_rls.sql`, `tests/dark-factory/migration-rls.test.ts` (or the existing
  migration test), `tests/fixtures` if a table list is pinned.

## Leg 1 — tenant-scoped budget model + store (#229)

- Extend `CostBudget` with a **tenant dimension**, sourced from the tenant registry (not a second config).
  Keep the existing fields; add `tenantId?: string` (absent = the global, non-tenant budget, so the
  existing Cost Budgets panel and its API keep working).
- `costBudgetId(period, category, tenantId?)` — the budget row key gains the tenant.
- `CostBudgetStore` gains **tenant-scoped** `ensureBudget`/`reserve`/`settle`/`listBudgets` overloads
  (additive; existing callers unchanged).
- **Migration:** add `tenant_id` to `df_cost_budgets` + `df_cost_reservations`, move the unique key to
  `(tenant_id, period, category)`, enable RLS, and keep the reserve path a genuine row-lock
  (`SELECT … FOR UPDATE`) so concurrent reservations serialize.
- **TDD (RED first, each on the real seam):**
  - concurrent reservations cannot exceed the tenant cap — **exact-boundary** (committed == cap trips) and
    **simultaneous** cases;
  - reservation + settlement are **idempotent** under duplicate delivery;
  - store outage / unknown tenant price / unbounded exposure → **refuse** (fail closed);
  - **unmeasured** actual leaves an explicit unresolved/conservative reservation — never zero, never released;
  - UTC monthly **rollover** at an explicit boundary.
- **Files:** `agent/lib/dark-factory/cost-budget.ts`, `cost-budget-store.ts`, `cost-budget-store-postgres.ts`,
  `cost-budget-store-sqlite.ts`, `db/migrations/007_df_cost_budgets_tenant.sql`, tests.

## Leg 2 — enforcement on orchestrator + PR-review (#230)

- Resolve the tenant **from the run's persisted `tenant_id`** (never re-derive from today's repo mapping).
- Orchestrator: wire the tenant-scoped store into the `agent/orchestrator-gate.ts` (`defineDynamic`) pre-call
  gate — the only genuine blocking hook (Eve's observe-only hooks cannot block).
- PR-review: wire the same store through `runGovernedLlmCall` / `scripts/pr-reviewer-budget.ts`.
- Surface the outcome on the run record: **cap-exhausted / store-unavailable / unpriced**, attributable per tenant.
- **TDD:** a call is not started when the cap is exhausted / the store is unavailable / a bounded estimate
  cannot be determined; a successful call settles exactly once; model fallback + retry are tested against the gate;
  the refusal reason is per-tenant distinguishable on the run outcome.
- **Files:** `agent/orchestrator-gate.ts`, `agent/lib/dark-factory/governed-llm-call.ts`,
  `scripts/pr-reviewer-budget.ts`, `agent/lib/dark-factory/run-history.ts` (outcome field), tests.

## Leg 3 — worker-side reserve/settle client (#218)

- A thin client that reserves before an LLM call and settles after, using the injected `worker-cost-env.ts`
  contract. It must **not** hold a database URL or credential: it adjudicates through the orchestrator
  (same shape as the credential broker), and fails closed when the adjudicator is unreachable.
- **TDD:** contract absent → the worker runs ungoverned exactly as today (opt-in preserved); contract present
  and refused → the LLM call is not made; no URL/token appears in the contract or client.
- **Files:** `agent/lib/dark-factory/worker-cost-env.ts`, a new worker-side client module, tests.
- ⚠️ **Open question (see Risks):** #218's acceptance criteria say "landing this requires R3 (the real worker)
  to exist first" — the worker is still a dry-run probe. Plan is to land the client + tests against a stub
  adjudicator and leave the real wiring to R3, **or** defer #218 to R3.

## Leg 4 — run outcome + operator UI (#231)

- Extend `app/dark-factory/ui/tenant-usage-panel.tsx` with per-tenant budget state: **cap, reserved, settled,
  remaining, unresolved** reservations.
- Render unmeasured/unpriced as an **em dash, never `0`**; show **store-unavailable** and **unpriced** as
  distinct states, not "no spend"; no prompt/completion text anywhere.
- **TDD:** per-tenant state visible; unmeasured → `—`; unavailable/unpriced distinguishable from no-spend;
  unresolved reservations visible.
- **Files:** `app/dark-factory/ui/tenant-usage-panel.tsx`, `use-tenant-usage.ts`, the tenants/cost-budget
  API routes as needed, `tests/dark-factory-ui/tenant-usage-panel.test.tsx`.

## Leg 5 — Postgres integration coverage in CI (#219)

- Stand up a disposable loopback Postgres (the repo's run-history test recipe) and run the gated
  `tests/dark-factory/cost-budget-store-postgres.test.ts`.
- Prove the **row-lock reserve path genuinely serializes** concurrent reservations under Postgres
  (the property SQLite/in-memory approximate but do not prove).
- Either wire it into CI, or document why it stays opt-in.
- **Files:** the Postgres test, a CI workflow step, `.env.example` if a var is added.

## ADRs (part of this release's Definition of Done)

- **ADR 0014 — tenant budgets are a dimension of the existing budget store** (#229): `tenantId` added as an
  OPTIONAL additive field on `CostBudget` and the store; a NEW `listTenantBudgets` keeps the global panel/API
  untouched.
- **ADR 0015 — an unprovisioned tenant is refused, never auto-provisioned** (#230): the governance seam refuses
  an unprovisioned customer with `tenant_unconfigured` rather than inventing a cap. (RLS on the run-history
  tables shipped as `db/migrations/006_df_rls_coverage.sql` in Leg 0 without a separate ADR.)
- Update `docs/adr/README.md` (an orphan ADR fails the drift guard).

## Validation

- `npx vitest run` — full suite green, no regressions; every leg's RED watched failing first.
- `npx tsc --noEmit --incremental false` — clean.
- `npm run build` — green.
- Local lint gate (cspell/tsc/prettier) incl. this plan and any `.sql`/migration files.
- Postgres leg actually executed against a disposable database (not skipped).
- Manual: seed a tenant budget (extend `scripts/seed-test-data.ts` if useful), then confirm the operator UI
  shows cap/reserved/settled/remaining and the refusal states.

## Risks / open questions

- **#218 vs R3.** Its own criteria say it needs the real worker (R3). Decide at plan review: land the client
  behind the opt-in contract now, or move #218 to R3. (Recommendation: land the client + tests, wire in R3.)
- **Interface churn.** The tenant dimension must be **additive** or the existing Cost Budgets panel/API and
  the #219 Postgres tests break. Prove with a regression test on the global (tenant-less) path.
- **Concurrency proof.** The in-memory/SQLite adapters can approximate the exact-boundary case but only
  Postgres proves the row lock — that is Leg 5's whole point.
- **RLS vs the service role.** Enabling RLS on the run-history tables must not break the app's own writes;
  confirm the connection role bypasses RLS (as the existing tables already rely on).
- **No prompts/completions** in any budget/usage record (the standing invariant).

## PR

One PR on `feat/df-tenant-budgets-212b` carrying `Closes #229 #230 #231 #218 #219 #214` (plus `Closes #211`
if Leg 0 is included). `#212` stays open for R3 (#215).