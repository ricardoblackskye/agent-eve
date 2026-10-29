# Provision the local checkout, and stop calling an environment failure a test failure Implementation Plan (#541)

> **For Hermes:** execute with the repo's own TDD discipline (RED -> GREEN per task, separate commits), then
> stop at GATE 2 for PR authorization.

**Goal:** make the coding stage able to pass locally. Today it cannot: the checkout is cloned but never
installed, so `npx vitest run` dies before collecting a test, `runTests` collapses that into `passed: false`,
and the developer burns its self-corrections on a failure no code edit can fix.

**Architecture:** two halves that reinforce each other. The checkout plan gains a **provisioning step** (pure,
decided through the `exists` predicate it already takes), and the workspace tools gain a **classification** so
a command that could not start is reported as *unmeasured* rather than failed — the distinction `amm-scan`
already makes for its own environment failures.

---

## Verified findings

| where                                                | what                                                                                                                                                        |
|------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `local-run-checkout.ts:60-82`                        | `planCheckout` returns `{path, mustClone, cloneArgs, summary}`. The clone is `git clone --depth 1`, and **there is no install step** — the whole of cause 1 |
| `local-run-checkout.ts:22-23`                        | the planner takes `exists: (path) => boolean` injected, so a provisioning decision can stay pure and testable                                               |
| `developer-agent.ts:718-723`                         | `passed: res.exitCode === 0` — a startup error is indistinguishable from a failing test                                                                     |
| `developer-agent.ts:708-716`                         | `npx vitest run` is on the allow-list, so the command itself is legitimate                                                                                  |
| `scripts/dark-factory-runner.ts:1117-1131`           | the loop runs `ctx.tools.runTests("npx vitest run")`, prints `Test result: PASS\|FAIL`, and records passing ACs only                                        |
| `amm-scan-runner.ts:154-181`                         | the precedent: a failure caused by OUR environment is **unmeasured**, never a repository marked down — `isNoEgress` is a curated marker list                |
| `tests/dark-factory/circuit-breaker.test.ts:221-226` | three `status: "failure"` records trip the breaker — so the classification has a seam: an environment failure must not be recorded as one                   |

### The same shape was diagnosed before, and this is the part it could not fix

`tests/dark-factory/coding-loop-feedback.test.ts` opens with #373: a resume against WebFeedPOC#162 wrote
byte-identical files three times and tripped the same breaker, because the loop discarded the failure output
and the author was never told what went wrong. That was wired up. My run shows what remains: the developer
**was** told, and its output was correct — one added line, exactly what the plan asked for — but the failure
was `Cannot find package '@vitejs/plugin-react'`, which no edit to the target's source can fix. The loop can
only spin, and the breaker can only trip. Fixing the signal is not enough on its own; the environment has to
be able to run the tests.

### The nesting is fixed by the same change

Cause 2 in the issue is that the workspace sits inside the agent repository, so `npx` resolved the **agent's**
vitest and then loaded the **target's** config. Once the checkout has its own `node_modules`, node resolution
finds the nearest one first and the split disappears. That is worth stating rather than adding a second
mechanism for.

## Global constraints

- **The provisioning decision stays pure.** `planCheckout` takes no filesystem of its own; the lockfile test
  goes through the `exists` predicate it already receives.
- **An unmeasured result is not a failure.** It must not consume a self-correction iteration, and it must not
  be recorded as one for the breaker. It must also never be silent: the log says the tests could not run, and
  why.
- **The documented command keeps working.** `npx vitest run` on the allow-list is unchanged; this is about
  whether it can start.
- **A genuine failing test is still a failure** — reported as such, counted as such, and still trips the
  breaker. The classification must not become a way to excuse real failures.
- No new dependency, and no secret in any output.

## Review focus

- **The classifier must discriminate.** A marker list that matches ordinary test output would silently convert
  real failures into unmeasured ones — the worst possible outcome, because the run would then look healthy.
  Assert a genuine failing-test output is NOT classified as unmeasured, next to the startup cases.
- **The install step must not run when the checkout is reused.** `mustClone` is false for a resume, and
  installing a second time would be wasteful at best; it belongs to provisioning a NEW checkout.
- **The lockfile decision must fail safe.** No lockfile and no `package.json` at all means no install command,
  not an `npm ci` that fails on a repository that was never a Node project.
- **A failed install must be loud.** If it is skipped or warns, the run must say so, because the next thing
  that happens is a test command that cannot start.

