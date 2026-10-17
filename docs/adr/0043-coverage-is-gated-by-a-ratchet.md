# 0043 — Coverage is gated by a ratchet, and it measures tests rather than types

- **Date:** 2026-10-17
- **Status:** Accepted

## Context

The request was to "add Unit Test Coverage to the CI pipeline" and it linked `typescript-coverage-report`.
Those are different measurements, and the names invite the mistake:

- **Unit test coverage** — the lines, statements, functions and branches the test suite executes. Produced
  by `@vitest/coverage-v8`.
- **Type coverage** — the share of expressions that are typed rather than `any`. That is what the linked
  package measures: it wraps `type-coverage`, and its `--threshold 80` means "80% of expressions are typed".

Nothing in the repository measured either: `vitest.config.ts` had no `coverage` block, no coverage provider
was installed, and the `Unit Tests` job was `npm ci` then `npm test`. The suite is 240 files and roughly
2,380 tests.

## Decision

- **The metric is unit test coverage**, via `@vitest/coverage-v8` at the version matching the installed
  Vitest. Type coverage is explicitly **not** this, and is not in scope; it may be added separately, and this
  record exists so its absence is not read as an oversight.
- **The gate is a RATCHET.** A committed baseline records what the repository achieves; the check fails when
  any metric DROPS and passes when one rises, suggesting that a human record the new floor. A fixed absolute
  threshold was rejected: at this size it would fail on day one and be disabled within a week, which is worse
  than no gate because it also teaches that the check can be ignored.
- **A ratchet rather than coverage `thresholds` in the config** — one mechanism, so a failure has exactly one
  explanation. Configure both and a red build has two possible causes, and the looser one wins.
- **ABSENT and MALFORMED inputs are different failures.** A metric missing from either summary is a
  `missing` violation, so the gate fails closed on an incomplete file. A metric present but not a numeric
  percentage means the input is not a coverage summary, so it throws. Treating absent as zero would let the
  gate pass on input it could not verify; treating malformed as absent would report a broken file as a
  coverage regression.
- **The measured surface is listed explicitly** through `coverage.include`. Without it Vitest reports only
  the files the tests happened to IMPORT, so an untested file is invisible and the number flatters itself.
  `scripts/` is deliberately excluded from measurement: it holds operator CLI entry points that unit tests do
  not drive, and a large pool of 0% files would blunt the metric for the changes that matter.
- **The baseline is measured under the same conditions as the gate.** CI sets five Postgres variables so the
  gated integration suites RUN rather than skip; a baseline measured locally without them understates the
  floor and weakens the gate.
- **The gate requires a PASSING test run.** It reads `numFailedTests` from the Vitest JSON report and refuses
  both modes when the run failed, because a failing test does not execute the code it would have covered and
  the numbers fall for a reason unrelated to coverage. Measured here, two failing tests moved lines by 0.28pp,
  which the ratchet reported as a drop and failed the gate on — a red build with no coverage change at all.
  Gating is the harmless half: `--update` from a failing run would commit a permanently LOWER floor, and the
  ratchet would then defend that floor forever. A missing or malformed report fails closed.

## Consequences

- The floor can only rise, and raising it is an ordinary committed change by a human (`--update`), never a bot
  editing its own bar in CI.
- A pull request that reduces coverage fails with the metric, both percentages and the cause. Every failure
  path names the file it could not read and the command that fixes it, because a gate that exits non-zero
  without saying what to do gets disabled.
- **The number is a proxy for test quality, not a measure of it.** The gate stops a regression; it is not a
  target to maximize, and a high percentage achieved by asserting on trivial lines is worse than a lower one
  that exercises real behaviour.
- The coverage provider is a seam: the ratchet reads a summary JSON, so replacing v8 with istanbul does not
  touch the gate.
