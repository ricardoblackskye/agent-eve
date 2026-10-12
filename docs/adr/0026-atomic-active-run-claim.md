# 0026. Atomic active-run claim (partial unique index on repo+issue)

**Status:** Accepted
**Date:** 2026-10-12
**Issue:** #328 (child of #276, P2a)

## Context

The Dark Factory trigger path (`agent/lib/dark-factory/entry.ts:753-808`) accepted a webhook
delivery and created a run via `runHistory.acceptDelivery(...)`. Its only duplicate guard was
**per delivery** ("this webhook delivery is already bound; not starting duplicate work"). A _second,
different_ delivery for the same `repo`+`issue` therefore created a **second active run**.

That is a real defect: the runner works on `process.cwd()` (`scripts/dark-factory-runner.ts:269`,
`:348`) and the local worker provider is `isolated:false`, so two concurrent active runs on one
clone share the working tree. The only isolation available today is _mutual exclusion_ of active
runs for the same issue.

Both stores already carried the intended guard — then dropped it:

```
DROP INDEX IF EXISTS df_run_active_issue_uidx;
```

present in `run-history-postgres.ts` and `run-history-store.ts`, with no replacement and no comment.
The index `df_run_active_issue_uidx` was a unique index over `(repo, issue)`, i.e. exactly the
active-run claim we needed. Its removal is why the guard no longer exists.

## Decision

Restore the claim as a **partial unique index** and enforce it **inside `acceptDelivery`** (the
single place a run is created), so it is atomic and cannot be defeated by a caller-side read.

1. **Partial unique index** in both stores:

   ```sql
   CREATE UNIQUE INDEX IF NOT EXISTS df_run_active_issue_uidx
     ON df_run_summaries (repo, issue)
     WHERE status IN ('queued','running','blocked');
   ```

   A _partial_ index is deliberate: the claim is released **automatically** whenever the run reaches
   a terminal status, because the row then no longer satisfies the `WHERE` predicate. No separate
   "release on terminal" code path can drift out of sync.

2. **In-store atomic claim.** `acceptDelivery` performs a fast pre-check (`SELECT … WHERE status IN
(…) LIMIT 1`); if an active run already exists it returns a distinct `activeConflict` outcome
   naming that run. The partial index is the real arbiter — under true concurrency the loser's
   `INSERT`/`upsert` violates the index (SQLite `SQLITE_CONSTRAINT_UNIQUE`, Postgres `23505`) and is
   translated, outside the (poisoned) transaction, into the same named refusal. No caller can create
   a second active run.

3. **Named refusal.** `entry.ts` turns `activeConflict` into `held` with a reason that names the
   existing run id and status (`… an active run already exists for owner/repo#163: run-… (queued);
not starting a second run`), satisfying the issue's "refused with a reason naming the existing
   run" requirement.

4. **Migration on existing data.** `CREATE UNIQUE INDEX` _fails_ if the deployed table already holds
   two active runs for one `repo`+`issue` — almost certainly why the index was dropped in the first
   place. So `ensureSchema` runs a bounded, idempotent **repair pre-pass** _before_ creating the
   index: for each `(repo, issue)` with more than one active run, the newest (by `created_at`, tie
   broken by `run_id`) is kept and the older ones are marked `aborted`/`terminal` — each written with `completed_at` and a `run.terminal` event, so the run
   stays READABLE by the record layer (a terminal status requires `completedAt`) and the ledger's
   timeline stays honest. The repair logs WHICH runs it terminated — a bounded list naming
   `repo#issue (runId)` — so an operator can trace what the claim removed. On a consistent
   database the pre-pass is a no-op.

## Consequences

- Exactly one active run per `repo`+`issue`; concurrent and sequential duplicate deliveries for the
  same issue are refused and name the holder. Verified by
  `tests/dark-factory/active-run-claim.test.ts` (SQLite + Postgres, including a concurrent pair).
- A terminal run does **not** block the #307 retry/rerun — the partial index releases the claim.
  A `blocked` (parked) run keeps the claim until it is resolved or terminated.
- The control deliveries (abort/resume) already resolve to the active run via a separate
  `claimControlDelivery` with its own cross-run guards; they are unaffected by this change.
- The repair pre-pass may terminate older active runs on a database that was already inconsistent;
  this is logged and is the correct resolution of a state the new constraint forbids.
- **Out of scope (separate issue after UAT):** giving each run its own workspace instead of
  `process.cwd()`. This index guarantees mutual exclusion; per-run isolation is a deeper change.
