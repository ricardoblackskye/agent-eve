# Developer and sandbox usage in the ledger Implementation Plan (#532, epic #453)

> **For Hermes:** execute with the repo's own TDD discipline (RED -> GREEN per task, separate
> commits), then stop at GATE 2 for PR authorization.

**Goal:** make the sandbox/developer path's spend visible in the usage ledger, so the calibration report
can report a real developer stage instead of comparing an expectation against an unmeasured zero — and
say honestly which stages it could measure.

**Architecture:** the gateway already settles the reservation from the provider's usage. Carry that
usage out of the settled seam and into the ledger as a `UsageEvent`, then make the run summary read the
ledger alone (one source), as ADR 0075 requires.

**Tech Stack:** TypeScript, Vitest, the existing governed seam and usage store, no new dependency.

---

## Verified findings (the reconnaissance this plan rests on)

### The sink the issue pointed at cannot work, and that is worth recording

`DeveloperAgent` exposes the narrow `WorkerUsageSink` seam, and the runner constructs it
**without** one (`new DeveloperAgent({ metrics })`, `dark-factory-runner.ts:422`). Wiring it looks like
the obvious fix, but the sink is called as `this.usage.record()` — **with no measurement**
(`developer-agent.ts:474`) — and the sandbox reports no tokens anywhere. So the sink has nothing to
report: it would write an empty event. The seam is the wrong lever, and the issue's own scope allows for
that by offering the ingestion route instead.

### Where the sandbox's spend actually is, and what it is missing

- The developer works through **sandboxed workspace tools**, so its model calls go through the deployed
  LLM gateway, not the in-process loop.
- The gateway uses *"the SAME governed seam the in-process loop uses: reserve -> run -> settle"*
  (`llm-gateway.ts:131`), and that seam settles from the provider's usage — `settleFromUsage` takes
  `{ inputTokens, outputTokens }`. **So the real usage is already in hand at the settle point.**
- What leaves that point is thin: `GatewayUsageRecord` is `{ runId, tenantId?, model, reservationId,
  estimatedUsd }` — a money estimate, **no tokens, no task type** — and `gateway-recorder.ts` turns it
  into a `run.cost` event with `stage: "worker"` and `costUsd: usage.estimatedUsd`.
- So the sandbox's spend IS visible to the run history (and #531's writer already sums it into the run
  summary), but the **ledger** never sees it — which is exactly why the calibration report shows the
  developer stage as unmeasured.

### The rule ADR 0075 already set

Once that spend reaches the ledger, the summary must stop adding the `run.cost` events, or it is counted
twice. ADR 0075 says so explicitly and names this issue as where it has to happen.

## Global constraints

- The ledger stays the record of what was MEASURED: tokens and cost, counts and money, never content.
- The event's cost is the SETTLED value where one exists. A reservation estimate is not an actual, and
  writing it as one would make the ledger disagree with the governor.
- Recording stays best-effort and opt-in, exactly as #209 and #492 established: no usage write may fail a
  call, and an unconfigured deployment records nothing.
- The report compares like with like: a stage whose spend was not measured is reported as unmeasured,
  never as a zero that drags its bias.
- No new env var unless one is genuinely needed.

## Review focus

- **The task type must be the one the estimator's split uses.** `decomposePlanCostEstimateFromCounts`
  returns `architect` and `developer`; a ledger row typed `worker` would appear as a third stage and
  compare against an expectation of zero. Assert the mapping rather than assuming it.
- **The settled value, not the estimate.** Prove the two differ in a fixture (a reservation that settles
  above or below its estimate) and that the ledger records the settled one.
- **One source for the summary.** Assert the summary's writer no longer adds the event term, with a
  fixture where an event AND a ledger row exist for the same run: the total must be the ledger's, not
  their sum.
- **A measured stage is not inferred from a zero.** The report's stage list must distinguish "recorded
  nothing" from "not recorded", and a fixture with no developer rows must not produce a developer bias.

