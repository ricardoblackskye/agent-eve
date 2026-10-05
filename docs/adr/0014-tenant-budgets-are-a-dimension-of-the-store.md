# 0014 — Tenant budgets are a dimension of the existing budget store

- Date: 2026-10-04
- Status: Accepted

## Context
R2 (#214) needs per-customer LLM budgets without standing up a second accounting
system. The global budget store already models a hard cap per (period, category)
with a reserve → settle flow that makes the cap enforceable. A tenant budget is
the same contract, scoped to one customer.

## Decision
Add `tenantId` as an OPTIONAL, additive dimension to `CostBudget` and to the
store's `ensureBudget` / `reserve` / `settle`. The tenant's budget is
discriminated by `costBudgetId(period, category, tenantId)` —
`tenant:<id>|period|category` — so a global row and a tenant row never collide, and
the reservation's tenant is derived from its budget row (no second column or index
is needed). The GLOBAL read path (`listBudgets`) is unchanged; a NEW method
`listTenantBudgets(tenantId, period?)` is added so the existing global Cost Budgets
panel and its tests remain byte-for-byte untouched (proved by the no-regression
test).

## Consequences
- One accounting system covers global and per-tenant budgets; enforcement,
  reporting, and the schema migration are shared.
- The global panel/API and the #219 Postgres integration tests are unchanged.
- A tenant budget and the global budget are independent caps, surfaced separately.
