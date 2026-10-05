# 0017 — Tenant scope is derived server-side and enforced at the route

- Date: 2026-10-05
- Status: Accepted

## Context
Several Dark Factory routes already accept a caller-supplied filter — `?tenant=`
on the usage ledger, `?repo=` on the run list. Once customers share the
dashboard, such a parameter is a request to *widen* the view, and a filter that is
trusted becomes an access-control hole: a customer could pass another tenant's id
and read their usage, runs or budgets.

## Decision
Scope is derived from the resolved membership and enforced in the route, never
from a query parameter. A customer is pinned to their own tenant: a supplied
`tenant` filter is ignored for them and applied only for an operator, who is
unscoped by design. Surfaces that span tenants — the tenant registry, the global
budget ledger, factory control and the LLM policy — are operator-only and refuse a
customer with 403. A run outside the caller's scope is reported as 404, so a
response never confirms that another tenant's run exists.

## Consequences
- A caller-supplied identifier can narrow an operator's view but can never widen a
  customer's.
- Enforcement lives in one seam (`guardViewer` / `guardOperator`) rather than being
  re-derived per route.
- New Dark Factory routes must use the guard; the raw session check is no longer
  sufficient to authorise a read.