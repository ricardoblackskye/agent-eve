# Story #144 — Factory-level Circuit Breaker / Cost Guard Implementation Plan

> **For Hermes:** Use test-driven-development to implement this plan task-by-task.
> **Branch:** `feat/circuit-breaker-144` (off `origin/main` = current)
> **Issue:** #144 (child of #143 epic)
> **Date:** 2026-09-16

**Goal:** Build a cross-task safety guard that caps cumulative worker-minutes per PBI and escalates after N failed self-correct cycles, preventing runaway costs and surfacing failures to humans.

**Architecture:** A seam (`CircuitBreaker`) that monitors the R1 `MetricsStore` stream, tracks worker budget per PBI, and emits `TripEvent` when thresholds exceeded. Independent additive guard on top of per-task retry/iteration bounds.

**Tech stack:** TypeScript, leverages R1 `MetricsStore` (worker-env tasks + attempt counts).

---

## Acceptance Criteria (from #144)

| AC | Description |
|----|-------------|
| AC1 | Given PBI with max worker-minute budget B, when cumulative minutes ≥ B, HALT all work and emit `circuit-breaker-tripped` event |
| AC2 | Given N failed self-correct cycles, when Nth completes, STOP retrying and ESCALATE to human |
| AC3 | Given tripped circuit, no additional worker-minutes consumed |
| AC4 | Independent of and additive to per-task retry/iteration bounds |

---

## Dependencies

- **R1 seams:** `MetricsStore` (task timing, status), `StateStore` (persist trip state)
- **R1 metrics:** `worker-env` task type includes duration for minute calculation
- **Circuit breaker config:** need env vars for `DF_MAX_WORKER_MINUTES_PER_PBI`, `DF_MAX_FAILED_SELFCORRECT`

---

## TDD Tasks

### Task 144.1 — Core types + TripEvent payload

**Test target:** `tests/dark-factory/circuit-breaker.test.ts`

**RED:**
```typescript
toTripEvent({pbiId, workerMinutes, reason}) produces valid event
→ reject missing pbiId
→ reject negative/minutes
→ reason must be 'worker-minutes-exceeded' | 'failed-selfcorrect-exceeded'
```

**GREEN:**
```typescript
interface CircuitBreakerConfig { maxWorkerMinutesPerPbi?: number, maxFailedSelfCorrect?: number }
type TripReason = 'worker-minutes-exceeded' | 'failed-selfcorrect-exceeded'
interface TripEvent { pbiId: string, workerMinutes: number, reason: TripReason, timestamp: string }
```

### Task 144.2 — Worker-minute tracking per PBI

**RED:**
```typescript
accumulateWorkerMinutes(taskMetrics: TaskMetric[]): Map<pbiId, minutes>
→ sum duration from worker-env tasks
→ return cumulative minutes per PBI
```

**GREEN:**
```typescript
function accumulateWorkerMinutes(metrics: TaskMetric[]): Map<string, number>
```

### Task 144.3 — Self-correct cycle counter

**RED:**
```typescript
countFailedSelfCorrectCycles(dispatcherMetrics: TaskMetric[]): number
→ count (dispatch attempts - 1) for CI-fail→re-dispatch patterns
→ where status = 'failed' AND cause = 'ci-failure'
```

**GREEN:**
```typescript
function countFailedSelfCorrectCycles(metrics: TaskMetric[]): number
```

### Task 144.4 — Circuit breaker core logic

**RED:**
```typescript
checkTripState(metrics, config) → TripEvent | null
→ sum worker minutes per PBI
→ compare to maxWorkerMinutesPerPbi
→ count self-correct cycles
→ compare to maxFailedSelfCorrect
→ emit TripEvent on first trip
```

**GREEN:**
```typescript
interface CircuitState { trippedPbis: Set<string>, tripEvents: TripEvent[] }
class CircuitBreaker {
  checkAndTrip(metrics: TaskMetric[], config: CircuitBreakerConfig): TripEvent | null
  isTripped(pbiId: string): boolean
}
```

### Task 144.5 — Integration with MetricsStore observer

**RED:**
```typescript
createCircuitBreakerObserver(store, config) → dispatch middleware
→ on each metrics record, check trip state
→ if trip, write to state and emit event
```

**GREEN:**
```typescript
function createCircuitBreakerObserver(metrics: MetricsStore, config: CircuitBreakerConfig): MetricsObserver
// Returns callback registered with dispatch.ts observer
```

### Task 144.6 — Environment wiring

**RED:**
```typescript
createCircuitBreaker(env) → CircuitBreaker instance
→ read DF_MAX_WORKER_MINUTES_PER_PBI (default: 60)
→ read DF_MAX_FAILED_SELFFCORRECT (default: 3)
→ create in-memory state + metrics observer
```

**GREEN:**
```typescript
function createCircuitBreaker(env: ProcessEnv): CircuitBreaker {
  const config = {
    maxWorkerMinutesPerPbi: parseInt(env.DF_MAX_WORKER_MINUTES_PER_PBI || '60'),
    maxFailedSelfCorrect: parseInt(env.DF_MAX_FAILED_SELFCORRECT || '3'),
  }
  return new CircuitBreaker(config, metricsStore, stateStore)
}
```

---

## Files to Create/Modify

| Action | Path | Description |
|--------|------|-------------|
| Create | `agent/lib/dark-factory/circuit-breaker.ts` | Circuit breaker seam |
| Create | `tests/dark-factory/circuit-breaker.test.ts` | TDD test suite |
| Modify | `agent/lib/dark-factory/index.ts` | export `createCircuitBreaker`, add observer |
| Modify | `.env.example` | `DF_MAX_WORKER_MINUTES_PER_PBI`, `DF_MAX_FAILED_SELFCORRECT` |
| Modify | `README.md` | R3 Circuit Breaker section |

---

## Validation

- ✅ `npx vitest run tests/dark-factory/circuit-breaker.test.ts` — all tests pass
- ✅ `npx tsc --noEmit` clean
- ✅ Local lint gate (cspell + markdownlint)
- ✅ Integration: metrics observer emits TripEvent when budget exceeded

---

## Risks / Open Questions

1. **Worker-minute precision** — is duration ms or seconds? Plan assumes seconds → minutes = duration/60000
2. **PBI identification** — how is PBI ID extracted from metrics? Need to confirm TaskMetric shape includes it
3. **Escalation channel** — this story focuses on trip detection; actual human notification is operational config

---

*Without a circuit breaker, recursive self-improvement becomes a runaway train.*