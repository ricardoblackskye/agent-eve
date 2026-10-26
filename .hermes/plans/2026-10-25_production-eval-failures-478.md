# Plan — #478: Fix production eval failures (orchestrator budget_exceeded)

- **Date:** 2026-10-25
- **Issue:** #478
- **Branch:** `fix/production-eval-failures-478`

## Symptom

Production evals (`https://agent-eve-gold.vercel.app`) fail with
`code: MODEL_SELECTION_FAILED`. Only `smoke` and `auth-valid` fail; the other 7 pass.
The Vercel production log shows the precise cause:

```
DynamicModelSelectionError: orchestrator cost gate refused the call:
  budget_exceeded (period 2026-10) - Reservation would exceed the configured budget cap.
  [cause]: CostRefusedError ... reason: 'budget_exceeded', category: 'orchestrator'
```

## Root cause (FINAL — confirmed by production budget row)

The production `df_cost_budgets` row for `period=2026-10, category=orchestrator`:

```
cap_usd: 30, spent_usd: 29.6045824, reserved_usd: 0, call_count: 49
```

- **Not a config error.** `budget_exceeded` (NOT `not_configured`) proves the cost gate is
  armed AND the cap is provisioned. The gate is working as designed.
- **No reservation leak.** `reserved_usd: 0` rules out the ADR 0054/0057 stranded-reservation
  story — the leak fix in #443/#457/#458 is holding; reservations settle correctly.
- **Genuine overspend.** `spent_usd = $29.60 of $30.00 cap` across 49 calls. The remaining
  `$0.40` is below the conservative reserve estimate, so `admit()` returns `budget_exceeded`.
  The budget is simply exhausted by real traffic (production + evals sharing one monthly cap).

### Why "worked before the last merge" is timing, not a regression

`git log` on `agent/agent.ts`, `chat-model.ts`, `orchestrator-gate.ts`, `entry.ts`,
`platform.ts`, and `app/api/eve/v1/[...slug]/route.ts` shows the recent merges
(#475/#476/#477) did **not** touch the model / gate / admission code. Cost per call is
identical to before. So the merge cannot have raised spend.

The evals passed at commit N-1 because the shared monthly budget still had headroom (run
early in the month / before production traffic spent it); they fail at commit N because
production traffic has since driven `spent_usd` to ~$29.60. The merge is coincidental —
this is a **capacity / budget-isolation** problem, not a code regression.

## Why only `smoke` / `auth-valid` fail

Those two evals drive a full gated orchestrator session via `t.send(...)` →
`/eve/v1/session`, which hits the cost gate. The other seven hit direct paths
(`/eve/v1/info`, `/api/*`, `/`) that never reach the gate, so they pass regardless of the
budget state. The gated calls fail the moment the shared budget is spent.

## Fix options

### (A) Quick unblock — raise the cap (config adjustment, not new config)
Raise `DF_COST_BUDGET_ORCHESTRATOR_USD` (e.g. `$30` → `$100`) in the Vercel prod env so the
shared budget has headroom for both production and eval traffic. One-line env change; needs
a redeploy to take effect. This unblocks the eval gate immediately but does not stop evals
from competing with production traffic (they can still fail later in a busy month).

### (B) Proper fix — isolate eval traffic from the production budget (code)
The evals are CI tests and should not consume (or compete for) the production cost budget.
Make the eval harness run against a **separate budget** so functionality, not budget, is what
the gate verifies:
- Give eval requests a distinct tenant / call-site category (e.g. a header the gate maps to a
  `TESTER` budget with its own cap), or
- Have the eval CI reset/refill the orchestrator budget (or use a per-run period) before the
  suite runs, or
- Point the eval target at a deployment where `DF_COST_BUDGET_DRIVER` is `console`/unset.

This is the durable fix and respects "no new config" (it is a code change to the eval harness /
gate tenant mapping, not a new secret).

## Recommendation

Do **(A)** now to unblock the gate, and schedule **(B)** as the proper follow-up so the eval
suite stops being flaky at month-end. No code change is required for (A); (B) is a small,
well-scoped change to the eval harness + gate tenant resolution.

## Verification

- (A): after raising the cap + redeploy, re-run the eval suite; `smoke` and `auth-valid` must
  reach green with the other seven still green.
- (B): after isolating the eval budget, confirm `df_cost_budgets` for the production tenant no
  longer moves when the eval suite runs, and evals pass regardless of production spend.

## ADR

If (B) is implemented, add `docs/adr/0065-<slug>.md` recording the decision to isolate eval
traffic from the production cost budget.
