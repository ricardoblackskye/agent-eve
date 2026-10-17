# Dark Factory — a comment on the plan may request a revision (Issue #378) Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** A comment on a parked plan that is not an explicit approval is plan FEEDBACK: the Architect Agent amends the plan, the plan comment is updated in place, and the run re-parks for approval. The run never codes without explicit approval, and the number of revision rounds is capped.

**Architecture:** One PURE classifier decides approval versus revision; the architect gains an `amendPlan` entry point beside `planStory`; the runner's resume branch splits on the classifier and refuses once the revision cap is reached. The deployed webhook path gets the same classifier as a fail-closed guard.

**Tech Stack:** TypeScript, Vitest, the Dark Factory runner (`tsx`), GitHub REST (issue comments), the existing `ExecutionPlan` validator and run-history ledger.

---

## Verified current state

Read from the code on 2026-10-17. Every line reference below was checked, not recalled.

| Fact                                                                               | Evidence                                          |
|------------------------------------------------------------------------------------|---------------------------------------------------|
| A comment on a ticket decodes as `resume` and the body is carried as `commentBody` | `agent/lib/dark-factory/trigger.ts:266-271`       |
| The resume intent sets `resume: true` and fences the comment as user-supplied data | `agent/lib/dark-factory/entry.ts:150, 184-196`    |
| A resume is accepted only against a `blocked` holder                               | `agent/lib/dark-factory/entry.ts:584-655`         |
| The runner knows only `--resume`; the comment text never reaches it                | `scripts/dark-factory-runner.ts:252`              |
| On a resume the plan is NOT regenerated and the architect is never called          | `scripts/dark-factory-runner.ts:360-426`          |
| The failure message already distinguishes a resume from a fresh run                | `agent/lib/dark-factory/plan-approval.ts:139-147` |
| The plan comment is updated in place on a re-post                                  | `agent/lib/dark-factory/plan-comment.ts:175-223`  |
| A machine-readable plan must END the comment with `</details>`                     | `agent/lib/dark-factory/plan-comment.ts:123-156`  |
| The architect exposes `planStory(story)` and no amendment entry point              | `agent/lib/dark-factory/architect-agent.ts:358`   |
| The deployed resume POSTs `{ message, runId, resume }` to the session handoff      | `agent/lib/dark-factory/entry.ts:940-986`         |
| The store can list a run's events, so a revision count is readable                 | `agent/lib/dark-factory/run-history-store.ts:152` |
| The event-type union is CLOSED, so a revision event is a schema-visible change     | `agent/lib/dark-factory/run-history.ts:52-63`     |

**The gap.** A comment can only ever resume a run. `--resume` reads the frozen plan back off the ticket and codes against it, so a comment saying "the target file is wrong, please update the plan" changes nothing while appearing to honour the human. The only way to change a plan today is a fresh run (remove and re-add the trigger label), which loses the thread of the original approval.

## Decisions — CONFIRMED

All five were settled by the user on Issue #378 and in review of this plan. The plan must not re-pose them as open questions.

1. **Approval is OPT-IN and fail-closed.** Only explicit approval wording counts as approval. Any other comment is revision feedback. The run must never code without explicit approval.
2. **A revision re-parks; it never falls through to coding.** A revision round costs one architect call and the run stays `blocked` until an explicit approval arrives.
3. **Clearing the `needs-answer` label remains an approval.** The parked question advertises it, and it is an explicit human act. Unchanged by this change.
4. **Revision rounds are capped at 5.** The cap is read from `DF_MAX_PLAN_REVISIONS` (default 5). On reaching the cap
   the run stops and ends terminally with a message naming the cap and the env var, rather than revising forever.
   A future change may replace the wording allow-list with a model-based classifier that scores whether a reply is
   genuinely asking for a revision; that is a recorded follow-up, not part of this change.
5. **The deployed path gets the GUARD only.** A revision comment must not start coding there. Full amendment on the deployed path is a later change, because that path resumes into the agent session and has no planning stage of its own.

## Proposed approach

