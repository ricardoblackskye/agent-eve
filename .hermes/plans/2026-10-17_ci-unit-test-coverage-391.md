# Add Unit Test Coverage to the CI pipeline (Issue #391) Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Unit test coverage (lines, statements, functions, branches) is measured on every pull request and on every push to `main`, is visible where the change is reviewed, and is gated by a RATCHET: the build fails if coverage DROPS.

**Architecture:** `@vitest/coverage-v8` produces the numbers from the existing suite; a small PURE ratchet compares them against a committed baseline and fails on a regression. The provider is a seam — the ratchet reads a summary JSON, so swapping the provider later does not touch the gate.

**Tech Stack:** Vitest 4 (`@vitest/coverage-v8`), Node 24, GitHub Actions (`ci.yml`), the repo's root guard suites.

---

## Decisions — CONFIRMED

Settled by the user before planning. The plan must not re-pose these.

1. **The metric is UNIT TEST coverage** — line, statement, function and branch coverage of the tests we already run —
   produced by `@vitest/coverage-v8`, version-matched to `vitest ^4.1.11`.
   **Not** TypeScript type coverage. The linked package `typescript-coverage-report` measures a DIFFERENT thing: its
   README says it "fills the gap of a missing **type coverage** reporting tool" and it wraps `type-coverage`, so its
   threshold describes the share of expressions that are typed rather than `any`. Type coverage is not in scope here.
2. **The gate is a RATCHET.** A committed baseline records today's numbers; the build fails if any metric DROPS.
   It must never fail merely for sitting below some absolute target, which would fail on day one and teach people
   to ignore it.

## Verified current state

| Fact                                         | Evidence                                                                       |
|----------------------------------------------|--------------------------------------------------------------------------------|
| There is no coverage configuration at all    | `vitest.config.ts` has a `test` block and no `coverage` key                    |
| No coverage provider or tooling is installed | `package.json` devDependencies hold no `coverage`, `istanbul` or `v8` provider |
| No coverage script exists                    | `package.json` `scripts` has no entry mentioning coverage                      |
| CI runs the suite without coverage           | `.github/workflows/ci.yml:76` — the `test` job is `npm ci` then `npm test`     |
| The job is named `Unit Tests`                | `.github/workflows/ci.yml:37` — the check name the branch ruleset gates on     |
| `coverage/` is not ignored                   | `grep coverage .gitignore` returns nothing                                     |
| ADRs are guarded against orphaning           | `tests/doc-drift-guards.test.ts` — "every ADR is linked from the index"        |
| The next ADR number is 0043                  | `docs/adr/` holds 0042 files, 0001-0042                                        |

**Why the check name matters.** The `test` job is named `Unit Tests`, and the user configures branch rulesets
themselves. Adding STEPS to that job keeps the check name identical, so no ruleset change is needed. Creating a NEW
job would produce a check the ruleset does not require, which is a silent gap rather than a gate.

## Approach

- **Provider and reporters.** `@vitest/coverage-v8` with reporters `text-summary`, `json-summary`, `lcov` and `html`.
  `json-summary` is the machine-readable input the ratchet reads; `html` and `lcov` are the human and tool-consumer views.
- **One run, not two.** The `test` job runs the suite WITH coverage rather than running it twice. Coverage
  instrumentation slows a run; a second pass would double the job's cost for no extra information.
- **The ratchet is pure.** A function comparing a baseline summary to a current summary and returning violations is
  unit-tested; the CLI around it only reads files, prints, and sets an exit code.
- **Fail closed.** A missing, unreadable or malformed baseline or summary FAILS with a message naming the file. A
  gate that passes when it cannot read its input is not a gate.
- **Visibility without extra credentials.** The metrics are written to `$GITHUB_STEP_SUMMARY`, which renders on the
  job's Summary tab and is reachable from the pull request's Checks page, and the HTML report is uploaded as an
  artifact. A PR comment is optional and deliberately last, because it needs an idempotent update and a token scope.
- **A drop is fixable, an improvement is recorded.** `--update` rewrites the baseline locally, so improving coverage
  is an ordinary committed change rather than a bot editing its own bar in CI.

## Tasks

### Task 1 — Install the provider and produce a summary (RED then GREEN)

**Objective:** `npm run test:coverage` writes a coverage summary.

