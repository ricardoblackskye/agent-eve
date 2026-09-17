# Issue #146 — Measurable Recursive Self-Improvement (the improvement controller)

**Branch:** `feat/df-self-improve` (off `origin/main` = `a43508f`)
**Issue:** #146 · `Release:R4` · depends on #140 (metrics), #138 (dispatch), #144 (cost guard) — all merged
**Release:** R4a of 2 (see the release-split table)

## Goal

Close the Dark Factory's self-improvement loop so it is **measurable, verified and
reversible**. On demand, the controller observes the #140 metrics, proposes a bounded
change to a tunable surface with an explicit written hypothesis, stages it behind a
versioned handle, re-measures against a fixed benchmark, accepts **only** if the objective
metric improves and no guardrail regresses — otherwise reverts — and appends an immutable
ledger entry recording what changed and its measured effect.

R4a delivers **one bounded cycle** (the whole loop minus the cadence). Unverified
self-improvement is a liability: left unguarded the loop will happily improve itself into a
regression, so every cycle is fail-closed on measurement.

## Verified current state (read from `main` @ `a43508f`)

Facts established before planning, not assumed:

| Seam | Reality on `main` | Consequence for this plan |
| --- | --- | --- |
| `metrics.ts` (#140) | `MetricsStore` = `record()`, `successRateByType(type)`, `getRecords()`; `TaskMetric = { taskType, iterations, fixCycles, status }` | OBSERVE aggregates over the existing store — **no parallel metric store** (MUST satisfied). |
| `metrics.ts` | **No latency or cost fields** | The objective cannot be latency/cost. Confirmed scope: objective = success rate, guardrails = iterations/fixCycles. |
| `tests/helpers/model-bench.ts` (#121) | `gradeStoryQuality()` + `assertLatencyWithinBudget()` are **pure**; `loadModelBaseline()` reads committed `tests/fixtures/model-baseline.json`; only `measureLatency()` needs a key | MEASURE reuses the pure graders over a committed fixture — deterministic, offline, no API key in CI. |
| `circuit-breaker.ts` (#144) | `recordWorkerActivity(WorkerActivity)`, `isTripped(pbiId)`, `getWorkerMinutes(pbiId)`, `getTripEvents()`; `WorkerActivity = { pbiId, durationMs, status }`; `PBI_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/` | A cycle is a bounded, budgeted unit: check `isTripped` and record activity with a pattern-valid `pbiId`. |
| `dispatch.ts` (#138) | `Dispatcher`, `DispatchObserver`, `DispatchAttemptMetric` | Not modified; already feeds the metrics store via `createDispatchObserver`. |
| `index.ts` | env factories (`createMetricsStore`, `createStateStore`, …); `readInt` throws on garbage; `DF_*` prefix | The controller gets a `createSelfImprovementController(env)` factory in the same style. |

**Leftover found:** `metrics.ts` still opens with `STUB — implementation pending (TDD RED).`
although it is fully implemented. Removed as a drive-by (this exact leftover-comment class
was a review finding on #147).

## Scope decisions (confirmed with the user)

1. **Split** R4 into R4a (core loop, one bounded cycle) + R4b (cadence, trend, operator CLI).
2. **Objective** = success rate per task type; **guardrails** = iterations + fixCycles per type;
   latency/cost deferred to a follow-up that extends #140's `TaskMetric`.
3. **First tunable surface** = the iteration/retry bound, wrapping the existing
   `DF_MAX_ITERATIONS` seam — the narrowest knob that is a real behaviour change.
4. **Operator gate** = a minimal hook in DECIDE (fail-closed for access-widening changes), no CLI/UI.
5. **MEASURE** = reuse the model-bench pure graders over a committed deterministic fixture.

## Release split

| Release | Scope | Branch | ACs covered |
| --- | --- | --- | --- |
| **R4a** (this plan) | One bounded cycle: observe → propose → apply → measure → decide → record, fail-closed, versioned + reversible, cost-guarded, operator-gate hook | `feat/df-self-improve` | AC1–AC5, AC7, AC8 |
| R4b | RECURSE on a configured cadence, objective-over-time trend report, operator CLI/UI | `feat/df-self-improve-cadence` | AC6, operator UX |
| Follow-up issue | Extend #140 `TaskMetric` with latency + cost, then add them as objective/guardrail candidates | — | closes the "latency, cost" gap in #146's step 1 |

**Non-goals (explicitly out of scope):** the within-task self-correction loop (#137/#138),
the cost guard itself (#143/#144 — respected, not reimplemented), metrics capture (#139/#140).

## Design (R4a)

New module `agent/lib/dark-factory/self-improve.ts`. Provider-agnostic: every step is an
injected interface, so no model, tool or vendor is named.

```ts
/** Aggregate view of one task type, derived ONLY from #140's store (no parallel store). */
export interface Observation {
  taskType: string;
  samples: number;
  successRate: number;   // objective
  meanIterations: number; // guardrail
  meanFixCycles: number;  // guardrail
}
export type Observer = (taskType: string) => Observation | null; // null = insufficient data

/** A knob the controller may change. Never mutated in place. */
export interface TunableSurface<T = unknown> {
  id: string;
  read(): T;
  stage(next: T): Promise<VersionHandle<T>>;
}
export interface VersionHandle<T = unknown> {
  id: string;        // e.g. "iteration-bound@v2"
  surfaceId: string;
  previous: T;
  next: T;
  apply(): Promise<void>;
  revert(): Promise<void>; // idempotent — AC4 reversion is safe to retry
}

export interface Proposal {
  surfaceId: string;
  next: unknown;
  hypothesis: string;                                  // AC1: explicit, written
  kind: "bounded-tuning" | "access-widening";           // gates the operator hook
}
export type Proposer = (obs: Observation) => Proposal | null; // null = nothing to try

export interface Measurement {
  fixtureVersion: string;
  objective: number;
  guardrails: Record<string, number>;
}
export interface Measurer { measure(): Promise<Measurement>; }

export interface Decision {
  verdict: "accept" | "reject";
  reason: string;
  objective: { before: number; after: number };
  guardrails: { before: Record<string, number>; after: Record<string, number> };
}
export interface LedgerEntry extends Decision {
  at: string;          // ISO-8601
  cycleId: string;
  surfaceId: string;
  hypothesis: string;
  fromVersion: string;
  toVersion: string;
}
export interface ImprovementLedger {
  append(entry: LedgerEntry): Promise<void>; // append-only
  entries(): LedgerEntry[];
}

/** Human gate. Absent gate + access-widening change = blocked (fail-closed). */
export interface OperatorGate {
  approve(proposal: Proposal): Promise<boolean>;
}

export type CycleResult =
  | { status: "no-op"; reason: "insufficient data" | "no proposal" }
  | { status: "blocked"; reason: "operator gate declined" | "operator gate missing" | "cost guard tripped" }
  | { status: "accepted" | "rejected"; decision: Decision; entry: LedgerEntry };
```

### Fail-closed rules (the heart of the story)

1. **No measurement ⇒ no acceptance.** If `measure()` throws or returns a non-finite
   objective, the change is REJECTED and reverted — never accepted on an unmeasured basis.
2. **Accept iff** `after.objective > before.objective + objectiveTolerance` **and** every
   guardrail satisfies `after[k] <= before[k] + guardrailTolerance`. Defaults are `0`
   (strict improvement / zero regression) so the default posture is the conservative one.
3. **Revert on every non-accept path** after `apply()`, including a throwing measurer.
4. **Access-widening change without an approving gate ⇒ blocked**, with no version applied.
5. **Cost guard first:** a tripped `pbiId` short-circuits to `blocked` before any work.
6. **`ok`/verdict vocabulary is explicit** — `status` describes what the cycle did, the
   `decision.verdict` describes the change; they are not conflated.

### Reusing the #121 harness for MEASURE

`Measurer` is implemented by a `BenchmarkMeasurer` that runs the **fixed** benchmark set
from a committed `tests/fixtures/self-improve-benchmark.json` through the pure
`gradeStoryQuality()` gate, and computes the objective from the outcomes. No network, no
`OPENROUTER_API_KEY`, deterministic in CI. The fixture's `version` is copied into the
measurement and the ledger entry, so a later fixture change cannot silently invalidate a
historic comparison.

## Tasks (TDD, vertical tracer bullets)

Strict RED → GREEN → REFACTOR per `test-driven-development`. **Declare every new export with
its real signature and a `throw new Error("not implemented")` body before writing the test** —
a missing named export makes Vitest fail at collection and destroys the whole test file
(lesson from #133/#147).

| # | RED (failing test first) | GREEN (minimal impl) | AC |
| --- | --- | --- | --- |
| 1 | `observeTaskType` returns `null` when the store has no samples; aggregates success rate + means from a seeded `InMemoryMetricsStore` | `observeTaskType(store, taskType, minSamples)` reading `getRecords()` | AC1, AC7 |
| 2 | `stage()` leaves the live value untouched until `apply()`; `revert()` restores `previous` and is idempotent | `IterationBoundSurface` (reads/writes the `DF_MAX_ITERATIONS` seam) + `VersionHandle` | AC3, AC4 |
| 3 | a proposal carries a non-empty hypothesis, and an empty one is refused | `Proposer` contract + `proposeFromObservation` | AC1 |
| 4 | the measurer returns a deterministic objective for the committed fixture, and records its `fixtureVersion` | `BenchmarkMeasurer` over the pure `gradeStoryQuality` | AC2 |
| 5 | **exact-boundary** decide: objective `== before` ⇒ reject; `== before + tolerance` ⇒ reject; strictly greater ⇒ accept; guardrail `== before + tolerance` ⇒ accept, `> tolerance` ⇒ reject | `decide(before, after, cfg)` | AC3, AC4 |
| 6 | a rejected change is reverted; a **throwing measurer** still ends reverted + rejected (fail-closed) | wiring in `runImprovementCycle` | AC4 |
| 7 | ledger entries are append-only and survive re-reading; each shows from/to version, baseline→after, verdict | `InMemoryImprovementLedger` | AC5 |
| 8 | insufficient data ⇒ `no-op` with reason `insufficient data`, and **no** surface call | controller guard | AC7 |
| 9 | a tripped cost guard ⇒ `blocked`, nothing applied; the cycle records a pattern-valid `WorkerActivity` | controller ↔ `CircuitBreaker` | #144 MUST |
| 10 | `access-widening` with no gate ⇒ `blocked`; gate approves ⇒ flows through; gate declines ⇒ `blocked` | operator hook | NFR security |
| 11 | `createSelfImprovementController(env)` fail-closed defaults; malformed `DF_SELFIMPROVE_*` throws a config-specific error | env factory | conventions |
| 12 | skill-set change is just another surface — flows through propose→apply→measure→decide unchanged | surface-agnostic test using a second surface | AC8 |

Drive-by: remove the stale `STUB — implementation pending (TDD RED).` comment in `metrics.ts`.

## Files likely to change

- **NEW** `agent/lib/dark-factory/self-improve.ts` — the controller + all seams.
- **NEW** `tests/dark-factory/self-improve.test.ts` — the TDD suite.
- **NEW** `tests/fixtures/self-improve-benchmark.json` — fixed, versioned benchmark set.
- `agent/lib/dark-factory/index.ts` — re-export the seam + `createSelfImprovementController(env)`.
- `agent/lib/dark-factory/metrics.ts` — drive-by stale-comment removal only.
- `.env.example` — document the new vars (config, not secrets).
- `README.md` — one-line purpose + public API + env vars for the new module.
- `.cspell.json` — new vocabulary.

New env vars (**config**, never secrets — validated digits-only, throw a config-specific error):

| Var | Default | Meaning |
| --- | --- | --- |
| `DF_SELFIMPROVE_ENABLED` | unset ⇒ disabled | Fail-closed: the controller is off unless explicitly enabled. |
| `DF_SELFIMPROVE_MIN_SAMPLES` | `30` | Below this the cycle NO-OPs as "insufficient data". |
| `DF_SELFIMPROVE_OBJECTIVE_TOLERANCE` | `0` | Required objective gain; `0` = strictly better. |
| `DF_SELFIMPROVE_GUARDRAIL_TOLERANCE` | `0` | Allowed guardrail regression; `0` = none. |

## Validation

- `npx tsc --noEmit` clean; full `npx vitest run` with the new tests (no new regressions).
- Local lint gate before push: `npx -y cspell@8 --config .cspell.json <changed files>` (including
  `.env.example` and this plan), plus a prettier check scoped to the changed files only.
- `grep -rn "TDD RED\|not implemented" agent/` returns nothing.
- **Provable on the operator's laptop:** an in-repo demo that runs one real cycle against an
  `InMemoryMetricsStore` + the committed fixture and prints the ledger entry
  (before → after, verdict, reverted-or-applied) — a runnable command, not CI-only evidence.

## Risks / open questions

- **Latency/cost are not in #140 yet.** The objective is therefore success-rate-only; the gap is
  named explicitly and handed to a follow-up rather than papered over with a synthetic metric.
- **Strict-by-default tolerance may reject genuinely good noisy changes.** That is the intended
  fail-closed posture; the operator widens tolerance explicitly rather than the default being loose.
- **Fixture versioning is load-bearing.** A silent edit to the benchmark fixture would invalidate
  historic ledger comparisons, so the version is recorded in every entry.
- **Revert semantics of a real surface.** R4a's surface is the in-process iteration bound, where
  revert is trivially sound. A surface backed by external state (a deployed prompt) would need a
  stronger guarantee — noted for R4b, not assumed here.
- The working tree is shared with another agent session; the branch was created off the remote
  tip and only these paths will be committed.

## Status

**GATE 1 — awaiting plan approval.** No implementation code will be written until this plan is
approved.
