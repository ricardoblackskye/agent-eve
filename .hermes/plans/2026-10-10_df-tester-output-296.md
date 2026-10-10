# Plan — #296: Capture + surface tester-agent test output in runs detail view

**Branch:** `feat/df-tester-output-296` (off `origin/main` @ `f26a69c`)
**Issue:** [#296](https://github.com/ricardoblackskye/agent-eve/issues/296)
**Epic:** #267 (Dark Factory — Pre-UAT Readiness) · #272 follow-up (after #295 git-diff)
**Date:** 2026-10-10

## Goal

Persist the tester-agent's **test-result detail** (per-test pass/fail) and surface it
in the runs detail view, alongside the PR link (#272) and run diff (#295).

Today only the **aggregates** (`findingCount` / `resolvedCount` / `acceptedCount`) ride on
`review.round` events and are surfaced by the view-model + `OutcomeArtifacts` panel. The
**per-test detail** is captured in `scripts/dark-factory-runner.ts` as
`capturedTestResults: { testFile, testCaseName, passed }[]` and passed into
`DefinitionOfDoneTask.testResults`, but the DoD only uses it for AC verification
(`definition-of-done.ts:543`) — it is **never persisted**. This plan closes that gap.

## Root cause (verified)

- `RunEvent` (`agent/lib/dark-factory/run-history.ts:85`) carries `findingCount` /
  `resolvedCount` / `acceptedCount` (aggregate) on `review.round`, validated in
  `toRunEvent` (lines 535-562). There is **no structured per-test field**.
- `definition-of-done.ts` records `review.round` events via `recordReviewRound`
  (lines 594-607), one per review round, with `...counts` (the aggregates) + run metrics.
  `task.testResults` is read only for AC verification (line 543), never written to an event.
- `view-model.ts` `toDetailView` sums the aggregates into `metrics` (lines 382-402) and
  returns `prUrl` + `gitDiff` (#295); it returns **no** per-test detail.
- `scripts/dark-factory-runner.ts` captures `capturedTestResults` (line 271) and passes
  `testResults: capturedTestResults` into the DoD task (line 368) — the data exists, it is
  just dropped before storage.

## Intended fix

### T1 — backend schema (mirror #295 + the `commentReference` JSON-column precedent)

- `agent/lib/dark-factory/run-history.ts`:
  - Add `export interface TestOutcome { testFile: string; testCaseName: string; passed: boolean }`
    (define locally — `run-history.ts` is the schema root; reusing the downstream
    test-result type in `definition-of-done.ts` would create a circular import).
  - Add `testResults?: TestOutcome[]` to `RunEvent` (alongside the aggregate fields, ~line 100).
  - In `toRunEvent`, validate `testResults` is used **only on `review.round`** (same guard
    shape as `findingCount`), and spread it into the returned event.
- `agent/lib/dark-factory/run-history-store.ts` (sqlite):
  - Add `test_results` to `RunEventRow`; include it in `CREATE TABLE df_run_events` (new DBs)
    and in the inline `ALTER TABLE df_run_events ADD COLUMN IF NOT EXISTS test_results`
    (existing DBs — same inline-ALTER pattern as `git_diff` / `comment_reference`).
  - `writeEvent`: add the `test_results` placeholder + value (`JSON.stringify(testResults) ?? null`).
  - `rowToEvent`: parse `test_results` JSON back to `testResults` (or `undefined` when null) —
    mirror the `commentReference` JSON round-trip already in the file.
- `agent/lib/dark-factory/run-history-postgres.ts`: identical `test_results` column +
  JSON round-trip (Postgres parity; the adapter already maps `comment_reference` as JSON).

### T2 — DoD wiring

- In `definition-of-done.ts` `recordReviewRound` (lines 594-607), attach
  `testResults: task.testResults` to the `review.round` event object. (The detail is
  identical across rounds; the view-model reads the most recent `review.round` that carries
  it, so duplication across rounds is harmless.)

### T3 — view-model

- `app/dark-factory/ui/view-model.ts`:
  - Add `testResults?: TestOutcome[]` to `DetailView`.
  - In `toDetailView`, after building `metrics`, extract the **most recent** `review.round`
    event that carries `testResults` (non-empty) and include it in the returned view.
    Keep the existing aggregated `findings` / `resolved` / `accepted` metrics.

### T4 — UI (consistency with #295's `RunDiffPanel`)

- `app/dark-factory/ui/components.tsx`: add a sibling `TestOutputPanel`
  (`{ testResults?: TestOutcome[] }`), mirroring `RunDiffPanel`'s `df-panel` / `df-panel-body`
  shape — color-coded per-test rows (passed → green, failed → red) + an aggregate line
  (N passed / M failed); empty state ("No test output captured") when absent. Added as a
  **sibling** of `RunDiffPanel` to stay consistent with the #295 panel that is already
  merged (rather than overloading `OutcomeArtifacts`).
- `app/dark-factory/runs/[runId]/page.tsx`: render
  `<TestOutputPanel testResults={view.testResults} />` next to `RunDiffPanel`.

### T5 — docs + ADR

- If `docs/pages/dark-factory-modules.md` (or another doc) catalogues `RunEvent` fields, add
  the `testResults` field. (Adding fields to existing files does not add a module, so the
  doc-drift module-count guard is unaffected — verify with the doc-drift test.)
- ADR `docs/adr/NNNN-structured-test-results-only.md`: record the decision to store only
  **structured** pass/fail (never the raw vitest output string), per run-history's
  no-raw-content principle (#297 owns the broader "never store raw prompts" rule).

## Tasks (TDD phases — one RED→GREEN cycle each)

- **T1 RED→GREEN (schema).** `tests/dark-factory/run-history.test.ts`: `testResults` on a
  `review.round` event is accepted, stored, and read back (assert on both sqlite and
  postgres adapters); `testResults` on a **non**-`review.round` event is rejected by
  `toRunEvent`. GREEN: the `run-history.ts` + both store adapters changes above.
- **T2 RED→GREEN (wiring).** `tests/dark-factory/definition-of-done.test.ts`: a
  `review.round` event recorded by `runDefinitionOfDone` carries `testResults` when
  `task.testResults` is supplied. GREEN: the `recordReviewRound` change.
- **T3 RED→GREEN (view-model).** `tests/dark-factory-ui/run-detail-page.test.tsx`: given a
  run whose latest `review.round` carries `testResults`, `toDetailView(...).testResults`
  equals it. GREEN: the `view-model.ts` extraction.
- **T4 RED→GREEN (UI).** `tests/dark-factory-ui/components.test.tsx`: `TestOutputPanel`
  renders one row per `TestOutcome` (pass/fail classed), an aggregate line, and an empty
  state when `testResults` is absent. GREEN: the component.
- **T5.** Doc update (if needed) + ADR; confirm `tests/doc-drift-guards.test.ts` still passes.

## Files likely to change

- `agent/lib/dark-factory/run-history.ts` · `run-history-store.ts` · `run-history-postgres.ts`
- `agent/lib/dark-factory/definition-of-done.ts`
- `app/dark-factory/ui/view-model.ts` · `components.tsx` · `runs/[runId]/page.tsx`
- `tests/dark-factory/run-history.test.ts` · `definition-of-done.test.ts`
- `tests/dark-factory-ui/run-detail-page.test.tsx` · `components.test.tsx`
- `docs/pages/dark-factory-modules.md` (only if it catalogues event fields) · `docs/adr/NNNN-…`

## Validation

- `npx vitest run tests/dark-factory tests/dark-factory-ui` (Node 24 on PATH).
- `npx tsc --noEmit --incremental false` (defeats the stale incremental-cache trap).
- `npm run build` (`DF_PLATFORM_PROVIDER=generic`) — proves the UI + store compile.
- Local lint gate before push: `npx cspell@8 --config .cspell.json` + markdownlint
  (`MD040`/`MD022`/`MD024`/`MD026`) on changed files, including this plan file.

## Risks / open questions

- Postgres adapter (`run-history-postgres.ts`) must mirror the new `test_results` column +
  JSON round-trip; `commentReference` is the template.
- The inline `ALTER TABLE` for sqlite existing DBs follows the `git_diff` /
  `comment_reference` precedent (no `db/migrations` file — the adapters' `ensureSchema`
  performs `ADD COLUMN IF NOT EXISTS`).
- `testResults` is attached to every `review.round`; the view-model reads the most recent
  non-empty one, so cross-round duplication is invisible to the UI.
- Storing only `{ testFile, testCaseName, passed }` (not the raw vitest output string)
  keeps the change inside run-history's no-raw-content boundary.
