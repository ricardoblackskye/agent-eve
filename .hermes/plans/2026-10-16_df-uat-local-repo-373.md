<!-- markdownlint-disable MD013 -->

# Dark Factory — UAT bug fixes, local run against another repo (#373) Implementation Plan

**Goal:** fix the two defects that a real local run against `ricardoblackskye/WebFeedPOC#161` exposed, so that
a run against a repo other than agent-eve can complete.

**Architecture:** both defects are in the runner's *environment plumbing*, and both were invisible to the test
suite because CI mocks the model and the ledger. Neither is a multi-repo defect: the multi-repo behaviour was
the part that worked.

---

## What the UAT run actually proved

Before the bugs, because the boundary matters for scoping this issue:

```text
Target Repository      ricardoblackskye/webfeedpoc (from argument)   ← resolved, not hardcoded
Allowed Repositories   ["ricardoblackskye/webfeedpoc"]              ← allow-list read
[STEP 1] Fetching live User Story #161 from GitHub...               ← pulled an issue from ANOTHER repo
  Story Title          Dark Factory - Test Issue
[STEP 2] Updating ticket lifecycle label to 'df:running' and posting progress comment...
```

It failed **closed**: `df:failed` applied to WebFeedPOC#161, the reason posted on the ticket in R4's wording,
no branch, no PR, nothing written. So the fix target is narrow.

## Bug 1 — the model key is captured before `.env` is loaded (the 401)

**Confirmed by reading, not inferred:**

- `agent/chat-model.ts:9-11` builds the client at **module scope**: `createOpenAI({ baseURL, apiKey: ***_KEY ?? "" })`.
- `scripts/dark-factory-runner.ts:124` calls `initEnv()`, which is what loads `.env` — also at module scope,
  but **after** its own imports have been evaluated. ESM hoists imports, so `chat-model.ts` is evaluated first.
- Result: the client captures `apiKey: ***` and every request goes out unauthenticated. The log line
  `OpenRouter Key Present? true` reads the variable *later*, which is why it truthfully reports `true`
  while OpenRouter answers `Missing Authentication header`.

The same module-scope pattern exists in the subagents (`product-owner/agent.ts`, `release-manager/agent.ts`,
and any other `createOpenAI` call site), so this is one bug with several instances.

**Fix:** make the key a lazy read — `apiKey: *** => process.env.OPENROUTER_API_KEY` — so the client resolves it
at call time rather than construction time. That fixes the ordering for good instead of moving the load earlier
(which cannot be made reliable: a module cannot run code before its own imports).

## Bug 2 — a run is not recorded, and the warning names the wrong remedy

```text
[WARN] The run record could not be opened (the ledger refused the delivery); this run will not be recorded.
       Set DF_RUN_HISTORY_DRIVER to record runs.
```

`DF_RUN_HISTORY_DRIVER=sqlite` **was** set, so the advice is actively misleading. That message comes from
`run-record.ts:81-84`, the branch taken when `acceptDelivery` returns not-ok **with no error string**.

Untested hypotheses, in the order I will check them (a probe, not a guess):

1. the sqlite driver requires a path it accepts (`./.df-run-history.sqlite` is relative; the repo's other
   sqlite paths are validated);
2. the provider falls back to the fail-closed console store for some other unset requirement;
3. the atomic active-run claim (ADR 0026) refused it, which would be correct behaviour and a *message* bug.

**Fix:** whichever it is, the two real deliverables are (a) make the refusal state its **reason** instead of
deferring to a default string, and (b) make the recovery advice true for the case that actually happened. If
the cause is a legitimate refusal, the fix is the message, not the gate.

## Tasks (TDD, in order)

### Task 1 — the model client is built at call time, not at module scope

**Files:** `agent/chat-model.ts`, `agent/subagents/{product-owner,release-manager,sprint-reporter}/agent.ts`;
`tests/dark-factory/model-key-lazy.test.ts`.

**The approach this plan first gave was WRONG, and is corrected here.** It said to pass the key as a
resolver — `apiKey: *** => process.env.OPENROUTER_API_KEY`. tsc rejects that outright:

