# #675 — a resume that adopts its own run must not be announced as a failure

**Issue:** [#675](https://github.com/ricardoblackskye/agent-eve/issues/675) (child of #666)
**Branch:** `chore/resume-warn-tells-the-truth-675`, based on `origin/main` @ `147d0bb` (the #683 merge)

## Goal

When a resume correctly continues a run the ledger already holds, the log says so. The `[WARN]`
stays for the case it was written for: a conflict that is genuinely a conflict.

## The evidence, from the two runs on disk

Both resumes logged this, and it is the whole issue:

```text
[WARN] The run record could not be opened: the ledger already holds an active run
(58c2f9e6-f298-4b70-805f-8815ef464fc8, status 'blocked') for ricardoblackskye/webfeedpoc#230,
so this attempt was not recorded.
```

```text
[WARN] The run record could not be opened: the ledger already holds an active run
(dc611b92-5415-4119-84b7-1637f00dbd73, status 'blocked') for ricardoblackskye/webfeedpoc#228,
so this attempt was not recorded.
```

**Both named run ids are the runs the resumes then continued.** `58c2f9e6` and `dc611b92` are the
run ids those two resumes ran under, so the warning presents the resume's own run as the thing
blocking it, and calls "not recorded" a run whose records it is in the middle of continuing.

## Root cause: the verdict is pronounced at a layer that cannot make it

`beginRunRecord` owns the conflict branch and logs it unconditionally
(`agent/lib/dark-factory/run-record.ts`):

```ts
if (accepted.activeConflict) {
  const { runId: holderRunId, status: holderStatus } = accepted.activeConflict;
  const conflict =
    `the ledger already holds an active run (${holderRunId}, status '${holderStatus}') for ` +
    `${input.repo}#${input.issue}, so this attempt was not recorded`;
  log(`[WARN] The run record could not be opened: ${conflict}.`);
  return { ..., activeConflict: { runId: holderRunId, status: holderStatus } };
}
```

The caller then makes the decision that makes that message false — `scripts/dark-factory-runner.ts`:

```ts
const begun = await beginRunRecord({ ... });
...
const startDecision = decideRunStart(begun, { resuming: isResume });
```

and `decideRunStart` already answers this case correctly:

```ts
if (options.resuming && status === "blocked") {
  return { kind: "adopt", runId: holder };
}
```

So the correct decision exists, is consulted, and is honoured — after a line has already told the
operator that the attempt was not recorded. A `blocked` run is resumable by design (ADR 0085); a
resume meeting it is the flow working, not failing.

`beginRunRecord` is not in a position to judge, because it is not given `resuming`. The verdict
belongs to `decideRunStart`, which has both facts.

## Intended fix

`beginRunRecord` accepts whether this is a resume, builds its `BeginRunRecordResult` first, and
asks **`decideRunStart`** what the conflict means before it logs anything:

- **adopt** (a resume meeting a `blocked` holder) — an `[INFO]` that names the run being resumed
  and its status. The attempt id is still fresh and still not its own record; the *run* is being
  continued, and that is what the message must say.
- **refuse** (any other conflict) — the existing `[WARN]`, unchanged, because in that case the
  ledger really is standing in the way and an operator needs to hear it.

Reusing `decideRunStart` rather than re-testing `status === "blocked"` in a second place is
deliberate: a duplicated rule is how the two drift apart again.

No ADR. This does not decide anything new — `decideRunStart`'s adopt/refuse split is already the
recorded decision. The fix makes the log agree with it, and the code comment carries that.

## Tasks (TDD — RED and GREEN as separate commits)

### Task 1 — RED: the same conflict, two verdicts

`tests/dark-factory/run-record-refusal.test.ts` owns `beginRunRecord`'s refusal messages. Add:

- a `blocked` holder **with `resuming`** — the log must **not** contain `[WARN]`, must **not** say
  "will not be recorded", and must name the held run as being resumed;
- a `blocked` holder **without `resuming`** — the existing `[WARN]` and its "not recorded" wording
  must remain. This is the control: without it, the fix could pass by silencing a real conflict;
- a **non-blocked** holder with `resuming` — still a refusal, because a resume that meets a
  running run cannot adopt it (`decideRunStart` says so, and the existing test already pins the
  consequence sentence);
- an agreement assertion: for the same result, `beginRunRecord`'s message and `decideRunStart`'s
  `kind` tell the same story, so the two cannot drift apart again.

### Task 2 — GREEN: the decision before the log

Pass `resuming` in, build the result, consult `decideRunStart`, log accordingly.

### Task 3 — confirm against the real logs

State what `df230-resume.log` line 9 and `df228-resume.log` line 9 would now read. Do not edit
those logs; they are evidence.

## Files likely to change

| File | Change |
| --- | --- |
| `agent/lib/dark-factory/run-record.ts` | `beginRunRecord` consults `decideRunStart` before logging |
| `scripts/dark-factory-runner.ts` | pass `resuming: isResume` into `beginRunRecord` |
| `tests/dark-factory/run-record-refusal.test.ts` | Task 1 |

## Validation

- `npx vitest run tests/dark-factory/run-record-refusal.test.ts tests/dark-factory/active-run-claim.test.ts tests/dark-factory/dispatch-blocked.test.ts tests/dark-factory/label-resume-retired.test.ts`
- The **full** suite before the push, with CI's DB env vars and
  `--exclude 'tests/env-example-coverage.test.ts'`. #674's baseline to hold is 3671 passed / 0
  failed, and this adds cases to it.
- `npx tsc --noEmit --incremental false`
- Local lint gate on changed files: `npx -y cspell@9.1.1`, `npx -y markdownlint-cli` with a config
  **file**, the pinned `npx -y markdown-table-formatter@1.6.1`. This plan file included: fenced
  blocks carry a language, no heading carries trailing punctuation, one trailing newline, every
  `name@version` token in backticks, and no line opens with a bare issue reference.

## Risks and open questions

- **The adoption must still happen.** This changes what is logged, never whether a run starts. The
  RED's non-blocked and non-resuming cases pin that the refusal path is untouched, and the
  existing claim and dispatch suites must stay green.
- **Two log levels, one event.** An operator grepping `[WARN]` will stop seeing the adopting case,
  which is the point — but it is worth stating plainly rather than leaving as a surprise.
- **Not in scope:** the other `[WARN]`s in the runner (lifecycle, revision round, cost, calibration
  history), and whether a resume should record its *attempt* as a separate row. The attempt id is
  deliberately fresh per attempt; the summary-row question is #681.
- **This is the same class as #673 and #674**: the system knows the truth, states something else,
  and the difference costs an investigation. #674 hid which check ran; #673 hid why a run did not
  certify; #675 calls a working resume a failure.
