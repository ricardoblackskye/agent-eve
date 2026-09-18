# #158 — latency and cost on `TaskMetric`

**Branch:** `feat/df-metric-fields-158` (off `origin/main` = `9adbc5b`, which includes #157 merged as PR #168)
**Issue:** #158 · last of the #157–#160 sequence (#160 → PR #165, #159 → PR #166, #157 → PR #168, all merged)

## What is missing

#146 step 1 (OBSERVE) names *"success rate per task type, iterations, fix-cycles, **latency, cost**"* as inputs,
but #140's `TaskMetric` carries only four fields — `taskType`, `iterations`, `fixCycles`, `status` — so the R4a
controller could only define **objective = success rate** and **guardrails = mean iterations / mean fixCycles**.

Cost is what the #144 circuit breaker exists to bound, and latency is already a tracked quality dimension
(#121). **A loop that cannot see either can "improve" success rate by spending unboundedly** — the exact
regression it exists to prevent.

## REVIEW findings (from the code)

- `MetricsStore.record(taskType, data)` takes an inline shape that is **duplicated verbatim in both stores**
  (`InMemoryMetricsStore` and `BufferedMetricsRecorder`), so this PR extracts a shared `TaskMetricInput` type —
  that is what makes "one contract point" literal rather than aspirational. `toTaskMetric(taskType, data)`
  validates every field and throws `InvalidMetricsError`, so validating the new fields **there** keeps the
  ingestion contract in one place.
- **`Observation { taskType, samples, successRate, meanIterations, meanFixCycles }`** is built by a single
  function, `observeTaskType(store, taskType, minSamples)`, from `store.getRecords()`. Extending *that* is what
  makes latency and cost observable.
- **`Measurement.guardrails` is a keyed `Record<string, number>`**, and DECIDE already:
  - iterates `Object.keys(after.guardrails)`,
  - skips keys absent before (`"a guardrail that did not exist before cannot have regressed"`),
  - compares each against `guardrailTolerance`.

  **So adding a guardrail is additive by construction** — no new comparison logic, and #158's AC *"latency
  regresses beyond tolerance ⇒ rejected and reverted"* is met by *including the key*.
- `objectiveTrend(entries, { surfaceId })` reports the objective series from `LedgerEntry.objective.after`, and
  the ledger entry already stores `guardrails: { before, after }` — so a guardrail series is derivable without
  changing the ledger shape.
- The **objective** comes from the #121 quality gate (success rate), not from the metrics store — which is what
  makes the "latency as the *objective*" half a different, larger change (see the decision below).

- **The guardrails themselves are built from the BENCHMARK's cases, not from the store** (`guardrails: { meanIterations: mean((c) => c.iterations), meanFixCycles: ... }`). So the reject-and-revert AC needs `BenchmarkCase` to carry the optional fields too — the store path alone would never reach DECIDE;
- **`BufferedMetricsRecorder` re-sends an explicit shape** in both `record()` and `flush()`. If only the interface signatures change, the #140 no-loss decorator silently **drops** the new fields on every buffered record — the new fields must be carried through those two re-sends, which is exactly the kind of loss that decorator exists to prevent;
- **The #140 baseline this must not disturb** is `tests/dark-factory/metrics.test.ts` — five suites (fix-cycle
  exactness, ingestion, success rate per task type, the no-loss guarantee, env wiring). AC4 is satisfied by those
  passing unchanged.

## Design

1. **`TaskMetric` gains optional `latencyMs?: number` and `costUsd?: number`.** Optional keeps every existing
   writer and stored record valid — AC1 without a migration.
2. **`toTaskMetric` validates them when present**: finite and `>= 0`. Negative, `NaN`, `Infinity` or
   non-numeric ⇒ `InvalidMetricsError` — AC2, at the single contract point.
   **Absent stays absent, never `0`**: "not measured" and "measured zero" are different facts, and defaulting a
   missing measurement to 0 would drag every mean toward a number nobody observed.
3. **`MetricsStore.record` accepts the two fields** and both stores pass through what `toTaskMetric` produced.
4. **`Observation` gains optional `meanLatencyMs?` / `meanCostUsd?`**, computed **over the samples that have
   the value**, and **omitted entirely when none do** — consistent with point 2.
5. **The measurement's guardrails include the latency/cost keys when observed**, so DECIDE evaluates them with
   the tolerance it already applies. A key that nobody measured is absent, which DECIDE already treats as
   "cannot have regressed".
6. **The guardrail series** is exposed via `objectiveTrend`'s sibling so the trend report can show latency and
   cost over cycles, not just as a single guardrail number.

## Decision — RESOLVED at GATE 1: guardrails now

**Resolved (approved): guardrails now — ACs 1–4, fully tested. Objective selection is deferred to its own
issue**, because it would mean changing what MEASURE produces (the objective comes from the #121 quality gate),
not adding a key. Doing it here would move the MEASURE/DECIDE boundary inside a diff that is about metrics —
which is precisely what makes a change hard to review.

## Tasks (RED → GREEN, one behaviour per cycle)

| #  | RED (failing test first)                                                                                       | GREEN                                                                    |
|----|----------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------|
| 1  | a record with no latency/cost is unchanged (`getRecords()` has neither key)                                    | optional fields, no defaulting                                           |
| 2  | finite `latencyMs`/`costUsd` values are stored and read back                                                   | pass-through in both stores                                              |
| 3  | `latencyMs: -1`, `NaN`, `Infinity`, `"120"` each throw `InvalidMetricsError`, naming the field                 | validation in `toTaskMetric`                                             |
| 4  | `costUsd: -0.01` throws; `costUsd: 0` is **accepted** (zero is a measurement)                                  | `>= 0`, not `> 0`                                                        |
| 5  | `observeTaskType` reports `meanLatencyMs` / `meanCostUsd` when samples carry them                              | means over measured samples                                              |
| 6  | when **no** sample carries a value, the key is **absent** from the observation (not `0`)                       | omit, never fake a zero                                                  |
| 7  | a mix (half the samples measured) means over the **measured** ones only                                        | filter, then mean                                                        |
| 8  | the measurement's guardrails include the observed latency/cost keys                                            | additive guardrail keys                                                  |
| 9  | **end-to-end**: a change that regresses latency beyond tolerance is rejected **and reverted**                  | existing DECIDE logic, no new branch                                     |
| 10 | **end-to-end**: a regression *within* tolerance is accepted (the guardrail is not a hair-trigger)              | tolerance is respected                                                   |
| 11 | the guardrail series reports latency/cost per cycle                                                            | trend extension                                                          |
| 12 | the existing #140 ingestion tests still pass **unchanged**                                                     | backward compatibility (AC4)                                             |
| 13 | a record with latency/cost survives a **failing backend** and is delivered by `flush()` with the fields intact | the decorator's two explicit re-sends carry them (the drop hazard above) |
| 14 | a `BenchmarkCase` carrying latency/cost puts `meanLatencyMs`/`meanCostUsd` into the measurement's guardrails   | `BenchmarkCase` + the guardrail record                                   |
| 15 | when **no** benchmark case carries them, those guardrail keys are **absent** from the measurement              | same absent-not-zero rule, at the MEASURE seam                           |

## Acceptance criteria (from the issue, made concrete)

- given a completed task with measured latency/cost, then the store carries it **without breaking existing
  records or writers**
- given negative / `NaN` / non-numeric latency or cost, then `InvalidMetricsError` is thrown **rather than a
  nonsense value being stored**
- given latency configured as a guardrail, when a change regresses it beyond `guardrailTolerance`, then the
  change is **rejected and reverted**
- the existing #140 ingestion tests continue to pass unchanged
- *(added by REVIEW)* given a metric nobody measured, then it is **absent** — it never appears as `0`

## Files

`agent/lib/dark-factory/metrics.ts` (fields + validation + stores) ·
`agent/lib/dark-factory/self-improve.ts` (`Observation`, measurement guardrails, trend series) ·
`agent/lib/dark-factory/index.ts` (the dispatch observer, so a dispatched task can carry its latency/cost) ·
`tests/dark-factory/metrics-latency-cost.test.ts` (new) ·
`tests/dark-factory/self-improve-guardrails.test.ts` (new, the end-to-end reject/revert cases) ·
`README.md` · `.cspell.json` if needed.

## Validation

`npx tsc --noEmit` · full `npx vitest run` · `cspell` + `prettier` on changed files · and a **local run** on
this laptop showing a real cycle **rejected on a latency regression** and **reverted**, with the numbers printed
— the same standard as #159 and #157, where the evidence was a run rather than an assertion.

## Status

**GATE 1 approved — guardrails scope** (objective selection deferred). Implementation is TDD: a RED test per row
above, then the smallest change that turns it GREEN, verified on this laptop before any push.

