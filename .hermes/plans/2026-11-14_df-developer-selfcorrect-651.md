# Plan: Developer loop - detect no-op self-correction, surface test failures, report terminal failure (#651)

**Issue:** #651
**Branch:** `fix/df-developer-selfcorrect-651`
**Base:** `origin/main` @ `e958ba2`

## Goal

Make the Developer coding loop OBSERVABLE and FAIL-FAST when it cannot self-correct, instead of
silently burning the circuit-breaker budget and aborting with only "the worker budget is exhausted".

## Context (what the run showed)

A real local run (WebFeedPOC#203, PR #642 code) on a trivial ADDITIVE story:

```text
Iteration 1/10: Wrote ProductList.jsx (469 chars), ProductList.test.jsx (1491) -> Test result: FAIL
Iteration 2/10: Wrote ProductList.jsx (469 chars), ProductList.test.jsx (1491) -> Test result: FAIL
Iteration 3/10: Wrote ProductList.jsx (469 chars), ProductList.test.jsx (1485) -> Test result: FAIL
[ERROR] Circuit breaker tripped - failed-selfcorrect-exceeded (limit 3) -> aborted, claim released.
```

The ORIGINAL `ProductList.test.jsx` passes 3/3 on the same checkout, so the suite itself is healthy:
the failure is the Developer's change, and the loop re-emitted byte-identical files.

## What already exists (do NOT rebuild)

- **The feedback loop.** `runMultiFileCodingLoop` carries `previousFailure` (`developer-agent.ts:875-891`)
  and the runner feeds `ctx.previousFailure?.output` into `authorFiles` -> `buildCodeAuthorPrompt`, which
  emits a "### YOUR PREVIOUS ATTEMPT FAILED" section (`code-author.ts:95-105`).
- **A preservation guard.** `assessPreservation` (`preservation-guard.ts`) refuses a `modify` that loses
  more than 50% of the existing lines (`MAX_REMOVED_RATIO = 0.5`); `authorFiles` applies it before writing
  anything and throws `PreservationRefusedError`.
- **Unmeasured vs failed.** `classifyTestRun` + `res.unmeasured` keep "the tests could not start" distinct
  from "the tests ran and failed" (`developer-agent.ts:853`, runner `1120-1163`).
- **A per-iteration outcome tap.** `onUnmeasured` plus the `roadblock` recorder already exist.

## Verified gaps (the real work)

1. **No byte-identical detection.** Nothing notices that iteration N authored the SAME bytes as iteration
   N-1, so a no-op self-correction silently consumes the breaker budget. (`developer-agent.ts:132` already
   NAMES this failure mode in a comment.)
2. **The failing test is invisible.** The runner logs only `Test result: FAIL` (runner `1166`) and discards
   `testOutcome.output`; the failure the model must act on is never shown in the log or the ledger artifact.
3. **`previousFailure` is conditional.** `if (!res.passed && res.output)` (`developer-agent.ts:889`) means an
   empty `output` drops the feedback entirely, so the NEXT iteration is re-invoked with an unchanged
   context - the exact "identical inputs -> identical output" the field exists to prevent.
4. **The terminal failure is not reported.** A run that exhausts its iterations aborts with
   "the worker budget is exhausted" (`developer-agent.ts:836-839`) and posts nothing to the ticket naming
   WHAT failed.
5. **AC3 - preservation for ADDITIVE plans is ratio-only.** A `modify` that keeps at least 50% of lines but
   drops the lines that mattered passes the guard; the observed rewrite (624 -> 469 chars) was sanctioned.

## Root cause (to CONFIRM under test)

The loop CAN self-correct, but a no-op iteration is indistinguishable from a real fix cycle, so three
identical attempts exhaust the breaker. The primary defect is the missing no-op detection plus the silent
failure, not the model.

## Intended fix (TDD, one behaviour per cycle)

- **T1 - Reproduce.** A focused unit test drives `runMultiFileCodingLoop` with a worker that returns
  byte-identical files and a failing test each iteration; pin today's behaviour first.
- **T2 - Always carry the failure.** Change the `previousFailure` condition so a failed iteration ALWAYS
  sets it (synthetic text when `output` is empty), so the next iteration's input differs.
- **T3 - Detect the no-op.** Track the previous iteration's authored content; when an iteration is
  byte-identical to the previous AND still failing, report it as a distinct outcome
  (`no-op self-correction`) and STOP, rather than burning the breaker budget.
- **T4 - Surface the failing test.** Log the bounded test output and attach it to the `review.round`
  artifact (respecting the no-raw-content rule: summarise, do not dump prompts/issues).
- **T5 - Report the terminal failure to the ticket.** On exhaustion, post the last failure reason, naming
  the no-op when that is what happened.
- **T6 - AC3, additive preservation.** Extend `assessPreservation` with the plan's additive intent, or
  tighten the rule for `modify` targets, with tests at the exact boundary.

## Files likely to change

- `agent/lib/dark-factory/developer-agent.ts` - loop: `previousFailure`, no-op detection.
- `agent/lib/dark-factory/preservation-guard.ts` and its test - AC3.
- `scripts/dark-factory-runner.ts` - worker logging and terminal-failure reporting.
- Tests under `tests/dark-factory/`.

## Validation

- New unit tests (RED first) for each acceptance criterion.
- Full suite plus `npx tsc --noEmit --incremental false`.
- `npm run eve:build` (a change under `agent/` must still build).
- Local lint on the changed files (cspell, markdownlint, table formatter, link check).
- Ideally a real local run on WebFeedPOC#203 that now surfaces the no-op instead of a bare breaker trip.

## ADRs

- None expected (no vendor, seam, or posture decision) - UNLESS T6 changes the preservation posture, in
  which case record it.

## Risks and open questions

- **Is the root cause the harness or the model?** If the feedback WAS delivered and the model ignored it,
  T3 is still correct but the true fix is a better model (tracked by #652). The reproduce step (T1) settles
  this.
- The preservation tightening (T6) could refuse legitimate edits - keep it scoped to ADDITIVE plans and
  test the boundary.

## Progress (implementation)

- **T1 (reproduce) - DONE.** `tests/dark-factory/coding-loop-noop.test.ts`. RED observed: the loop ran all
  10 iterations on a repeated failing artefact (`expected 10 to be 2`).
- **T3 (detect the no-op) - DONE.** The loop compares a failing iteration's artefact identity
  (`WorkerResult.artefactHash`) with the previous failing iteration's and stops with
  `LoopResult.stopReason = "no-op-self-correction"`. Verified end to end: `authorFiles` reports the identity
  (`AuthorFilesResult.artefactHash = artefactIdentity(files)`) and the runner's coding worker returns it, so
  the detection is LIVE and not dead code.
- **T4 (surface the failing test) - DONE.** The runner now prints a bounded tail of a failing iteration's
  test output; it previously logged only `Test result: FAIL`.
- **T2 (always carry the failure) - DROPPED, deliberately.** The plan called for synthesizing feedback when a
  failed iteration produced no output. `coding-loop-feedback.test.ts` PINS the opposite as a deliberate
  decision ("nothing is invented for a worker that reports only a verdict"), and the reproduction shows the
  real defect is the no-op, not the missing text. Implementing T2 would reverse a tested decision to fix a
  cause it does not address.
- **T5 (report the terminal failure to the ticket) - OUTSTANDING.** `applyTerminalLifecycle` applies labels
  and carries no reason, so this needs a ticket-comment path; the `roadblock` reporter already used for the
  unmeasured case is the existing seam.
- **T6 (preservation for additive plans) - OUTSTANDING.** Tightening `MAX_REMOVED_RATIO` is a POSTURE change,
  so it wants its own decision rather than riding along here.

