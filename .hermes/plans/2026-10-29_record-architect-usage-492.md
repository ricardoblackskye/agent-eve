# Architect planning in the usage ledger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An architect planning call records a `UsageEvent` with `taskType: "architect"`, so planning spend is separable from implementation spend in the usage ledger.

**Architecture:** An optional, narrow usage sink on the governed call path — the same shape `developer-agent.ts` already exposes as `WorkerUsageSink` — supplied ONLY for the architect call at the runner's composition root. The event is written after the call returns, from the provider's measured usage when it reports one, best-effort. The query side needs no production change: `UsageReport.byTaskType` and `UsageQueryParams.runId` already exist.

**Tech Stack:** TypeScript, Vitest, the `ai` SDK (`streamText`, v7), the existing usage ledger (`usage-store.ts`, `usage-ledger.ts`).

**Spec:** issue #492 — `feat(df): record architect planning in the usage ledger, not just the budget category`. Its acceptance criteria are the contract; this plan implements exactly them.

## Global Constraints

- **Opt-in.** Usage recording happens only when `isUsageRecordingConfigured(env)` is true (`DF_USAGE_DRIVER` = `postgres` | `sqlite`). No driver, no events — and no new env vars.
- **Best-effort.** A ledger outage, a malformed event, or an unconfigured store must never fail the call it measures. Failures are logged, never thrown (`recordSafely`).
- **No content.** `UsageEvent` carries `{ runId, pbiId?, taskType, model, tokensIn?, tokensOut?, costUsd?, durationMs?, tenantId?, ts }`. Never prompts or completions.
- **Absent is not zero.** An unmeasured field is omitted; the report shows `—` and counts the event toward `unmeasured`. Never write `0` for "we did not measure".
- **`taskType` is required on every event** and is the key `byTaskType` groups on.
- **One price source.** Any cost we record comes from `resolvePrice` (the governor's own resolver, ADR 0027), never a second table.
- **Developer and tester counts must not change** (AC3). Their paths keep writing exactly what they write today.

## Review Focus

The five conditions most likely to bite, each pinned by a test in the owning task:

1. **Usage recording is unconfigured** — no `DF_USAGE_DRIVER`. The planning call must still succeed and record nothing.
2. **The store throws while recording** — the call must still succeed, and the failure must be logged rather than swallowed silently.
3. **The provider reports no usage** — `tokensIn`/`tokensOut`/`costUsd` must be ABSENT, not `0`, so the report shows `unmeasured` rather than free.
4. **A call that is REFUSED by the cost gate** — no event at all: nothing was spent, so there is nothing to attribute.
5. **A resumed run** — the architect is never called, so no architect event appears for that run (the existing "architect not called on resume" property must not be contradicted by a phantom event).

## Task 1: A usage sink on the governed call path

**Files:**
- Modify: `agent/lib/dark-factory/governed-agent-call.ts` (the options interface + the record step)
- Test: `tests/dark-factory/governed-call-usage.test.ts`

**Interfaces:**
- Consumes: `UsageStore`/`recordSafely` from `./usage-store`, the `UsageEvent` shape from `./usage-ledger`.
- Produces: `GovernedAgentCallOptions<T>.usage?: GovernedCallUsage<T>` where

```ts
export interface UsageMeasurement {
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs?: number;
}

export interface GovernedCallUsage<T> {
  /** The task type recorded on the event, e.g. "architect". */
  taskType: string;
  /** Best-effort sink. Its record() resolves false rather than throwing. */
  sink: { record(measurement?: UsageMeasurement & { taskType?: string }): Promise<boolean> };
  /** Measured usage from the call's result. Absent fields stay ABSENT on the event. */
  measurementOf?: (result: T) => UsageMeasurement;
  /** Test seam: overrides the clock-free duration source. */
  durationMs?: () => number;
}
```

- [ ] **Step 1: Write the failing test** — a governed call WITH a `usage` option appends exactly one event whose `taskType` is `"architect"` and which carries the measured tokens; a call WITHOUT the option appends nothing.

```ts
it("records a usage event, tagged with the call's task type", async () => {
  const seen: UsageMeasurement[] = [];
  const sink = { record: async (m) => { seen.push(m as UsageMeasurement); return true; } };
  await runGovernedAgentCall(
    { governor, runHistory: store, runId: "run-1" },
    { category: "architect", model: "deepseek/deepseek-v4.1-flash", inputTokens: 10, outputTokens: 10,
      run: async () => "plan", usage: { taskType: "architect", sink } },
  );
  expect(seen).toHaveLength(1);
  expect(seen[0].taskType).toBe("architect");
});

it("records nothing when no sink is supplied", async () => { /* AC3 */ });
```

- [ ] **Step 2: Run it** — `npx vitest run tests/dark-factory/governed-call-usage.test.ts`. Expected: FAIL, `usage` is not a known option (and no event is recorded).

- [ ] **Step 3: Implement** — in `runGovernedAgentCall`, after `outcome.ok`, call `options.usage?.sink.record({ taskType: options.usage.taskType, ...(options.usage.measurementOf?.(outcome.result) ?? {}) })` inside a `try/catch` that logs on failure. On a REFUSED call, record nothing.

- [ ] **Step 4: Run it** — expected PASS, plus the existing governed-call suite still green.

- [ ] **Step 5: Commit** — `test(492): RED …` then `feat(492): GREEN …` (separate commits, per the repo convention).

## Task 2: Wire it at the architect call

**Files:**
- Modify: `scripts/dark-factory-runner.ts` (the architect's `runGovernedAgentCall`, ~line 520)
- Test: `tests/dark-factory/architect-usage-wiring.test.ts`

**Interfaces:**
- Consumes: Task 1's `GovernedCallUsage`, `isUsageRecordingConfigured` + `createUsageStore` + `BufferedUsageRecorder` from `./usage-store-provider`, `estimateCost` + `resolvePrice` from `./cost-budget`.
- Produces: the architect call site passing `usage: { taskType: "architect", sink, measurementOf }`.

- [ ] **Step 1: Write the failing test** — a source-level guard that the architect call site passes `taskType: "architect"` AND builds its sink behind `isUsageRecordingConfigured` (the pattern `scripts/pr-reviewer-usage.ts:75` already uses), so an unconfigured deployment records nothing.
- [ ] **Step 2: Run it** — expected FAIL: the call site has no `usage` option.
- [ ] **Step 3: Implement** — build the sink once at the top of the run (`isUsageRecordingConfigured(env) ? new BufferedUsageRecorder(createUsageStore(env)) : null`), and pass it only on the architect call. Capture the provider's usage from the stream result before returning; **first read the installed `ai` types to confirm the member name** (`readonly usage: PromiseLike<LanguageModelUsage>` appears in `node_modules/ai/dist/index.d.ts`) and await it after the text stream completes. Compute `costUsd` with `estimateCost(model, tokensIn, tokensOut)`; leave any field absent when it was not measured. Record `durationMs` from the call's own start/end.
- [ ] **Step 4: Run it** — expected PASS; then `npx tsc -p tsconfig.json --noEmit --incremental false`.
- [ ] **Step 5: Commit** — RED then GREEN.

## Task 3: Prove the query side separates architect spend per run (AC2)

**Files:**
- Test: `tests/dark-factory/architect-usage-query.test.ts` (no production file changes expected)

**Interfaces:**
- Consumes: `queryUsage` / `UsageReport.byTaskType` (`usage-query.ts`), a SQLite usage store from `usage-store-provider.ts`.

- [ ] **Step 1: Write the test** — with two events on one run, `taskType: "architect"` and `taskType: "developer"`, `queryUsage({ runId })` returns a `byTaskType` entry for `architect` whose totals cover ONLY the architect event, and the developer entry is unchanged.
- [ ] **Step 2: Run it** — expected PASS on the query side if it already separates task types (it does: `UsageReport.byTaskType` + `UsageQueryParams.runId`), which is itself the finding: **AC2 needs a test, not new code**. If it fails, the failure names what is missing and that becomes a new task.
- [ ] **Step 3: Add the AC3 regression case** — a run with developer/tester events but no architect sink records exactly the same events and counts as before.
- [ ] **Step 4: Commit** — `test(492): prove architect spend is separable per run`.

## Task 4: Close the honesty and refusal gaps

- [ ] **Step 1: The three Review Focus cases 2, 3 and 4**, one test each: a throwing sink, a provider that reports no usage (fields ABSENT, event still recorded, counted in `unmeasured`), and a gate-refused call (no event).
- [ ] **Step 2: Run the full suite** — `npx vitest run` — and confirm no new failures, in particular `tests/env-example-coverage.test.ts` (no new env var may be introduced) and the doc-drift guards (no new module, so no catalogue row).
- [ ] **Step 3: Lint gate** — cspell on every changed file, markdownlint + the pinned `markdown-table-formatter@1.6.1` on changed markdown.
- [ ] **Step 4: Commit.**

## Self-Review

- **Spec coverage:** AC1 → Tasks 1–2. AC2 → Task 3. AC3 → Task 1 step 1's no-sink case + Task 3 step 3. AC4 (no content) → the event shape is untouched, and the sink takes only numbers. No spec section lacks a task.
- **Step scan:** each step is a name/assertion, a signature, or a command with its expected output. No step says "handle edge cases".
- **Type consistency:** `UsageMeasurement` and `GovernedCallUsage<T>` are defined once, in Task 1, and referenced by name in Task 2. `taskType` is the same key the ledger requires and `byTaskType` groups on.
- **Proportion:** four tasks, no code bodies beyond the two test snippets whose assertions ARE the contract.
- **Deliberately NOT in this plan:** changing what the governor SETTLES for the architect call (the reservation still stands). That is the run-level actual #490 needs, and folding it in here would widen this change past its acceptance criteria.

## Execution Handoff

Plan saved. Which execution approach would you prefer?

- **Subagent-driven** — a fresh subagent implements each task and a fresh reviewer checks it before the next starts.
- **Native** — I implement every task in this session, then a fresh reviewer checks the whole branch.

**For this plan I recommend Native**, because the four tasks share one interface (`GovernedCallUsage`) and two files, so the interface decisions are already made here and a fresh context per task would mostly re-read the same 60 lines. The risk of a shipped mistake is low: the blast radius is a new optional option on an existing seam with an existing test suite around it.
