# Plan: Wire `runHistory.recordPlan(...)` into the runner's post-plan step (#505)

## Goal
Persist the generated execution plan to `df_plans` when the Dark Factory runner posts a plan, so a local/prod run leaves an auditable plan row (epic #453 / #487 AC6). **Closes #505.**

## Background / root cause (from the #503 investigation)
The runner's post-plan step (`postPlanComment`, `scripts/dark-factory-runner.ts:856`) never calls `runHistory.recordPlan(...)`. The only plan-related write is `recordPlanRevision` (line 739), which only runs on the resume/amendment branch and appends a `run.resumed` **event** — not a plan row. So `df_plans` stays empty even with a configured store. (The "no `DF_RUN_HISTORY_DRIVER`" dry-run masking was a separate, already-understood config point — this issue is the *code* gap.)

## Change
1. **New helper** `recordPostedPlan(runHistory, { runId, plan, planRevision, source })` in `agent/lib/dark-factory/plan-revision-recorder.ts`:
   - calls `runHistory.recordPlan({ runId, planRevision, storyId: plan.storyId, source, plan, createdAt: new Date().toISOString() })`.
   - **Guard:** catches the specific *"run history provider is not configured"* error, logs `[PLAN] not persisted (run-history provider not configured — dry-run)`, and **continues**; any *other* error propagates (fail-closed for real DB/misconfiguration failure). This keeps dry-run usable but loud (no silent no-op).
2. **Call site 1 (first post):** in `scripts/dark-factory-runner.ts` immediately after the plan post succeeds (after line 870), with `planRevision = 1`, `source = "architect"`.
3. **Call site 2 (amendment):** on the resume/revision plan post, call the same helper with `planRevision = readPlanRevisionCount(runHistory, runId).count + 1` and `source = "amendment"` (mirrors the existing `recordPlanRevision` revision logic at line 741; `UNIQUE(run_id, plan_revision)` de-dupes re-plans).

## Files
- `agent/lib/dark-factory/plan-revision-recorder.ts` — new `recordPostedPlan` helper.
- `scripts/dark-factory-runner.ts` — call site after first plan post + amendment path.
- `tests/dark-factory/record-posted-plan-505.test.ts` — sqlite unit test.
- `tests/dark-factory/runner-record-plan-505.test.ts` + extend `fakeHistory()` to capture `recordPlan` calls — integration test.

## Tests (TDD — RED → GREEN → REFACTOR)
- **RED:** new tests fail (helper absent / runner records nothing).
- **GREEN:** implement helper + call sites; tests pass.
- **Unit:** `SqliteRunHistoryStore(":memory:")` gets exactly one `df_plans` row with correct `storyId`, `source = "architect"`, `plan_revision = 1`, and a non-null `plan` jsonb.
- **Integration:** `fakeHistory()` (extended to capture plan calls) shows the runner recorded `source "architect"`, `revision 1` after posting the plan; and `source "amendment"`, `revision 2` on a simulated re-plan.

## Acceptance (from #505)
- A local run with `DF_RUN_HISTORY_DRIVER=postgres` + `DF_RUN_HISTORY_DATABASE_URL` yields **one `df_plans` row per posted plan** (re-plans bump `plan_revision`).
- Plan content matches the plan rendered/posted to the issue.
- Dry-run (console) store surfaces the omission loudly (logged warning), no silent no-op, and does **not** abort the dry-run.

## Real-run proof (required by user)
- Retire the stale claim on `ricardoblackskye/webfeedpoc#173` in the local ledger (as done before).
- Run `npm run df:local-run -- --repo ricardoblackskye/webfeedpoc --issue 173` with `DF_RUN_HISTORY_DRIVER=postgres` + `DF_RUN_HISTORY_DATABASE_URL`.
- Query `df_plans` for the new `run_id` → expect exactly one row; sanity-check `df_run_events` persisted.
- Report the row + `EXIT=0` / park.

## Out of scope
- Plan **estimate** persistence (#487 estimate path) — separate.
- Changing the dry-run **reporter** (GitHub comments/labels) — separate.

## Decision for reviewer (GATE 1)
Dry-run store behavior: I propose **log-and-continue** for the *"not configured"* error (loud, non-aborting) and **fail-closed** for any other error. Confirm or adjust.

## Branch
`fix/wire-record-plan-505` (off `origin/main`). PR will target `main` and set **Closes #505**.