**Files:**
- Modify: `package.json` (devDependency + script)
- Modify: `vitest.config.ts` (a `coverage` block)
- Modify: `.gitignore` (`coverage/`)

**Step 1 (RED):** run `npm run test:coverage` before adding anything.
Expected: FAIL — the script does not exist, and `--coverage` reports that the provider is missing.

**Step 2 (GREEN):** add `@vitest/coverage-v8` at the version matching the installed `vitest`, the script
`"test:coverage": "vitest run --coverage"`, a `coverage` block, and `coverage/` to `.gitignore`.

The `coverage` block:
- `provider: "v8"`,
- `reporter: ["text-summary", "json-summary", "lcov", "html"]`,
- `reportsDirectory: "coverage"`,
- `include` the product code the unit suite covers (`agent/**`, `app/**`, `scripts/**`),
- `exclude` tests, the e2e directory, config files and generated output.

**Step 3:** run it and confirm `coverage/coverage-summary.json` exists and parses.
Run: `npm run test:coverage`

### Task 2 — The ratchet comparison, pure (RED then GREEN)

**Objective:** one function decides whether coverage dropped.

**Files:**
- Create: `scripts/coverage-ratchet.ts`
- Test: `tests/coverage-ratchet.test.ts`

**Step 1 (RED):** declare the signature with a `throw new Error("not implemented")` body so the tests execute and
fail for the right reason, then write the cases:

```ts
expect(compareCoverage(baseline, current).ok).toBe(true);            // identical
expect(compareCoverage(baseline, lower).violations).toContain("lines");
expect(compareCoverage(baseline, higher).ok).toBe(true);             // an increase passes
expect(compareCoverage(baseline, missingMetric).ok).toBe(false);     // fail closed
```

**Step 2 (GREEN):** implement it:

```ts
export interface CoverageMetric { covered: number; total: number; percentage: number }
export interface CoverageViolation { metric: string; baseline: number; current: number }
export function compareCoverage(baseline: unknown, current: unknown): { ok: boolean; violations: CoverageViolation[]; deltas: ... };
```

Rules:
- Compare `lines`, `statements`, `functions` and `branches` from the summary's `total` block.
- A metric ABSENT from either side is a violation, not a pass — fail closed.
- Allow a small float tolerance (default 0.05 percentage points) so rounding in the summary cannot produce a false
  failure. The tolerance is a parameter with a default, NOT an env var, so the `env-example-coverage` guard stays quiet.
- A drop larger than the tolerance is a violation; an increase is not.

**Step 3:** run to green: `npx vitest run tests/coverage-ratchet.test.ts`

### Task 3 — The ratchet CLI (RED then GREEN)

**Objective:** the gate can be run from CI and from a laptop.

**Files:**
- Modify: `scripts/coverage-ratchet.ts`
- Test: `tests/coverage-ratchet.test.ts` (thin CLI cases over injected readers)

- Default: read the committed baseline and `coverage/coverage-summary.json`, print a metric-by-metric table
  (baseline, current, delta), and exit non-zero when a violation is present.
- `--update`: write the current numbers to the baseline and exit zero. Used locally when coverage improves.
- Fail closed with an actionable message when either file is missing, empty or malformed — never exit zero.
- Report the improvement too: when coverage rose, say so and name the new baseline so a human can `--update`.

### Task 4 — Establish the baseline from the PRE-CHANGE tree

**Objective:** a baseline that reflects `main`, not this branch's own new tests.

**Files:**
- Create: `coverage-baseline.json`

Run coverage on the branch point (the commit before this change) and commit the resulting numbers. Recording the
branch's own coverage instead would let this pull request raise its own floor, which inverts the ratchet.

State the measured numbers in the PR body so the baseline is reviewable rather than opaque.

### Task 5 — Wire it into CI without renaming the job

**Objective:** every PR and every push to `main` measures, reports and gates.

**Files:**
- Modify: `.github/workflows/ci.yml` (the `test` job only)

- Change the `test` job's run step from `npm test` to `npm run test:coverage`, keeping the job NAME `Unit Tests`.
- Add a step that writes the metric table to `$GITHUB_STEP_SUMMARY`.
- Add the ratchet step, which fails the job on a drop.
- Add an artifact upload for `coverage/` (html + lcov), with `if: always()` so a failing run still yields the report.
- Keep the existing Postgres service and the five gate variables untouched: they make the gated integration suites
  run rather than skip.

