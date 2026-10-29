# Let df:local-run drive a resume Implementation Plan (#539)

> **For Hermes:** execute with the repo's own TDD discipline (RED -> GREEN per task, separate commits),
> then stop at GATE 2 for PR authorization.

**Goal:** make a resume runnable through the documented entry point, so it gets the launcher's prerequisite
preflight instead of meeting one abort per missing prerequisite by hand.

**Architecture:** `--resume` becomes a launcher flag. It reaches two places: the spawn args (so the runner
knows to continue a parked run) and the preflight (so the claim check expects the state a resume needs rather
than refusing it).

---

## The finding that shapes this plan

My own issue text said the preflight "already handles the 'an active run is held' case that a resume depends
on". **It does not — it refuses it.** `local-run-preflight.ts:293-301` pushes `claim-held` whenever a holder
exists, with the fix *"wait for it to finish, or retire the claim"*. A parked run holds its issue's claim
until a human answers it, which is exactly the state a resume wants to continue, so simply accepting
`--resume` would produce a launcher that refuses **every** resume — a worse failure than the one being fixed,
because it would look like a legitimate refusal.

The two entry points therefore have **opposite** claim preconditions:

| entry point | a held claim                                                         |
|-------------|----------------------------------------------------------------------|
| a fresh run | a refusal (unchanged — something else is already working this issue) |
| a resume    | a **requirement**, and it must be parked                             |

## Verified findings

| where                                                   | what                                                                                                                          |
|---------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------|
| `scripts/dark-factory-local-run.ts:38-45`               | the parser knows `--repo`, `--issue`, `--workspace-root`, `--allow-remote-store`; anything else returns `unknown argument: …` |
| `scripts/dark-factory-local-run.ts:105`                 | the spawn passes only `--repo` and `--issue`, so there is no path for a resume even if the flag were accepted                 |
| `scripts/dark-factory-runner.ts:328`                    | the runner reads `process.argv.includes("--resume")` — the flag it needs already exists on the other side                     |
| `agent/lib/dark-factory/local-run-preflight.ts:283-302` | the claim check, which currently refuses any holder                                                                           |
| `agent/lib/dark-factory/local-run-preflight.ts:60-68`   | `PreflightInput` — where the resume intent has to arrive                                                                      |
| `agent/lib/dark-factory/local-run.ts:103-109`           | `spawn.args`, where the flag has to be forwarded                                                                              |

The live evidence is in the issue: `DF_CONTROL_DRIVER` unset aborted a real resume, and the preflight already
knows how to report exactly that, up front, in one block with the variable named.

## Global constraints

- **A fresh run's behaviour does not change.** A held claim still refuses. Only the resume path gains the
  mirror-image rule.
- **Only a parked run is resumable.** `blocked` is the park; `running` means a live worker (resuming would put
  two processes on one issue) and `queued` has nothing to continue. Both refuse.
- **A resume with no holder refuses too** — there is nothing to continue, and saying so is better than
  spawning a runner that will fail on its own.
- **The launcher still reports every problem at once**, and never prints a secret.
- The failure text names the run, so the operator knows which run they are resuming.

## Review focus

- **The refusals must be distinguishable.** A resume refused for *no parked run* and a fresh run refused for a
  *held claim* are different situations with different fixes; assert both, so a check that refuses everything
  cannot pass.
- **`running` must refuse on a resume.** This is the case that protects against two processes on one issue, and
  it is the easiest one to get wrong by treating every holder as resumable.
- **The flag must reach the child.** Assert `--resume` appears in `spawn.args` only when asked for, so it is
  not silently dropped or always added.
- **The preflight stays pure.** No I/O beyond the injected probes; the claim comes from the probe it already
  has.

## Tasks

### Task 1 — the preflight learns what a resume needs

**Files:** modify `agent/lib/dark-factory/local-run-preflight.ts`, test
`tests/dark-factory/local-run-preflight.test.ts`.

`PreflightInput` gains `resume?: boolean`. In §7:

- `resume` + no holder → a problem saying there is no parked run to continue.
- `resume` + holder `blocked` → **not** a problem; the claim is what a resume is for.
- `resume` + holder `running` or `queued` → the existing `claim-held` refusal, with the status named.
- no `resume` + holder → the existing refusal, unchanged.

RED: the four cases above. The `blocked` case is the one that fails against today's code, and the others
guard the behaviour that must not change.

### Task 2 — the launcher accepts and forwards it

**Files:** modify `scripts/dark-factory-local-run.ts` and `agent/lib/dark-factory/local-run.ts`, test
`tests/dark-factory/local-run.test.ts`.

Add `--resume` to the parser (a boolean, no value), thread it through `LaunchInput` into both
`buildLaunchDecision`'s spawn args and `preflightLocalRun`'s input.

RED: the spawn carries `--resume` when the flag is given and does not carry it otherwise; the preflight
receives the intent.

### Task 3 — the docs name the resume path

**Files:** the docs page that owns local runs (find it via the existing `docs-page` guards), and the
launcher's usage line if it prints one.

A resume through `df:local-run` is the supported way to continue a parked run; a direct runner invocation is
what #540 is about, not this.

### Task 4 — the live proof

Re-drive the parked run for `ricardoblackskye/webfeedpoc#177` (run `122ff27b-e044-489a-851f-593b7404ab70`,
status `failed` after its circuit breaker, so it may need a fresh park) through
`npm run df:local-run -- --repo ricardoblackskye/webfeedpoc --issue 177 --resume`, with `DF_CONTROL_DRIVER`
deliberately UNSET, and show that the launcher reports it in the preflight block — the outcome the issue asks
for — rather than aborting one prerequisite at a time.

---

## Validation

- Full suite green with no new failures, `tsc --noEmit --incremental false` clean, every pinned linter clean
  locally on the changed files.
- **The Postgres legs must RUN**: export the five `DF_*_TEST_DATABASE_URL` variables, because a skipped leg is
  how a CI-only failure shipped on #533.
- Unset the run-time `DF_*` exports before validating, or the suite lies.

## Settled decisions (agreed at GATE 1)

1. **A `--resume` flag on the launcher.** The documented entry point, and the only one that gives the operator
   the preflight. Documenting the direct-run path instead would be documenting the defect.
2. **`blocked` is the only resumable status.** `running` means a live worker and resuming it would put two
   processes on one issue; `queued` has nothing to continue. Both refuse, naming the status.
3. **A resume with no holder refuses**, saying there is nothing to resume. Letting the runner start fresh
   would silently turn a resume into a new run.
4. **The checkout is reused.** The decision is already `existsSync`-based, and re-cloning would throw away the
   parked run's workspace for no benefit.
5. **Scope: the flag and the claim semantics only.** #540's env resolution and #541's missing install stay
   where they belong.

## Risks that remain

- **A resume of a parked run that a human already answered** is not modelled here: the run's status is the
  only signal this check has, so an answered-but-not-yet-resumed park looks identical to an unanswered one.
- **The launcher cannot prove the held claim is the run the operator means.** It can only report which run
  holds it, which is why the refusal text names the run.
