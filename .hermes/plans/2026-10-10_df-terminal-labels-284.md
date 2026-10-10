# Plan — #284: Terminal lifecycle labels (`df:done` / `df:failed`) on run completion

**Branch:** `feat/df-terminal-labels-284` (off `origin/main` @ `f26a69c`)
**Issue:** [#284](https://github.com/ricardoblackskye/agent-eve/issues/284)
**Epic:** #267 (Dark Factory — Pre-UAT Readiness) · carved out of #269
**Date:** 2026-10-10

## Goal

When a Dark Factory run reaches its terminal state, apply the matching lifecycle
label and clean up the in-flight one — idempotently and fail-closed:

- **success → `df:done`**, **failure → `df:failed`** (mapped from the run's terminal status).
- Remove **`df:running`** on the same transition, and **`needs-answer`** when a
  parked run completes.
- Applied **at most once per run** (a re-delivery must not double-apply).
- A label-write failure is **surfaced on the run**, never swallowed.

This closes the gap the trigger re-run guard (`decideDarkFactoryTrigger`) depends
on: it keys "already finished" on `df:done` / `df:failed` being present, but today
those labels are never (reliably) written by the library.

## Root cause (verified)

- `TRIGGER_LABELS` (`agent/lib/dark-factory/trigger.ts:49`) defines
  `running/done/failed/question` but the `done`/`failed` members are only read by
  the trigger's re-run guard — they are **never written** by a library module.
- `scripts/dark-factory-runner.ts` is the real executor. It applies `df:running`
  (STEP 2, line 199) and `df:done` + removes `df:running` **only on full success**
  (STEP 7, lines 403-404, inside `if (dodResult.pr)`). On every **failure** path
  (architect plan fail → line 249, domain-validation fail → line 264, dev-loop fail
  → lines 338-341, push fail → `execSync` throw) it just throws — **no `df:failed`,
  no `df:running` cleanup**.
- `finalizeRunAsDone` (`definition-of-done.ts:441`, #271) exists and gates `df:done`
  behind the Definition of Done, but its **only caller is its own test** — it is not
  wired into the pipeline.
- `dispatch.ts` (orchestrator, #268) records terminal dispatch state but applies **no**
  GitHub labels. `entry.ts` `recordTerminal` records a `run.terminal` run-history
  event on abort/failure but applies **no** label.

## Intended fix

### New library module — `agent/lib/dark-factory/run-finalizer.ts`

A single, testable, fail-closed seam that both the runner (and future orchestrator
paths) call at run completion.

```ts
import type { LabelWriter } from "./definition-of-done"; // identical to entry.ts LabelWriter
import type { RunHistoryStore } from "./run-history-store";
import { TRIGGER_LABELS } from "./trigger";
import { isDoneGateSatisfied, type DefinitionOfDoneResult } from "./definition-of-done";

export type TerminalStatus = "succeeded" | "failed";
export interface TerminalFinalizerDeps { labelWriter: LabelWriter; runHistory: RunHistoryStore; }
export interface TerminalFinalizeOutcome { applied: boolean; skipped?: boolean; error?: string; }

export async function applyTerminalLifecycle(
  deps: TerminalFinalizerDeps,
  args: { repo: string; issue: number; runId: string; terminalStatus: TerminalStatus;
          dodResult?: DefinitionOfDoneResult },
): Promise<TerminalFinalizeOutcome>
```

Behaviour:

1. **Idempotency (re-delivery guard).** Read `runHistory.getRun(runId)`; if a
   `run.terminal` event with `status === terminalStatus` already exists for the run,
   return `{ applied: false, skipped: true }` and perform **no** label writes.
   Reuses the existing `run.terminal` event type — no run-history schema change.
2. **Map terminal status → label.**
   - `succeeded`: apply `df:done` **only if** `dodResult` is supplied and
     `isDoneGateSatisfied(dodResult)` (the #271 DoD gate). If the DoD is not
     satisfied, do **not** apply `df:done` and leave the run for human review
     (out of #284's strict success/failure acceptance — #271 owns the blocked path).
   - `failed`: apply `df:failed`.
3. **Cleanup on the same transition.** Always `remove` `df:running` and
   `needs-answer`. A `remove` that 404s (label already absent) is treated as success
   (idempotent-mutations rule); any other `{ ok: false }` is a real failure.
4. **Fail-closed.** Collect every `add`/`remove` result. If any is `{ ok: false }`
   (excluding the 404-remove case), record a `run.terminal` event carrying the error
   and **throw** a `LabelWriteError` (or return `{ applied: false, error }`) — never
   silently continue. The runner's existing error handling then stops the script, but
   the failure is already recorded on the run.
5. **Record completion.** On success, append a `run.terminal` event with
   `status === terminalStatus` so the idempotency check (step 1) and the run history
   reflect the terminal state.

`TRIGGER_LABELS` supplies the label names; `createGitHubLabelWriter`
(`issue-writer.ts:57`) adapts the runner's `GitHubIssueWriter` to the `LabelWriter`
`add`/`remove` seam, so no new GitHub transport code is written.

### Wire into `scripts/dark-factory-runner.ts`

- After `const issueWriter = new GitHubIssueWriter({ token })` (line 167), build
  `const labelWriter = createGitHubLabelWriter(issueWriter);` and pass `runHistory`
  (already in scope) — these are the `TerminalFinalizerDeps`.
- **Success path (STEP 7):** replace the inline
  `issueWriter.addLabel(..., "df:done")` + `issueWriter.removeLabel(..., "df:running")`
  (lines 403-404) with
  `await applyTerminalLifecycle({ labelWriter, runHistory }, { repo: targetRepo, issue: issueNum, runId, terminalStatus: "succeeded", dodResult });`
  Keep the existing success comment (lines 405-413).
- **Failure paths:** at each terminal-failure point (architect plan fail, domain
  validation fail, dev-loop fail, push fail) call
  `await applyTerminalLifecycle({ labelWriter, runHistory }, { repo: targetRepo, issue: issueNum, runId, terminalStatus: "failed" });`
  before the existing `throw`. The `needs-answer` add at line 249 stays (it is a
  transient "parked" signal during the failure); the finalizer removes it on the
  terminal transition. Fail-closed surfacing is handled inside the finalizer.

### Not in scope (explicit)

- The end-to-end pipeline proof up to "PR opened" — that is **#269**.
- Applying `df:failed` on **abort** — abort is reversible (the trigger re-run guard
  must keep allowing re-trigger), so `entry.ts` `recordTerminal` is left label-free.
- DoD-refused runs (no PR) stay in the #271 `needs-answer` / blocked path; the
  finalizer does not apply `df:done` for them.

## Tasks (TDD phases — one RED→GREEN cycle each)

- **T1 — finalizer unit tests.** `tests/dark-factory/run-finalizer.test.ts`
  (RED first): succeeded+DoD-satisfied → adds `df:done`, removes `df:running` +
  `needs-answer`, records `run.terminal(succeeded)`; succeeded+DoD-refused → no
  `df:done`; failed → adds `df:failed`, removes both, records `run.terminal(failed)`;
  re-delivery (existing `run.terminal`) → skipped, no writes; label-write `{ ok:false }`
  → throws + records error (fail-closed, not swallowed). Use an in-memory fake
  `LabelWriter` + a fake `RunHistoryStore` (or the existing in-memory store if one
  exists). GREEN: implement `applyTerminalLifecycle` + `LabelWriteError`.
- **T2 — wire into runner.** Add the `labelWriter` + the two call sites in
  `scripts/dark-factory-runner.ts`. If a runner unit test exists, extend it to assert
  the finalizer is invoked on success and on failure; otherwise add a focused test
  that the runner imports + calls `applyTerminalLifecycle` (no real GitHub calls).
- **T3 — e2e doc/comment.** Update the premise comment in
  `tests/dark-factory/dark-factory-pipeline-e2e.test.ts` (lines ~11-12: "applied by
  NO library module today … `df:failed` nowhere") to reflect the new
  `run-finalizer.ts`; confirm the entry/dispatch-path assertions still pass (entry.ts
  still applies no terminal labels by design).
- **T4 — docs + ADR.** Add a `run-finalizer.ts` row to
  `docs/pages/dark-factory-modules.md` (bump module count) to satisfy the doc-drift
  guard. Add ADR `docs/adr/NNNN-terminal-labels-fail-closed.md` recording the
  fail-closed + idempotent decision (why labels are applied by a library finalizer,
  not inline, and why 404-remove is treated as success).

## Files likely to change

- `agent/lib/dark-factory/run-finalizer.ts` (NEW)
- `scripts/dark-factory-runner.ts` (success + failure call sites)
- `tests/dark-factory/run-finalizer.test.ts` (NEW)
- `tests/dark-factory/dark-factory-pipeline-e2e.test.ts` (comment + maybe assertion)
- `docs/pages/dark-factory-modules.md` (catalog row + count)
- `docs/adr/NNNN-terminal-labels-fail-closed.md` (NEW)

## Validation

- `npx vitest run tests/dark-factory tests/dark-factory-ui` (Node 24 on PATH).
- `npx tsc --noEmit --incremental false` (full type-check; `--incremental false`
  defeats the stale-cache trap).
- `npm run build` (`DF_PLATFORM_PROVIDER=generic`) — proves the runner + new module
  compile.
- Local lint gate before push: `npx cspell@8 --config .cspell.json` on changed files;
  `npx markdown-table-formatter@1.6.1 --check` + `npx markdownlint-cli@0.45.0 -c
  {"default":false,"MD040":true}` on changed `.md` (incl. the plan file).

## Risks / open questions

- The runner is a `scripts/` file executed out-of-band (not in the webhook request);
  `npm run build` still type-checks it, so the new call sites are compile-verified,
  but they are not exercised by the entry/dispatch unit suites — hence the dedicated
  finalizer unit tests (T1) carry the behaviour.
- `GitHubIssueWriter.removeLabel` 404 handling must be confirmed to return a shape the
  finalizer can read (status 404 ⇒ treat as success). Checked during T1/T2.
- If the e2e test asserts "no library module applies terminal labels" for the
  entry/dispatch path, that assertion still holds (entry.ts unchanged); only the
  comment premise about the runner changes.