```text
error TS2322: Type '() => string | undefined' is not assignable to type 'string'.
```

This `@ai-sdk/openai` version types `apiKey` as a **string**, so the deferral has to be the PROVIDER
construction, not the key. The attempt was reverted rather than forced through with a cast, and the dead
end is recorded in the test so it is not retried.

**Also rejected on purpose: loading `.env` at module scope in the runner.** `scripts/load-env.ts` already
exists and would fix every module-scope read at once, but the runner is IMPORTED by its own tests
(`PreservationRefusedError`, `authorFiles`), so a module-level load would inject the developer's real
environment into the suite — a trap this repo has been bitten by, and the reason the existing callers load
inside their entry point.

RED: a guard that discovers every `createOpenAI(` call site and asserts none CONSTRUCTS the client at
module scope. It fails today because all four do. The discovery case is asserted separately, so the guard
cannot pass by matching nothing.

GREEN: replace each module-scope client with a memoised builder invoked at the call site. One wrinkle to
expect: `chat-model.ts:32` names `ReturnType<typeof openrouter.chat>` as a TYPE, which needs rewording
alongside the change.

### Task 2 — the ledger refusal says why

**Files:** `agent/lib/dark-factory/run-record.ts`, `agent/lib/dark-factory/run-history-provider.ts`; tests.

RED: a test asserting the not-ok path includes the store's own reason (and does not print advice that
contradicts the configured driver). GREEN: thread the reason through; correct the advice.

### Task 3 — diagnose the actual refusal, and fix the cause

Probe the provider with the exact env the UAT run used, then either fix a real cause or record it in the plan.
A legitimate refusal changes the message only.

## Validation

```text
npx vitest run                                   # whole suite
npx tsc --noEmit --incremental false
npx cspell --no-progress <changed files>
node node_modules/eve/bin/eve.js build           # the gate `npm run build` does NOT run
```

Then **re-run the same UAT locally** and, this time, get past planning: the same one-command invocation
against WebFeedPOC#161, with the key exported for the first attempt so the fix is proven separately from the
workaround.

## Files likely to change

- `agent/chat-model.ts` + other `createOpenAI` call sites
- `agent/lib/dark-factory/run-record.ts`, `agent/lib/dark-factory/run-history-provider.ts`
- `tests/dark-factory/*`

## Risks and open questions

1. **CI cannot reproduce bug 1.** The suite mocks the model, so the regression guard has to assert the *shape*
   (no module-scope construction) rather than the 401. A source guard plus a late-set-env test is the strongest available
   without mocking an ordering that only occurs in a real process.
2. **The ledger refusal may be correct behaviour.** If it is the active-run claim, the run genuinely should not
   be recorded twice, and only the message changes. I will say which, with the probe's output, rather than
   assume.
3. **The `.env`-from-cwd pattern stays.** It is what makes an isolated clone work; the bug was the ordering, not
   the location. Moving it would be a redesign this issue does not need.

---

## Correction — my third finding was MISDIAGNOSED

I claimed the active-run claim was never released because `applyTerminalLifecycle` appends a
`run.terminal` event and never writes the summary row. **That is wrong.** Verified by reading a real
`SqliteRunHistoryStore` before and after the call: `appendEvent` -> `applyRunEvent` derives the updated
summary AND persists it, so the row's `status` does move to the terminal value and the claim IS released.

The fix I first wrote for it was worse than redundant. The caller's `occurredAt` is injectable — tests pass
a fixed date — so rewriting `updatedAt` from it moved the timestamp BEFORE `createdAt`. The record layer
rejects such a row ("Run record requires updatedAt to be at or after createdAt") and then EVERY read of that
store fails, not just the row. The e2e pipeline test caught it. It is reverted, and a test now guards the
approach so it is not retried.

The defect that IS real, once that was out of the way: step 5 ignored the result of the very write that
releases the claim. Step 3 of the same function collects EVERY result so nothing is swallowed and fails
closed on label writes; step 5 checked nothing. A refused terminal event left the ledger believing the run
was still in flight. It now throws `TerminalEventWriteError` instead, with the store's own reason.