**Verification:** the workflow must be valid YAML and the job name unchanged. Confirm the name with
`grep -n "name: Unit Tests" .github/workflows/ci.yml` after the edit.

### Task 6 — ADR 0043, the index row, and the documented commands

**Files:**
- Create: `docs/adr/0043-coverage-is-gated-by-a-ratchet.md`
- Modify: `docs/adr/README.md` (index row)
- Modify: `README.md` and/or `AGENTS.md` (the new commands)

The ADR records BOTH decisions: unit test coverage rather than type coverage, and a ratchet rather than a fixed
threshold. A ratchet is a deliberate departure from the obvious approach, which is exactly what an ADR is for: the
next reader will otherwise assume the absence of a threshold is an oversight.

Run: `npx vitest run tests/doc-drift-guards.test.ts tests/adr-integrity.test.ts`
Expected: PASS — no orphan ADR, no dead links.

### Task 7 — Prove the gate actually fails

**Objective:** a green run does not prove a gate works.

- Run the suite, then edit a copy of the summary JSON to lower one metric and confirm the ratchet FAILS naming that
  metric and both numbers.
- Confirm the unmodified summary PASSES.
- Confirm a missing summary and a missing baseline each FAIL with an actionable message.
- Confirm `--update` rewrites the baseline and that a subsequent check passes.

## Files likely to change

| Action | Path                                              |
|--------|---------------------------------------------------|
| Create | `scripts/coverage-ratchet.ts`                     |
| Create | `tests/coverage-ratchet.test.ts`                  |
| Create | `coverage-baseline.json`                          |
| Create | `docs/adr/0043-coverage-is-gated-by-a-ratchet.md` |
| Modify | `package.json`                                    |
| Modify | `vitest.config.ts`                                |
| Modify | `.gitignore`                                      |
| Modify | `.github/workflows/ci.yml`                        |
| Modify | `docs/adr/README.md`                              |
| Modify | `README.md`                                       |

## Validation

- `npx tsc --noEmit --incremental false` — clean. Vitest strips types without type-checking, so a green suite can
  hide a type error.
- `npx vitest run` — the FULL suite, plus the root guards: `tests/adr-integrity.test.ts`,
  `tests/doc-drift-guards.test.ts`, `tests/env-example-coverage.test.ts`.
- Local lint gate on every changed file BEFORE any push: `markdownlint` (MD040, MD026, MD018) and
  `markdown-table-formatter@1.6.1` driven from a CONFIG FILE, plus `cspell` — reword, never teach the dictionary.
- `npm run test:coverage` then the ratchet against the committed baseline — must pass on this branch.
- Task 7's deliberate failure, which is the only real proof the gate is wired.

## Commit plan

```text
plan(ci): 391 measure unit test coverage and gate it with a ratchet
test(ci): 391 RED - the coverage ratchet comparison
feat(ci): 391 GREEN - compare a coverage summary against the baseline
feat(ci): 391 measure coverage in CI and publish the metrics
docs(ci): 391 ADR 0043 and the documented commands
```

Verify a RED/GREEN split against the trees, never the commit messages: `git show <red-sha>:<path>` must not contain
the implementation symbol.

## Risks and open questions

| Ref | Item                                                                     | Position                                                                                                                                             |
|-----|--------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| R1  | Coverage instrumentation adds time to the `test` job.                    | Accepted: one coverage run replaces the plain one, so the job stays a single pass over the suite.                                                    |
| R2  | A flaky test could depress a metric and fail an unrelated pull request.  | The tolerance (Task 2) absorbs rounding; a genuine flake must be fixed, which the repo already treats as a defect.                                   |
| R3  | Raising the baseline after an improvement is a manual step.              | Deliberate: `--update` is local and committed, so a human records the new floor rather than CI editing its own bar.                                  |
| R4  | Coverage is a proxy for test quality, not a measure of it.               | Stated in the ADR: the gate stops a DROP, and it is not a target to maximize.                                                                        |
| R5  | An excluded-from-coverage directory could hide untested code.            | The include list is explicit in `vitest.config.ts` and reviewable; exclusions are tests, e2e and generated output only.                              |
| R6  | A PR comment with the table would be more visible than the step summary. | Recommended first as step summary plus artifact, because a comment needs an idempotent update; add it separately if the summary proves hard to find. |
