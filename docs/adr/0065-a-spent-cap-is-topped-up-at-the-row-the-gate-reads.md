# 0065 — A spent cap is topped up at the row the gate reads

- **Date:** 2026-10-26
- **Status:** Accepted

## Context

Issue #478 surfaced the failure mode: the orchestrator budget row read
`cap_usd: 30, spent_usd: 29.60, reserved_usd: 0, call_count: 49` — genuinely spent, with no
stranded reservations — so `admit()` refused every gated eval with `budget_exceeded` and the
`smoke` / `auth-valid` gates went red. Diagnosing it exposed a gap in the control surface.

The ceiling the gate enforces is the budget **row** (`df_cost_budgets.cap_usd`); the
`DF_COST_BUDGET_*_USD` env var only **seeds** that row the first time it is created
(`ensureBudget` is `ON CONFLICT DO NOTHING`). So editing the env var on a running deployment
does not move the ceiling, and an operator who has spent a period had no supported way to
raise it — only hand-written SQL against the database.

## Decision

Cap management is a **store write**, exposed as an operator CLI.

- `CostBudgetStore.setBudgetCap(period, category, capUsd, tenantId?)` — an upsert that
  changes `cap_usd` and **preserves** `spent_usd` / `reserved_usd` / `call_count`, so the
  period's accounting survives. Unknown category, or a negative / non-finite cap, is refused
  (a blocked result) rather than written. Implemented by all four providers; the `console`
  provider stays fail-closed like its siblings.
- `npm run df:cost-budget` (`show` / `set` / `add`) is built on it. The driver comes from
  `DF_COST_BUDGET_DRIVER`, so one command drives local SQLite or the deployed Postgres.
- Deliberately **not** `ensureBudget` (create-if-absent, never updates) and **not** an env
  change: the row is the truth, the env var is the seed.
- Deliberately **no** `spent_usd` reset. A top-up raises the ceiling; zeroing spend would
  erase the period's accounting and let it exceed the ceiling the operator actually intends.

## Consequences

- An operator has a supported, provider-neutral path to restore headroom, and the reason a
  config change appears not to work is now documented rather than rediscovered.
- `spent_usd` / `call_count` survive a top-up, so the audit trail for the period stays intact.
- `add` is a read-modify-write and is not atomic across concurrent writers; that is acceptable
  for a single-operator, manual command, and it is stated in the CLI usage.
- This does **not** settle the design question #478 raised — that eval traffic shares one
  global budget with production traffic, so a busy month can still starve the gate. That
  remains open on #478.