Four pieces, one of them shared by both execution paths:

1. **The classifier** — `classifyPlanResponse(commentBody)` in a new `agent/lib/dark-factory/plan-response.ts`. Pure, offline-testable, no network. It returns a `kind` of `approval` or `revision` plus a REASON, matching the reason-bearing style of `decideDarkFactoryTrigger`.
2. **The cap** — `resolveMaxPlanRevisions(env)`, defaulting to 5, plus a recorded revision event so the count is durable and auditable.
3. **The amendment** — `ArchitectAgent.amendPlan({ story, currentPlan, feedback })`, sharing the parse-validate-retry core with `planStory`.
4. **The branch** — the runner's resume path splits on the classifier and refuses past the cap; the deployed webhook path uses the same classifier as a guard.

The comment reaches the runner through a new `--answer-file <path>` argument — a FILE, not an argument value. That keeps user text out of the process list and out of shell quoting, and it matches the repo's existing rule that user-supplied text is data, never instructions. Argument resolution belongs in `agent/lib/dark-factory/runner-config.ts`, beside `resolveIssueNumber` and `resolveBranchName`.

## Tasks

### Task 1 — The classifier (RED then GREEN)

**Objective:** A pure function that decides approval versus revision from a comment body.

**Files:**
- Create: `agent/lib/dark-factory/plan-response.ts`
- Test: `tests/dark-factory/plan-response.test.ts`

**Step 1: Declare the signature as a stub**

A missing named export fails test COLLECTION, which looks like RED but is not a behavior assertion. Create the module with the real signature and a `throw new Error("not implemented")` body FIRST, then add the tests so they fail for the right reason.

**Step 2: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { classifyPlanResponse } from "../../agent/lib/dark-factory/plan-response";

describe("classifyPlanResponse", () => {
  it("treats an explicit approval as approval", () => {
    expect(classifyPlanResponse("Approved").kind).toBe("approval");
  });
  it("treats approval wrapped in markdown emphasis as approval", () => {
    expect(classifyPlanResponse("**Approved**").kind).toBe("approval");
  });
  it("treats approval followed by a request as a revision", () => {
    expect(classifyPlanResponse("Approved, but also update the header").kind).toBe("revision");
  });
  it("treats an unrelated comment as a revision", () => {
    expect(classifyPlanResponse("thanks, what is the ETA?").kind).toBe("revision");
  });
  it("treats an empty comment as a revision", () => {
    expect(classifyPlanResponse("").kind).toBe("revision");
  });
  it("does not approve on the word 'approved' inside a negation", () => {
    expect(classifyPlanResponse("not approved - change the target file").kind).toBe("revision");
  });
});
```

**Step 3: Run it and confirm it fails for the right reason**

Run: `npx vitest run tests/dark-factory/plan-response.test.ts`
Expected: FAIL on the assertions, with the module loading.

**Step 4: Implement**

```ts
export type PlanResponseKind = "approval" | "revision";

