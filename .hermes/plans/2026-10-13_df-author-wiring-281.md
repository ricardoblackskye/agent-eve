# R2b (T5b #281) — wire the sandbox author into the runner

> **For Hermes:** Implement task-by-task with `subagent-driven-development` after GATE 1 approval.

**Goal:** Make the code-author seam, sandbox execution driver and governed gateway actually run
inside the Dark Factory loop, so the `agent-cli` author can be armed for real runs and sandbox spend
is recorded — closing the four remaining acceptance criteria (B1–B4) left when R2 merged.

**Architecture:** Today the runner authors code inline (build prompt → governed `streamText` →
regex-extract JSON → write files) and never disposes the execution sandbox. R2 shipped the *seams*
(`createCodeAuthorProvider`, the `opensandbox` driver, `withSandbox`, `handleGatewayRequest`) but the
runner still calls none of them. T5b is the wiring: B1 swaps the inline authoring block for the seam;
B2 makes the runner own the sandbox lifecycle (create once per run, dispose on every exit); B3 connects
the gateway's `recordUsage`/`recordRefusal` hooks to run-history; B4 labels sandboxes by run id and
reaps orphans from the create-leak.

**Tech Stack:** TypeScript, Vitest, the existing `dark-factory` seam modules, the OpenSandbox SDK
(already a dependency), Postgres run-history (`RunHistoryStore`).

---

## Current context / assumptions