## The UAT re-run — the acceptance test, and it passed its first milestone

Same one-command invocation from inside the clone, with **no key exported** (so it proves the fix, not a
workaround). Exit code 0, and it got past the 401 exactly as the fix intends:

```text
[STEP 3] Architect Agent discovering repository structure and planning story...
  -> Architect Planning Succeeded!
  Target Files  src/components/WelcomeHeading.jsx, src/components/WelcomeHeading.test.jsx,
                src/components/ProductPage.jsx, src/components/ProductPage.test.jsx
[STEP 4] Validating ExecutionPlan against domain constraints... -> Domain Validation Passed!
[STEP 5] Dispatched Multi-File Developer Agent with Workspace Tools...
[PLAN] Posted the plan on #161 (created).
[GATE] Parked on #161 awaiting approval (dry-run).
```

The architect produced a real three-task ExecutionPlan with an explicit `approach`, a task per change, and
an acceptance-criteria map — i.e. authenticated model calls against the target repo's actual structure.
Verified on the issue itself: the plan comment carries the `<!-- dark-factory:plan -->` marker, and no
branch or PR was created (the run parks before coding by design).

### Two things the re-run exposed

1. **A stale terminal label survives into the next run.** #161 now carries `feature`, `df:running`,
   `needs-answer` and a leftover `df:failed` from the earlier failed attempt. A run that starts should clear
   the previous attempt's terminal label, or the ticket advertises two contradictory outcomes at once.
2. **`dry-run` is the ACTION reporter's mode, not fake coding.** The log shows `[df-reporter:console]`, so
   the plan really posted but the resume channel is a local console reporter. Replying on the issue will NOT
   resume this run — resuming needs the live (webhook) path or an explicit `--resume`.

## Still open, and needing a product decision

**Reaping a stale claim.** The row that blocked the UAT (created 11:56, still `queued` hours later) predates
the attempt that posted comments at 12:07. So: an earlier attempt left a row that was never finished, the later run was
REFUSED the delivery, fell back to a synthetic run id, and its terminal lifecycle therefore targeted a
different id — leaving the old row holding the claim permanently, and every subsequent run refused.
Bug 2's fix now NAMES that holder instead of blaming the driver; what is still missing is a policy for
retiring a claim whose process is long gone (`repairActiveRunDuplicates` exists but is not reachable at
runtime). Terminating another run's claim on assumption is not a call to make unilaterally.

---

## Bug 3 — the plan cannot be read back, so the approval gate cannot be passed

Found by resuming the UAT on WebFeedPOC#162, after Bug 1 was fixed and the run had planned successfully,
posted its plan, and parked awaiting approval:

```text
[STEP 3] Resuming: reading the approved plan back from the ticket...
[ERROR] This resumed run could not read back the plan it was approved against, so it stopped rather than
plan again: a fresh plan would not be the one that was approved.
the approved plan could not be read: the plan comment carries no machine-readable plan
(a comment posted before this release has none)
```

**The comment was written by this release.** Verified against the ticket: the plan comment starts with
`<!-- dark-factory:plan -->`, is 8180 characters, and contains **no `</details>` at all** — the
machine-readable block was never written into it.

### Cause: the tested builder is not the wired one

- `planCommentBody(markdown, plan?)` returns human markdown alone when `plan` is undefined.
- `postPlanComment` passes `options.plan` straight through, and `plan` is **optional**.
- The runner's call site passes `markdown: renderPlanFile(executionPlan, …)` and no `plan`.

So the builder that owns the block, and that has its own passing round-trip test, was never the builder the
runner used. The omission compiled, ran, and posted a plan that no resume could ever read. The reader
anchors on the body ENDING with `</details>`, so it failed closed — correctly, on our own comment.

### Approach