export interface PlanResponseDecision {
  kind: PlanResponseKind;
  reason: string;
  matched?: string;
}
```

Rules the implementation must hold:
- Normalize first: trim, strip markdown emphasis and backticks and surrounding quotes, collapse whitespace, lowercase, drop trailing punctuation.
- **Approval is a WHOLE-MESSAGE match** against one documented allow-list. Containment is not enough: "Approved, but also update the header" must be a revision, because a comment carrying a request is feedback.
- Everything else is a revision: empty, unrelated, a question, or any negative phrasing.
- The allow-list lives in ONE exported constant so the ticket wording and the tests agree on it.

Allow-list to confirm while writing the tests: `approved`, `approve`, `i approve`, `i approve the plan`, `lgtm`, `looks good`, `go ahead`, `proceed`, `ship it`.

**Step 5: Run to green**

Run: `npx vitest run tests/dark-factory/plan-response.test.ts`
Expected: PASS.

### Task 2 — The revision cap

**Objective:** Count revision rounds durably and refuse past the cap.

**Files:**
- Modify: `agent/lib/dark-factory/plan-response.ts` (the env resolver, beside the classifier)
- Modify: `agent/lib/dark-factory/run-history.ts` (event-type union and `RUN_EVENT_TYPES`)
- Modify: `app/dark-factory/ui/view-model.ts` (a human label for the new event)
- Modify: `.env.example`
- Test: `tests/dark-factory/plan-response.test.ts`, `tests/dark-factory/run-history.test.ts`

**Step 1: Write the failing tests**

```ts
it("defaults the revision cap to 5", () => {
  expect(resolveMaxPlanRevisions({})).toBe(5);
});
it("reads the revision cap from the environment", () => {
  expect(resolveMaxPlanRevisions({ DF_MAX_PLAN_REVISIONS: "2" })).toBe(2);
});
it("refuses a malformed cap rather than defaulting silently", () => {
  expect(() => resolveMaxPlanRevisions({ DF_MAX_PLAN_REVISIONS: "abc" })).toThrow();
});
```

A blank value counts as unset and falls through to the default; a supplied-but-invalid value is REFUSED, not defaulted. That mirrors the repo's existing rule for per-repo settings: falling through on a malformed value would silently use a different number than the one asked for.

**Step 2: Add the event type**

Add `run.plan_revised` to the `RunEventType` union AND the `RUN_EVENT_TYPES` array. Declare its status constraint in `toRunEvent` beside the `run.resumed` rule: a plan revision is recorded while the run is `blocked`, because the run re-parks around it.

**Step 3: Run to green**

Run: `npx vitest run tests/dark-factory/plan-response.test.ts tests/dark-factory/run-history.test.ts`

**Step 4: Name the env var in `.env.example`**

Its absence reddens `tests/env-example-coverage.test.ts` the moment a source file reads it.

### Task 3 — The amendment entry point

**Objective:** Let the architect produce a revised plan from the current plan plus human feedback.

**Files:**
- Modify: `agent/lib/dark-factory/architect-agent.ts`
- Test: `tests/dark-factory/architect-agent.test.ts`

**Step 1: Write the failing test** — assert that `amendPlan` returns a parsed `ExecutionPlan` whose target files reflect the feedback, and that the retry budget is honored on an invalid response.

**Step 2: Add the surface**

```ts
export interface PlanAmendmentInput {
  story: StoryInput;
  currentPlan: unknown;
  feedback: string;
}

async amendPlan(input: PlanAmendmentInput): Promise<ArchitectResult>;
```

- Extract the parse-validate-retry core shared with `planStory` (DRY). The observable behavior of `planStory` must not change — the existing tests are the pin.
- The amendment prompt carries the story, the CURRENT plan serialized, and the feedback. Fence the feedback and label it user-supplied data, never instructions: that text flows to an agent which then writes code.
- Reuse `DefaultPlanParser` and `validateExecutionPlan` unchanged.

**Step 3: Run to green**

Run: `npx vitest run tests/dark-factory/architect-agent.test.ts`

### Task 4 — Plumb the answer to the runner

**Objective:** The runner can receive the human's comment.

**Files:**
- Modify: `agent/lib/dark-factory/runner-config.ts` and its test
- Modify: `scripts/dark-factory-runner.ts`

**Step 1: Write the failing test** for a resolver with this contract:

```ts
export type RunnerAnswerResult =
  | { ok: true; answer?: string }
  | { ok: false; error: string };
