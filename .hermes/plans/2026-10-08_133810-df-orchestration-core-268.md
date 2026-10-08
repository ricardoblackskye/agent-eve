# Dark Factory — Orchestration Core handler (dev → tester → PR) — #268

> **For Hermes:** implement task-by-task with the `test-driven-development` skill
> (RED → GREEN → REFACTOR). This plan is the GATE 1 deliverable; no implementation
> code is written until the user approves it.

**Goal:** Implement the missing Dark Factory orchestration handler — the
`DispatchHandler` that runs **Developer Agent → Tester Agent → PR** in sequence —
and wire it to the existing `Dispatcher`, which already supplies retry/backoff,
parking, and per-run status.

**Issue:** #268 · **Epic:** #267 (Dark Factory — Pre-UAT Readiness, P0) ·
**Branch:** `feat/df-orchestration-core-268`

**Tech stack:** TypeScript, Vitest, `node:sqlite` (`:memory:`) for dispatcher tests.

---

## ⚠️ Finding first — the issue premise is stale (this re-scopes #268)

The issue says *"`agent/lib/dark-factory/dispatch.ts` is `STUB - implementation
pending (TDD RED)`"*. **It is not.** `dispatch.ts` (582 lines) contains a complete,
well-tested `Dispatcher`. Only its header comment still says "STUB".

Consequence for the four acceptance criteria:

| AC                                             | Status today | Evidence                                                                                             |
|------------------------------------------------|--------------|------------------------------------------------------------------------------------------------------|
| AC1 — handler runs dev→tester→pr in sequence   | **MISSING**  | No `DispatchHandler` implementation exists anywhere; every test stubs it (`handler: async () => {}`) |
| AC2 — retry/backoff via `DEFAULT_RETRY_POLICY` | **DONE**     | `dispatch.ts` retry loop; `tests/dark-factory/dispatch.test.ts`                                      |
| AC3 — parked runs do not consume retry budget  | **DONE**     | `dispatch-blocked.test.ts` — "a parked run consumes nothing"                                         |
| AC4 — dispatch status recorded per run         | **DONE**     | `Dispatcher.persist()` + `emit()`; `dispatch.test.ts`                                                |

**So #268 reduces to AC1:** implement the handler and prove the *handler + Dispatcher
integration* satisfies AC2–AC4 end-to-end. No changes to `dispatch.ts` behaviour are
needed (only its stale header comment corrected).

---

## Approach

A new module `agent/lib/dark-factory/dispatch-handler.ts` exports
`createDispatchHandler(deps): DispatchHandler`.

The handler is a **thin, injected orchestrator** — it owns *sequence and translation*,
nothing else:

```text
checkpoint()
developer stage  →  tester stage  →  (pr stage)
```

- It calls the cooperative `checkpoint` before each stage (honours pause/stop).
- It translates stage outcomes into the Dispatcher's control vocabulary:
  - stage **returns** → continue; final return → Dispatcher records `succeeded`;
  - stage **throws `Error`** → retryable (Dispatcher applies `DEFAULT_RETRY_POLICY`);
  - stage **throws `ParkedRunError`** → `blocked`, **no** retry, **no** backoff burn.
- **All** retry/park/status/timeout/dedup/control-gate machinery stays in
  `Dispatcher` (reused unchanged).

Stages are **injected** (`FactoryStages`), so the handler is unit-testable with no
GitHub / LLM / network. The *real* stage implementations (wiring `DeveloperAgent`,
`TesterAgent`, `runDefinitionOfDone`/`GitHubPrWriter`) are composed separately and are
exercised by the end-to-end pipeline test in sibling issue **#269** — not here.

### Why injected stages rather than the agents directly
1. The AC is about *sequence and control semantics*, not agent internals.
2. `DeveloperAgent` needs an `ExecutionPlan` (from the Architect), `TesterAgent` needs a
   `ValidationRequest` (branch/sha), and the PR stage needs `DefinitionOfDoneDeps` — each
   already a rich injected seam. Injecting the three stage functions keeps this handler
   honest and keeps #268 out of GitHub/LLM territory.
3. It matches the repo's existing DI convention (every seam takes deps).

---

## Task structure

### Task 0 — Branch & plan *(done in this step)*
- Branch `feat/df-orchestration-core-268` created from `origin/main`.
- This plan committed and pushed. **Then stop (GATE 1).**

### Task 1 — RED: the handler runs the stages in order
**Files:** Create `tests/dark-factory/dispatch-handler.test.ts`

```ts
import { describe, it, expect } from "vitest";
import {
  createDispatchHandler,
  type FactoryStages,
} from "../../agent/lib/dark-factory/dispatch-handler";
import { toDispatchEvent } from "../../agent/lib/dark-factory/dispatch";

