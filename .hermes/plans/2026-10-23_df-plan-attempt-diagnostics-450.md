# Issue #450 — a plan rejection must say which rule rejected it

- **Date:** 2026-10-23
- **Branch:** `fix/plan-attempt-diagnostics-450`
- **Status:** awaiting plan approval (GATE 1)

## Goal

When the Architect gives up, the run must be able to say **what** rejected each attempt and **which rule** fired, and the record must survive the run. Today it says "no attempt produced a valid plan" and nothing else.

## What I established

**The rejection is real but not content-determined.** I re-ran `planStory` against the real model with the real dependencies and it returned `ok: true, retries: 0` on the first attempt. Offline, driving the agent with a stub model that returns the first attempt's plan from the failing run also returns `ok: true`. So the same story can pass or fail across runs, and the plan CONTENT that failed is not reliably reproducible. Any fix that assumes a specific rule fired will be wrong; the fix has to make the failure visible.

**Correction to my earlier reading.** I said the failing attempt's plan "validates, so a good plan was discarded". That is not proven and I am withdrawing it: the failing run print streams the model's output with no delimiter, so I cannot attribute a given JSON object to a given attempt with confidence. What is proven is the `valid: true` result for that TEXT, not that it was attempt 1's text as the loop saw it.

**Three mechanisms make the failure undiagnosable, all in code:**

1. **Each attempt's reason is overwritten.** `runPlanLoop` assigns `lastErrors` on every iteration (`architect-agent.ts:723`, `:730`, `:749`), so when every attempt fails, only the LAST attempt's errors survive. Attempts 1 and 2's reasons are destroyed. The park message is built from that single surviving list.

2. **The park reason can be the wrong one.** `refusedTarget` is computed from the LAST attempt's codes only (`:748`). A `target-role` refusal on attempt 1 followed by any other failure on attempt 3 reports `plan-invalid`, and the human is asked a different question than the one that actually applies.

3. **Nothing durable records the attempts.** There is no run event and no artifact. The only trace is the runner streaming raw model text to stdout (`process.stdout.write(chunk)`, `dark-factory-runner.ts:451`), which concatenates attempts with no separator - so even that record cannot be split back into attempts. Diagnosing this failure required re-deriving the attempts from braces in a log.

**Related but separate:** the repair prompt is identity-free - `buildRepairPrompt` (`:637`) sends only the story NUMBER, the errors, and the previous output. No repository, no story body, no file list. That is the mechanism behind #451, and it also means a repair after a parse failure has no story at all, which is why a retry drifted to a plan about `agent-eve`'s own `architect-agent.ts`. Filed as #451; this issue does not fix it, but the diagnostics added here are what will prove it.

## Intended fix

Make the plan loop's outcome a first-class record instead of a single overwritten string.

1. **Per-attempt outcomes.** Collect, for every attempt, `{ attempt, stage, codes, errors }` where `stage` is `parse` or `validate` - a parse failure and a validation failure are different faults and currently indistinguishable in the message.
2. **Report all of them.** The failure `error` names every attempt, and the result carries the codes as a set. `reason` is derived from the UNION of attempts, so a `target-role` refusal in any attempt parks as `refused-target` and asks the right question.
3. **A delimited attempt record.** Give each attempt a boundary in the streamed output (one line naming the attempt number and verdict, before and after its text) so a park can be attributed from the log. Keep it to the existing stdout channel rather than adding a store.
4. **The park message names the rule.** `explainPlanFailure` states which rule refused and, when the codes differ between attempts, that they differed - rather than "no attempt produced a valid plan".
5. Record the same summary as a run-history event when a history store is configured, so the failure is visible in the board and not only in a terminal.

## Tasks (TDD)

1. **RED - every attempt's reason survives.** Drive `runPlanLoop` with a stub model: attempt 1 fails validation with code `target-role`, attempt 2 fails at PARSE. Assert the result reports BOTH, with their stages, and does not report only the last.
2. **GREEN - collect and report.**
3. **RED - the reason reflects the union.** The same fixture must park as `refused-target`, not `plan-invalid`, because one attempt hit the target rule. A control case with no target-role in any attempt must still be `plan-invalid`.
4. **GREEN - derive from the union.**
5. **RED - attempts are delimited.** Assert the stream the agent produces marks each attempt, so text can be attributed - the assertion is on the emitted stream, not on a source string.
6. **GREEN - emit the delimiters.**
7. **RED - the park text names the rule.** `explainPlanFailure` output contains the code and, for differing attempts, says so.

## Files likely to change

- `agent/lib/dark-factory/architect-agent.ts` - `runPlanLoop` collects attempts; `ArchitectResult` gains the record
- `agent/lib/dark-factory/plan-response.ts` or the failure explainer - name the rule
- `tests/architect-agent-*.test.ts` - the loop fixtures above
- `docs/adr/0057-*.md` + index, `docs/pages/dark-factory-modules.md` if the surface changes

## Risks

- **Do not chase a rule that does not exist.** The temptation is to "fix the validator" that rejected the good plan. I could not reproduce that rejection and the content validates, so a validator change would be a guess. The observable defect is the lost reason; that is what this change fixes, and it will produce the evidence for any follow-up validator work.
- Attempt records carry plan fragments and model text: they go to stdout and the run history, both of which already carry the plan. No new secret surface.
- Reporting more per park may make the comment longer; it replaces an unactionable sentence, so this is a net gain, but the message must stay short enough to read.