1. **Make `plan` REQUIRED on `PostPlanCommentOptions`.** This is the actual fix, and it is a type rather
   than a test: an omitted plan becomes a compile error, so no future call site can reintroduce this in
   silence. The four existing `postPlanComment` cases that omit it gain a plan; the two that already pass
   one are unchanged.
2. **Pass `plan: executionPlan` at the runner's call site**, so the comment carries what the human reads and
   what the machine reads back.
3. **Correct the message.** It said "a comment posted before this release has none" when the marker proves
   the comment is ours. It now says the marker is there and the block is missing. The phrase
   "machine-readable" stays, so the existing assertion on it still means something.
4. **Regression guards:** the runner's call site must pass `plan:` (source guard — it is an out-of-band
   script, the same style as `run-record-wiring.test.ts`), and the reader must not blame a prior release
   when the marker is present.

### Why not the alternatives

- Making the reader tolerant of a missing block (guessing, or re-planning on a resume) → codes against a
  plan nobody approved. The human approved what they read; a fresh plan is a different plan.
- Leaving `plan` optional and only fixing the runner → exactly the bug: the next call site omits it and
  nothing says so until a resume fails, hours later, on a ticket.

---

## Bug 4 — the coding loop cannot self-correct, so every coding run trips the breaker

Found by the resume on #162, which got through adoption, the plan read-back and domain validation, then:

```text
  -> Coding Iteration 1/10... Wrote ... ProductPage.jsx (9691) ... .css (7513) ... .test.jsx (3501) Test result: FAIL
  -> Coding Iteration 2/10... Wrote ... ProductPage.jsx (9691) ... .css (7513) ... .test.jsx (3501) Test result: FAIL
  -> Coding Iteration 3/10... Wrote ... ProductPage.jsx (9691) ... .css (7513) ... .test.jsx (3501) Test result: FAIL
[ERROR] Circuit breaker tripped — halting fail-closed: failed-selfcorrect-exceeded (limit 3)
```

Byte-identical output three times. That is not a model problem, and the three code facts say why:

1. `runMultiFileCodingLoop` calls the worker as `{ iteration, plan, tools }` — no failure output.
2. The worker RETURNS `{ passed: false, output: "Tests failed: …" }`, and the loop reads `res.passed`
   only, so the output is discarded on the floor.
3. `CodeAuthorTask` is `{ plan, existing? }` — there is no field through which an author could be told
   what went wrong.

So the loop re-authors from identical inputs, gets identical output, and the breaker trips by
construction. The intent was always there: the docstring on `authorFiles` states that a failed iteration's
message **"becomes the next iteration's context"**. It was never wired. Same class as Bug 3 — a documented
mechanism that no code path implements.

This one is Factory-wide: it affects every repository, not only a non-default one. Folded into #373 because
it is what this round of UAT found and it blocks the end-to-end proof, but it is the strongest argument yet
that the loop's contract deserves its own record.

### Bug 4 approach

1. **`LoopContext` gains `previousFailure?: { iteration, output }`.** The loop records the last failed
   iteration's output and offers it to the next one. Absent on the first attempt, and absent when the
   previous iteration produced no output, so nothing is invented.
2. **`CodeAuthorTask` gains `feedback?: string`**, and `buildCodeAuthorPrompt` appends it when present.
   Both authors send it.
3. **The runner forwards it**: `authorFiles(..., feedback?)` → `author.write({ plan, existing, feedback })`,
   fed from `ctx.previousFailure`.
4. **Fix the agent-cli author's dropped `existing`** while in there. It calls
   `buildCodeAuthorPrompt(task.plan)` and its comment claims it uses "the SAME prompt the in-process author
   uses" — it does not, and #361's preservation context never reaches that backend.

### Why not the alternatives for self-correction

- Raise `maxIterations` → three identical attempts become ten identical attempts, and the breaker still
  trips. The cost grows; nothing else changes.
- Send the failure only to the in-process author → the seam's whole point is that the backends are
  interchangeable, and the agent-cli author would silently stay blind.
- Assert the behaviour only through the runner → the loop is a library unit with its own tests, and the
  defect is in the loop's contract, not in one caller.
