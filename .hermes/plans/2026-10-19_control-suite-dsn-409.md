# #409 — the control suite joins the test-DSN contract, then the floor is taken from CI

## What the evidence says

`tests/dark-factory/control-postgres.test.ts:4` gates on

```ts
const databaseUrl = process.env.DF_CONTROL_DATABASE_URL ?? process.env.DF_RUN_HISTORY_DATABASE_URL;
```

while `tests/dark-factory/pg-global-setup.ts` resets the control tables for `DF_CONTROL_TEST_DATABASE_URL`. The setup
and the suite therefore read DIFFERENT variables, and the suite skips unless a production-shaped name happens to be
set. CI sets `DF_CONTROL_DATABASE_URL` explicitly, so it runs there; a local run with the five `DF_*_TEST_DATABASE_URL`
variables does not run it.

Comparing CI's uploaded coverage artifact with a local run (200 files each) found **exactly one divergent file**:

| file | CI | local |
|---|---|---|
| `agent/lib/dark-factory/control-postgres.ts` | 11/16 functions, +24 branches, +34 lines | 1/16 functions |

Totals: CI `84.41 / 83.66 / 85.95 / 77.01`, local `84.01 / 83.28 / 85.37 / 76.71` (lines / statements / functions /
branches). So the floor recorded in #410 came from the LOCAL run and sits 0.3-0.6pp BELOW what CI measures. A floor
below reality permits the loss it exists to prevent.

`control-postgres.test.ts` also imports no helper from `pg-test-helpers`, so it never calls `assertDisposableDsn` —
the only Postgres suite without that guard, falling back to a production-shaped variable while writing rows.

## What this plan does NOT do

It does not change the runtime contract. `DF_CONTROL_DATABASE_URL` stays the factory's own setting (`.env.example`,
the control store, the runners). Only the TEST gate changes, so a test suite can no longer reach a live database by
way of a fallback.

## Release split

Two landings, so the baseline update cannot mask the delta it exists to fix.

| Landing | Branch | Content |
|---|---|---|
| 1 | `fix/control-suite-dsn-409` | the suite joins the contract; the registry gains the seventh suite; CI supplies the test variable |
| 2 | `chore/coverage-floor-from-ci-409` (after 1 merges) | floor re-recorded from CI's artifact, plus the honest failure message |

## Landing 1 — tasks

**Task 1 (RED) — the registry must cover every Postgres suite, and each suite must read its own variable.**
Extend `tests/dark-factory/pg-suite-isolation.test.ts`:

- the registry has SEVEN entries, and `control-postgres.test.ts` is one of them;
- for every entry, the suite file mentions its own `dsnVar` and does NOT mention any other `DF_*_DATABASE_URL` name.

The second assertion is the guard that would have caught this defect: a suite gating on a name the setup does not
reset is now a test failure rather than a silent skip. RED today — the registry holds six entries.

**Task 2 (RED) — the control suite refuses a non-disposable DSN.**
`tests/dark-factory/pg-suite-isolation.test.ts` asserts that calling the suite's resolver with a production-shaped
DSN throws, and that the derived DSN puts the control suite in its own schema. RED today.

**Task 3 (GREEN) — wire it.**
- `pg-test-helpers.ts`: add the seventh `PG_SUITES` entry (`file`, `dsnVar: DF_CONTROL_TEST_DATABASE_URL`, its own schema).
- `control-postgres.test.ts`: gate on `DF_CONTROL_TEST_DATABASE_URL`, derive the DSN with `testDsnFor`, assert
  `assertDisposableDsn` before the first write, and keep the runtime `DF_CONTROL_DATABASE_URL` name out of the file.
- `pg-global-setup.ts`: the control tables are reset inside the control suite's own schema, like the other six.

**Task 4 — CI supplies the test variable.**
`.github/workflows/ci.yml`: replace `DF_CONTROL_DATABASE_URL` with `DF_CONTROL_TEST_DATABASE_URL` in the job env, and
correct the block comment to say SIX gate variables, each named `DF_*_TEST_DATABASE_URL`.

**Task 5 — prove it locally.**
- the control suite runs and passes with `DF_CONTROL_TEST_DATABASE_URL` set, and SKIPS with only the production-shaped
  name set (the property that makes a silent skip impossible to repeat);
- the full suite, all six `DF_*_TEST_DATABASE_URL` variables set: the four totals must match CI's artifact EXACTLY.

**Task 6 — record the contract.**
Amend ADR 0052's consequences: seven suites, each gated on its own `DF_*_TEST_DATABASE_URL`, each with its own schema,
and the disposable-DSN assertion as the condition for writing.

## Landing 2 — tasks (after landing 1 merges)

**Task 7 — the floor, from CI's artifact.** Set `coverage-baseline.json` to CI's measured totals, committed alone, with
a message stating that the MEASUREMENT moved (local now matches CI, because the seventh suite runs) and not that
coverage moved.

**Task 8 — the gate must still bite.** Raise every floor 2pp in place, assert the mutation LANDED by reading the value
back, require a non-zero exit naming each metric and both percentages, then restore the recorded floor.

**Task 9 — the message names the real cause.** `scripts/coverage-ratchet.ts`: when a metric falls while its DENOMINATOR
grew, say so, and name the platform; a RED test asserts the message distinguishes "the code base grew" from
"coverage of existing code fell". This is the change that stops sending an author to an innocent diff.

## Validation (both landings)

- `npx tsc --noEmit --incremental false`
- full suite with all six DSNs; then twice, to confirm identical coverage numbers
- `npx cspell -c .cspell.json` over the WHOLE diff file set, staged first
- the docs/ADR guards; `npm run coverage:ratchet` after landing 2
- CI at gate 6: MegaLinter, Unit Tests, TS, Eve Build, Playwright, evals

## Acceptance

1. The control suite runs locally on `DF_CONTROL_TEST_DATABASE_URL` alone, and skips when only the production-shaped
   name is set.
2. Local totals equal CI's artifact exactly, so one floor serves both.
3. The floor equals CI's measurement, and the gate still fails when every floor is raised 2pp.
4. A suite gating on a name the setup does not reset fails a test rather than skipping.

## Risks

- **A half-landed change makes the suite skip in CI.** Tasks 3 and 4 must ship together; the Task 1 guard fails if they
  do not.
- **Removing the fallback could strand an operator** who relied on `DF_CONTROL_DATABASE_URL` to run this suite. The
  suite now refuses a non-disposable DSN by design; the README/docs line names the variable to set.
- **The runtime read must survive.** `DF_CONTROL_DATABASE_URL` stays in `.env.example` and in the control store; only
  the test gate moves. The env-coverage guard covers the runtime side.
- **A floor from CI cannot be reproduced on a machine where the seventh suite is skipped** - which is precisely why
  task 3 comes first.
