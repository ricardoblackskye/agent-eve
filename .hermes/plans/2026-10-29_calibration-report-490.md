# Calibration Report Implementation Plan (#490, epic #453)

> **For Hermes:** execute with the repo's own TDD discipline (RED -> GREEN per task, separate
> commits), then stop at GATE 2 for PR authorization.

**Goal:** turn recorded estimate/actual pairs into the calibration factor the estimator consumes in
v2 — signed bias first, then MAE/MAPE by stage and cost class, with a minimum-sample refusal.

**Architecture:** a PURE aggregation module joins two already-recorded sides on `run_id` — the
plan's band (`df_plan_estimates`) and the run's measured spend (`df_usage_events`) — and a thin
script runs it against the configured stores. No new write path is required.

**Tech Stack:** TypeScript, Vitest, the existing `PlanLedger` and usage stores, no new dependency.

---

## Verified findings (the reconnaissance this plan rests on)

### The pair's actual half does not exist where the issue assumed

| check                       | result                                                                                                                                          |
|-----------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------|
| `df_run_summaries.cost_usd` | **NULL for every run** (9 local rows, all `aborted`)                                                                                            |
| `df_run_events.cost_usd`    | **NULL** — 3 events per run, no cost                                                                                                            |
| `df_usage_events`           | holds exactly **one** real cost: the architect call from the live #492 run ($0.0932)                                                            |
| `df_cost_reservations`      | columns are `reservation_id, budget_id, estimated_usd, created_at, settled` — **no `run_id`**, so the budget store cannot be attributed per run |

So the `df_plan_estimate_accuracy` view reads a column nothing populates. That was the "writer, not
a join" correction already recorded on the issue.

### But the ledger already carries what the report needs

`df_usage_events` has `run_id` AND `task_type` on every row, and `queryUsage(store, { runId })`
exposes it. That is a per-run, per-STAGE measured actual — exactly AC2's split — available today,
with no new writer.

### The seams that exist and are unused

- `costOf?: (result: T) => number | undefined` on the governed call (`governed-agent-call.ts:69` ->
  `governed-llm-call.ts:57`), which **no production call passes**, so every in-process reservation
  settles `null`.
- the run-summary upsert already accepts `cost_usd` (`run-history-postgres.ts:612`, sqlite twin
  `run-history-store.ts:702`) — nothing supplies a value.
- `estimatePlanCostSafely({ plan, model })` is called with **no `history`**, so `confidenceFor([])`
  is always `"low"` and `revisionFactorFor([])` is always `1`.

### The estimator is already shaped for calibration

- `BAND_LOW_MULTIPLIER` / `BAND_HIGH_MULTIPLIER` are documented in-file as placeholders
  ("#490 calibrates it").
- `PLAN_ESTIMATOR_VERSION = "v1"`, with "bump this whenever a constant below changes".
- Its formula decomposes per stage: inputs are `min(files, 24) x 12,000 / 4` tokens x
  `CONTEXT_READS_PER_RUN`, and outputs are `ARCHITECT_OUTPUT_TOKENS` for the planner plus
  `taskCount x OUTPUT_TOKENS_PER_TASK` for the developer.

### The one real pair that exists today

Run `f86f6a17` (plan #8): estimate **$0.2042**, measured architect actual **$0.0932**. That is
enough to prove the whole pipeline end to end, and it is below any sane minimum sample size, which
proves AC1's refusal on the same data.

---

## Scope

### In scope

1. A **pure** `calibration-report.ts` module: join, signed bias, MAE/MAPE, by stage, by cost class,
   minimum-sample refusal, sample size on every metric.
2. The **per-stage expectation**, derived from the estimator's own formula, so AC2's by-stage bias
   compares like with like.
3. The **factor seam** on `EstimatePlanCostInput` — the "form the module can accept" in AC3.
4. A thin `scripts/df-calibration-report.ts` CLI.
5. An ADR recording the actual's definition and the factor's formula.

### Deliberately NOT in scope (each becomes its own issue, per the standing rule)

- **The run summary's `cost_usd` is never written.** The report does not need it (it reads the
  ledger), but the accuracy view does, and a half-populated run cost would UNDER-report spend.
- **Developer usage is not recorded on the in-process path.** `createWorkerUsageRecorder` has no
  production caller, so a developer's sandbox spend never reaches the ledger. The report must state
  this blind spot rather than imply the stages it cannot see are free.
