# Fix production eval failures (#478)

**Issue:** https://github.com/ricardoblackskye/agent-eve/issues/478
**Status:** Root cause identified — operator/config fix, **no code change required**.

## Observed failure (production evals, `main`)
```
✗ smoke  gates 0/2
  ✗ succeeded (0% < 100%): run failed (code: MODEL_SELECTION_FAILED)
  ✗ satisfies(the agent replied with nothing) (0% < 100%): predicate did not hold for false
✗ auth-valid  gates 0/1
  ✗ succeeded (0% < 100%): run failed (code: MODEL_SELECTION_FAILED)
```

## Root cause
`MODEL_SELECTION_FAILED` is emitted by the **`eve` framework** (`node_modules/eve/.../tool-loop.js`:
`failModelSelection` → `code: "MODEL_SELECTION_FAILED"`) when the agent's **dynamic model
resolver throws**. In agent-eve that resolver (`agent/lib/dark-factory/governed-model.ts:52`) runs the
cost gate first (`gate.admit()`), so the throw is a `CostRefusedError` (a `CostGovernorRefusal`)
surfaced as `MODEL_SELECTION_FAILED`.

The underlying refusal is **`budget_exceeded`**, not a model-pricing defect:

- The production default model `deepseek/deepseek-v4.1-flash` **is** in the price table
  (`agent/lib/dark-factory/model-price-floor-data.ts:29`), so `resolvePrice` does not return `null`
  → **not** `unpriced_model`.
- The original #478 report documents the exact store state: *"orchestrator row read `cap_usd: 30`,
  `spent_usd: 29.60`"*. A configured, spent cap = `budget_exceeded`.
- Recent #498/#499 commits rewrote `model-price-floor-data.ts` / `cost-budget.ts` (price floor/ceiling)
  but did **not** remove the default model price, so they are not the cause.
- The `frontend` eval failure (`browser proxy health returns 200 → 500`) is the **same root cause**:
  the proxy-health path calls the agent, which fails model selection when the gate refuses; it should
  recover once the budget is topped up.

The cost governor is correctly **fail-closed**. This is a production budget-state problem, not a code
defect — which is why PR #480 (which closed #481) shipped an *operator CLI to top up the cap* rather
than changing gate behaviour.

## Fix (operator action — not a code change)
Top up the **production** orchestrator budget cap with the CLI from PR #480. Point the driver at the
production Postgres store (local default is SQLite):

```bash
# 1. Inspect current state — confirm cap / spent / headroom
DF_COST_BUDGET_DRIVER=postgres DF_COST_BUDGET_DATABASE_URL=<prod-postgres-url> \
  npm run df:cost-budget -- show --category orchestrator

# 2. Top up the cap
#    --add   : relative top-up (current cap + amount)
#    --set    : absolute ceiling
DF_COST_BUDGET_DRIVER=postgres DF_COST_BUDGET_DATABASE_URL=<prod-postgres-url> \
  npm run df:cost-budget -- add --category orchestrator --amount 50
```

Notes:
- `DF_COST_BUDGET_DATABASE_URL` (or `DF_RUN_HISTORY_DATABASE_URL`) selects the production Postgres.
- `setBudgetCap` preserves `spent_usd` / `reserved_usd` / `call_count`, so the period's accounting
  survives the top-up (ADR 0065). The `DF_COST_BUDGET_*_USD` env var only seeds the row on first
  creation, so it cannot move an existing ceiling — the CLI is the supported path.
- Period defaults to `DF_COST_BUDGET_PERIOD` or the current UTC month.

## Verification
1. Re-run the production evals (the `production-evals` CI job on `main`, or locally with
   `EVE_EVAL_AUTH_TOKEN` + `VERCEL_PROTECTION_BYPASS` set). Expect `smoke` and `auth-valid` to pass
   with no `MODEL_SELECTION_FAILED`.
2. Confirm the `frontend` eval's proxy-health `500` clears (same root cause).
3. If any other eval still fails, run `df:cost-budget -- show` for the other categories
   (`developer`, `pr-review`, `tester`) to check they are not also spent.

## Out of scope / follow-up
- The top-up is **per period**. Real traffic will eventually spend it again, so the evals can fail
  later. A durable fix (higher base cap, or excluding eval traffic from the production budget) is a
  separate design decision — candidate follow-up issue, **not** folded into #478.
- No source change is required for #478; the gate behaviour is correct.
