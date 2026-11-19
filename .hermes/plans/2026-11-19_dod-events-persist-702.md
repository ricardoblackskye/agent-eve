# A resumed run records its events, and the Definition of Done's facts reach the ledger

**Goal:** a resumed run appears as `running` while it works, and the Definition of Done's own facts - the PR it opened, its review rounds, the acceptance-criteria matrix and the test results - are persisted, so the run details page can show them.

**Architecture:** two writes that should already be happening. The approval resume must mark the run resumed (the ledger refuses any other event from a `blocked` run), and the runner must hand its run-history store to the Definition of Done (today it does not, so every DoD event is discarded silently).

**Tech stack:** TypeScript, the run ledger (Postgres in production, SQLite in tests), Vitest.

**Issue:** [#702](https://github.com/ricardoblackskye/agent-eve/issues/702)

**Branch:** `fix/dod-events-persist-702`

## Root cause (measured on two real runs)

Run `e1af302b` (WebFeedPOC#237) and run `30e5e5a7` (WebFeedPOC#239) each persist exactly three events:

```text
run.accepted    trigger/queued
worker.question worker/blocked     <- the park
run.terminal    terminal/failed
```

Everything else the run did is missing, and the page can only render what was persisted - which is why TEST OUTPUT and ACCEPTANCE CRITERIA are empty on every run and why the run reads `blocked` while it is actually coding.

Two causes, both verified in the code:

1. **An approval resume never marks the run resumed.** The ledger's rule is explicit (`run-history.ts`): from `blocked`, only `run.resumed` or `run.terminal` may follow, and `run.resumed` requires the current status to be `blocked`. The *revision* path appends one via `recordPlanRevision` (`plan-revision-recorder.ts`), but the plain **approval** path does not. So the summary stays `blocked`/`worker` for the whole resumed run, and every later work event is refused.
2. **The runner never wires its store into the Definition of Done.** `DefinitionOfDoneDeps.runHistory` is optional and the DoD's `record()` opens with `if (!deps.runHistory) return undefined;` - a silent no-op - while `dodDeps` in `scripts/dark-factory-runner.ts` passes only `prWriter`, `commentWriter` and `runChecks`.

The two interact: wiring the store on its own makes the run **worse**, because the first write the DoD attempts (`pr.opened`, right after it opens the PR) is refused:

```text
Reason: Run history persistence failed: Run history store write failed:
Run record requires "type" to resume a blocked run before further work events (received "pr.opened").
```

Measured, with the store wired as a one-line experiment on the #239 run: `DoD Status blocked`, `AC Matrix Count 0`, still three events persisted. The refusal is correct; what was missing was the resume that should have preceded it.

## Intended fix

### Part 1 - an approval resume marks the run resumed

Append a `run.resumed` event when the run adopts a blocked run on the APPROVAL path, before the coding phase. Guarded by the current status: the store itself rejects `run.resumed` from a non-`blocked` run, so the write is idempotent by construction - a second call reads `running` and skips.

### Part 2 - the counter must not count an approval as a revision

`countPlanRevisions` counts **every** `run.resumed` event (`events.filter((e) => e.type === "run.resumed")`), so a naive approval resume would consume one of the plan-revision rounds. The revision event id is already a distinct form (`plan-revision-resume:<hash>`), so the approval resume gets its own id form and the counter is narrowed to the revision form - one rule, stated once, with a test that an approval does not spend a revision round.

### Part 3 - the Definition of Done's facts are persisted

Pass `runHistory` into `dodDeps`, so `pr.opened` (carrying the PR URL), `review.round` (carrying the acceptance-criteria matrix and the test results) and the DoD's own terminal event are written.

### Part 4 - the unwired recorder is loud

Replace the silent `return undefined` with a warning (or a throw) when the store is absent: a writer that cannot write must say so. The silence is what hid causes 1 and 2 for the whole life of the page.

## Tasks

### Task 1 - RED: an approval resume moves the run out of `blocked`

**Files:** `tests/dark-factory/plan-revision-recorder.test.ts` (or the resume seam's own test file)

Fixture: a run parked via `worker.question` (`blocked`), then the approval resume. Assert the run's status is `running` afterwards and that a following work event (`pr.opened`) is accepted rather than refused.

**Expected RED:** the resume leaves it `blocked`, and the following event is refused with `requires "type" to resume a blocked run`.

### Task 2 - GREEN: append `run.resumed` on the approval path

### Task 3 - RED/GREEN: an approval does not consume a revision round

Assert `countPlanRevisions` ignores the approval resume's event and still counts each revision. Both cases, or the change trades one bug for another.

### Task 4 - RED/GREEN: the Definition of Done's events reach the store when it is given one

Assert `pr.opened` and `review.round` are persisted, and that a DoD with no store says so instead of discarding silently.

### Task 5 - the gates, plus a real-run proof

## Files likely to change

- `scripts/dark-factory-runner.ts` - append `run.resumed` on the approval resume; pass `runHistory` into `dodDeps`.
- `agent/lib/dark-factory/plan-revision-recorder.ts` - the id form for an approval resume, and the narrowed counter.
- `agent/lib/dark-factory/definition-of-done.ts` - the loud unwired-recorder path.
- `tests/dark-factory/*` - the RED/GREEN pairs above.

## Validation

- Unit tests per leg, then the full suite with the Postgres test DSNs set (as CI runs it), `tsc --noEmit`, and the repo's lint gates on every changed file.
- **Proof on a real run:** a local sandbox run whose details page shows the acceptance-criteria matrix and the test output, and which reads `running` while it codes rather than `blocked`. This is the same local e2e harness used for #698/#699 (WebFeedPOC).

## Risks and open questions

1. **Ordering.** The `run.resumed` write must happen before the coding phase and before any other work event; the store enforces this, so a misplacement surfaces as a refusal rather than silent loss - which is the point of Part 4.
2. **A second terminal write.** With the store wired, the DoD writes its own terminal event AND the finalizer writes one. The existing idempotency key (`markerEventId`) and the DoD's distinct event id (`dod:<runId>:terminal`) are what keep that a no-op; the tests must pin that a run is finalised once.
3. **Scope.** The remaining page gaps (the diff is never captured, the checkpoints panel shows names only) are [#704](https://github.com/ricardoblackskye/agent-eve/issues/704) and are NOT part of this change.
