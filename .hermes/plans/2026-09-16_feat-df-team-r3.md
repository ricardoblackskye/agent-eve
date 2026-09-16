# Dark Factory R3 — Eve's Team (feat/df-team) Implementation Plan

> **For Hermes:** Use test-driven-development to implement this plan task-by-task.
> **Branch:** `feat/df-team` (off `origin/main` = the current tip including PR #149)
> **Stories (R3 work items):** #131 (Developer Agent epic) · #132 (Tester Agent epic) · #143 (Circuit breaker epic)
> **Date:** 2026-09-16
> **Prerequisite:** R1 (`#134`/`#138`/`#140`) and R2 (`#135`/`#142`) are merged. This branch starts from their culmination on `origin/main`.

**Goal:** Complete the Dark Factory by giving Eve a team of specialized worker agents — a Developer Agent that writes code in sandboxes, and a Tester Agent that validates before PRs — plus a factory-level circuit breaker/cost guard to prevent runaway costs and surface failures to humans.

**Architecture (2-3 sentences):** R3 delivers the "hands" of the factory. Three new seams under `agent/lib/dark-factory/`: a `DeveloperAgent` that orchestrates sandbox coding, a `TesterAgent` that runs validation loops, and a `CircuitBreaker` that caps worker-minutes and failed self-correct cycles. Each follows the established canonical-payload + adapter + fail-closed-default pattern, with the circuit breaker depending on the R1 metrics store and worker environment from R2.

**Tech stack:** TypeScript (Node 22 for local dev, CI uses Vercel), Vitest for testing, `node:sqlite` and in-memory adapters already in place from R1/R2. No new runtime dependencies.

---

## Release Position

| Release | Branch                   | Scope                                                                                              | State              |
|---------|--------------------------|----------------------------------------------------------------------------------------------------|--------------------|
| R1      | `feat/df-core`           | Execution memory, dispatch/self-correction, observability                                          | MERGED             |
| R2      | `feat/df-worker-env`     | Credential boundary (#142), worker environment (#135)                                            | MERGED             |
| **R3**  | **`feat/df-team`**       | Developer Agent (#131/#133), Tester Agent (#132/#136), Circuit Breaker (#143/#144)              | **this plan**      |

## Scope Summary

**Epics in scope:**
- #131 — Developer Agent (Eve's Team) → Story: #133
- #132 — Tester Agent (Eve's Team) → Story: #136
- #143 — Factory-level circuit breaker / cost guard → Story: #144

**Key dependencies:**
- R1 seams (`state.ts`, `dispatch.ts`, `metrics.ts`) for coordination and observability
- R2 seams (`credentials.ts`, `worker-env.ts`) for sandbox execution and credential safety
- Circuit breaker integrates with metrics store to track worker-minutes per PBI

## Non-goals in R3

- No QStash queue integration (still in-process/discrete dispatch)
- No GitHub App (credential boundary uses existing PAT via broker)
- No live container providers (E2B/Modal remain dry-run defaults until keys exist)
- These remain future work for R4+ (e.g., `#146` Measurable Recursive Self-Improvement)

---

## Common Seams

Three new modules under `agent/lib/dark-factory/`:

```text
agent/lib/dark-factory/
├── developer-agent.ts   # DeveloperAgent seam + TaskAssignment canonical payload
├── tester-agent.ts      # TesterAgent seam + ValidationReport canonical payload  
├── circuit-breaker.ts   # CircuitBreaker seam + TripEvent canonical payload
└── index.ts             # extended factory functions + orchestration wiring
```

---

## Story #133 — Developer Agent

**Intent (from #131/#133):** Accept a specific task description, run it in a sandboxed worker environment, write code, modify guided files by skeletal map, write tests, iterate until tests pass.

**Key integrations:**
- Uses `Dispatcher` to receive CI-failure events or task dispatch
- Uses `WorkerProvider` (R2) to provision sandbox
- Uses `CredentialBroker` (R2) for repo access leases
- Uses `MetricsStore` (R1) to record iteration/fix cycles

**Core behaviors:**
1. Receive task via dispatch → route to worker sandbox
2. Push context (skeletal map + PBI data) into sandbox
3. Execute coding logic within sandbox timeout
4. Worker iterates locally (TDD: fail → fix → pass)
5. Report back via dispatch + emit metrics
6. Circuit breaker can halt if worker-minutes exceeded

---

## Story #136 — Tester Agent

**Intent (from #132/#136):** Validate a developed branch before PR submission using static analysis, smoke tests, and security scans to catch regressions early.

**Key integrations:**
- Reads state via `StateStore` to get commit hash and test output
- Uses existing linting/test commands (`tsc`, `cspell`, `vitest`)
- Blocks PR creation if any check fails

**Validation loop:**
1. Receive "developed branch" notification
2. Checkout branch → run static analysis (`tsc`, `cspell`)
3. Execute smoke tests (`vitest run`)
4. Run security scan (if configured)
5. Return combined pass/fail report
6. Optionally block PR via GitHub check

---

## Story #144 — Factory-level Circuit Breaker

**Intent (from #143/#144):** Cross-task guard that caps worker-minutes per PBI and escalates after N failed self-correct cycles, preventing cost spirals.

**Integration points:**
- Monitors `TaskMetric` stream from R1 `MetricsStore`
- Tracks cumulative worker-minutes per PBI (project board item)
- Counts self-correct cycles (dispatch retries → CI fails → re-dispatch)
- Emits `TripEvent` when thresholds exceeded

**Behaviors:**
1. Given PBI with `max_worker_minutes=B`, trip when cumulative minutes ≥ B
2. Given N failed self-correct cycles, escalate to human channel
3. After trip, halt all work, no additional minutes consumed
4. Independent of per-task retry/iteration bounds (additive guard)

---

## Files Likely to Change

- `agent/lib/dark-factory/developer-agent.ts` — Developer agent seam, `TaskAssignment` payload
- `agent/lib/dark-factory/tester-agent.ts` — Tester agent seam, `ValidationReport` payload
- `agent/lib/dark-factory/circuit-breaker.ts` — Circuit breaker seam, `TripEvent` payload
- `agent/lib/dark-factory/index.ts` — extend factories, wire new seams
- `tests/dark-factory/developer-agent.test.ts` — TDD tests for coding loop
- `tests/dark-factory/tester-agent.test.ts` — TDD tests for validation loop
- `tests/dark-factory/circuit-breaker.test.ts` — TDD tests for trip conditions
- `.env.example` / `README.md` / `ARCHITECTURE.md` — document R3 env vars
- `.cspell.json` — any new technical words from linter

## Validation (must all pass before push / PR)

- **TDD discipline:** every task RED→GREEN observed; each test fails for the right reason first
- **Full suite:** `npx vitest run` — all existing tests still pass (no new regressions)
- **Type-check:** `npx tsc --noEmit` clean
- **Local lint gate (MANDATORY before push):** cspell on changed files; markdownlint clean on docs
- **R3 AC self-check:**
  - #133: Developer agent accepts task → iterates in sandbox → passes tests
  - #136: Tester agent blocks PR on quality/security failures
  - #144: Circuit breaker trips on worker-minute cap or failed self-correct threshold

## Risks / Open Questions

1. **Worker-minute measurement:** Need clear definition of "worker minute" — total sandbox time? CPU time? This affects how we count toward the cap. Recommend starting with wall-clock time per task.
2. **Human escalation channel:** What's the configured channel for circuit breaker alerts? Should this be a new env var like `DF_ESCALATION_CHANNEL`?
3. **PBI identity:** Issues use "PBI" (Product Backlog Item) terminology. Need to confirm how PDIs map to GitHub project items or issue IDs.
4. **Self-correct cycle definition:** When does a "self-correct cycle" begin and end? Is it: CI fail → dispatch → fix → CI pass (one cycle) or something else?

---

## Task Breakdown (TDD Structure)

### Task 133.1 — Developer Agent core types + dispatch handler

### Task 133.2 — Sandbox provisioning with context push

### Task 133.3 — TDD coding loop (fail → fix → pass)

### Task 133.4 — Worker-agent metric emission

### Task 136.1 — Tester Agent validation types

### Task 136.2 — Static analysis integration

### Task 136.3 — Smoke test execution

### Task 136.4 — Security scan integration

### Task 144.1 — Circuit breaker types + worker-minute tracking

### Task 144.2 — Self-correct cycle counting

### Task 144.3 — Trip event emission + blocking behavior

### Task 144.4 — Integration with R1 metrics store

---

*A plan file saves work; an implemented feature changes the world.*