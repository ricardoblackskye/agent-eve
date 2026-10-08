# Dark Factory — Cost governor live in agent LLM calls (#270)

> **For Hermes:** implement with the `test-driven-development` skill. This plan is the
> GATE 1 deliverable; no code until the user approves it.

**Goal:** Make the cost governor actually gate the agents' LLM calls — every ungoverned
call site — so an over-budget call is **refused at the call site**, and record the
refusal as a **machine-readable code on the run**.

**Issue:** #270 · **Epic:** #267 (P0) · **Branch:** `feat/df-cost-governor-live-270`

**Tech stack:** TypeScript, Vitest, `node:sqlite` (`:memory:`) + Postgres adapter.

---

## Finding — what is (and isn't) governed today

| LLM surface                                                                           | Today                                                                                                                                      | Gap                                |
|---------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------|
| Root orchestrator (chat)                                                              | **GATED** — `agent.ts` uses `buildDynamicOrchestratorModel({gate})`, `createOrchestratorGate` → `governor.admit` (category `orchestrator`) | none                               |
| Subagents — `product-owner`, `release-manager`, `sprint-reporter`                     | build their own `createOpenAI({baseURL})` client and return a **static** model                                                             | **ungoverned**                     |
| Runner — `scripts/dark-factory-runner.ts` Architect `generateText` + Developer worker | call `streamText({model, prompt})` **directly**                                                                                            | **ungoverned**                     |
| `runGovernedLlmCall` (`governed-llm-call.ts`)                                         | exists + tested; used only by the PR reviewer                                                                                              | not used by the agents             |
| Run record of a refusal                                                               | `RunEvent` stores **no** reason; `recordTerminal` writes a bare `run.terminal`                                                             | **nothing records a cost refusal** |

So the cap is decorative for exactly the surfaces a run drives.

## Scope decisions (agreed at review)
- **Gate everything ungoverned:** the three subagents **and** the runner's Architect/Developer calls.
- **Record the machine-readable refusal code on the run** — the `CostGovernorRefusal`
  value (`not_configured` | `unpriced_model` | `budget_exceeded` | `budget_unavailable` |
  `tenant_unconfigured`), **not free text**.

---

## Design

