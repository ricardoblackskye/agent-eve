# Issue #450 — a plan rejection must say which rule rejected it

- **Date:** 2026-10-23
- **Branch:** `fix/plan-attempt-diagnostics-450`
- **Status:** GATE 1 cleared — implementing (TDD); empirical scenario pinned from 10 live runs

## Goal

When the Architect gives up, the run must be able to say **what** rejected each attempt and **which rule** fired, and the record must survive the run. Today it says "no attempt produced a valid plan" and nothing else.

## What live runs showed (10 runs, real model, same story and repo)

I ran `planStory` against the real model with the real target checkout ten times — five at the provider's default sampling and five at `temperature: 0, seed: 42`. Every run used the same story (#172) and the same 253-file list.

| batch                      | runs   | ok    | failed |
|----------------------------|--------|-------|--------|
| provider default           | 5      | 4     | 1      |
| `temperature: 0, seed: 42` | 5      | 3     | 2      |
| **total**                  | **10** | **7** | **3**  |

**Setting temperature to 0 did not make the outcome deterministic.** The provider appears to ignore or under-honour both `temperature` and `seed` for this model. So a single live run is **not** a reliable pass/fail gate: the same inputs failed 3 times in 10.

**The failure mechanism is deterministic even though its trigger is probabilistic.** Every failure had the identical shape:

1. **Attempt 1 parsed and looked valid to a plain validator** — `parsed: true`, `valid: true`, no codes.
2. **The agent's context-aware validator rejected it** with `target-missing`: the plan listed `src/pages/HomePage.test.jsx`, which does not exist in the repository. The model invents a test file path and asks to modify it.
3. **The repair prompt then lost the repository and story identity**, so the retry drifted. Attempt 2 returned zero characters after 60s (truncation/timeout); attempt 3 planned against `agent-eve`'s own `agent/lib/dark-factory/architect-agent.ts`.
4. The run parked as `plan-invalid` and reported only the LAST attempt's errors.

**Correction — my earlier "valid plan was discarded" claim is dead twice over.** First I could not attribute the streamed JSON to an attempt. Now the repeated runs show the plan does **not** validate against the real file list: the validator is right to reject it. The defect is not a wrong rejection; it is that the rejection's reason is destroyed and the repair loses identity. My earlier offline replay said `valid: true` only because it validated without the file list — the single most misleading omission in this investigation.

**What this means for testing the fix.** Live runs cannot gate a pass/fail assertion. The fix's unit tests must drive `runPlanLoop` with a **stub** `generateText` returning fixed attempt outputs — those are fully deterministic. Live runs are useful only to measure rates over N and to confirm the drift mechanism.

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

- **The validator is not the bug.** Repeated runs show the rejected plan listed a file that does not exist (`src/pages/HomePage.test.jsx`), so `target-missing` is correct. A validator change would be a guess in the wrong direction. The defect is the destroyed reason and the identity-free repair; this change makes both visible. If the hallucinated-test-file rate (3/10 here) matters for reliability, that is a separate prompt/model issue and needs its own issue.
- **Do not treat one live run as proof.** The same inputs failed 3 times in 10, and temperature 0 did not fix it. Any acceptance evidence for this fix must come from stubbed fixtures; a green live run alone proves nothing.
- Attempt records carry plan fragments and model text: they go to stdout and the run history, both of which already carry the plan. No new secret surface.
- Reporting more per park may make the comment longer; it replaces an unactionable sentence, so this is a net gain, but the message must stay short enough to read.
