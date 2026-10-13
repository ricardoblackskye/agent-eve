# Plan — #332: make the Postgres test suites hermetic

**Branch:** `test/df-pg-hermetic-332`
**Issue:** [#332](https://github.com/ricardoblackskye/agent-eve/issues/332) — labels `ci`, `dark-factory`.

## Current state (verified)

Five Postgres-backed suites, each with its own DSN env var and each gated by `describeWithDatabase`
(absent DSN → skipped, which is why CI-less runs report a block of skips):

| suite                                | DSN (pattern)                      |
| ------------------------------------ | ---------------------------------- |
| `run-history-postgres.test.ts`       | `DF_RUN_HISTORY_TEST_DATABASE_URL` |
| `usage-store-postgres.test.ts`       | `DF_USAGE_TEST_DATABASE_URL`       |
| `cost-budget-store-postgres.test.ts` | `DF_COST_BUDGET_TEST_DATABASE_URL` |
| `tenant-store-postgres.test.ts`      | `DF_TENANT_TEST_DATABASE_URL`      |
| `control-postgres.test.ts`           | `DF_CONTROL_TEST_DATABASE_URL`     |

**Nothing truncates, anywhere.** The suites share one database and accumulate rows across runs. CI is
unaffected (a fresh `postgres:16-alpine` container per run), so the flake is visible **only** on a
developer's machine — which is exactly the surface we want the change provable on.

Observed twice with **no code change between runs**: #328 (`aggregates status counts, terminal trend,
and measured sums`) and #329 (`1 failed | 34 passed` → `35 passed`). Also hit during #335.

## Root cause, precisely

Aggregate-style assertions count rows across a whole table, so they are sensitive to anything left
behind. Several suites already work around this by using run-scoped ids their rows per run (added in #328), but
that only protects tests that filter by their own namespace — it cannot protect a test that asserts a
table-wide aggregate or an order-dependent walk. Namespacing is a workaround for one symptom; the
shared, never-reset state is the condition.

## Tasks (RED → GREEN) — ALL DONE

**T1 (RED) — hermetic-start guard.** `pg-test-helpers.ts` ships `pgRowCounts` + a `beforeAll` reset in
every suite. The guard `it("starts from its own empty tables (#332)")` in run-history **RED-failed
measurably**: `expected { df_run_summaries: 222, df_run_events: 326, df_run_deliveries: 222 } to deeply
equal { …0 }` against the shared fixture (it had 222/326/222 accumulated rows at the time).

**T2 (GREEN) — reset each suite's own tables.** New `tests/dark-factory/pg-test-helpers.ts` with
`PG_TABLES` (per-suite ownership) and `resetPgTables` (`TRUNCATE … RESTART IDENTITY CASCADE`, then a
self-verifying re-count that throws if anything remains). Wired into all five suites:
`runHistory`, `usage`, `costBudget`, `tenants`, `control`. No production code, no cross-suite tables.

**T3 — proven twice back-to-back.** With `DF_*_TEST_DATABASE_URL` pointed at the local
`df-run-history-pg-test` container, all five suites pass **26/26 on RUN 1 and 26/26 on RUN 2**
immediately after, with no code change between. `tsc -p tsconfig.json --noEmit` is clean.

**T4 — non-vacuity.** `it("reset actually clears pre-existing rows (non-vacuity #332)")` creates a real
run via the store, asserts the table is NOT empty (`>= 1`), then asserts `resetPgTables` brings it back
to 0. The guard is therefore proven to fail on dirtiness, not merely pass on emptiness.

> Note: each run truncates at `beforeAll` (start-clean), so the fixture is left dirty *after* a run but is
> emptied again at the next run's start — that start-clean invariant is what removes the flake. Truncate is
> scoped per suite's own tables; no whole-schema reset, so adjacent suites cannot be affected.

## Constraints

- **Scope each truncate to the tables a suite owns.** Never a whole-schema reset, and never another
  suite's tables: the suites own distinct tables, so owning-your-own is sufficient and cannot break a
  adjacent suite.
- **Do not weaken any assertion** to make the flake go away. The fix is isolation, not tolerance.
- **Keep the DSN-gated skipping.** An unset DSN must still skip cleanly, not fail.
- **No CI changes.** CI is already green; this is a local-harness fix.

## Files (expected)

- `tests/dark-factory/pg-test-helpers.ts` (new, or an extension of the existing `describeWithDatabase` helper)
- the five `*-postgres.test.ts` suites (declare owned tables)
- no production code

## Verification

Postgres suites green **twice in a row** locally (T3) · the hermetic-start guard (T1) · stray-row
non-vacuity (T4) · full suite · `tsc` · cspell · Prettier.

## Out of scope

Any CI workflow change. Root-causing individual test assertions that are merely order-dependent —
isolation removes the condition, and rewriting those tests is separate work.