### A. One gate, parameterised by category (DRY)
Generalise the existing orchestrator gate rather than copy it:
- New `agent/lib/dark-factory/cost-gate.ts` → `createCostGate({ category, env, model,
  inputTokens, outputTokens?, tenantId?, governor? })` returning `{ admit(): Promise<void> }`
  that THROWS on refusal (the pre-call gate #217 established).
- `agent/orchestrator-gate.ts` keeps its public shape by delegating:
  `createOrchestratorGate(input) === createCostGate({ ...input, category: "orchestrator" })`.

### B. Subagents become governed (opt-in, unchanged when unconfigured)
Generalise `buildOrchestratorModel`/`buildDynamicOrchestratorModel` into
`agent/lib/dark-factory/governed-model.ts` → `buildGovernedModel({ category, env,
chatModel, gate })`, and have `orchestrator-model.ts` delegate (public shape preserved).

Each subagent (`agent/subagents/{product-owner,release-manager,sprint-reporter}/agent.ts`)
mirrors `agent/agent.ts`'s **two-branch** definition: a static `defineAgent` when nothing is
configured (byte-identical to today), and a `defineDynamic` model wrapping the gate when
governance IS configured, so a refusal **fails the turn before the provider call**.
- Category: **`orchestrator`** (the interactive agent surface — the existing categories are
  `orchestrator | developer | tester | pr-review`; adding new ones would touch
  `COST_CATEGORIES`, the env set, the store schema and the #277 dashboards). *(Decision to confirm.)*
- **Watch-out:** `release-manager` currently hardcodes `nvidia/nemotron-3-ultra-550b-a55b:free`.
  If that id is absent from the price table, gating refuses every call with `unpriced_model`.
  Resolve by adding a price row **or** pointing it at the priced default model (flag).

### C. Runner calls go through `runGovernedLlmCall` (category `developer`)
In `scripts/dark-factory-runner.ts`, wrap both call sites:
```ts
const governed = await runGovernedLlmCall({
  governor, category: "developer", model,
  inputTokens: estimatePromptTokens(prompt), outputTokens: MAX_OUTPUT_TOKENS,
  run: () => collectStream(streamText({ model, prompt })),
  costOf: (r) => r.costUsd, // or undefined when unmeasured
});
if (!governed.ok) { await recordCostRefusal(governor, runId, governed.reason); throw new Error(...); }
```
- Governor built once from env via `isCostGovernanceConfigured` / `createCostGovernor`
  (opt-in: unconfigured ⇒ `null` ⇒ the runner behaves exactly as today).
- On refusal: **record the code on the run**, then fail the run (never silently continue).

### D. Record the refusal code on the run (run-history)
Add a machine-readable field to the run ledger:
- `run-history.ts`: add `costRefusal?: CostGovernorRefusal` to `RunEvent`; validate it in
  `toRunEvent` (one of the five codes, or omitted); carry it through `applyRunEvent`.
- Record it on the existing **`run.terminal`** event with `status: "failed"` (no new event
  type needed) via a shared helper `recordCostRefusal(history, { runId, repo, issue, code })`.
- Persistence:
  - `run-history-store.ts` (SQLite): add `cost_refusal TEXT` to `df_run_events` in
    `SQLITE_SCHEMA` + an idempotent `ALTER TABLE … ADD COLUMN` in `handle()` (the file
    already migrates `handoff_sent`/`completed`/`tenant_id` this way); plumb `RunEventRow`,
    `rowToEvent`, `writeEvent`.
  - `run-history-postgres.ts`: same column in its schema-ensure + write/read mapping.
  - `db/migrations/009_df_run_events_cost_refusal.sql`: idempotent
    `ALTER TABLE df_run_events ADD COLUMN IF NOT EXISTS cost_refusal TEXT;` (adds a column,
    not a table → the RLS-coverage guard is unaffected). Operator applies it (the repo does
    not auto-migrate).

### E. Posture
- **Opt-in:** unconfigured ⇒ nothing changes anywhere (mirror the orchestrator's contract).
- **Fail-closed:** when governance IS configured, an unprovisioned cap / unpriced model /
  unreachable store **refuses** (already true in the governor) and the refusal is recorded.

---

## Task structure (TDD)

### Task 0 — Branch & plan *(this step)* — then **GATE 1**

### Task 1 — `createCostGate` (generalise the gate), test-first
RED→GREEN on `tests/dark-factory/cost-gate.test.ts`: admits under the cap; THROWS on
`budget_exceeded`; throws on `unpriced_model`; returns `null` when unconfigured; and
`orchestrator-gate` still passes its existing tests (byte-compatible delegation).

### Task 2 — `buildGovernedModel` (generalise the dynamic model), test-first
`tests/dark-factory/governed-model.test.ts`: unconfigured ⇒ returns the static model;
configured ⇒ returns the dynamic sentinel whose `step.started` runs the gate FIRST and
throws before returning a model. Keep `orchestrator-model.test.ts` green.

### Task 3 — Gate the three subagents
For each of `product-owner`, `release-manager`, `sprint-reporter`: convert to the
two-branch definition. Test at the module level that the exported definition is unchanged
when unconfigured (assert the static-model branch) and dynamic when a gate is present.

### Task 4 — `RunEvent.costRefusal` + persistence (run-history)
RED→GREEN: `toRunEvent` accepts each of the five codes and rejects an unknown one; a
`run.terminal` event with `costRefusal` round-trips through SQLite (reopen + read); the
Postgres adapter maps the column (contract test, `describe.skip`-gated on the test DSN).

### Task 5 — Runner wiring
Wrap both `streamText` call sites in `runGovernedLlmCall`; on refusal call
`recordCostRefusal(...)` then throw. Test with an injected governor: an over-budget call is
**refused at the call site** and the run records `costRefusal: "budget_exceeded"`.

### Task 6 — Local gate (MANDATORY before any push)
```bash
npx vitest run tests/dark-factory tests/orchestrator-gate.test.ts tests/orchestrator-model.test.ts
npx vitest run                       # full suite, no NEW regressions
npx tsc --noEmit --incremental false
npx -y cspell@8 --config .cspell.json <changed files>
npx vitest run tests/doc-drift-guards.test.ts tests/env-example-coverage.test.ts tests/migration-rls.test.ts
npx -y markdown-table-formatter@1.6.1 --check <changed .md>   # + markdownlint MD040/MD026
DF_PLATFORM_PROVIDER=generic npm run build
```

---

## Files likely to change

| File                                                                                                                   | Action                                                    |
|------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------|
| `agent/lib/dark-factory/cost-gate.ts`                                                                                  | **Create** — category-parameterised gate                  |
| `agent/lib/dark-factory/governed-model.ts`                                                                             | **Create** — category-parameterised dynamic model         |
| `agent/orchestrator-gate.ts`, `agent/orchestrator-model.ts`                                                            | Modify — delegate to the new modules (shape preserved)    |
| `agent/subagents/{product-owner,release-manager,sprint-reporter}/agent.ts`                                             | Modify — two-branch governed definition                   |
| `agent/lib/dark-factory/run-history.ts`                                                                                | Modify — `RunEvent.costRefusal` + validation              |
| `agent/lib/dark-factory/run-history-store.ts` (+ `-postgres.ts`)                                                       | Modify — column plumbing                                  |
| `db/migrations/009_df_run_events_cost_refusal.sql`                                                                     | **Create** — idempotent ALTER                             |
| `agent/lib/dark-factory/cost-refusal-recorder.ts`                                                                      | **Create** — `recordCostRefusal(...)` helper              |
| `scripts/dark-factory-runner.ts`                                                                                       | Modify — govern the two call sites                        |
| `tests/dark-factory/*.test.ts`                                                                                         | **Create** — cost-gate, governed-model, refusal-recording |
| `docs/pages/dark-factory-modules.md`, `docs/pages/flow-cost-governance.md`, `docs/adr/0020-*.md`, `docs/adr/README.md` | Modify/Create — docs + ADR                                |

---

## Risks & open questions
1. **Category for the subagents** — reuse `orchestrator`, or add real categories
   (`product-owner`, …)? Reuse is far cheaper; **confirm**.
2. **`release-manager`'s hardcoded `:free` model** may be unpriced ⇒ gating refuses every
   call. Add a price row, or switch it to the priced default model? **Confirm.**
3. **Where "on the run" lands** — the run's **event ledger** (proposed) vs also the
   `RunSummary` (dashboard column, more blast radius). Proposed: event ledger now; summary
   is a possible #277 follow-up. **Confirm.**
4. **Size** — this touches agent definitions, the runner, and the run-history schema/adapters.
   If that is too much for one PR, split into: (R-a) gate the subagents + runner (Tasks 1–3, 5),
   (R-b) the run-history `costRefusal` recording (Task 4). **Confirm or accept as one.**
5. **No new env vars** — reuses `DF_COST_BUDGET_*`; `.env.example` unchanged.

## ADRs (decision-time, this change)
- **ADR 0020 — every agent LLM surface is governed by one category-parameterised gate, and a
  cost refusal is recorded as a machine-readable code on the run.** Context: the cap was
  decorative for the subagents and the runner, and the run ledger stored no refusal reason.
  Decision: one shared gate + dynamic-model builder (category-parameterised); the runner uses
  `runGovernedLlmCall`; refusals append a `run.terminal` event carrying `costRefusal`
  (a `CostGovernorRefusal` code, never free text). Consequences: the cap gates every surface;
  the reason is queryable without storing prompts; adding a category/budget is a seam change,
  not a rewrite.

## Out of scope
- Wiring the **worker runtime** (`worker-cost-client` → R3 #215).
- Cost **dashboards** (#277).
- Any change to the governor/store semantics themselves.
