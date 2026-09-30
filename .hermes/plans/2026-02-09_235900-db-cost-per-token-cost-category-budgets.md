# Dark Factory LLM Cost Governance — Per-token + cost-category budgets (#208, #206 R7)

> **For Hermes:** Implement only after this plan is approved. Use subagent-driven-development task-by-task, with spec-compliance and code-quality review after each task.

**Goal:** Govern Dark Factory LLM spend along two independent axes — (1) a per-token (or per-call) budget so we never silently exceed a configured ceiling, and (2) per cost-category budgets (orchestrator, developer/test worker, pr-review) so one surface cannot starve or bankrupt the others.

**Architecture:** One provider-neutral `CostBudgetStore` seam (console refuse-default, postgres, optional sqlite) holding periodic cost caps + spent totals, plus an in-process `CostGovernor` that enforces ceilings before each LLM call and records actual cost afterwards. Cost is the canonical unit; token budgets are converted via a model price table. Categories are an explicit enum, each with its own configured cap. The existing `chat-model.ts` (orchestrator) and `scripts/pr-reviewer.ts` paths are wired first; the developer/test worker is wired through the sandbox-seam env injection described in #135/#142/#133. The dashboard exposes budget status read-only (operator-only in R1).

**Tech Stack:** TypeScript, standard PostgreSQL via `pg` (Supabase as managed Postgres, not a required SDK — no vendor SDK import), optional SQLite for local/test, Next.js API routes + UI, Vitest. #211 migration/RLS foundation must land first so budget tables follow the same source-controlled, RLS-enabled pattern.

---

## Issue review and decisions captured