- **The estimator is never given `history`**, so `confidence` is always `low` and `revisionFactor`
  is always `1`. Not an AC of #490, but it is the reason the factor is the only calibration lever.

---

## Global constraints

- The module is PURE: no clock, no randomness, no store, no env read. Same input -> byte-identical
  output, so a test can pin every metric exactly.
- No content: counts and money only, never prompts, file contents or issue text.
- The estimator stays ADVISORY and never blocks. The report's refusal is about not publishing noise,
  not about gating a run.
- Every metric carries its `sampleSize`. A metric without an `n` is not reportable.
- Money handling uses the same one-price-source convention as the estimator: no new price table.

## Review focus

- **A run with no estimate must be excluded, not counted as zero** (AC4). Assert this with a run
  present in the ledger that has no estimate row, so exclusion cannot be satisfied by an empty input.
- **The refusal must be non-vacuous.** Prove it refuses below the minimum AND publishes above it, on
  the same fixture shape, so a hardcoded `undefined` cannot pass both.
- **Sign discipline.** `signedErrorUsd = estimate - actual` throughout, matching the view. A positive
  value means the estimator was HIGH. State the direction in the type's doc comment and pin it.
- **Tester excluded** (AC6), asserted by a `taskType: "tester"` row that must not move any number.
- Division safety: `MAPE` with a zero actual must not produce `Infinity` or `NaN` in output.

---

## Tasks

Implement the stage decomposition first: the report consumes it for its by-stage metrics.

### Task 2 — the per-stage expectation

**Files:** create `agent/lib/dark-factory/calibration-report.ts`, test
`tests/dark-factory/calibration-report.test.ts`.

**Interface (fixed here so the tests can be written first):**

```ts
export interface CalibrationPair {
  runId: string;
  costClass: CostClass;
  confidence: CostConfidence;
  expectedUsd: number;
  actualUsd: number;
  /** Per-stage measured spend, keyed by task type, excluding the tester. */
  stageActualUsd: Record<string, number>;
  /** Per-stage expectation from the estimator's own decomposition. Sums to expectedUsd. */
  stageExpectedUsd: Record<string, number>;
}

export interface CalibrationReportInput {
  pairs: CalibrationPair[];
  /** Runs the ledger knows about that have no estimate row. Excluded, never counted as zero. */
  runsWithoutEstimate: number;
  minimumSampleSize: number;
}

export interface CalibrationReport {
  reportable: boolean;
  reason?: "below-minimum-sample-size";
  sampleSize: number;
  excludedWithoutEstimate: number;
  bias: Metric;
  mape: Metric;
  byStage: Array<{ stage: string } & { bias: Metric; mape: Metric }>;
  byCostClass: Array<{ costClass: CostClass } & { bias: Metric; mape: Metric }>;
  factor: number;
}

export interface Metric {
  sampleSize: number;
  value: number | undefined;
}
```

**Step 1 — RED.** Assert, in order: (a) signed bias is the mean of `estimate - actual`, positive
when the estimator is high; (b) MAE/MAPE on the same fixture; (c) a run with no estimate is counted
in `excludedWithoutEstimate` and moves no metric; (d) a `tester` stage row moves no number;
(e) `sampleSize` accompanies every metric; (f) below `minimumSampleSize`, `reportable` is false,
`reason` names it, `factor` is absent and NO metric value is published; (g) at exactly the minimum
it reports — the exact-boundary case.

**Step 2 — run it:** expect the failure set above, and confirm no vacuous passes.

**Step 3 — GREEN.** Minimise: one pass to accumulate, one to emit. Round money to 4 decimals at the
boundary only.

**Step 4 — run the suite, then commit** as `test(490): RED ...` and `feat(490): GREEN ...`.

### Task 2 — the per-stage expectation

**Files:** modify `agent/lib/dark-factory/plan-cost-estimate.ts`, test
`tests/dark-factory/plan-estimate-stage-split.test.ts`.

Export a pure decomposition of the SAME formula:

```ts
export interface PlanCostStageEstimate {
  stage: "architect" | "developer";
  expectedUsd: number;
}
export function decomposePlanCostEstimate(input: EstimatePlanCostInput): PlanCostStageEstimate[];
```

