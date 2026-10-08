# #271 — Enforce Definition of Done before `df:done`

**Epic:** #267 Foundations towards UAT · **Priority:** P1 · **Type:** fix / hardening
**Depends on:** #268 (orchestrator) for the *call site* — this issue delivers the gate + its
unit tests; #268 wires the orchestrator to invoke it. No `df:done` is applied by an agent's
self-report.

## Background (from code investigation)
- `agent/lib/dark-factory/definition-of-done.ts` exports `runDefinitionOfDone(task, deps)` which
  already enforces the DoD:
  - **AC verification** via `evaluateAcTraceability(plan, testResults)` → blocks (`status: "blocked"`)
    when acceptance criteria are not satisfied by the test trace.
  - **Review findings** via `deps.runChecks(round)` (linter / codeql / test / pr-reviewer) → must be
    `resolved`/`accepted` before `status: "done"`.
- BUT `runDefinitionOfDone` is **never called** anywhere (only re-exported from `index.ts:261`) —
  it is dead code today.
- `TRIGGER_LABELS.done = "df:done"` is **never applied** to an issue. It is only defined and used by
  `decideDarkFactoryTrigger` as a *guard against re-triggering* a finished run.
- The orchestrator `dispatch.ts` is the #268 stub: it sets `status: "succeeded"` (lines 529/549/555)
  without invoking the DoD or applying any label.
- **Net today:** no run is ever labelled `df:done`, and the DoD is never enforced. The fix is to route
  terminal-success through the DoD and gate the `df:done` label on its result.

## Goal
Add one testable gate that runs the DoD and applies `df:done` **only** when the DoD passes. `df:done`
may never be applied from an agent self-report.

## Approach
1. Add `finalizeRunAsDone(runId, deps)` in `definition-of-done.ts` (next to `runDefinitionOfDone`):
   - call `runDefinitionOfDone(task, deps)`;
   - if `result?.status === "done"` → `deps.labelWriter.add(repo, issue, TRIGGER_LABELS.done)`;
   - else → do **not** apply `df:done` (leave for human review; applying `df:failed`/`needs-answer`
     is out of scope here and handled by the orchestrator).
2. Export a pure, IO-free guard `isDoneGateSatisfied(result): boolean` =
   `result != null && result.status === "done"` for unit testing without mocks.
3. The orchestrator (#268) will call `finalizeRunAsDone` from its terminal-success path instead of
   setting `succeeded` bare — closing the loop so the DoD is actually enforced at runtime.

## TDD
### RED — `tests/dark-factory/definition-of-done.test.ts`
- **T1:** `finalizeRunAsDone` does **not** add `df:done` when `runDefinitionOfDone` returns
  `status: "blocked"` (ACs fail). Assert `labelWriter.add` is never called with `df:done`.
- **T2:** does **not** add `df:done` when review findings are unresolved (`status: "succeeded"` but
  `hasBlocking === true` / `allAccepted === false`).
- **T3:** **does** add `df:done` when the DoD passes (`status: "done"`).
- **T4 (guard):** `isDoneGateSatisfied` is `false` for `blocked`/undefined, `true` for `done`.

### GREEN
- Implement `finalizeRunAsDone` + `isDoneGateSatisfied`; all 4 tests pass; `tsc --noEmit` clean.

### REFACTOR / regression
- A test asserts the success path cannot reach `df:done` without the gate (no bare label add).

## Acceptance Criteria
- [ ] `df:done` is applied to an issue **only** after `runDefinitionOfDone` returns `status: "done"`
      (ACs + review findings verified).
- [ ] `df:done` is **not** applied when ACs fail or review findings are unresolved.
- [ ] `isDoneGateSatisfied` is exported and unit-tested.
- [ ] Unit tests cover blocked / unresolved-findings / passing cases (RED → GREEN).
- [ ] No code path applies `df:done` from an agent self-report (only via the gate).

## Out of scope
- The orchestrator call site (`dispatch.ts`) — delivered in #268.
- PR creation / merge — user-driven.

## Verification (this host)
- Node 24.18; `npx vitest run tests/dark-factory/definition-of-done.test.ts`; `npx tsc --noEmit`;
  `next build` smoke only if UI is touched (it is not).