## Tasks

### Task 1 — the checkout plan provisions itself

**Files:** modify `agent/lib/dark-factory/local-run-checkout.ts`, test
`tests/dark-factory/local-run-checkout.test.ts`.

The plan gains the provisioning step: `npm ci` when `package-lock.json` exists, `npm install` when only
`package.json` exists, and nothing when neither does — all decided through the injected `exists`, so the
planner stays pure. `summary` names it, so the launcher's output still says what it will do.

RED: the three shapes above, plus the reuse case producing no install at all.

### Task 2 — the launcher runs it, in the one place env and cloning already happen

**Files:** modify `agent/lib/dark-factory/local-run.ts`, `scripts/dark-factory-local-run.ts`, tests as above.

After a clone, run the planned install in the checkout, with the same injected-spawn discipline the clone
uses. A failed install is reported loudly and the run continues, so the failure that follows is classified
rather than mysterious.

### Task 3 — a test command that cannot start is unmeasured, not failed

**Files:** modify `agent/lib/dark-factory/developer-agent.ts` (`WorkspaceTools.runTests`), a pure classifier
beside it, `scripts/dark-factory-runner.ts` (the loop's reporting and the breaker's record), tests
`tests/dark-factory/run-tests-classification.test.ts` and the loop's existing suite.

`runTests` returns whether the command actually ran. A startup-class failure — module-not-found, a config
that cannot load, a missing binary — is *unmeasured*: printed as such, no AC recorded, and **not** recorded as
a worker failure, so it cannot trip the breaker. A non-zero exit that ran to completion stays a failure.

RED: the startup markers from the real run (`ERR_MODULE_NOT_FOUND`, `Cannot find package`, a failed config
load) classify as unmeasured; a genuine assertion failure does not; the breaker does not count an unmeasured
iteration; and the log says the tests could not run.

### Task 4 — the docs

**Files:** the local-runs page, which already owns the launcher's behaviour, and the module's own doc comments.

State that a local run provisions the target's dependencies before the coding loop, and that a test command
which cannot start is reported as unmeasured rather than as a failing test.

### Task 5 — the live proof

Re-drive `ricardoblackskye/webfeedpoc#177`. Its workspace clone exists and is locked by an IDE process, so the
proof may need a fresh park under a new workspace; either way the two demonstrations are: the install runs and
the tests then START, and — separately, if provisioning is unavailable — the run reports the tests as
unmeasured and does **not** trip the breaker for it.

---

## Validation

- Full suite green with no new failures, `tsc --noEmit --incremental false` clean, every pinned linter clean
  locally on the changed files.
- **The Postgres legs must RUN**: export the five `DF_*_TEST_DATABASE_URL` variables, because a skipped leg is
  how a CI-only failure shipped on #533.
- A leftover untracked clone inside the repo makes `env-example-coverage` fail locally (#519) — remove
  `df-workspaces/` before judging the suite, or discount exactly that one failure and say so.

## Settled decisions (agreed at GATE 1)

1. **Provision AND classify.** Each half is insufficient alone: classification without provisioning leaves the
   coding stage unable to pass locally, and provisioning without classification leaves an unfixable failure
   looking like a bad edit.
2. **The install command is lockfile-aware** — `npm ci`, else `npm install`, else nothing — decided through the
   `exists` predicate the planner already takes, so it stays pure.
3. **A failed install is reported loudly and the run continues**, so that the failure which follows is
   classified rather than mysterious.
4. **The classifier lives with the workspace tools** that own the command's output, mirroring `amm-scan`'s
   marker list.
5. **An unmeasured iteration is not recorded as a worker failure**, so it cannot trip the breaker: the breaker
   counts three of the developer's failures, and our environment's failure is not one of them.

## Risks that remain

- **A genuine failing test must stay a failure.** The marker list is the risk surface: a pattern that matches
  ordinary test output would quietly convert real failures into unmeasured ones and make a broken run look
  healthy. The review focus asserts the negative case beside the positive ones.
- **Provisioning costs time on a fresh checkout** (network plus an install) and buys nothing on a reuse, which
  is why it is tied to `mustClone` rather than run unconditionally.
- **A target with no network and no cache cannot be provisioned.** It is reported, and the tests that follow
  are unmeasured, so the run is honest rather than stuck.
- **The residual npx risk**: with the target's own `node_modules` present, resolution takes the nearest one;
  a dependency the target is genuinely missing could still walk up into the agent's tree. Not addressed here.
