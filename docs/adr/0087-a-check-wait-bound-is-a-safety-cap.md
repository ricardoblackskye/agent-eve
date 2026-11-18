# 0087. A check-wait bound is a safety cap, not a latency budget

**Date:** 2026-11-17
**Status:** Accepted
**Issue:** [#676](https://github.com/ricardoblackskye/agent-eve/issues/676)

## Context

Since #659 the gate covers the whole project: every check the pull request runs is blocking, so the
Done waits for the pull request's checks before certifying. #676 recorded a correct run reporting
`blocked` because that wait was shorter than the project's own CI:

```text
[df-reporter] Story #224 is NOT done
- `PR-CHECK-UNSETTLED:e2e` (error): The check 'e2e' has not finished (in_progress)
- `PR-CHECK-UNSETTLED:MegaLinter` (error): The check 'MegaLinter' has not finished (in_progress)
```

The checks went green minutes later on their own. The issue proposed either raising the bound or
making it per-repository, reasoning that "a bound too generous for a fast repository delays every
run's verdict".

## Decision

**The bound is a ceiling on a check that never settles, not a latency budget.** `settlePullRequestChecks`
polls and returns the moment nothing is unsettled, which `tests/dark-factory/pr-check-gate.test.ts`
pins directly - "returns the checks as soon as they have all finished, with **one read**". A bound of
five minutes and a bound of an hour are therefore indistinguishable to a repository whose checks
settle in two; the timeout is only ever reached by a stuck descriptor.

The premise that motivated per-repository configuration does not hold, so:

- the default is raised to **twenty minutes**, covering the pull request's queue plus the slowest
  descriptor the whole-project gate must observe (`e2e` and `MegaLinter` are each around ten
  minutes on WebFeedPOC, and ten configured was still unsettled);
- the bound stays overridable per environment, and is now **validated**: `Number("5m")` is `NaN`, and
  `now - started >= NaN` is false forever, so a typo used to turn this bounded wait into an
  unbounded one;
- **no per-repository declaration is added.** It would put a surface on every target to work around
  a default that was simply too small.

## Consequences

- A run whose checks settle quickly is unaffected - the number is only reached by a check that never
  settles.
- A stuck check now costs up to twenty minutes before the run reports blocked, rather than five. The
  run logs the bound before it waits, so the ceiling is visible; a per-poll heartbeat is deliberately
  not part of this change.
- A malformed override falls back to the default instead of waiting forever.
- A repository needing longer than twenty minutes still has the environment override.
