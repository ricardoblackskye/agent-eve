# 0013 — Test data is seeded through the store seam

- Date: 2026-10-02
- Status: Accepted

## Context
Developers need comprehensive, re-runnable test data across every Dark Factory
store (runs, control, tenants, usage, cost) to exercise the dashboard and the
honesty invariants by hand. A seed that wrote raw SQL would bypass the very
invariants it exists to exercise — it could insert a measured zero where the
system means "unmeasured", or rewrite write-once attribution — and would have to
be reimplemented per driver.

## Decision
The seed (`scripts/seed-test-data.ts`) drives the **store/provider seam only**:
it calls `upsertTenant`/`assignRepo`, `acceptDelivery`/`appendEvent`, `record`,
`ensureBudget`/`reserve`, and `writeFactory`/`writeRun`/`appendEvent`. It is
**deterministic** — fixed ids and a fixed timestamp — so a re-run is an
idempotent no-op (delivery/event ids dedupe; usage and reservations are guarded
by a read before writing). Its `--reset` is a **table-level delete** guarded
fail-closed: it refuses when `NODE_ENV=production` or a preview/production
stage, and clears only the known Dark Factory tables.

## Consequences
- The seed behaves identically on sqlite and Postgres and cannot violate an
  invariant (unmeasured stays absent, attribution stays write-once).
- Reset is the one deliberate exception to "no raw SQL": it is a destructive
  admin operation the seam does not model, so it is contained, table-listed, and
  fail-closed.
- Adding a store means adding a scenario and a table list; the seam keeps the
  inserts honest.