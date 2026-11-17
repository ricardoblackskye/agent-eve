# #672 — the run outcome cannot say "produced a pull request but not certified"

**Issue:** [#672](https://github.com/ricardoblackskye/agent-eve/issues/672) (child of #666)
**Branch:** `feat/df-outcome-vocabulary-672`, based on `origin/main` @ `9353033`

## Goal

Stop a run that produced working code from being recorded as `df:failed`, and record it
as `df:blocked` — a state that says "produced work, awaiting certification" and that a
human can re-trigger without editing labels by hand.

## Root cause (verified in code, not inferred)

The DoD already computes the exact distinction that is being lost. In
`agent/lib/dark-factory/definition-of-done.ts`:

```ts
export type DoneStatus = "done" | "blocked" | "refused";

export interface DefinitionOfDoneResult {
  ok: boolean;
  status: DoneStatus;
  pr?: PullRequestDetails;
  // ...
}
```

Three places then throw it away:

**1. The label vocabulary has no word for it** — `agent/lib/dark-factory/trigger.ts:54`:

```ts
export const TRIGGER_LABELS = {
  running: "df:running",
  done: "df:done",
  failed: "df:failed",
  question: "needs-answer",
} as const;
```

`df:blocked` is **not implemented anywhere**. `grep -rn '"df:blocked"' agent/ scripts/ app/`
returns nothing. Yet `definition-of-done.ts:10` and `:480` both already document it as the
intended behaviour:

> On exhaustion the task stops and becomes `df:blocked` / `needs-answer`.

So this change makes the code match its own documentation rather than inventing vocabulary.

**2. The terminal status has no room for it** — `agent/lib/dark-factory/run-finalizer.ts:26`:

```ts
export type TerminalStatus = "succeeded" | "failed";
```

**3. The runner collapses the verdict to a boolean** —
`scripts/dark-factory-runner.ts:1505`:

```ts
terminalStatus: dodResult.ok ? "succeeded" : "failed",
```

and the finalizer turns everything non-`succeeded` into `df:failed` —
`run-finalizer.ts:227`:

```ts
const terminalLabel =
  terminalStatus === "succeeded"
    ? isDoneGateSatisfied(dodResult)
      ? TRIGGER_LABELS.done
      : null
    : TRIGGER_LABELS.failed;
```

**Observed consequence.** WebFeedPOC#224 produced PR #225 (4 files, tests green) and was
labelled `df:failed`, because the Definition of Done refused to certify while `e2e` and
`MegaLinter` were still `in_progress`. The checks went green minutes later on their own.
Every `terminalStatus: "failed"` call site in the runner (755, 799, 819, 845, 858, 898,
1348, 1421, 1871, 2036) is a genuine crash path and keeps `df:failed`.

**The other half was already fixed.** The comment at the call site records it: *"#659: the
lifecycle follows the VERDICT. It used to be `succeeded` whenever a PR existed, so the
record and the ticket comment agreed with each other and disagreed with the DoD."* #659
removed the **false success**. This issue removes the **false failure**.

## The decision this encodes (agreed on #672)

- A run is not marked `failed` unless it is genuinely failed; "produced work, awaiting
  certification" is its own outcome.
- `df:done` remains the only label that makes a ticket un-triggerable, so `df:blocked` is
  automatically re-triggerable — the guard only refuses labels in its terminal list.
- Re-triggering a crashed run (`df:failed`) is deliberately **out of scope** and tracked
  separately as #677, which changes what "terminal" means.

## Intended fix

### 1. `trigger.ts` — add the word, and one definition of "terminal"

```ts
export const TRIGGER_LABELS = {
  running: "df:running",
  done: "df:done",
  blocked: "df:blocked",
  failed: "df:failed",
  question: "needs-answer",
} as const;

/** Labels that describe a FINISHED attempt. A re-trigger is refused for these and no others. */
export const TERMINAL_LABELS: readonly string[] = [
  TRIGGER_LABELS.done,
  TRIGGER_LABELS.failed,
];
```

- The trigger's guard (`trigger.ts:209`) uses `TERMINAL_LABELS` instead of an inline array.
- **Membership is unchanged** — `df:blocked` is deliberately absent, which is what makes it
  re-triggerable.
- The constant belongs here, in the label owner, because `run-finalizer.ts` already imports
  `TRIGGER_LABELS` from `trigger.ts`; putting it in the finalizer would create an import
  cycle. This also removes the duplicate set currently declared at `run-finalizer.ts:84`
  (`TERMINAL_LABELS`), so "terminal" has one definition — the intent behind #348 R2 and the
  existing `label-source.test.ts`.

### 2. `run-finalizer.ts` — read the verdict instead of a boolean

```ts
export type TerminalStatus = "succeeded" | "blocked" | "failed";
```

The decision follows the DoD's own status when a verdict is present:

```ts
const terminalLabel = dodResult
  ? dodResult.status === "done"
    ? TRIGGER_LABELS.done
    : dodResult.status === "blocked"
      ? TRIGGER_LABELS.blocked
      : null // "refused": #271 leaves it for human review, no terminal label
  : terminalStatus === "succeeded"
    ? null // no verdict on a success: an agent's self-report must never produce df:done (#271)
    : TRIGGER_LABELS.failed; // a genuine crash path
```

Two behaviours change here, both deliberate and both to be stated in the PR body:

- A `blocked` verdict with a PR now yields `df:blocked` instead of `df:failed`.
- A `refused` verdict with a PR now yields **no terminal label** instead of `df:failed`,
  which is what #271 has documented all along (*"a run whose DoD was refused is left for
  human review"*) but which the current code only honours on the `succeeded` branch.
  The in-flight labels (`df:running`, `needs-answer`) are still cleared either way, so the
  ticket does not advertise a state that is over.

### 3. `scripts/dark-factory-runner.ts` — pass the verdict

At the `if (dodResult.pr)` call site, the record should agree with the label:

```ts
terminalStatus: dodResult.status === "blocked" ? "blocked" : dodResult.ok ? "succeeded" : "failed",
```

### 4. Tighten the wiring guard to its intent

`tests/dark-factory/run-finalizer-wiring.test.ts:38` pins the exact expression:

```ts
source.match(/terminalStatus:\s*dodResult\.ok\s*\?\s*"succeeded"\s*:\s*"failed"/g)
```

That is the "guard pinned to an exact string" trap — it breaks on any legitimate change and
says nothing about the behaviour it exists to protect. Re-express it as the intent: the
terminal status at that call site is derived from `dodResult` and not a bare literal, and
the lifecycle still follows the verdict rather than the mere existence of a PR.

## Tasks (TDD — RED and GREEN as separate commits)

### Task 1 — RED: the DoD's `blocked` verdict must not be a failure

`tests/dark-factory/run-finalizer.test.ts`: a run with a PR and `dodResult.status === "blocked"`
expects `add:df:blocked` in the label ops, expects **no** `add:df:failed`, and expects
`df:running` and `needs-answer` still removed.

Run: `npx vitest run tests/dark-factory/run-finalizer.test.ts`
Expected: FAIL — the current code emits `add:df:failed`.

### Task 2 — RED: the `refused` verdict is left for human review (#271)

Same file: a run with a PR and `dodResult.status === "refused"` expects **no** terminal label
added, and the in-flight labels cleared.

Expected: FAIL — the current code emits `add:df:failed`.

### Task 3 — RED (control): a genuine crash is still `df:failed`

`terminalStatus: "failed"` with **no** `dodResult` expects `add:df:failed`.

This case already passes today. It is in the set deliberately: without it, a change that
marked everything `df:blocked` would satisfy Tasks 1 and 2. The control is what makes them
mean something.

### Task 4 — RED: `df:blocked` is re-triggerable, and `df:done` is not

`tests/dark-factory/trigger.test.ts`: an `issues` labelled event on a ticket carrying
`df:blocked` **is** accepted as a trigger, while `df:done` and `df:failed` are still refused
with the existing reason text.

Both directions in one task: the acceptance alone would pass if the guard were deleted
entirely, and the refusal alone would pass if the new label were never added.

### Task 5 — GREEN: the vocabulary and the decision

Apply sections 1–3 above. Run the three test files, then the full suite for regressions.

Commit convention per this repo: `test(672): RED — ...` then `feat(672): GREEN — ...`.

### Task 6 — the wiring guard

Update `run-finalizer-wiring.test.ts` to the intent (section 4). It may go red as a
consequence of Task 5, in which case this task is what makes it green again.

### Task 7 — ADR 0085

`docs/adr/0085-a-run-that-produced-work-is-not-marked-failed.md` — the decision, the forces
(a blocked DoD is not a code failure; `df:done` alone is terminal), and the consequence that
`df:failed` now means an error path. Add the index row to `docs/adr/README.md` using the
**pinned** `npx -y markdown-table-formatter@1.6.1` (write in place), and keep the row short
enough to fit the existing column width so the formatter does not re-pad the table.

### Task 8 — docs

Grep `docs/pages/` for the `df:*` labels and add `df:blocked` wherever the lifecycle is
documented, with the meaning "produced work, awaiting certification; re-triggerable".

## Files likely to change

| File                                              | Change                                                                                             |
|---------------------------------------------------|----------------------------------------------------------------------------------------------------|
| `agent/lib/dark-factory/trigger.ts`               | add `blocked`, own `TERMINAL_LABELS`, guard uses it                                                |
| `agent/lib/dark-factory/run-finalizer.ts`         | `TerminalStatus` + `"blocked"`; decision reads `dodResult.status`; drop the duplicate terminal set |
| `scripts/dark-factory-runner.ts`                  | call site passes the verdict                                                                       |
| `tests/dark-factory/run-finalizer.test.ts`        | Tasks 1–3                                                                                          |
| `tests/dark-factory/trigger.test.ts`              | Task 4                                                                                             |
| `tests/dark-factory/run-finalizer-wiring.test.ts` | Task 6                                                                                             |
| `docs/adr/0085-*.md`, `docs/adr/README.md`        | Task 7                                                                                             |
| `docs/pages/*.md`                                 | Task 8                                                                                             |

## Validation

- `npx vitest run tests/dark-factory/run-finalizer.test.ts tests/dark-factory/trigger.test.ts`
- Full suite: `npx vitest run` (baseline on `origin/main` is 3658 passed / 15 skipped with
  CI's DB env vars exported)
- `npx tsc --noEmit --incremental false` — a bare `npm run typecheck` can pass on a stale
  build-info, so the flag matters
- Local lint gate on the changed files, all of it, before the push: `npx -y cspell@9.1.1`,
  `npx -y markdownlint-cli@0.45.0` with the config **file** (`{default:false, MD040, MD047,
  MD026}`), `npx -y markdown-table-formatter@1.6.1 --check`. The plan file itself is linted:
  fenced blocks carry `text`, headings carry no trailing punctuation, the file ends in a
  single newline.
- `grep -rn "df:blocked" agent/ scripts/` should show the new label in the vocabulary and
  the decision, and nowhere else.

## Risks and open questions

- **Existing tests may encode today's behaviour.** `run-finalizer.test.ts:126` ("a failed run
  applies df:failed") is expected to keep passing because its fixture carries no `dodResult`
  — that is the crash path. If any fixture *does* carry a `dodResult`, the assertion changes
  and the reason must be stated in the commit and the PR body: the old assertion was
  encoding the defect.
- **`df:blocked` will be auto-created on the target repo** the first time it is applied (the
  labels API creates a missing label with a default color). Worth deciding whether to
  pre-create it with a color and description on WebFeedPOC for a tidier board — a
  user-side action, not a code one.
- **Open question for GATE 1:** should `refused` really get *no* label, or should it get
  `df:blocked` too? The plan follows #271 ("left for human review") because it is the
  documented intent, but `refused` (a missing acceptance map, an unresolved security
  finding) is arguably also "produced work, awaiting certification". Deciding this now costs
  one line; deciding it later costs another PR.
- **Not in scope:** making `df:failed` re-triggerable — #677.
- **Not in scope:** the two findings that share the DoD's output path, #673 (the empty AC
  matrix) and #676 (the bounded check wait). They are separate issues and must not be folded
  into this branch.
