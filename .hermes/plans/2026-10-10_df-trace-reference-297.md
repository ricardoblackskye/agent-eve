# Plan — #297 Surface agent reasoning / trace reference in runs detail

**Issue:** #297 — DF #272 follow-up: capture + surface agent reasoning / trace reference in runs detail view
**Branch:** `feat/df-trace-reference-297` (off `origin/main`, post #296 merge)
**Epic:** #267 (Foundations towards UAT)

## Goal

Persist a reference to the agent's execution reasoning (the Acceptance Criteria traceability matrix) on a Dark Factory run and surface it in the runs detail view, without ever storing raw prompts or issue content.

## Verified gap

- `run-history` deliberately keeps no raw prompts or free-form content; it stores only structured, derived fields (for example `gitDiff` from #295 and `testResults` from #296).
- The Definition of Done already computes `acMatrix` (the agent's reasoning mapping each acceptance criterion to the test that verifies it, with a pass/fail verdict) and renders it as `traceabilityTable`, posting that to the PR. It is **never persisted** to run history.
- The runs detail view (`app/dark-factory`) surfaces `prUrl` (#272), `gitDiff` (#295) and `testResults` (#296), but no trace or reasoning reference.

## Intended fix

Mirror the #296 `testResults` seam exactly:

1. Add a structured `TraceItem` array to the `review.round` run event — the AC traceability matrix — stored as a JSON column (`trace`) in both the sqlite and postgres adapters, validated only on `review.round`.
2. Wire the Definition of Done's AC matrix into `recordReviewRound` (the same spot `testResults` is attached).
3. Surface `trace` on `DetailView` in the view-model (extracted from the most recent `review.round` event).
4. Render a `TracePanel` in the runs detail page (sibling of the merged `TestOutputPanel`), showing AC ID, description, test file / case and the pass/fail verdict.

`TraceItem` is defined locally in `run-history.ts` (shape identical to `AcTraceabilityItem`) to avoid a circular import, exactly as #296 defined `TestOutcome`.

## Security

Only derived reasoning is stored: the AC to test mapping (`acId`, `description`, `testFile`, `testCaseName`, `passed`). No raw prompt text, no issue body, no free-form agent output. This honours the run-history no-raw-content principle.

## Tasks (TDD — one RED then GREEN pair each)

| Task | Work                                                                                                                                               |
|------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| T1   | Backend schema: `TraceItem` + `RunEvent.trace`; `optionalTrace` validator; `trace` JSON column plus ALTER in sqlite and postgres; round-trip tests |
| T2   | DoD wiring: attach the AC matrix (mapped to `TraceItem` array) to `recordReviewRound`                                                              |
| T3   | View-model: `DetailView.trace`; extract from `review.round`                                                                                        |
| T4   | UI: `TracePanel` plus render on runs detail page; component and page tests                                                                         |

## Files likely to change

- `agent/lib/dark-factory/run-history.ts` (type plus validator plus `toRunEvent`)
- `agent/lib/dark-factory/run-history-store.ts` and `run-history-postgres.ts` (column plus read or write)
- `agent/lib/dark-factory/definition-of-done.ts` (`recordReviewRound` wiring)
- `app/dark-factory/ui/view-model.ts` (surface)
- `app/dark-factory/ui/components.tsx` and `app/dark-factory/runs/[runId]/page.tsx` (panel)
- Tests: `run-history.test.ts`, `run-history-store.test.ts`, `run-history-postgres.test.ts`, `definition-of-done.test.ts`, `view-model.test.ts`, `components.test.tsx`, `run-detail-page.test.tsx`

## Validation

- `npx vitest run tests/dark-factory tests/dark-factory-ui` (targeted new tests plus no regressions)
- `npx tsc --noEmit --incremental false`
- `npx -y cspell@8 --config .cspell.json` on changed files
- Build gate `DF_PLATFORM_PROVIDER=generic npm run build`
- Open PR for CI; do not merge (user drives merges)

## Risks and open questions

- **UI seam:** `components.tsx` has an `OutcomeArtifacts` panel that the Dark Factory testing skill nominates as the home for follow-up artifacts. #296 shipped a sibling `TestOutputPanel` instead for consistency with the existing `RunDiffPanel`. This plan follows the #296 merged pattern (sibling `TracePanel`) for visual consistency; flagging in case you prefer extending `OutcomeArtifacts`.
- **Reference versus content:** the issue example mentions a link to the trace artifact. The AC matrix is the actual available trace artifact and is stored directly (like `gitDiff` and `testResults`), not as an external link — simpler and more useful in-app. If you specifically want an external trace URL instead, say so.
- **Branch name** `feat/df-trace-reference-297` (no hash, cspell-clean).

## ADR

One ADR ships with this change: run-history stores derived trace artifacts (AC to test matrix), never raw agent content — records the no-raw-content boundary for the trace field.