const event = () => toDispatchEvent({ runId: "run-268", repo: "o/r", ref: "main", status: "success" });

it("runs developer → tester → pr, in order", async () => {
  const order: string[] = [];
  const stages: FactoryStages = {
    developer: async () => { order.push("developer"); },
    tester: async () => { order.push("tester"); return { passed: true }; },
    pr: async () => { order.push("pr"); },
  };
  await createDispatchHandler({ stages })(event(), "developer", async () => {});
  expect(order).toEqual(["developer", "tester", "pr"]);
});
```

**Run:** `npx vitest run tests/dark-factory/dispatch-handler.test.ts`
**Expected:** FAIL — module does not exist (real RED once the stub below exists).

### Task 2 — GREEN: declare the seam, minimal implementation
**Files:** Create `agent/lib/dark-factory/dispatch-handler.ts`

```ts
import { ParkedRunError, type DispatchEvent, type DispatchCheckpoint, type DispatchHandler } from "./dispatch";

export interface FactoryStageContext { event: DispatchEvent; worker: string; }
export interface TesterStageResult { passed: boolean; parked?: boolean; reason?: string; }

export interface FactoryStages {
  developer(ctx: FactoryStageContext, checkpoint: DispatchCheckpoint): Promise<void>;
  tester(ctx: FactoryStageContext, checkpoint: DispatchCheckpoint): Promise<TesterStageResult>;
  pr(ctx: FactoryStageContext, checkpoint: DispatchCheckpoint): Promise<void>;
}

export interface DispatchHandlerDeps { stages: FactoryStages; }

export function createDispatchHandler(deps: DispatchHandlerDeps): DispatchHandler {
  return async (event, worker, checkpoint) => {
    const ctx: FactoryStageContext = { event, worker };
    await checkpoint();
    await deps.stages.developer(ctx, checkpoint);
    const tester = await deps.stages.tester(ctx, checkpoint);
    if (!tester.passed) {
      if (tester.parked) throw new ParkedRunError(tester.reason ?? "worker needs a human decision");
      throw new Error(`Tester gate failed: ${tester.reason ?? "validation failed"}`);
    }
    await deps.stages.pr(ctx, checkpoint);
  };
}
```

**Run:** the Task 1 test. **Expected:** PASS.

### Task 3 — RED/GREEN: a checkpoint runs before each stage
Assert `checkpoint` is invoked (≥) once before each stage begins. Test with a counter
that snapshots at each stage entry (`expect(checkpointCallsAtDev).toBeLessThan(...)`).
Assert a `StoppedRunError` thrown by `checkpoint` propagates (so a stopped run never
reaches the next stage).

### Task 4 — RED/GREEN: retry/backoff via `DEFAULT_RETRY_POLICY` (AC2)
Integration test: build a real `Dispatcher` (in-memory `SqliteStateAdapter(":memory:")`)
whose `handler` is `createDispatchHandler` with a `tester` stage that fails **twice**
then passes. Inject `sleep` counting calls.
- Expected: developer stage ran **3** times; `outcome.status === "succeeded"`.

### Task 5 — RED/GREEN: a parked run consumes no retry budget (AC3)
Tester stage throws `ParkedRunError`.
- Expected: `outcome.status === "blocked"`, developer ran **1** time, `sleep` called **0**
  times. (Mirrors `dispatch-blocked.test.ts`, now through the handler.)

### Task 6 — RED/GREEN: dispatch status recorded per run (AC4)
Read the store after a successful dispatch: `store.get<DispatchRecord>(dispatchKey("run-268"))`
→ `status === "succeeded"`, `attempts === 1`. And after a parked run → `"blocked"`.

### Task 7 — RED/GREEN: stage failures propagate as retryable
A `developer` stage that throws → the Dispatcher retries (bounded) and the run ends
`failed` once the budget is exhausted (never infinite).

### Task 8 — Wire-up (barrel, docs, ADR)
- Modify `agent/lib/dark-factory/index.ts`: export `createDispatchHandler`,
  `FactoryStages`, `FactoryStageContext`, `TesterStageResult`, `DispatchHandlerDeps`.
- Modify `docs/pages/dark-factory-modules.md`: add a `## dispatch-handler` entry
  (Source path + Exports) — **required** or `tests/doc-drift-guards.test.ts` fails.
- Modify `docs/pages/flow-run-lifecycle.md`: document dev → tester → pr (the handler).
- Create `docs/adr/0019-orchestration-handler-sequences-the-factory-pipeline.md` and
  link it from `docs/adr/README.md` (index integrity is guarded).
