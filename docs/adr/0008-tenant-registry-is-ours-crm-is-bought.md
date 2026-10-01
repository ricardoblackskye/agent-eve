# 0008 — The tenant registry is ours; the CRM is bought

- **Date:** 2026-10-01
- **Status:** Accepted

## Context

Moving to multiple customers raised the question of how to manage clients
overall — build a CRM or buy one. "Client management" was being treated as a
single problem, which made both options look more expensive than they are.

## Decision

Split it into three layers with different owners:

- **Tenant registry** — tenant id, status, repository-to-tenant mapping,
  memberships, budget caps. **We build it.**
- **Commercial / relationship** — contacts, contracts, renewals, invoicing,
  support threads. **We buy it**, or use a spreadsheet.
- **The seam** — one-way sync, CRM to registry, keyed on a stable id.
  **We build it thin, and later.**

## Consequences

- We do not build a CRM, and we do not let CRM concerns shape the registry schema.
- Budget caps and memberships live in the registry, so every customer-facing
  release builds against it rather than inventing its own source of truth.
- The seam is deliberately deferred: until a real CRM exists, hand-maintaining the
  registry is cheaper than an integration. The stable id exists from day one so
  the seam can be added without a migration.