The architect takes one context read plus `ARCHITECT_OUTPUT_TOKENS`; the developer takes the other
context read plus `taskCount x OUTPUT_TOKENS_PER_TASK`. Assert the parts SUM to the whole-run
`expectedUsd` (a rounding-tolerant comparison), and that an empty plan does not produce a negative
part.

**Doc-comment the assumption:** `CONTEXT_READS_PER_RUN = 2` split one read per stage is structural,
not measured — the same caveat the constant already carries.

### Task 3 — the factor seam

**Files:** modify `agent/lib/dark-factory/plan-cost-estimate.ts`, test
`tests/dark-factory/plan-estimate-calibration-factor.test.ts`.

Add `calibrationFactor?: number` to `EstimatePlanCostInput`, defaulting to 1, documented as the seam
v2 consumes. A non-finite or non-positive factor falls back to 1 rather than producing a `NaN` band,
and the applied value is recorded in `features`. `PLAN_ESTIMATOR_VERSION` does NOT change here:
defaulting to 1 leaves every existing band byte-identical, and the bump belongs to the change that
first passes a measured factor.

The report's `factor` is `mean(actual / estimate)` over reportable pairs — the multiplicative
correction a multiplier-based estimator needs — computed only when the sample is sufficient.

### Task 4 — the script

**Files:** create `scripts/df-calibration-report.ts`, tests
`tests/dark-factory/calibration-report-script.test.ts` (source guard, the repo's convention for
composition roots).

Reads the estimate rows through `PlanLedger.listEstimates(period?)`, the spend through
`queryUsage(store, {})`, joins on `run_id` in the module, and prints text or `--json`. Flags:
`--period`, `--min-samples` (default from `MIN_CALIBRATION_SAMPLES`, overridable by
`DF_CALIBRATION_MIN_SAMPLES`). Exit code 0 whether or not the sample is sufficient — an insufficient
sample is a finding, not a failure.

### Task 5 — ADR 0074 and docs

**Files:** create `docs/adr/0074-the-calibration-actual-is-recorded-usage.md`, modify
`docs/adr/README.md`, `docs/pages/dark-factory-cost-estimation.md`, `.env.example`.

Record: the actual is the run's RECORDED usage, summed per run from the ledger (not the run
summary), and why; the factor is multiplicative with a minimum-sample refusal; the by-stage
expectation is derived from the estimator's own formula and inherits its assumption. Add the env var
to `.env.example` (the coverage guard fails otherwise) and reference the new module from the cost
page (the doc-drift guard fails otherwise).

---

## Validation

- Full suite green with no new failures, `tsc --noEmit --incremental false` clean.
- The pinned linters locally on every changed file, including the plan and the ADR:
  `markdownlint` (fence languages, single trailing newline), `markdown-table-formatter@1.6.1`,
  `cspell`, `markdown-link-check`.
- **Live proof on the local store:** run the script against `df-local-pg` and show it reading the
  real pair (estimate $0.2042, architect actual $0.0932, positive signed bias) while REFUSING to
  publish metrics at n=1 — AC1 and the pipeline demonstrated on real data, not a fixture.
- Unset the run-time `DF_*` exports before validating, or the suite lies.

## Settled decisions (agreed at GATE 1)

1. **The actual is the usage ledger.** Summed per run from `df_usage_events`, because it is the only
   per-run, per-stage MEASURED source, and it already carries `run_id` and `task_type`. The run
   summary's `cost_usd` stays empty; populating it is a follow-up issue, not a prerequisite.
2. **The by-stage expectation is derived from the estimator's own formula**, so the by-stage bias
   compares like with like. The one-read-per-stage split stays documented as structural.
3. **The factor is multiplicative**: `mean(actual / estimate)` over reportable pairs, withheld when
   the sample is insufficient.
4. **The minimum sample reuses `MIN_CALIBRATION_SAMPLES = 10`**, overridable with
   `DF_CALIBRATION_MIN_SAMPLES`.
5. **One PR.** The ledger removes the prerequisite writer, so this is a single coherent change; the
   three gaps found during reconnaissance become their own issues.

## Risks that remain

- **The developer stage is unmeasured on the in-process path** until sandbox usage is ingested. The
  report must state this rather than present the architect alone as "the run".
- **A hardcoded `undefined` factor could satisfy the refusal and the publish cases at once.** Both
  are asserted on the same fixture shape, above and below the boundary, so neither can be vacuous.
