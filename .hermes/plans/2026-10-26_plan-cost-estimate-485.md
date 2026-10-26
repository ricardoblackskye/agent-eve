# Plan cost estimator — pure band estimator (#485)

Epic: **#453 Agents Cost Estimator** · Issue: **#485** · Branch: `feat/df-plan-cost-estimate-485`
Base: `bb76bda` (post-#491) · ADR: covered by **0069** (already merged)

## Goal

A pure function that turns a validated `ExecutionPlan` plus prior run history into a **cost band**, a
**cost class** and a **confidence label** — never a single number, and never a gate. This is the
testable core of #453 v1: everything else (#486 persistence, #487 wiring, #488 comment) moves this
value around.

## Root state verified on `main`

| Fact                                                                                                              | Where                                       |
|-------------------------------------------------------------------------------------------------------------------|---------------------------------------------|
| `resolvePrice(model) → ModelPrice \| null`                                                                        | `agent/lib/dark-factory/cost-budget.ts:130` |
| `ModelPrice = { inputUsdPer1k, outputUsdPer1k }`                                                                  | `cost-budget.ts:93`                         |
| Price table holds reservation **ceilings**, not exact rates (ADR 0027)                                            | `cost-budget.ts:98`                         |
| `estimateCost(model, inTok, outTok)` already exists                                                               | `cost-budget.ts:162`                        |
| `ExecutionPlan { storyId, title, summary, approach?, tasks?, targetFiles, acceptanceCriteriaMap, dependencies? }` | `plan-validator.ts:39`                      |
| `PlanTargetFile { path, action: "create"\|"modify"\|"replace", rationale }`                                       | `plan-validator.ts:12`                      |
| `PlanTask { title, objective, files?, steps?, verification? }`                                                    | `plan-validator.ts:31`                      |
| `RunSummary` carries `attemptCount`, `reviewCount`, `iterationCount`, `fixCycleCount`, `costUsd?`                 | `run-history.ts:66`                         |
| Bounded reader caps: `MAX_CONTEXT_FILES_READ = 24`, `MAX_CHARS_PER_FILE = 12_000`                                 | `architect-agent.ts:188`                    |
| Catalog states `_107 modules._` while the tree holds **122**                                                      | `docs/pages/dark-factory-modules.md:13`     |

Every `RunSummary` field the Revision Factor needs is **already recorded** — this module adds no
instrumentation.

## Intended design

### Signature — a deliberate refinement of the issue sketch

The issue sketched `estimatePlanCost(plan, history, priceTable)`. I propose a single options object
instead, because the price source must be **injectable** to satisfy both the purity criterion and the
single-price-source criterion at once:

```ts
export interface EstimatePlanCostInput {
  plan: ExecutionPlan;
  model: string;
  history?: RunSummary[];
  /** Defaults to the governor's own `resolvePrice` — one price source of truth. */
  resolvePrice?: (model: string | null | undefined) => ModelPrice | null;
}

export interface PlanCostEstimate {
  lowUsd: number;
  expectedUsd: number;
  highUsd: number;
  costClass: "XS" | "S" | "M" | "L" | "XL";
  confidence: "low" | "medium" | "high";
  features: Record<string, number | string>;
}

export function estimatePlanCost(input: EstimatePlanCostInput): PlanCostEstimate;
```

Reason for the deviation: the default keeps one price source (the criterion), while the injectable
seam makes "a changed price moves the estimate" a real unit assertion rather than an env mutation.
**Flagged for approval.**

### The cost model — input-token-centric

Research for #453 found input tokens dominate agentic coding cost and that output-line counts are a
weak predictor. So the model predicts **tokens**, then prices them.

Structural token estimate (all constants named and exported so they are reviewable, not magic):

```text
contextTokens = min(targetFileCount, MAX_CONTEXT_FILES_READ) * (MAX_CHARS_PER_FILE / CHARS_PER_TOKEN)
outputTokens  = taskCount * OUTPUT_TOKENS_PER_TASK
plannerTokens = contextTokens + ARCHITECT_OUTPUT_TOKENS
```

`CHARS_PER_TOKEN = 4` matches the runner's own `Math.ceil(prompt.length / 4)` reservation, so the
estimator and the governor count the same way.

Revision Factor from history — the revision-factor idea from the cost-estimation literature, using
fields already on `RunSummary`:

```text
revisionFactor = max(1, mean(iterationCount + fixCycleCount + 1))   // empty history => 1
```

Band spread. Measured run-to-run variance for the same task is large (worst case ~30x, averaged
max/min roughly 2x), so a defensible default is a symmetric span around the expectation:

```text
expectedUsd = priced(plannerTokens + outputTokens) * revisionFactor
lowUsd      = expectedUsd * BAND_LOW_MULTIPLIER       // 0.5
highUsd     = expectedUsd * BAND_HIGH_MULTIPLIER      // 2.0
```

**This multiplier is a documented guess with no data behind it.** That is the honest posture for v1
and it is exactly what #490 calibrates. **Flagged for approval** as the single biggest unknown.

### Cost class — the agreed absolute thresholds

| Class | Range      |
|-------|------------|
| XS    | < $0.25    |
| S     | $0.25 – $1 |
| M     | $1 – $5    |
| L     | $5 – $20   |
| XL    | > $20      |

Class is derived from `expectedUsd`. Boundary values are tested on **both** sides of every edge,
including exactly-equal, because a `>=` comparison hides an off-by-one behind above/below tests.

### Cold start and unknown models — both produce a band, never an error

- **Empty history** → `revisionFactor = 1`, `confidence: "low"`, band still emitted. Agreed behaviour.
- **Unknown model** (`resolvePrice → null`) → fall back to the **dearest price in the table** as a
  conservative ceiling, `confidence: "low"`, and `features.priceSource = "unknown-model-ceiling"`.
  Never a throw, never zero. Zero would understate cost, which is the failure that matters.
- **Zero/negative token inputs** → clamped explicitly at zero with a guard; negative counts must not
  produce a negative band.

### Confidence

`low` when there is no history; `medium` when history is below `MIN_CALIBRATION_SAMPLES`; `high` at or
above it. v1 deliberately keeps this coarse — dispersion-aware confidence needs the pairs #490 builds.

### Purity and determinism

- No network, no model call, no filesystem write.
- No `Date.now()`, no `Math.random()` — same inputs, byte-identical output.
- Features are numeric/structural only: counts, token estimates, prices. **No prompts, no file
  contents, no free-form issue text**, matching the `UsageEvent` privacy contract.

## Tasks — vertical tracer bullets, RED then GREEN each

| # | Task                     | RED asserts                                                                                      |
|---|--------------------------|--------------------------------------------------------------------------------------------------|
| 1 | Structural band skeleton | Empty-history plan yields a band with `lowUsd <= expectedUsd <= highUsd` and `confidence: "low"` |
| 2 | Class thresholds         | Exact boundaries at 0.25, 1, 5, 20 — value equal to the edge lands in the upper class            |
| 3 | Price source             | Injected resolver's changed price moves the band; default path is `resolvePrice`                 |
| 4 | Unknown model            | Conservative ceiling band, `confidence: "low"`, no throw, not zero                               |
| 5 | Token guards             | Zero target files and negative counts clamp explicitly; no negative band                         |
| 6 | Revision factor          | History with iteration/fix cycles raises `expectedUsd`; empty history leaves factor 1            |
| 7 | Determinism + purity     | Two identical calls deep-equal; source guard that the module imports no fs/network/clock         |
| 8 | Docs references          | Catalog row and page reference make the doc-drift guard green                                    |

One behaviour per cycle. No horizontal slicing.

## Files likely to change

| File                                            | Change                             |
|-------------------------------------------------|------------------------------------|
| `agent/lib/dark-factory/plan-cost-estimate.ts`  | NEW — the pure estimator           |
| `tests/dark-factory/plan-cost-estimate.test.ts` | NEW — the TDD suite                |
| `docs/pages/dark-factory-modules.md`            | catalog row naming the module path |
| `docs/pages/flow-cost-governance.md`            | the page that owns cost governance |

A new `agent/lib/dark-factory/*.ts` is an **orphan** until a `docs/pages/*.md` page contains its path
literally, so the catalog row ships in the **same commit** as the module or the tree guard is red
immediately. No new `process.env` read is introduced (`resolvePrice` already owns the price
override), so `.env.example` needs no new row.

## ADRs

No new ADR. The decisions this module implements — bands not numbers, the absolute thresholds,
summary-requested advisory posture, single price source, structural-first-then-calibrated — are already
recorded in **0069**. A new record would restate it.

Candidate worth watching during implementation: if the band-span multiplier settles as a *documented
policy* rather than a placeholder, that is a new decision and gets its own ADR then.

## Validation

- Each RED watched failing for the right reason before its GREEN.
- Full suite, with the pass/fail tally read from a redirected log — never through a pipe.
- `npx tsc -p tsconfig.json --noEmit --incremental false`.
- cspell over the **derived** changed-file list, not a hand-picked subset.
- `tests/doc-drift-guards.test.ts` and `tests/env-example-coverage.test.ts` green.
- Pinned `markdown-table-formatter@1.6.1` and `markdownlint-cli@0.45.0` on changed markdown.
- `DF_PLATFORM_PROVIDER=generic npm run build` before the PR.

## Risks and open questions

1. **The band multiplier is unfounded.** 0.5x–2x is a placeholder, not a measurement. If the first
   bands are uselessly wide, the honest fix is a narrower *class* and a stated wide band — not
   invented precision.
2. **Token constants are structural estimates.** `CHARS_PER_TOKEN`, `OUTPUT_TOKENS_PER_TASK` and the
   per-file read assumption are reviewable working numbers. They are the model's weakest link and
   the first thing #490 should correct.
3. **History granularity.** v1 consumes whole-run `RunSummary`, so the estimate is whole-run too.
   Per-stage attribution needs #492 (architect events in the usage ledger).
4. **Signature deviation** from the issue's sketch (options object + injectable price source) needs
   the user's approval before implementation.
5. **Out of scope, observed not carried:** the catalog's stated `_107 modules._` is stale against the
   real 122. It is **not** guarded by any test, so fixing it is unrelated churn.