```

- No `--answer-file` present leads to `{ ok: true }` with no answer.
- A readable file leads to `{ ok: true, answer: "<contents>" }`.
- A named but unreadable or missing file leads to `{ ok: false, error }`. **REFUSE, never fall back to "no answer".** A silent fallback would turn a revision into an approval, which is the exact failure this change exists to prevent.

**Step 2: Read the answer in the runner** next to the existing `isResume` read at `scripts/dark-factory-runner.ts:252`.

**Step 3: Run to green**

Run: `npx vitest run tests/dark-factory/runner-config.test.ts`

### Task 5 — The revision branch in the runner

**Objective:** A revision amends, records a round, and re-parks. Approval keeps today's behavior. Past the cap, the run ends terminally.

**Files:**
- Modify: `scripts/dark-factory-runner.ts`
- Test: `tests/dark-factory/runner-plan-revision.test.ts`

**Step 1: Write the failing test** pinning the invariant mechanically — the same way #365 R4 pins that the architect is never called on a resume:

- With a revision answer: `amendPlan` IS called, `postPlanComment` runs, `parkForApproval` runs, and **`runCodingPhase` is NEVER invoked**.
- With a revision answer once the cap is reached: the run ends terminally and `amendPlan` is NOT called.
- With an approval answer: the coding phase IS reached and `amendPlan` is NOT called.
- With no readable answer: the run refuses rather than coding.

**Step 2: Implement the split** in STEP 3, where `isResume` is handled today (`scripts/dark-factory-runner.ts:360-426`):

- Approval leads to today's path, unchanged: `loadApprovedPlan`, then code.
- Revision leads to: count the run's `run.plan_revised` events; if the count has reached the cap, fail terminally
  naming the cap and the env var; otherwise `loadApprovedPlan` (this is the CURRENT plan), then
  `architectAgent.amendPlan({ story, currentPlan, feedback })`, then `validateExecutionPlan`, then
  `postPlanComment` (updates the plan comment IN PLACE), then record `run.plan_revised` under an event id derived
  from the comment id so a re-delivered comment is a no-op, then `parkForApproval`, then report and RETURN
  without coding.
- Fail-closed: if the current plan cannot be read, or the amendment fails validation, apply the terminal failed lifecycle with the existing `explainPlanFailure` story, exactly as the fresh planning path does.

Note the structure-preserving rule for the plan comment: the machine-readable block is anchored on the comment ENDING with `</details>`. `postPlanComment` already rebuilds it correctly, so use that builder and never a hand-rolled concatenation.

**Step 3: Run to green**

Run: `npx vitest run tests/dark-factory/runner-plan-revision.test.ts`

### Task 6 — The deployed path must not read a revision as approval

**Objective:** On the deployed webhook path, a revision comment must not hand off a plain resume into coding.

**Files:**
- Modify: `agent/lib/dark-factory/entry.ts`
- Test: `tests/dark-factory/entry.test.ts`

- Classify `intent.answer` at the resume branch (`agent/lib/dark-factory/entry.ts:584-655`).
- A revision must NOT build `{ resume: true }` with the current handoff message. Hold it and post the reason, so the human knows the feedback was seen and the plan is being revised.
- Fail-closed: an unclassifiable answer is a revision.

### Task 7 — ADRs, index, and docs

**Files:**
- Create: `docs/adr/0041-df-plan-approval-is-opt-in.md`
- Create: `docs/adr/0042-df-plan-revision-needs-approval.md`
- Modify: `docs/adr/README.md` (index rows)

ADR 0041 records decision 1: approval is opt-in and fail-closed, and every other comment is feedback. ADR 0042 records decisions 2, 3, 4 and 5: a revision amends in place and re-parks, clearing the question label stays an approval, revision rounds are capped at 5, and the deployed path ships the guard only.

Document the new `--answer-file` argument and the new `DF_MAX_PLAN_REVISIONS` variable where the runner's other arguments and variables are documented.

Run: `npx vitest run tests/adr-integrity.test.ts`
Expected: PASS — numbers gap-free, no orphan records.

### Task 8 — Prove it on the local runner

**Objective:** Demonstrate the loop end to end, on this machine.

On a disposable clone of a target repo:

1. Run fresh and let it park with a plan (`needs-answer`).
2. Resume with a REVISION answer file. Expect the plan comment updated IN PLACE, the run re-parked, and NO code written.
3. Resume with an APPROVAL answer file. Expect coding to start.

**Carry the #166 lesson into this step:** verify the amended plan's target file against the repo before approving. A plan can name a shared component when the story means a page — that reached a real PR once. Check with a search for which page composes the named component.

## Files likely to change

| Action | Path                                               |
|--------|----------------------------------------------------|
| Create | `agent/lib/dark-factory/plan-response.ts`          |
| Create | `tests/dark-factory/plan-response.test.ts`         |
| Create | `tests/dark-factory/runner-plan-revision.test.ts`  |
| Create | `docs/adr/0041-df-plan-approval-is-opt-in.md`      |
| Create | `docs/adr/0042-df-plan-revision-needs-approval.md` |
| Modify | `agent/lib/dark-factory/architect-agent.ts`        |
| Modify | `agent/lib/dark-factory/runner-config.ts`          |
| Modify | `agent/lib/dark-factory/entry.ts`                  |
| Modify | `agent/lib/dark-factory/run-history.ts`            |
| Modify | `app/dark-factory/ui/view-model.ts`                |
| Modify | `scripts/dark-factory-runner.ts`                   |
| Modify | `.env.example`                                     |
| Modify | `docs/adr/README.md`                               |
| Modify | `tests/dark-factory/architect-agent.test.ts`       |
| Modify | `tests/dark-factory/entry.test.ts`                 |
| Modify | `tests/dark-factory/run-history.test.ts`           |

## Validation

- `npx tsc --noEmit --incremental false` — clean. Vitest strips the types without type-checking, so the suite can be green while `tsc` rejects the code.
- `npx vitest run` — the FULL suite. The module suites are not the whole gate: `env-example-coverage`, `doc-drift-guards` and `adr-integrity` live at the tests ROOT.
- Local lint gate on every changed file BEFORE any push: `markdownlint` (MD040, MD026, MD018) and `markdown-table-formatter@1.6.1` run from a CONFIG FILE, plus `cspell` — reword, never teach the dictionary.
- `npx vitest run tests/adr-integrity.test.ts tests/doc-drift-guards.test.ts tests/env-example-coverage.test.ts`
- Task 8's three-step demonstration on this machine.

## Commit plan

RED and GREEN are SEPARATE commits, so the history shows the failing test preceding the code that answers it.

```text
plan(df): 378 let a comment on the plan request a revision            (already pushed)
test(df): 378 RED - the plan response classifier and the revision cap
feat(df): 378 GREEN - classify a plan reply and cap revision rounds
test(df): 378 RED - the architect must be able to amend an approved plan
feat(df): 378 GREEN - amendPlan beside planStory
test(df): 378 RED - a revision must amend and re-park, never code
feat(df): 378 GREEN - the runner revision branch and the answer file
test(df): 378 RED - a revision must not start coding on the webhook path
feat(df): 378 GREEN - guard the deployed resume
docs(df): 378 ADR 0041 and ADR 0042, the env var and the new argument
```

Verify a RED/GREEN split against the trees, never the commit messages: `git show <red-sha>:<path>` must not contain the implementation symbol.

## Risks and open questions

| Ref | Item                                                                                                                                          | Position                                                                                                                                                       |
|-----|-----------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| R1  | The revision cap could be reached by an incidental comment, since every non-approval reply is a revision.                                     | Accepted. The run ends terminally with a message naming the cap and `DF_MAX_PLAN_REVISIONS`, so the failure is legible rather than silent.                     |
| R2  | `run.plan_revised` is a schema-visible addition to a CLOSED union.                                                                            | Expected surface: the union, `RUN_EVENT_TYPES`, the `toRunEvent` status rule, and the UI label map. Watch `doc-drift-guards`, which can enumerate event types. |
| R3  | A whole-message allow-list can reject a reasonable approval phrased differently.                                                              | The list is ONE exported constant, so extending it is a one-line change with a test. A model-based classifier that scores the reply is the recorded follow-up. |
| R4  | An amended plan can declare a `create` action for a path that already exists, which the runner treats as a mismatch rather than an overwrite. | The amendment prompt should restate the rule.                                                                                                                  |
| R5  | The runner's sandbox is disposed in a `finally` when the coding phase ends.                                                                   | The revision path deliberately never enters the phase, so it must not touch the sandbox at all.                                                                |
