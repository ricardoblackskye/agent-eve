# #676 — the check-wait bound is a safety cap, not a latency budget

**Issue:** [#676](https://github.com/ricardoblackskye/agent-eve/issues/676) (child of #666)
**Branch:** `chore/check-wait-outlasts-slow-ci-676`, based on `origin/main` @ `e5c6866` (the #685 merge)

## Goal

A run whose checks go green in twelve minutes certifies, instead of reporting `blocked` because its
wait was shorter than its own CI.

## What the issue says, and the one premise it gets wrong

The issue frames a fork — *"raise the bound, or make it per-repository configurable"* — and justifies
the second with: *"a bound too generous for a fast repository delays every run's verdict."*

**That premise is false, and the repository already tests why.** `settlePullRequestChecks`
(`definition-of-done.ts`) polls and returns the moment nothing is unsettled:

```ts
while (checks.some((check) => check.status !== "completed")) {
  if (now() - startedAt >= deps.timeoutMs) break;
  await deps.sleep(deps.pollIntervalMs);
  checks = await deps.fetchChecks();
  ...
}
return checks;
```

`tests/dark-factory/pr-check-gate.test.ts:111` pins exactly that: *"returns the checks as soon as they
have all finished, with **one read**"* (and `:128`, *"polls while a check is still running, then
returns the settled result"*). A bound of five minutes and a bound of an hour are indistinguishable to
a repository whose checks settle in two — **the timeout is only ever reached by a check that never
settles.**

So the cost of a generous bound is not latency; it is how long a run waits before giving up on a
hung descriptor. That reframes the choice: this is a **safety cap** against a stuck check, and the
right cap is one that covers the slowest descriptor the whole-project gate must observe — not the
tightest one that fits an average repository.

## Root cause

`scripts/dark-factory-runner.ts`:

```ts
const PR_CHECKS_TIMEOUT_MS = Number(process.env.DF_PR_CHECKS_TIMEOUT_MS ?? 300_000);
```

**The default is five minutes.** #659 gates the whole project, so every check is blocking, and on
WebFeedPOC `e2e` and `MegaLinter` are each around ten minutes. The #224 run had the bound raised to
ten minutes and *still* reported blocked:

```text
[df-reporter] Story #224 is NOT done
- `PR-CHECK-UNSETTLED:e2e` (error): The check 'e2e' has not finished (in_progress)
- `PR-CHECK-UNSETTLED:MegaLinter` (error): The check 'MegaLinter' has not finished (in_progress)
```

The refusal itself was correct — a run cannot certify against a verdict that has not arrived. The
bound was simply shorter than the CI it was waiting for.

### A second defect on the same line

`Number(...)` accepts anything. `DF_PR_CHECKS_TIMEOUT_MS=5m` (or any typo) yields `NaN`, and the
runner passes `Math.max(0, NaN)` down as the timeout. In `settlePullRequestChecks` the comparison
`now() - startedAt >= NaN` is **false forever**, so the loop never breaks: a mistyped variable turns
the bounded wait into an unbounded one, which is the opposite failure and just as silent.

## Intended fix

1. **`resolvePrChecksTimeoutMs(env)`** in a small lib module, beside the other resolvers the runner
   already uses (`resolveLintCommands`, `resolveMaxReviewRounds`). It returns the env value only when
   it parses as a positive, finite number, and **the default otherwise** — so a typo is a fallback,
   not an infinite wait.
2. **The default becomes twenty minutes.** The observed need is a single deadline (#659) that must
   cover the pull request's queue plus its slowest descriptor: `e2e` and `MegaLinter` around ten
   minutes each, and a run that had ten was still unsettled. Twenty is a margin over the measured
   case rather than a round number.
3. **The runner logs the bound** before the DoD runs, so a run that is waiting says so. The
   operator's override stays and is now validated.

**Not per-repository.** The caveat that motivated it does not hold, and adding a declaration surface
a target must maintain — to fix a symptom caused by a default being too small — is the more complex
of the two answers. If a target ever needs longer than twenty minutes, the env override is already
there and now safe.

**One ADR**, because the issue asks for a decision and this is one worth recording:
`docs/adr/0087-a-check-wait-bound-is-a-safety-cap.md`. It records the early-return property as the
reason the bound is a cap, cites the test that proves it, and states why a generous default is not a
cost. Without it, the next reader sees a twenty-minute timeout and reasonably asks why it is not
five.

## Tasks (TDD — RED and GREEN as separate commits)

### Task 1 — RED: the resolver does not exist yet

New cases in `tests/dark-factory/pr-check-gate.test.ts` (the file that owns this gate):

- an unset variable yields the default;
- a valid override is honoured;
- **a non-numeric override falls back to the default rather than yielding `NaN`** — the defect that
  makes the wait unbounded;
- a zero or negative override falls back too, because a zero bound would refuse every run;
- the default is long enough for the case this issue was filed from (asserted against the observed
  need, so the number is a decision recorded in a test rather than a magic constant).

### Task 2 — GREEN: the resolver, its use, and the log

Add the module, point the runner at it, log the bound.

### Task 3 — cite, do not duplicate

The early-return property is already pinned by `pr-check-gate.test.ts:111` and `:128`. State that in
the ADR rather than adding a third test of the same behaviour.

## Files likely to change

| File                                                                         | Change                                               |
|------------------------------------------------------------------------------|------------------------------------------------------|
| `agent/lib/dark-factory/pr-checks-timeout.ts`                                | new: `resolvePrChecksTimeoutMs`                      |
| `scripts/dark-factory-runner.ts`                                             | use it; log the bound; delete the bare `Number(...)` |
| `tests/dark-factory/pr-check-gate.test.ts`                                   | Task 1                                               |
| `docs/adr/0087-a-check-wait-bound-is-a-safety-cap.md` + `docs/adr/README.md` | the decision                                         |

## Validation

- `npx vitest run tests/dark-factory/pr-check-gate.test.ts tests/dark-factory/definition-of-done.test.ts`
- The **full** suite before the push, with CI's DB env vars and
  `--exclude 'tests/env-example-coverage.test.ts'`. #675's baseline to hold is 3675 passed / 0 failed.
- `npx tsc --noEmit --incremental false`
- The local lint gate on every changed file — and **gated**, not merely printed: suite exit, `tsc`,
  cspell's summary text, markdownlint with a config **file**, and the pinned table formatter for the
  ADR index row. On #675 a gate that reported cspell's finding without gating on it pushed a branch
  carrying a lint error; that is the failure this line exists to prevent.

## Risks and open questions

- **A longer bound lengthens the silence before giving up on a hung check.** Raising the cap from
  five minutes to twenty is only safe because a settling check returns early, but a *stuck* one now
  costs twenty minutes of an unchanged log compared with five. The runner will log the bound at the
  start, which names the cap without pretending to be progress. A per-poll heartbeat is deliberately
  **not** in scope; it is a separate change with its own surface, and it is the natural follow-up.
- **Twenty minutes is a judgement, not a measurement of the worst case.** It is derived from the
  slowest CI observed (around ten minutes for each of `e2e` and `MegaLinter`) with margin. If a
  repository ever exceeds it, the env override is the intended answer, and after this change a typo
  in that override no longer makes things worse.
- **Not in scope:** making the bound per-repository (the premise for it does not hold), the poll
  interval (fifteen seconds, unrelated), and #679.
