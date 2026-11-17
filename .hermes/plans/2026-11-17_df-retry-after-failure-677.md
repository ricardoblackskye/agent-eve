# #677 — a crashed run must be retryable from the ticket

**Issue:** [#677](https://github.com/ricardoblackskye/agent-eve/issues/677) (child of #672, which came from #666)
**Branch:** `feat/df-retry-after-failure-677`, based on `origin/main` @ `464fc8a` (the merge of #678)

## Goal

Let a human retry a crashed run by re-applying the `dark-factory` label, instead of having to
remove `df:failed` by hand first.

## Root cause (verified in the merged code)

The guard in `agent/lib/dark-factory/trigger.ts` refuses a re-trigger for every label in
`TERMINAL_LABELS`:

```ts
// A run that already reached a terminal state is finished: re-applying the label must
// not start a second one. (Aborting or resuming a finished run is meaningless too.)
for (const terminal of TERMINAL_LABELS) {
  if (issueLabels.includes(terminal)) {
    return decide("not-a-trigger", `the run already reached '${terminal}'; not starting or changing it`);
  }
}
```

and `TERMINAL_LABELS` is `[df:done, df:failed]`. So a ticket carrying `df:failed` - which the
runner applies from eleven crash/error call sites plus the DoD path - is un-triggerable.

**The circularity #677 exists to break:** the rule agreed on #672 is *do not mark a run failed
unless it is genuinely impossible to retry*. But the guard is what makes it impossible to retry. Whether
`df:failed` is an accurate word for the outcome and whether the ticket can be retried are two
different questions folded into one label.

**The mechanics already support a retry.** `run-finalizer.ts` clears `OUTCOME_LABELS`
(`df:done`, `df:blocked`, `df:failed`) at run start - the #373 behaviour - so a fresh attempt
already removes the stale label. The guard is the only thing stopping a deliberate retry from
reaching that code. `#228` and `#230` both demonstrated the symptom: a run that produced a pull
request and could not be retried.

## Intended fix

### 1. Separate "the attempt finished" from "the ticket is closed"

`TERMINAL_LABELS` is not wrong: `df:failed` *does* describe a finished attempt. What the guard
needs is a different question - which labels make the ticket un-triggerable - and the two are no
longer the same set.

```ts
/**
 * Labels that make a ticket UN-TRIGGERABLE (#677). A strict subset of TERMINAL_LABELS, and the
 * difference is the whole point: `df:done` means the work is finished and must not silently be
 * redone, whereas `df:failed` describes a finished ATTEMPT whose ticket a human may deliberately
 * retry. The run-start clearing (#373, OUTCOME_LABELS) already removes the stale label, so no
 * other machinery is needed.
 */
export const RETRIGGER_REFUSED_LABELS: readonly string[] = [TRIGGER_LABELS.done];
```

The guard iterates this instead. Its reason text is unchanged and still accurate
(`the run already reached 'df:done'; not starting or changing it`).

### 2. The three label sets, and why they differ

| Set                        | Members                     | Decides                                  |
|----------------------------|-----------------------------|------------------------------------------|
| `TERMINAL_LABELS`          | `done`, `failed`            | which labels describe a FINISHED attempt |
| `OUTCOME_LABELS`           | `done`, `blocked`, `failed` | what a fresh start CLEARS (#373, #672)   |
| `RETRIGGER_REFUSED_LABELS` | `done`                      | whether a re-trigger is REFUSED (#677)   |

Three sets is the honest count. Collapsing any two of them re-creates one of the defects already
found: collapsing 1 and 3 makes a crashed run impossible to retry, and collapsing 2 and 3 leaves a
re-triggered ticket advertising `df:running` beside a stale outcome label.

### 3. The retry is recorded, with no new vocabulary

A fresh dispatch mints a new run id, so the ledger already holds one row per attempt and the
count is visible per repo+issue - which is the visibility #677 asked for. Worth **verifying**
rather than assuming (see Tasks), but the expectation is that no new event type is needed.

## Tasks (TDD — RED and GREEN as separate commits)

### Task 1 — RED: `df:failed` is a trigger again, and `df:done` still is not

`tests/dark-factory/trigger.test.ts`. Both directions in one case, because either alone passes
for the wrong reason - the acceptance alone would pass if the guard were deleted, and the refusal
alone would pass if nothing had changed.

- a ticket labelled `df:failed` → `kind === "trigger"` (fails today: `not-a-trigger`)
- a ticket labelled `df:done` → `not-a-trigger`, **and the reason names `df:done`**
- a ticket labelled `df:blocked` → `trigger` (the #672 property, re-pinned against this change)

Run: `npx vitest run tests/dark-factory/trigger.test.ts`
Expected: FAIL - `df:failed` is currently refused.

### Task 2 — RED (control): the reason text still identifies the refusing label

The #672 lesson applies: an assertion on `kind` alone is satisfied by any refusal. Assert the
reason mentions `df:done` specifically, so a guard that refused everything cannot pass.

### Task 3 — GREEN: the refused set

Apply section 1. Run the trigger suite, then the full suite.

Commit convention: `test(677): RED — ...` then `feat(677): GREEN — ...`.

### Task 4 — verify the double-run guard, do not assume it

The claim (ADR 0026) is what prevents two concurrent runs, and `local-run-preflight.ts` already
refuses with `claim-held`. Establish by reading, and state in the PR, what actually refuses a
retry while a run is in flight. A ticket mid-run carries `df:running`, not `df:failed`, so the
guard is not even consulted - but a payload could carry both, and the claim must be what refuses
it. If the existing claim tests already cover that, say so and cite them rather than writing a
duplicate.

### Task 5 — verify the retry is visible in the run history

Confirm that N attempts on one ticket produce N run rows (no new vocabulary needed). If the run
history cannot answer "how many times has this ticket been attempted", that is a real gap and
belongs in the plan's own follow-up rather than being silently skipped.

### Task 6 — ADR 0086

`docs/adr/0086-a-failed-attempt-is-retryable.md`. This **decides** what 0085 deliberately left
open - 0085 says so in its own Consequences: *"Deliberately not decided here: whether `df:failed`
should also be re-triggerable ... changes what 'terminal' means and is tracked separately as
#677."* So 0086 needs no supersede; it records the decision, and should name the distinction
that was missing:

- **"terminal"** describes the ATTEMPT's state - it finished.
- **"un-triggerable"** describes the TICKET - it must not be started again.

`df:failed` is terminal but retryable; `df:done` is both. Conflating the two is what made a
crashed run unrecoverable.

Add the index row to `docs/adr/README.md` with the **pinned**
`npx -y markdown-table-formatter@1.6.1` (writes in place, no flag), keeping the row short enough
to fit the existing column width so the formatter does not re-pad the table.

### Task 7 — docs

- `docs/pages/dark-factory-modules.md:679` says the run "must carry a terminal label ... so the
  trigger re-run guard has something to key on". That rationale is now only true of `df:done`;
  update it.
- `docs/pages/dark-factory-local-runs.md:423` names the outcome labels; check whether it claims a
  re-trigger is refused and correct it if so.

## Files likely to change

| File                                                                          | Change                                            |
|-------------------------------------------------------------------------------|---------------------------------------------------|
| `agent/lib/dark-factory/trigger.ts`                                           | add `RETRIGGER_REFUSED_LABELS`; the guard uses it |
| `tests/dark-factory/trigger.test.ts`                                          | Tasks 1-2                                         |
| `docs/adr/0086-a-failed-attempt-is-retryable.md`, `docs/adr/README.md`        | Task 6                                            |
| `docs/pages/dark-factory-modules.md`, `docs/pages/dark-factory-local-runs.md` | Task 7                                            |

No runner change and no new run-history vocabulary are expected. If Task 5 shows otherwise, that
is a finding to raise rather than to widen this branch with.

## Validation

- `npx vitest run tests/dark-factory/trigger.test.ts` then the **full** suite
  (`npx vitest run --exclude 'tests/env-example-coverage.test.ts'`, with CI's DB env vars).
  A targeted run is not a gate: on #672 I pushed on targeted runs while the full suite was still
  going and CI caught what they missed.
- `npx tsc --noEmit --incremental false` - a bare `npm run typecheck` can pass on stale build-info.
- Local lint gate on every changed file before the push: `npx -y cspell@9.1.1`,
  `npx -y markdownlint-cli@0.45.0` with a config **file**, the pinned
  `npx -y markdown-table-formatter@1.6.1 --check`. The plan file itself is linted: fenced blocks
  carry a language, headings carry no trailing punctuation, the file ends in a single newline, and
  every `name@version` token is inside backticks.
- A source-level wiring guard is all the runner gets, so prefer a behaviour test where behaviour
  exists: this change is in a pure decision function, which is directly testable.

## Risks and open questions

- **A retry must not start a second concurrent run.** The claim is the guard, not the trigger
  (Task 4 establishes this precisely). Worth an explicit test only if the existing claim coverage
  does not already show it.
- **An infinite retry loop** is not possible: the trigger fires on a label event, not a schedule,
  so each retry needs a human.
- **Should `df:done` ever be re-triggerable** - to redo work after a revert? The plan says no:
  `df:done` means the work landed, and silently redoing it on a label event would be worse than
  making the operator use a fresh ticket. Flagged for you at GATE 1 because it is the same
  decision one step further on.
- **An aborted run** leaves no terminal label (`entry.ts` clears `df:running` and `needs-answer`
  and applies none - there is no `df:aborted`), so such a ticket is already retryable. Verified
  in recon; no change needed, and it is recorded here so the next reader does not re-derive it.
- **Not in scope:** #679 (the generated plan's unaligned tables) and #674 (the loop log naming
  only the last check). Both are the "factory artifacts must be lint-clean" thread, which is its
  own branch.
