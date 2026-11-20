# A run waiting on its checks stays in progress

**Goal:** a run whose pull request's checks have not settled is left **non-terminal and resumable**, so its record never says `failed` for something that is merely unknown - and when the checks do settle, the run acquires the real verdict (green to `succeeded`, red to `failed`) without a human re-triggering anything.

**Architecture:** the Definition of Done already reaches the right verdict (`blocked` + `blockedReason` + `pendingChecks`) and the ticket label already follows it. What does not follow it is the **terminal event**, whose write is also what releases the run's claim. This change makes the event follow the same verdict the label already uses.

**Tech stack:** TypeScript, the run ledger (Postgres in production, SQLite in tests), Vitest.

**Issue:** [#703](https://github.com/ricardoblackskye/agent-eve/issues/703)

**Branch:** `fix/run-status-until-checks-settle-703`

## The rule this establishes

| the pull request's checks | the run's record |
| :--- | :--- |
| all green | `succeeded` |
| any red | `failed` |
| **not yet settled** | **not terminal - the run is still in progress, waiting** |

A run reports `done` or `failed` only when one of those is actually true.

## Root cause (measured)

- The DoD **already knows**: `runDefinitionOfDone` returns `status: "blocked"` with `blockedReason: "checks-not-finished"` and `pendingChecks: [...]` (`CHECKS_NOT_FINISHED`, `definition-of-done.ts:162`; computed at `:193-194`).
- The runner **throws that away**: `terminalStatus: dodResult.ok ? "succeeded" : "failed"` (`scripts/dark-factory-runner.ts:1568`), collapsing the DoD's three-outcome verdict back to a boolean.
- `applyTerminalLifecycle` (`agent/lib/dark-factory/run-finalizer.ts:220`) **already follows the verdict for the LABEL** - `dodResult.status === "done" -> df:done`, `=== "blocked" -> df:blocked`, `refused -> null` - and its own comment records why (#672). So the ticket says `df:blocked`, correctly.
- What ignores the verdict is **step 5**, the marker write:

```ts
const marker = await runHistory.appendEvent(
  terminalEvent(runId, terminalStatus, markerEventId(runId), occurredAt, dodResult?.pr?.url),
);
```

  and step 5 is ALSO what releases the active-run claim (#373). So the label says "not done, re-triggerable" while the record says terminal `failed` and the claim is gone.
- The ledger cannot express the middle case: `TERMINAL_STATUSES = ["succeeded", "failed", "aborted"]` appears twice (`run-history.ts:272`, `run-finalizer.ts:103`), and the store refuses `blocked` as a terminal event status on purpose - *"`blocked` means not done **and resumable**"* (#672). So a waiting run has to masquerade as `failed`.

**Measured**

- `18c58665` (WebFeedPOC#241): the only terminal event is `terminal-lifecycle:18c58665-...` with status `failed`, written by `applyTerminalLifecycle` - while PR #243's checks were **all green** minutes later.
- `30e5e5a7` (WebFeedPOC#239): same, with `e2e` still `in_progress` when the wait hit its bound.
- `e1af302b` (WebFeedPOC#237): the DoD blocked on a **real** failure (the PR's `e2e` genuinely failed, 9 specs) and `failed` is **correct here and must stay correct**.
- The DoD wrote **no** terminal event for its blocked verdict, so suppressing the finalizer's write leaves the run exactly in the state it should be: `blocked`, claim held, re-triggerable.

## Legs

| leg | what it delivers | ship independently? |
| :--- | :--- | :--- |
| **A** | do not finalise a run whose DoD verdict is `blocked` | yes - the honesty fix on its own |
| **B** | persist the verdict, reason and pending checks | yes - the page can say *why* |
| **C** | a re-entry adopts the SAME run and re-verifies the checks | needs B (to route the re-entry) |

## Leg A - the terminal event follows the DoD verdict

**Where:** `agent/lib/dark-factory/run-finalizer.ts` (`applyTerminalLifecycle`, step 5) and the call site `scripts/dark-factory-runner.ts:1568`.

**Change:** when `dodResult.status === "blocked"`, apply the label and clear the in-flight labels exactly as today, but **do not write the marker/terminal event** - so the run stays non-terminal and keeps its claim. Steps 1-4 are unchanged; only step 5 is gated.

**Tasks**

1. **RED** - `tests/dark-factory/run-finalizer.test.ts`: a run whose `dodResult.status` is `blocked` (with `blockedReason: "checks-not-finished"`, `pendingChecks: ["e2e"]`) ends with **no** `run.terminal` event, its summary status still `blocked`, and its claim still held; the `df:blocked` label is still applied and the in-flight labels still cleared.
   *Expected RED:* today it writes `terminal-lifecycle:<runId>` with status `failed` and releases the claim.
2. **GREEN** - gate step 5 on the verdict.
3. **RED** - a red check (`dodResult.status === "failed"`) and a done run (`"done"`) both still finalise exactly as today (guard against over-correcting into never finalising).
4. **GREEN** - no change needed beyond keeping the existing paths; the test pins that behaviour.

## Leg B - the run records why it is waiting

**Where:** the DoD's `blocked` verdict fields, the ledger, and the page.

**Change:** persist the DoD verdict, `blockedReason` and `pendingChecks` so the run page can say *"waiting on `e2e`"* instead of showing a bare status, and so Leg C has something to route on.

**Tasks**

1. **RED** - the ledger refuses an unstructured reason: assert that a `blocked` run's record carries the verdict, the reason and the pending check names, readable back from the store.
2. **GREEN** - carry them through the existing event/summary write path (prefer the existing event fields over a new column; see the open question on schema below).
3. **RED/GREEN** - the view-model exposes them and the page renders the waiting reason for a run that is not done (the panels already exist).

## Leg C - a re-entry adopts the same run

**Where:** the runner's resume path.

**Change:** a delivery for a run blocked on **unfinished checks** re-enters the **Definition of Done** (re-read the PR's checks) instead of re-planning or re-coding, and adopts the **same run** - green to `succeeded`, red to `failed`. This is what makes waiting safe: without it a blocked run needs a human to tell it apart from a plan-park.

**Tasks**

1. **RED** - a run blocked with `blockedReason: "checks-not-finished"` that is re-entered with the checks now green reaches `succeeded` on the SAME `runId`, without a new run and without re-coding.
2. **GREEN** - route the re-entry on the persisted reason (Leg B), reusing the existing claim-adoption path that a parked run already uses (#699).
3. **RED/GREEN** - a plan-park resumes into planning exactly as today (the two blocked states must not be confused).

## Files likely to change

- `agent/lib/dark-factory/run-finalizer.ts` - step 5 gate (Leg A).
- `agent/lib/dark-factory/definition-of-done.ts` - the verdict/reason fields carried through (Leg B).
- `agent/lib/dark-factory/run-history.ts` - the write path for the reason (Leg B).
- `app/dark-factory/ui/view-model.ts` + `components.tsx` - render the waiting reason (Leg B).
- `scripts/dark-factory-runner.ts` - the call site, and the re-entry routing (Legs A, C).
- `tests/dark-factory/run-finalizer.test.ts`, `tests/dark-factory-ui/view-model.test.ts` - the RED/GREEN pairs.

**Explicitly NOT touched:** the ledger's `TERMINAL_STATUSES` and the store's refusal of `blocked` as a terminal status. Both are load-bearing (#672) and are what make "leave it non-terminal" the right fix rather than widening the vocabulary.

## Validation

- Unit tests per leg, then the full suite with the Postgres test DSNs set (as CI runs it), `tsc --noEmit`, and the repo's spell/markdown gates on every changed file.
- **Proof on a real run**: a local sandbox run against a WebFeedPOC issue whose checks are still settling - the record must read non-terminal/`blocked` with the claim held, and the page must name the pending check. Then re-enter once the same checks go green and confirm the SAME run reaches `succeeded`.
- **Regression proof**: a run blocked on a genuinely red check still ends `failed` (the #237 shape).

## Risks and open questions

1. **Scope of Leg A - all `blocked` verdicts, or only `checks-not-finished`?** The ledger's own vocabulary says `blocked` means "not done and resumable", which argues for applying it to every `blocked` verdict; `checks-not-finished` is merely the measured case. Recommendation: **all `blocked`**, with the reason persisted in Leg B so the page can still distinguish them. Needs a decision, because it widens what stays resumable.
2. **The claim is held, so a fresh trigger is refused.** With Leg A, a waiting run keeps its claim, so a new delivery for the same repo+issue is adopted as a re-entry rather than starting a second run. That is the intended ADR 0085 semantics and it is exactly what #699 established for the parked case - but it IS a behaviour change and needs stating in the PR.
3. **A waiting run could wait forever.** There is no queue or worker (the executor is parked in #668), so nothing wakes it: Leg C only fires on a re-entry. A run left waiting must therefore be visibly re-triggerable, which the `df:blocked` label already means (#677 asks whether `df:failed` should be too).
4. **Leg B's storage shape.** Prefer an existing event field over a new column (the `review.round` payloads show the event table already carries structured JSON, so a `verdict`/`reason` payload may fit the same pattern); decide before writing the migration, and check `\d df_run_events` in FULL - the listing truncates, and a truncated listing is what an absent column looks like.

## What this does NOT fix

- **#704** - the run diff is never captured and worker checkpoints carry no detail.
- **#716** - `iterationCount` and `fixCycleCount` are fabricated zeros (a separate "record what the run did" defect).
- **#701** - the coding loop cannot run the target's e2e suite, which is *why* runs reach the DoD with an unsettled check in the first place.
