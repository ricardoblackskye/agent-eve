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

## Tasks (RED → GREEN)

**T1 (RED) — a hermetic-start guard per suite.** Assert each suite begins from its own empty tables.
Today this fails whenever leftovers exist, and it is reproducible on demand by inserting a stray row and
re-running. This is the assertion that makes the whole issue testable rather than from a single observation.

**T2 (GREEN) — reset each suite's own tables.** Extend the shared database helper so a suite declares
the tables it owns and those are `TRUNCATE`d (`RESTART IDENTITY CASCADE`) before it runs. Wire it into
all five suites with their real table names.

**T3 — prove it on a developer machine.** Run the Postgres suites **twice back-to-back** and show the
second run green. That is the acceptance evidence the issue asks for, and it is the standard the rest of
this epic has been held to.

**T4 — non-vacuity.** Insert a stray row into a suite's table, re-run, and confirm it is still green
(i.e. the truncate genuinely resets, rather than the suite happening to pass). Without this, "it stopped
flaking" is unproven either way.

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