## Tasks

### Task 1 — carry the usage out of the settled seam

**Files:** modify `agent/lib/dark-factory/llm-gateway.ts` (widen `GatewayUsageRecord`), test
`tests/dark-factory/gateway-usage-record.test.ts`.

Add the measured fields the seam already has: `tokensIn`, `tokensOut`, and the settled `costUsd`, with
`estimatedUsd` kept for the reservation trail. RED: the record carries what the ledger needs; the call
site passes the settled cost rather than the estimate.

### Task 2 — the gateway records a usage event

**Files:** modify `agent/lib/dark-factory/gateway-recorder.ts`, test
`tests/dark-factory/gateway-usage-recorder.test.ts`.

The recorder gains the usage store and writes a `UsageEvent` with `taskType: "developer"` alongside the
existing `run.cost` event (which the run history keeps for its own trail). Opt-in and best-effort: no
usage store configured records nothing, and a usage failure never fails the forwarded call.

### Task 3 — one source for the run summary

**Files:** modify `agent/lib/dark-factory/run-cost-recorder.ts`, test
`tests/dark-factory/run-cost-recorder.test.ts` (extend).

Per ADR 0075: the summary is the LEDGER's total once the gateway writes usage events. Stop adding the
event term, and assert with a fixture that has both — the total must be the ledger's alone.

### Task 4 — the report says which stages it measured

**Files:** modify `agent/lib/dark-factory/calibration-report.ts`, test
`tests/dark-factory/calibration-report.test.ts` (extend).

A stage with no recorded actual is marked unmeasured and excluded from the bias, rather than compared
against zero. `byStage` keeps listing it, so the blind spot stays visible instead of silently vanishing.

### Task 5 — ADR 0076 and docs

**Files:** create `docs/adr/0076-sandbox-usage-reaches-the-ledger.md`, modify `docs/adr/README.md` and
`docs/pages/dark-factory-cost-estimation.md`.

Records why the sink route was rejected (no measurement to report), why the settled seam is the right
source, and that the summary now reads one source. Closes the loop ADR 0075 opened.

---

## Validation

- Full suite green with no new failures, `tsc --noEmit --incremental false` clean, every pinned linter
  clean locally on the changed files.
- **Live proof:** run the factory for real with both ledgers on the local store, then show a
  `task_type: "developer"` row in `df_usage_events` — the first the ledger has ever held — the
  calibration report's developer stage carrying a real bias instead of a withheld MAPE, and the run
  summary's `cost_usd` still matching the ledger (proving the event term was dropped, not double counted).
- Unset the run-time `DF_*` exports before validating, or the suite lies.

## Settled decisions (agreed at GATE 1)

1. **Carry the usage out of the settled seam.** The tokens are already in hand at the point the
   reservation settles, so nothing has to be re-derived — and ingesting the `run.cost` events instead
   would have meant recording a money estimate as though it were a measurement.
2. **The task type is `developer`**, the name the estimator's split uses, so the by-stage comparison
   lines up. `worker` would match the existing event's stage but appear as a stage with no expectation
   to compare against.
3. **The summary's event term goes**, per ADR 0075: with the gateway writing usage events the ledger is
   the one source, and keeping both would count the same spend twice.
4. **An unmeasured stage is marked and excluded from the bias.** A zero actual is not a prediction, and
   the stage still appears in `byStage` so the blind spot stays visible.
5. **The tester's spend is recorded too.** The ledger is the record of spend; consumers already filter by
   task type, and the estimator's scope is enforced where the comparison happens rather than at intake.

## Risks that remain

- **The gateway's cost record and the ledger can briefly disagree** while a deployment has one change but
  not the other. The settled value is what the ledger takes, so a lag shows up as a smaller recorded
  spend, never as a larger one.
- **A sandbox run's spend still depends on the gateway forwarding the usage hook.** If a deployment does
  not configure the usage store, the ledger records nothing and the report says so rather than guessing.
