# Plan — #328 (DF P2a): restore an ATOMIC active-run claim

**Branch:** `fix/df-active-run-claim-328`
**Issue:** [#328](https://github.com/ricardoblackskye/agent-eve/issues/328) (child of #276)

## The defect, located precisely

`entry.ts:753-808` is the **TRIGGER** path. It calls `acceptDelivery({deliveryId, repo, issue, tenantId})`
and its ONLY duplicate guard is per **deliveryId** (`:801`, *"this webhook delivery is already bound"*).

**There is no (repo, issue) mutual exclusion: a second, DIFFERENT delivery for the same repo+issue
creates a SECOND run.**

A correction to my first reading of this code, recorded because it changes the fix:

- `findActiveRun` (`entry.ts:321`) is **not** a dispatch guard. Its only two callers are the **abort**
  (`:439`) and **resume** (`:586`) paths, where it *binds* the control delivery to the active run.
  For triggers there is no guard at all — not even a racy one.

Evidence the guard was intended and lost: both stores carry
`DROP INDEX IF EXISTS df_run_active_issue_uidx;` (`run-history-postgres.ts:108`,
`run-history-store.ts:347`) — no replacement, no comment.

Why it matters concretely: the runner operates on `process.cwd()`
(`scripts/dark-factory-runner.ts:269`, `:348`) and the worker provider is `local` with
`isolated: false`, so two runs on one clone SHARE the working tree. Mutual exclusion is the isolation
available today.

## Design

1. A **partial unique index** on `df_run_summaries (repo, issue) WHERE status IN ('queued','running','blocked')`
   in BOTH stores — restoring the dropped index's intent. A partial index releases the claim
   **automatically** when the status becomes terminal, so reruns keep working.
2. The claim is enforced **inside `acceptDelivery`** — the single place a run is created — so it is
   atomic: the INSERT itself must conflict, never a preceding SELECT. No caller can defeat it.
3. The conflict is surfaced as a **distinct outcome naming the existing run** (`runId` + `status`), so
   `entry.ts` can return held/refused per AC1 instead of a generic error.
4. **Migration on EXISTING data** — the risk that most likely killed the index before:
   `CREATE UNIQUE INDEX` FAILS if the deployed table already holds two active runs for one
   (repo, issue). The migration must therefore be tolerant: a bounded pre-pass that terminalises older
   active duplicates (newest wins) BEFORE the index is created, idempotent and logged. → ADR `0026`.

## Tasks (RED → GREEN)

- **T1 (RED)** — tests: (a) two **concurrent** deliveries, different deliveryIds, same repo+issue →
  exactly ONE run and the other refused **naming the winner**; (b) same, sequentially; (c) a
  DIFFERENT repo+issue is unaffected.
- **T2 (GREEN)** — the partial index + the in-store claim + the named refusal, in BOTH stores.
- **T3** — release-on-terminal: a terminal run does NOT block the #307 retry/rerun, while a `blocked`
  (parked) run DOES.
- **T4** — docs + ADR `0026` (the partial-index choice and the migration pre-pass).

## Verification

Full suite · BOTH Postgres suites against a **real** database (containers are up on `:5432`/`:55432`)
· tsc · cspell · `npm run build`. **Non-vacuity:** T1 must FAIL without the index.

## Out of scope

Per-run workspaces (each run its own clone) — the deeper fix for same-clone collisions, and its own
issue after the UAT run · real container isolation (#280 / R1) · the abort/resume binding (unaffected).
