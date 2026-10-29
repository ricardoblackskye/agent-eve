# Resolve .env.local from the repository root, not the cwd Implementation Plan (#540)

> **For Hermes:** execute with the repo's own TDD discipline (RED -> GREEN per task, separate commits),
> then stop at GATE 2 for PR authorization.

**Goal:** make the promise in `dark-factory-runner.ts:270-273` true. It says `.env.local` is loaded "so a
direct `tsx scripts/dark-factory-runner.ts` sees the same variables the launcher provides". It does not, when
the cwd is the target checkout — which is always for a local run, because discovery reads the cwd (#405) and
the launcher spawns the runner inside the checkout.

**Architecture:** `loadLocalEnv`'s default directory becomes the **agent repository root**, resolved from
`import.meta.url` rather than from the process. The explicit `dir` parameter stays, because the tests use it,
but no production caller relies on the cwd any more.

---

## Verified findings

| where                                                                                                                     | what                                                                                                                   |
|---------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------|
| `scripts/load-env.ts:33`                                                                                                  | `export function loadLocalEnv(dir: string = process.cwd()): string[]` — the whole defect, in one default               |
| `scripts/load-env.ts:45`                                                                                                  | `if (process.env[key] !== undefined) continue;` — an explicitly exported value already wins, and must keep winning     |
| `agent/lib/dark-factory/local-run.ts:213-216`                                                                             | `loadLauncherEnv(dir?)` wraps it, so an `undefined` argument already means "use the default"                           |
| `scripts/dark-factory-local-run.ts:93`                                                                                    | the launcher passes `process.cwd()` **explicitly**, so it would not gain the new rule unless this changes too          |
| `scripts/dark-factory-runner.ts:273`                                                                                      | the runner's direct-run path: `loadLocalEnv()` with no argument — the call that fails in a checkout                    |
| `scripts/seed-test-data.ts:809`, `df-cost-budget.ts:81`, `df-calibration-report.ts:119`, `openrouter-verify-models.ts:45` | every other operator script calls it with **no argument**, so each one inherits the cwd today                          |
| `tests/dark-factory/load-env.test.ts`                                                                                     | four cases, and **every one passes an explicit `dir`** — the default resolution is untested, which is why this shipped |

The live evidence is in the issue: a direct resume in the checkout printed `GitHub Token Present? false` and
`OpenRouter Key Present? false`, then `[ERROR] Missing GITHUB_TOKEN or OPENROUTER_API_KEY in environment or
.env`.

## Global constraints

- **An explicitly exported value still wins.** That rule is the module's stated contract and must survive
  unchanged.
- **Never load the TARGET's environment.** The cwd of a local run is a checkout of someone else's repository;
  its `.env.local` is that project's configuration, not the agent's credentials. Resolving from the agent
  repo root is not only more reliable, it is the only defensible choice.
- **The parameter stays.** It is how the tests isolate the filesystem, and removing it would push them onto
  the real repo.
- No secret is ever printed, here or in the refusal text.

## Review focus

- **The default must not depend on the process.** Assert the resolved directory is the repo root while the
  cwd is somewhere else entirely — by moving the process's working directory into a temp one — because a test that only checks
  the happy path in the repo root would pass against the old code too.
- **The shell still wins.** Re-assert the no-override rule against the new default, not only against an
  explicit directory, since that is the contract a production DSN depends on.
- **A target checkout's env is not loaded.** With the cwd in a directory that HAS an `.env.local`, nothing
  from it may reach `process.env` — the security-shaped half of the same rule.
- **Every caller benefits, not just the runner.** The change is in the default, so the four operator scripts
  gain it too; say so in the commit rather than leaving it as a surprise.

## Tasks

### Task 1 — the default resolves from the module

**Files:** modify `scripts/load-env.ts`, test `tests/dark-factory/load-env.test.ts`.

Compute the repo root from `import.meta.url` (`scripts/` sits one level below it), use it as the default, and
export the resolved directory so a test can assert the rule without depending on whether a real `.env.local`
exists (CI has none, so a filesystem-based assertion could not be written honestly).

RED:
- the resolved directory is the repository root;
- it is unchanged after the process's working directory is moved to a temp directory;
- a `.env.local` in the CURRENT directory is **not** loaded when the default is used;
- the no-override rule still holds against the new default.

### Task 2 — the launcher stops passing the cwd

**Files:** modify `scripts/dark-factory-local-run.ts`, test `tests/dark-factory/local-run.test.ts` if it
asserts the call.

The launcher delegates to the default, so one rule governs every caller. A launch from a different directory
then loads the agent's env rather than whatever `.env.local` happens to be in the cwd.

### Task 3 — the module's header says what it now does

**Files:** modify `scripts/load-env.ts` (the doc comment).

Its current header says "Next loads `.env.local` for the APP; a bare `tsx scripts/...` never sees it" — which
this makes true from any directory. Record that the resolution is repository-rooted, and that a target
checkout's env is deliberately never read.

### Task 4 — the live proof

Re-drive the parked run for `ricardoblackskye/webfeedpoc#177` from its checkout, invoking the runner
**directly** (the path that failed), with no `.env.local` in that checkout, and show `GitHub Token Present?
true` / `OpenRouter Key Present? true` — the two lines that were false in the issue. The workspace clone is
currently locked by an IDE process; if it is still locked, the proof reproduces the failure first and then
walks the resolution, stating plainly which half was demonstrated.

---

## Validation

- Full suite green with no new failures, `tsc --noEmit --incremental false` clean, every pinned linter clean
  locally on the changed files.
- **The Postgres legs must RUN**: export the five `DF_*_TEST_DATABASE_URL` variables, because a skipped leg is
  how a CI-only failure shipped on #533.
- A leftover untracked clone inside the repo makes `env-example-coverage` fail locally (#519) — remove
  `df-workspaces/` before judging the suite, or discount exactly that one failure and say so.

## Settled decisions (agreed at GATE 1)

1. **The default is the agent repository root**, resolved from `import.meta.url`. It makes the runner's own
   comment true, and it can never read a target checkout's env.
2. **The launcher stops passing `process.cwd()`.** One rule governs every caller.
3. **The resolved directory is exported and asserted.** CI has no `.env.local`, so a filesystem-based assertion
   could only be written dishonestly; asserting the rule itself is the honest form.
4. **The four operator scripts inherit the change.** Accepted, and stated in the commit: they are run from the
   repository anyway, and this removes fragility rather than adding any.
5. **The repo root is computed locally in `load-env.ts`**, the way `local-run.ts` already computes its own. No
   shared helper; that is a wider refactor than this bug needs.

## Notes that shape the tests

- The no-override rule is already covered against an explicit directory, and it cannot be re-asserted against
  the new default without a `.env.local` at the repository root — which CI does not have. A test that depends
  on one machine's file would be worse than no test, so the default's coverage is the rule itself: the resolved
  directory, and that it does not move with the process.
- The security-shaped case is asserted directly: with the working directory in a folder that HAS an
  `.env.local`, nothing from it may reach `process.env`.

## Risks that remain

- **A caller that legitimately wanted the cwd's env no longer gets it.** That is the decision, not a
  side effect: the agent's credentials live in the agent's repository.
