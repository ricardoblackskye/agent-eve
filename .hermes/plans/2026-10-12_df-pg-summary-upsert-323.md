# Plan — #323: the Postgres run-history store must UPSERT the run summary

**Branch:** `fix/df-pg-summary-upsert-323`
**Issue:** [#323](https://github.com/ricardoblackskye/agent-eve/issues/323)

## The bug — proven, not inferred

`recordRunSummary` on **Postgres** fails for any run that already exists, which is the
normal case because the run row is created at acceptance:

```
recordRunSummary (run row ALREADY EXISTS) -> ok = false
error = duplicate key value violates the unique constraint on the summaries table
```

`recordRunSummary` is the **diff-capture path** (`diff-capture.ts`), so on Postgres the
captured diff is **never persisted** — #295's feature is silently broken on the backend
production runs, and the write reports `ok:false`.

## Root cause — the two stores diverge

| Store | statement |
|---|---|
| SQLite `writeSummary` (`run-history-store.ts`) | `INSERT ... ON CONFLICT(run_id) DO UPDATE SET ...` — an **UPSERT** |
| Postgres `insertSummary` (`run-history-postgres.ts`) | **plain `INSERT`**, no `ON CONFLICT` → duplicate-key error |

## The RED already exists — no new test is needed

`tests/dark-factory/run-history-postgres.test.ts` → *"round-trips the git diff through the
postgres store (#295)"* **FAILS against a real database today**. An unusual TDD shape: the
failing test predates the fix and was simply never run, because the suite is skipped unless
a test DSN is set.

## Fix

Give the Postgres `insertSummary` the same upsert semantics as the SQLite `writeSummary`:
`ON CONFLICT (run_id) DO UPDATE SET` — using the same column list as `updateSummary`,
**minus `tenant_id`** (attribution is write-once; `updateSummary` already documents that
rule, and the SQLite `DO UPDATE` follows it too).

The parameter array is unchanged: all 18 columns are already supplied, so this is a
statement-shape fix, not a data change.

## Verification

- **Postgres suite against the real disposable DB: 24/24**, up from 23/24.
- Full suite · `tsc` exit 0 (captured explicitly) · cspell · `npm run build`.
- **Non-vacuity**: the Postgres test fails without the fix (already demonstrated above) and
  passes with it.
- Re-run the SQLite-equivalent diff round-trip to prove the two stores now AGREE.

## Out of scope

The CI-coverage gap (the Postgres suites never run in CI). That is a separate `[ci]` change
and must land **AFTER** this fix, or CI goes red on this very bug.