- #208 is the next story under #206 (Eve Dark Factory LLM Control Mechanism enhancements). This plan covers the #208 budget side; the thinking-level / max-steps policy (#208 policy side) and the #209 usage ledger are sibling increments and must stay coordinated.
- #206 clarifies the cost ledger is **counts only** (no raw finding text); this plan inherits that: budgets track costs/counts, never prompt/completion content.
- #209 builds an append-only usage ledger with `costUsd` etc. This plan's governor records **actual cost** into that ledger (reusing #209's `recordUsage`) and reads **configured caps** from `CostBudgetStore`. The two stores are distinct: ledger = observed past, budget = forward limit + spent accumulator.
- #211 establishes source-controlled SQL migrations + RLS for run-history/control tables. Budget tables MUST follow that same pattern (migration file + `ENABLE ROW LEVEL SECURITY`, no `anon`/`authenticated` policies unless direct client access is deliberately required).
- Clarified with the user earlier (for #212, reused here as standing policy):
  - Hard monthly USD cap with pre-call reservations for customer budgets. For the operator budget here, the same "reserve before call, reconcile after" model applies but the cap is operator-configured, not per-customer.
  - LLM usage only for the first budget; other cost categories (sandbox compute, hosting) deferred.
  - Fail-closed: an unavailable budget store or unknown model price must NOT silently allow an unmetered/unbounded call.

## Recommended release split

| Release | Branch | Scope |
|---|---|---|
| R1 — Operator LLM cost governance | `feat/df-cost-budgets-208` | Per-token + per-cost-category budgets, fail-closed governor, operator dashboard read-only, console/postgres/sqlite drivers. (This plan.) |
| R2 — Customer-scoped budgets | `feat/df-tenant-budgets-212b` | Reuse this governor with `tenantId` dimension (from #213 tenant attribution). Deferred to #214. |
| R3 — Policy + budget unification | `feat/df-llm-policy-206b` | Fold thinking-level/max-steps (#208 policy) and budget reservation into one provider-neutral LLM policy seam. |

This issue = R1 only. Do not implement R2/R3 here.

## Cross-release invariants

1. **Canonical cost unit = USD.** Token budgets are expressed as tokens but enforced by converting to estimated USD via a model price table; the hard ceiling is always a USD amount per period.
2. **Categories are explicit.** `CostCategory = "orchestrator" | "developer" | "tester" | "pr-review"` (aligned with #206 surfaces). Each has its own cap; a call MUST carry exactly one category.
3. **Reserve before spend, reconcile after.** Before an LLM call: check cap for (period, category) and reserve `estimatedCost`. After: record actual `costUsd` (or counted call) to the ledger and decrement the reservation. Concurrent calls within one process use a shared in-memory reservation map; cross-process use the Postgres row with `SELECT ... FOR UPDATE`/advisory lock (same pattern as control-postgres CAS).
4. **Fail-closed.** If the budget store is unavailable, or the model price is unknown/unestimatable, the call is REFUSED with a clear `budget_unavailable` / `unpriced_model` reason — never admitted unbounded. A refusal is a structured result, not a thrown crash, at the seam.
5. **Honesty of measurement.** Missing `costUsd` from a provider response stays ABSENT (never `0`). If a call has no measurable cost, count it as a call (if call-count budget exists) but do not invent a dollar amount.
6. **No content in budgets.** Only cost/count/category/model/timestamp. Never store prompts or completions.
7. **Provider-neutral.** No Supabase/Vercel SDK in the seam. Standard `pg` for Postgres; SQLite for local/test; `console` refuses.

## R1 — Detailed implementation plan

### Task 1: Canonical budget types + price table (TDD)

**Objective:** Define `CostCategory`, `CostBudget`, `CostBudgetStore` interface, `CostGovernor` interface, and a model→price resolver. Prove validation with tests before storage/UI.

**Likely files:**
- Create `agent/lib/dark-factory/cost-budget.ts` (types, `toCostBudget`, validation, `EnvConfigError` on malformed env).
- Create `agent/lib/dark-factory/model-prices.ts` (versioned USD price table keyed by model id; `resolvePrice(model)` → `{ inputUsdPer1k, outputUsdPer1k } | null`).
- Create `tests/dark-factory/cost-budget.test.ts`.

**TDD steps:**
1. Tests: invalid category rejected; budget with negative/non-numeric cap rejected; unknown model returns `null` price; known model returns sane per-1k price; `estimateCost(model, inTokens, outTokens)` math; `tokensToUsd` conversion.
2. Run `npx vitest run tests/dark-factory/cost-budget.test.ts` → confirm behavioral failures.
3. Implement minimal types + `toCostBudget` + price table + `estimateCost`.
4. Re-run targeted test + `npm run typecheck`.

### Task 2: Budget store seam + Postgres/SQLite adapters + migration

**Objective:** Persist per-(period, category) caps + spent, with RLS, using #211's migration pattern.

**Likely files:**
- Create `agent/lib/dark-factory/cost-budget-store.ts` (interface + `createCostBudgetStore(env)` factory: `console` refuse → `postgres` → `sqlite` → unknown throws).
- Create `agent/lib/dark-factory/cost-budget-store-postgres.ts`, `cost-budget-store-sqlite.ts`.
- Add `db/migrations/<NN>_df_cost_budgets.sql` (`ENABLE ROW LEVEL SECURITY`; no public policies).
- Add `tests/dark-factory/cost-budget-store.test.ts` + gated Postgres integration test (`DF_COST_BUDGET_TEST_DATABASE_URL`, skip if unset — mirror run-history-postgres pattern).

**TDD steps:**
1. Test: set cap, read cap, record spend (call count + USD), read remaining, period isolation, idempotent record (same eventId no double count), store unavailable → refuse, unknown driver → throw.
2. Run targeted test → expected failures.
3. Implement adapters + migration; wire `createCostBudgetStore` to env (`DF_COST_BUDGET_DRIVER`, `DF_COST_BUDGET_DATABASE_URL` fallback to run-history URL, `DF_COST_BUDGET_DB_PATH` for sqlite; reject sqlite in prod/preview).
4. Re-run focused + integration.

**Migration sketch (final names/types in the file):**
```
CREATE TABLE df_cost_budgets (
  id TEXT PRIMARY KEY,               -- e.g. "2026-02|orchestrator" (period|category)
  period TEXT NOT NULL,              -- YYYY-MM
  category TEXT NOT NULL,
  cap_usd DOUBLE PRECISION NOT NULL,
  spent_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  call_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE df_cost_reservations (
  id TEXT PRIMARY KEY,               -- opaque reservation id
  budget_id TEXT NOT NULL REFERENCES df_cost_budgets(id),
  estimated_usd DOUBLE PRECISION NOT NULL,
  created_at TEXT NOT NULL
);
ALTER TABLE ... ENABLE ROW LEVEL SECURITY;
```

### Task 3: Cost governor (reserve → call → reconcile)

**Objective:** Enforce ceilings before each LLM call and record actual cost after, fail-closed.

**Likely files:**
- Create `agent/lib/dark-factory/cost-governor.ts` (`createCostGovernor(store)`, `reserve(category, model, estTokens)`, `settle(reservationId, actualCostUsd?)`, `status(category)`).
- Extend `tests/dark-factory/cost-budget.test.ts` or add `cost-governor.test.ts`.

**TDD steps:**
1. Test: reserve succeeds when under cap; reserve REFUSED (structured) when would exceed cap; concurrent reservations within process never both admitted past cap; settle records actual cost + decrements reservation; unknown model price → refuse with `unpriced_model`; store down → refuse with `budget_unavailable`; double settle idempotent.
2. Run → failures.
3. Implement governor using in-memory reservation map + store transactions; reuse control-postgres CAS/advisory-lock style for Postgres.
4. Re-run + `npm run typecheck`.

### Task 4: Wire orchestrator chat model

**Objective:** Gate `agent/chat-model.ts` LLM calls behind the governor.

**Likely files:**
- Modify `agent/chat-model.ts` (inject `CostGovernor` + category `"orchestrator"`).
- Add `tests/.../chat-model.test.ts` (mock governor; assert reserve called pre-call, settle post-call, refusal short-circuits).

**TDD steps:**
1. Test: chat call reserves; on governor refusal, call is not made and returns structured refusal; on success, settle records cost.
2. Run → failures.
3. Wire; keep model resolution from `EVE_CHAT_MODEL` (existing).
4. Re-run.

### Task 5: Wire PR-review path

**Objective:** Gate `scripts/pr-reviewer.ts` LLM calls.

**Likely files:**
- Modify `scripts/pr-reviewer.ts` (category `"pr-review"`, use governor around its model call; reuse existing `PR_REVIEW_MODEL`/`PR_REVIEW_MAX_TOKENS` for estimate).
- Add `tests/.../pr-reviewer.test.ts` (mock governor).

**TDD steps:** same RED→GREEN pattern as Task 4 with the pr-review category and tokens.

### Task 6: Wire developer/test worker (sandbox env injection)

**Objective:** Apply budgets to worker LLM calls via the sandbox-seam env (do not push secrets; inject policy+category hints).

**Likely files:**
- Modify `agent/lib/dark-factory/credentials.ts` / sandbox provisioning (#135/#142) to inject `DF_COST_BUDGET_*` + category `"developer"`/`"tester"` as env the worker reads; worker calls a thin client that reserves/settles against the same store.
- Add contract test for the env shape + worker-side client.

**TDD steps:** test env injected with category + caps; worker client reserves/settles; missing env → worker runs ungoverned only if explicitly local (fail-closed in prod). Implement; re-run.

### Task 7: Operator dashboard — budget status (read-only)

**Objective:** Show per-category cap / spent / remaining / period + global total.

**Likely files:**
- Create `agent/lib/dark-factory/cost-budget-query.ts` + `app/api/dark-factory/cost-budgets/route.ts` (reuse `getViewerSession` + response helpers from metrics route).
- Create `app/dark-factory/ui/use-cost-budgets.ts` + `cost-budgets-panel.tsx`; mount in `app/dark-factory/page.tsx`.
- Add `tests/dark-factory/cost-budget-query.test.ts` + `tests/dark-factory-ui/use-cost-budgets.test.tsx`.

**TDD steps:** test unauthorized→401, query returns per-category + total, unmeasured shows `—` not `0`; UI loading/empty/error; implement; re-run; run E2E slice.

### Task 8: Env docs + lint gate

**Objective:** Document new vars and pass MegaLinter/cspell.

**Likely files:**
- Append to `.env.example` (`DF_COST_BUDGET_DRIVER`, `DF_COST_BUDGET_DATABASE_URL`, `DF_COST_BUDGET_DB_PATH`, `DF_COST_BUDGET_PERIOD`, `DF_COST_BUDGET_ORCHESTRATOR_USD`, `DF_COST_BUDGET_DEVELOPER_USD`, `DF_COST_BUDGET_TESTER_USD`, `DF_COST_BUDGET_PR_REVIEW_USD`).
- Run `npx cspell@9` on changed files; `npm test`; `npm run typecheck`; `npm run build`.

## R1 completion gate

- `npm test` passes; `npm run typecheck` + `npm run build` pass.
- Postgres integration tests pass against disposable DB.
- cspell/MegaLinter clean on all changed files (incl. migration + plan doc).
- Orchestrator, pr-review, and worker paths all governed; fail-closed on store-down/unknown-price.
- Dashboard operator-only, read-only, no prompt/completion content.

## Risks / open decisions

1. **Period boundary:** default monthly `YYYY-MM`, UTC. Confirm before impl; allow `DF_COST_BUDGET_PERIOD=monthly|daily`.
2. **Estimate accuracy:** pre-call estimate uses max requested tokens × price; actual may differ. Over-reserve then reconcile (release difference back). Acceptable for a hard cap.
3. **Cross-process concurrency:** single Eve instance expected; Postgres lock covers multi-instance. Confirm deployment model.
4. **Price table maintenance:** model ids change; unknown model → refuse (fail-closed), operator updates table. Consider env override `DF_MODEL_PRICE_<model>` for quick fixes.
5. **#211 dependency:** do not create a second migration root; place budget migration in the location #211 establishes.

## Out of scope (this issue)

- Customer/tenant-scoped budgets → #214.
- Thinking-level / max-steps policy unification → #208 policy / R3.
- Sandbox compute / hosting cost categories.
- Editing budgets from dashboard (env-only).
- Invoicing / payment.