- `main` is at `85ba6f308` (PR #345 merged). This branch starts from `origin/main`.
- The runner builds the execution backend at `scripts/dark-factory-runner.ts:350`
  (`createSandboxProvider().create(process.cwd())`) and never calls `dispose()` — confirmed: the
  surrounding block is `try { loop } catch { ... throw }` with **no `finally`**.
- Inline authoring lives at `scripts/dark-factory-runner.ts:378-419`: builds `workerPrompt`, calls
  `runGovernedAgentCall` + `streamText`, parses JSON, writes files, runs `ctx.tools.runTests`. The
  exact `workerPrompt` text also exists in `buildCodeAuthorPrompt` (`agent/lib/dark-factory/code-author.ts`)
  — B1 must use that builder so the prompt is byte-for-byte unchanged.
- `createCodeAuthorProvider(env, deps)` lives in `code-author-provider.ts`. For `in-process` it needs
  `deps.generate` (a `(prompt) => Promise<string>` returning the model text). B1 supplies `generate`
  by wrapping the **existing** governed call, so `DF_CODE_AUTHOR` unset == today's behaviour.
- `withSandbox(provider, fn, workspaceDir?)` exists in `agent-cli-author.ts` but the runner does not use it.
- The gateway already calls `deps.recordUsage?.()` / `deps.recordRefusal?.()` (`llm-gateway.ts:121-154`);
  the route at `app/api/llm-gateway/route.ts` does **not** set them, so they are currently no-ops.
- `recordCostRefusal(runHistory, { runId, code })` already exists (`cost-refusal-recorder.ts`) and is
  the model for B3's refusal path. The **usage** path needs a run-history write method to be confirmed
  during B3 (see Risks).

## Open questions resolved at plan time

- **Scope:** T5b is the deferred tail of **#281** (reopened by the user), not a new issue. This branch
  is the only change for #281's remaining ACs. Do NOT create a separate issue.
- **Prompt parity:** B1 uses `buildCodeAuthorPrompt(executionPlan)` so the in-process path is identical
  to the inline one. The agent-cli path uses the same builder (already wired in `agent-cli-author.ts`).
- **Lifecycle boundary:** the sandbox is used for `runTests` *inside* the loop, so it must live for the
  whole STEP 5, not just authoring. "One sandbox per run, disposed on success/throw" = create before the
  loop, `dispose()` in a `finally` after it (or `withSandbox` wrapping the whole phase).
- **No new behaviour when unset:** every change is gated on `DF_CODE_AUTHOR`/`DF_SANDBOX_DRIVER` being at
  their current defaults, so an unconfigured deployment behaves exactly as today.

---

## Task B1 — the runner drives `CodeAuthorProvider`

**Objective:** replace the inline authoring block with `author.write({ plan })`, defaulting to
`in-process` and behaving byte-for-byte as today.

**Files:**
- Modify: `scripts/dark-factory-runner.ts` (import + build provider + swap the `worker` block)
- Modify: `agent/lib/dark-factory/code-author-provider.ts` (if a `generate` shim is needed for parity)
- Test: `tests/dark-factory/runner-authoring.test.ts` (new; pure, no sandbox)

**Step 1: Write failing test (no real runner — extract a pure helper first)**

Refactor the `worker` body's authoring into a small pure function in the runner module:
`authorFiles(author: CodeAuthorProvider, plan: unknown, tools: WorkspaceTools): Promise<{files: Record<string,string>; raw: string}>`
that calls `author.write` then writes each file via `tools.writeFile`. In the test, inject a fake
`CodeAuthorProvider` returning a fixed map and a fake `tools`, and assert the files are written and the
raw output is returned. Also test: when `author.write` throws, the function lets the error propagate
(no silent empty write).

```ts
it("writes every authored file via the workspace tools", async () => {
  const written: Record<string, string> = {};
  const author = { author: "in-process" as const, write: async () => ({ files: { "a.ts": "x" }, raw: "r" }) };
  const result = await authorFiles(author, { summary: "p" }, { writeFile: async (p, c) => { written[p] = c; } } as any);
  expect(written).toEqual({ "a.ts": "x" });
  expect(result.raw).toBe("r");
});
```

**Step 2: Run test to verify failure** — `authorFiles` not defined → FAIL (module-load error).
**Step 3: Implement `authorFiles`** extracting the JSON-write logic from the inline block.
**Step 4: Run test** → PASS.
**Step 5: Swap the inline block in the runner.** Build the provider near the other setup:
```ts
const codeAuthor = createCodeAuthorProvider(process.env, {
  generate: (prompt) => runGovernedAgentCall({ governor, runHistory, runId }, {
    category: "developer", model: modelId,
    inputTokens: Math.ceil(prompt.length / 4), outputTokens: 8_000,
    run: async () => { const s = streamText({ model, prompt }); let o = ""; for await (const c of s.textStream) o += c; return o; },
  }),
});
```
and in the `worker`, replace lines 378-419's prompt-build/parse/write with `const { files, raw } = await authorFiles(codeAuthor, ctx.plan, ctx.tools);`.
**Step 6: Run the FULL suite + `tsc --noEmit --incremental false`** — no regressions; the in-process
path still produces identical output (assert by reusing `buildCodeAuthorPrompt` in `authorFiles`'s
underlying adapter, not in the runner).
**Step 7: Commit** `feat(#281): B1 runner drives CodeAuthorProvider, in-process parity kept`.

---

## Task B2 — sandbox lifecycle: create once, dispose on every exit

**Objective:** the runner owns the sandbox lifecycle; `dispose()` runs on success, on throw, and on
abort. Prove the ORDER with a recording double.

**Files:**
- Modify: `scripts/dark-factory-runner.ts` (wrap STEP 5 in a lifecycle helper)
- Test: `tests/dark-factory/runner-sandbox-lifecycle.test.ts` (new)

**Step 1: Write failing test** — a recording `SandboxProvider` double records `create`/`dispose`:
```ts
function recordingProvider() {
  const log: string[] = [];
  const provider = {
    driver: "local" as const, isolated: false,
    create: () => { log.push("create"); return { writeFile: async () => {}, runTests: async () => ({ passed: true, output: "" }), readFile: async () => "", listFiles: async () => [] }; },
    dispose: async () => { log.push("dispose"); },
  };
  return { provider, log };
}
it("disposes the sandbox even when the phase throws", async () => {
  const { provider, log } = recordingProvider();
  await expect(runCodingPhase({ provider, work: async () => { throw new Error("boom"); } })).rejects.toThrow("boom");
  expect(log).toEqual(["create", "dispose"]);   // exactly one create, dispose on throw
});
```
**Step 2: Run** → FAIL (`runCodingPhase` undefined).
**Step 3: Extract `runCodingPhase({ provider, author, loopConfig, work })`** from the runner's STEP 5,
where `provider.create(process.cwd())` is called at the top and `await provider.dispose?.()` runs in a
`finally` (so it fires on success AND throw). Replace the inline STEP 5 wiring with a call to it.
**Step 4: Run test** → PASS; add a success-order test (create → work → dispose).
**Step 5: Full suite + tsc** — green.
**Step 6: Commit** `feat(#281): B2 runner owns sandbox lifecycle, dispose on every exit`.

> Note: B2 does not change the `opensandbox` driver's `dispose()` (already idempotent, never throws).
> It only makes the *runner* call it. This is the acceptance criterion defending "closing the client
> does not terminate the sandbox".

---

## Task B3 — gateway spend recorded into run-history

**Objective:** wire `recordUsage`/`recordRefusal` in the gateway route to run-history so a forwarded
sandbox call records a usage row and a refusal records a refusal row (not a silent no-op).

**Files:**
- Modify: `app/api/llm-gateway/route.ts` (set `recordUsage`/`recordRefusal` deps)
- New: `agent/lib/dark-factory/gateway-recorder.ts` — `createGatewayRecorder(store, runId)` returning
  `{ recordUsage, recordRefusal }` adapting `GatewayUsageRecord`/`GatewayRefusalRecord` to run-history writes.
- Test: `tests/dark-factory/gateway-recorder.test.ts` (new; in-memory store double)

**Step 1: Write failing test** using an in-memory `RunHistoryStore` double that records writes:
```ts
it("records a usage row and a refusal row", async () => {
  const store = inMemoryHistory();
  const rec = createGatewayRecorder(store, "run-1");
  await rec.recordUsage({ runId: "run-1", model: "m", reservationId: "r", estimatedUsd: 0.01 });
  await rec.recordRefusal({ runId: "run-1", model: "m", reason: "over-budget" });
  expect(store.writes).toHaveLength(2);
});
```
**Step 2: Run** → FAIL (module missing).
**Step 3: Implement `createGatewayRecorder`** — `recordRefusal` reuses `recordCostRefusal`; `recordUsage`
writes via the run-history write method confirmed in Risks below. Thread `runId` from the lease into the
deps (the route already has `runId` available; if not yet, derive it from the lease metadata parsed in
`handleGatewayRequest`).
**Step 4: Run test** → PASS.
**Step 5: Wire the route** — in `deps` at `route.ts:56`, add
`recordUsage: (u) => rec.recordUsage(u), recordRefusal: (r) => rec.recordRefusal(r)` where `rec =
createGatewayRecorder(runHistoryStore, runId)`.
**Step 6: Extend `llm-gateway.test.ts`** with one test asserting `handleGatewayRequest` invokes the
supplied `recordUsage` on a forwarded call and `recordRefusal` on a denied call (already mostly covered;
add the run-history adapter to an integration assertion).
**Step 7: Full suite + tsc** → green.
**Step 8: Commit** `feat(#281): B3 gateway recordUsage/recordRefusal wired to run-history`.

---

## Task B4 — label-based sandbox reaping (create-leak defense)

**Objective:** label every sandbox with its `runId` and reap orphans from a previous run with the same
id, so a client-timeout create-leak does not leave an unterminated, spending sandbox.

**Files:**
- Modify: `agent/lib/dark-factory/sandbox-provider.ts` (`createSandboxProvider` accepts `runId`, passes
  `metadata: { runId }` to the opensandbox driver)
- Modify: `agent/lib/dark-factory/opensandbox-driver.ts` (`SandboxCreateSpec` gains optional `metadata`)
- New: `agent/lib/dark-factory/sandbox-reaper.ts` — `reapSandboxesByRun(runId)` using the SDK list API
- Test: `tests/dark-factory/sandbox-reaper.test.ts` (new; fake list + kill)

**Step 1: Recon the SDK list API shape** (`SandboxManager` / `Sandbox.list`) — this is the one external
unknown; do it first, in code, before writing the adapter. The fake in the test mirrors the reconned shape.
**Step 2: Write failing test** — a fake manager returns two sandboxes (one matching `runId`, one not);
`reapSandboxesByRun` kills only the matching one.
**Step 3: Run** → FAIL.
**Step 4: Implement `reapSandboxesByRun`** from the reconned API; set `metadata` in the create spec;
call `reapSandboxesByRun(runId)` at runner start (before `createSandboxProvider`).
**Step 5: Run test + full suite + tsc** → green.
**Step 6: Commit** `feat(#281): B4 label sandboxes by run id and reap orphans`.

---

## Files likely to change

- `scripts/dark-factory-runner.ts` — B1 (import + build author, swap block), B2 (lifecycle helper)
- `app/api/llm-gateway/route.ts` — B3 (wire record hooks)
- `agent/lib/dark-factory/code-author-provider.ts` — B1 (parity shim if needed)
- `agent/lib/dark-factory/gateway-recorder.ts` — B3 (new)
- `agent/lib/dark-factory/sandbox-provider.ts` — B4 (runId → metadata)
- `agent/lib/dark-factory/opensandbox-driver.ts` — B4 (metadata in spec)
- `agent/lib/dark-factory/sandbox-reaper.ts` — B4 (new)
- `tests/dark-factory/runner-authoring.test.ts`, `runner-sandbox-lifecycle.test.ts`,
  `gateway-recorder.test.ts`, `sandbox-reaper.test.ts` — new
- `docs/adr/0031-*.md`, `0032-*.md` — new ADRs; `docs/adr/README.md` row added
- `.env.example` — only if a NEW env var is introduced (none expected; reuse existing
  `DF_CODE_AUTHOR`, `DF_SANDBOX_DRIVER`, `DF_LLM_GATEWAY_MODELS`)

## Tests / validation

- New Vitest suites for B1–B4 as above; all mock-first (no live sandbox required for B1–B3 unit tests).
- B1/B2/B3 also verified live on the developer host with the self-hosted OpenSandbox where practical
  (the runner can be invoked against a real issue in dry form, or a focused script drives
  `createCodeAuthorProvider` + `withSandbox` end-to-end).
- Full suite + `npx tsc --noEmit --incremental false` must be green before each commit.
- Local lint gate (cspell/standard/markdownlint/MegaLinter pinned versions on the changed files AND
  `.hermes/plans/*.md`) must pass before any push.

## Risks / open questions

- **B3 run-history write method for usage:** grep found `recordCostRefusal` and `recordBreakerTrip` but
  no obvious `writeUsage`/`writeCostEvent`. During B3, confirm the exact `RunHistoryStore` method (and
  record shape) used for a spend/usage event; if none exists, add one (a `writeCostEvent`-style method)
  rather than overloading the refusal path. This is the one place the plan may need a small store addition.
- **B4 SDK list API shape:** `SandboxManager`/`Sandbox.list` return shape is unverified — recon it in
  code first (Step 1 of B4); the fake mirrors reality so the test catches drift.
- **Behaviour parity:** B1 must not change the in-process output. The test must pin that `createCodeAuthorProvider`
  with `DF_CODE_AUTHOR` unset returns the same files the inline block produced (use a captured baseline).
- **Lifecycle vs runTests:** the sandbox is needed for `runTests` inside the loop; B2 disposes only after
  the loop, never mid-iteration. Do not move `dispose()` into the authoring sub-step.

## ADRs to add (required by the SDLC flow)

- **0031 — the runner consumes the code-author seam (fail-closed).** Why: a seam with no caller is dead
  code, and the in-process default must remain behaviour-identical. Decision: the runner resolves
  `createCodeAuthorProvider` and calls `author.write`; unset == in-process parity; `agent-cli` is armed
  only when its deps are supplied (it already refuses otherwise). Consequence: the inline authoring path
  is removed; prompt changes must go through `buildCodeAuthorPrompt`.
- **0032 — sandbox lifecycle is the runner's responsibility, force-disposed.** Why: closing the SDK
  client does not terminate a sandbox, so a missing `dispose()` is a leak and spend. Decision: the runner
  creates one sandbox per run and `dispose()`s it in a `finally`; a recording double proves the order.
  Consequence: B4's label-reaping is defense-in-depth, not the primary release mechanism.

(If B3 requires a new run-history write method, add **0033 — sandbox spend is a first-class run-history
event** recording that decision.)

---

## GATE 1

Plan committed and pushed to `feat/df-author-wiring-281` BEFORE any implementation. Await approval.