- Fix the stale `STUB` header comment in `dispatch.ts`.
- **No new env vars** → `.env.example` is unchanged (keeps `env-example-coverage` green).

### Task 9 — Local gate (MANDATORY before any push)
```bash
npx vitest run tests/dark-factory/dispatch-handler.test.ts
npx vitest run tests/dark-factory
npx vitest run                       # full suite, no NEW regressions
npx tsc --noEmit --incremental false
npx vitest run tests/doc-drift-guards.test.ts tests/env-example-coverage.test.ts
npx -y cspell@8 --config .cspell.json agent/lib/dark-factory/dispatch-handler.ts tests/dark-factory/dispatch-handler.test.ts docs/adr/0019-*.md
DF_PLATFORM_PROVIDER=generic npm run build
```

---

## Files likely to change

| File                                                                    | Action                                        |
|-------------------------------------------------------------------------|-----------------------------------------------|
| `agent/lib/dark-factory/dispatch-handler.ts`                            | **Create** — the handler seam                 |
| `tests/dark-factory/dispatch-handler.test.ts`                           | **Create** — TDD tests                        |
| `agent/lib/dark-factory/index.ts`                                       | Modify — barrel exports                       |
| `agent/lib/dark-factory/dispatch.ts`                                    | Modify — correct the stale `STUB` header only |
| `docs/pages/dark-factory-modules.md`                                    | Modify — module doc entry (drift guard)       |
| `docs/pages/flow-run-lifecycle.md`                                      | Modify — describe the pipeline                |
| `docs/adr/0019-orchestration-handler-sequences-the-factory-pipeline.md` | **Create**                                    |
| `docs/adr/README.md`                                                    | Modify — link ADR 0019                        |

---

## Validation (Definition of Done for this issue)
- [ ] New handler unit + integration tests pass; each watched fail-then-pass.
- [ ] `dispatch.test.ts` / `dispatch-blocked.test.ts` / `dispatch-control-gate.test.ts` still green.
- [ ] Full `npx vitest run` — no NEW regressions.
- [ ] `npx tsc --noEmit --incremental false` clean.
- [ ] `doc-drift-guards` + `env-example-coverage` green.
- [ ] Local lint (cspell/standard) clean on changed files.
- [ ] ADR 0019 written and linked.
- [ ] No code path merges a PR (invariant from `pr-writer.ts`) — handler only *opens*.

---

## Risks & open questions

1. **Architect stage.** The issue names `dev → tester → pr`, but the Developer Agent's
   multi-file loop consumes an `ExecutionPlan` produced by the **Architect Agent**
   (`architect-agent.ts`). Recommendation: keep this handler to the three stages the AC
   names and treat *plan resolution* as an input to the `developer` stage (the real stage
   wiring in #269 runs Architect→Developer). **Confirm this reading.**
2. **Tester-failure semantics.** Recommendation: a **validation failure throws** (the
   Dispatcher retries it, bounded by `DEFAULT_RETRY_POLICY`, since the dev loop may
   self-correct), while an explicit **question/ambiguity** throws `ParkedRunError`
   (`blocked`, no retry). **Confirm** vs. parking every tester failure.
3. **Production invocation point is OUT OF SCOPE here.** `entry.ts` deliberately does not
   run the loop (it hands off via a session POST), and the worker runtime is a separate
   release. Wiring the handler into the real invocation is #269's job. #268 delivers the
   handler + Dispatcher integration + tests.
4. **`scripts/dark-factory-runner.ts`** currently duplicates a dev→PR path (no tester).
   Refactoring it to consume this handler is **deferred** (YAGNI); noted as a follow-up so
   the two don't drift silently.
5. **Stage result shapes** are kept minimal now (`TesterStageResult`) and expanded by TDD
   as real stages need them.

---

## ADRs to add (decision-time, this change)
- **ADR 0019 — The orchestration handler sequences the factory pipeline.**
  Context: `dispatch.ts` provides retry/park/status but no pipeline. Decision: the
  pipeline is a thin injected `DispatchHandler` over the unchanged `Dispatcher`; retryable
  failures throw, human questions park (`ParkedRunError`); the Dispatcher owns retry,
  backoff, parking and status. Consequences: the handler stays unit-testable and the
  control semantics live in exactly one place.

---

## Out of scope
- Real agent wiring / GitHub calls / the end-to-end pipeline test (→ #269).
- Refactoring `scripts/dark-factory-runner.ts`.
- Any change to `Dispatcher` retry/park/status behaviour.
