# Test data creation (#250)

**Branch:** `feat/seed-test-data-250` (off `origin/main`)
**Issue:** #250 (Epic)
**ADR:** 0013 — test data is seeded through the store seam, deterministically, with a fail-closed reset

## Goal
A re-runnable, deterministic, scenario-based seed tool that populates **all** Dark Factory stores with comprehensive test data for local/dev and the Supabase **test** project, plus a **fail-closed `--reset`**. It must respect every store invariant: unmeasured is absent (never zero), attribution is write-once, and tenant ids are opaque.

## Current state (verified)
- No comprehensive seed exists. Only `scripts/seed-tenant-assignments.ts` seeds tenants+repos — the reference pattern: store-layer, idempotent, explicit args, dry-run, structured report, unit-tested.
- ~13 tables across 5 store seams, all reachable through the provider layer (driver-selected):
  - run-history: `df_run_summaries`, `df_run_events`, `df_run_deliveries`, `df_run_control_receipts`
  - control: `df_factory_control`, `df_run_control`, `df_control_events`
  - tenants: `df_tenants`, `df_tenant_repos`
  - usage: `df_usage_events`
  - cost: `df_cost_budgets`, `df_cost_reservations`
- Seeding APIs: `upsertTenant`/`assignRepo`; `record`; `ensureBudget`/`reserve`/`settle`; `acceptDelivery`/`appendEvent`; `writeFactory`/`writeRun`/`appendEvent`.

## Intended fix
`scripts/seed-test-data.ts` — a CLI that:
- selects scenarios: `--scenario=<name>` (repeatable) or `--all`; `--dry-run`; `--reset` (fail-closed).
- drives the **store/provider layer only** (no raw SQL for inserts) so it behaves identically on sqlite and postgres and cannot violate a store invariant.
- is **deterministic** (fixed ids + fixed timestamps) and therefore **idempotent** — re-running is a no-op that reports what it found.

Scenario registry (each a coherent dataset):
- `happy-path` — one tenant, a repo assignment, several completed runs with events, measured usage, budgets within cap.
- `multi-tenant` — three tenants, distinct repos, cross-tenant usage/attribution.
- `unassigned` — runs + usage with NULL tenant (the genuine unassigned bucket).
- `unmeasured` — usage events with NULL tokens/cost/duration (the "unmeasured is never zero" rule).
- `over-budget` — budgets at/over cap with open reservations.
- `mixed-status` — runs across every status for the trend/reporting views.
- `control` — factory paused, a run paused/stopped, plus control events.
- `empty` — no rows (empty-state testing).

Reset: `--reset` clears **only** the Dark Factory test tables, refuses when `NODE_ENV=production` (fail-closed), and reports what it cleared. Mechanism decided in RED (a seam-clean optional `clear()` vs a contained, table-listed delete); either way it is guarded and never touches a non-test table.

## Tasks (TDD)
- RED: `tests/dark-factory/seed-test-data.test.ts` — arg parsing (scenario selection, unknown scenario, `--reset` refused under `NODE_ENV=production`), and each scenario applied to an in-memory/sqlite store then asserted through the store **read** APIs (tenant/repo counts, unassigned bucket non-zero, unmeasured count, over-cap reservation, run statuses, control state). A Postgres integration test gated by `DF_*_TEST_DATABASE_URL`.
- GREEN: implement `scripts/seed-test-data.ts` until green.
- REFACTOR: keep scenarios as small pure builders over the seams.

## Files likely to change
- `scripts/seed-test-data.ts` (new)
- `tests/dark-factory/seed-test-data.test.ts` (new)
- `package.json` (`seed:test-data` script)
- `README.md` (usage + env prereqs)
- `docs/adr/0013-test-data-is-seeded-through-the-store-seam.md` (new) + `docs/adr/README.md` (index row)

## Validation
- `npx vitest run tests/dark-factory/seed-test-data.test.ts`, then the full suite (no regressions).
- `npx tsc --noEmit --incremental false` clean.
- `npx cspell@9` on changed files (add words to `.cspell.json`, never weaken).
- `npm run build` green.
- Local MegaLinter parity (cspell; markdownlint for the ADR/README).
- Postgres integration gated on `DF_*_TEST_DATABASE_URL` (runs once the Supabase test project exists).

## Risks / open questions
- **Per-store idempotency:** verify each write's duplicate semantics (`acceptDelivery` exposes `duplicate`; confirm `record`/`appendEvent`/`ensureBudget` are safe on re-run).
- **Reset mechanism:** seam-clean `clear()` vs contained raw delete; both fail-closed.
- **Deterministic dates:** fixed timestamps keep re-runs stable but pin trend views to a fixed window — acceptable for test data; document it.
- **Credentials:** the Postgres path needs the test project URL; until then it runs on sqlite.
- **Scope:** the issue is labelled Epic but has no phases; delivered as one release per the user's decision.