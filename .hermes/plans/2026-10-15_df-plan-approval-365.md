<!-- markdownlint-disable MD013 -->

# Dark Factory: a human authorizes the plan before coding starts

**Issue:** #365 (R4 of four) · **Branch:** `feat/df-plan-approval-361` · **Depends on:** R3 (merged in #366)

R1 and R2 (#361, merged in #363/#364) stopped the loop destroying working code and made it commit what it
really wrote. R3 (#366) made the architect plan properly and post that plan on the ticket before coding.
R4 is the last piece: **make the run stop and wait for a human to approve that plan.**

## What exists already, and what does not (read from the code)

The two halves both exist. Neither is wired, so no run has ever paused for approval.

**The park half is built but never called.**

- `worker-reporter.ts` has `WorkerMessageKind = "question"` and renders `"this run is blocked on a human
  decision"` with the text *"Reply here and the run resumes; it will not consume further iterations while
  it waits."*
- `run-history.ts` derives the run's status FROM an event: `if (event.type === "worker.question") return
  "blocked"`, and it validates that a `worker.question` carries status `"blocked"`.
- The event carries `commentReference?: CommentReference`, documented as *"the system of record for this
  event's question/blocker… the ledger stores the reference, never the text."*
- The runner never emits it. Its only callers are a demo script and tests.

**The resume half is real and tested.** `trigger.ts` decodes a comment on a parked run as `resume`, and
clearing the `needs-answer` label as `resume` too. `entry.ts` requires an active run whose status is
`blocked` before it will resume, and carries the human's comment as **data**, never as instructions.

So R4 wires two existing halves together and inserts the park between planning and coding.

## Design

1. The architect plans.
2. The plan is posted on the ticket (R3, already shipped).
3. **The run parks:** emit the `question` report (which records the comment reference and makes the run
   `blocked`), apply the `needs-answer` label, and return **without running the coding loop**.
4. A human replies, or clears `needs-answer`. The existing trigger path resumes the run.
5. The resumed dispatch **skips planning** and codes against the plan that was approved.

## The design gap this plan has to close

**A resumed dispatch cannot see the parked run's workspace.** The sandbox is disposed when the run parks,
and the resume is a fresh dispatch, so the approved plan cannot be read from a file the run left behind.
It must come from somewhere that survives the gap.

The plan comment survives, and `run-history.ts` already calls the comment *the system of record* for the
question. So the recommendation is:

**Put the machine-readable plan in the plan comment**, alongside the human rendering, inside a collapsed
`<details>` block at the end. `parsePlanFromComment` reads it back. One source of truth: the thing the
human actually approved is the thing the resumed run codes against. The rendering stays first, so a human
reading the ticket still sees the plan, not JSON.

Rejected alternatives:

- **Store the plan in the run record.** The schema deliberately stores *references*, not payloads — a plan
  is a large document, and widening the ledger for it is a bigger change than this release needs.
- **Commit the plan to the branch at park time.** The branch is created by the commit itself, so there is
  nothing to read back from a resume, and it would put a plan for unapproved work on the remote.

**This needs a decision before implementation**, because it changes a module R3 already shipped: R4 would
extend `plan-comment.ts` to carry the JSON as well as the rendering.

## Tasks (TDD, one behaviour per cycle)

Each task is a RED/GREEN pair, and each RED is verified to fail on absent behaviour rather than a broken
module — a `ReferenceError` count of zero is part of the check.

### Task 1: the plan comment carries a machine-readable plan

**Files:** modify `agent/lib/dark-factory/plan-comment.ts`, test `tests/dark-factory/plan-comment.test.ts`.

`planCommentBody` appends a collapsed block containing the plan JSON; `parsePlanFromComment` returns the
plan or a reason it cannot be read. Round-trip: render, post, re-read, same plan. A comment written by an
older run has no block, so parsing must fail **closed** with a clear reason rather than returning a
guessed plan.

### Task 2: the run parks between planning and coding

**Files:** modify `scripts/dark-factory-runner.ts`, test `tests/dark-factory/runner-park.test.ts`.

After the plan comment and before `runCodingPhase`: emit the `question` report, apply `needs-answer`, and
return. Two things to assert: the coding loop was **not** entered, and the park is **idempotent** — a
re-delivery must not post a second question or a second label.

### Task 3: the resumed dispatch codes against the approved plan

**Files:** modify `scripts/dark-factory-runner.ts`, test `tests/dark-factory/runner-park.test.ts`.

When the dispatch carries an explicit resume, read the plan from the ticket's own comment and skip the
architect entirely. Asserted both ways: the architect is **not** called on a resume, and **is** called on
a fresh run.

### Task 4: a plan that cannot be read fails closed

**Files:** modify `scripts/dark-factory-runner.ts`, test `tests/dark-factory/runner-park.test.ts`.

If the approved plan cannot be recovered, the resumed run must stop with a message on the ticket rather
than re-planning (which would code against something the human never approved) or blindly proceeding.

## Verification

The gate has to be proven in **both** directions, and neither direction is proven by a unit test alone:

- **Coding does not start before approval** — park, then assert no loop, no branch, no PR.
- **Coding does start after approval** — resume, then assert the loop runs against the approved plan.

Plus the local gate, and — the lesson from #366 — `node node_modules/eve/bin/eve.js build`, which is the
gate the deployment actually runs and which `npm run build` does not.

## Risks

- **A park that never resumes leaves a ticket blocked forever.** The resume path exists and is tested, but
  R4 must not park a run whose question cannot be posted; if the park cannot be recorded, fail closed.
- **The label is the lock.** Applying `needs-answer` and clearing it are both outside this codebase (the
  human's action), so the design must not depend on a human clearing it *and* replying.
- **R3's module changes under R4.** Extending `plan-comment.ts` is additive, but the round-trip test is
  what stops the two drifting.
