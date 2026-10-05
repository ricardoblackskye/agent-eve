# 0015 — An unprovisioned tenant is refused, never auto-provisioned

- Date: 2026-10-04
- Status: Accepted

## Context
A customer's LLM cap must come from the operator (sourced from the tenant registry
/ finance), not be invented at call time. The GLOBAL budget is materialized from
env caps (`DF_COST_BUDGET_*_USD`) because there is no other source for a global
ceiling. A tenant has no such default.

## Decision
The governance seam distinguishes the two paths. For the GLOBAL path it ensures the
budget from the env caps exactly as before. For a TENANT path it does NOT
auto-create a budget: `CostGovernor.admit` reads `listTenantBudgets(tenantId,
period)` and refuses with a distinct `tenant_unconfigured` reason when no row
exists, and with `budget_unavailable` when the store is unreadable. The refusal
names the tenant, so it is attributable rather than a generic error (see #230). An
unprovisioned customer therefore fails CLOSED — never silently admitted against an
invented cap.

## Consequences
- A missing tenant cap cannot fail open.
- Operators provision tenant budgets explicitly (API / seed); an auto-provisioned
  cap is impossible, which is the desired posture for customer billing.
- The refusal reason is surfaced distinctly in the operator UI and in run outcomes.
