# Plan — #478: Fix production eval failures (smoke + auth-valid MODEL_SELECTION_FAILED)

- **Date:** 2026-10-25
- **Issue:** #478
- **Branch:** `fix/production-eval-failures-478`

## Symptom

Evals run against `https://agent-eve-gold.vercel.app` (production, via Vercel
protection bypass). 7 of 9 pass; `smoke` and `auth-valid` fail with
`run failed (code: MODEL_SELECTION_FAILED)`. Both failing evals drive a full
gated chat session through `t.send("Hello! ...")`; the other seven hit direct
HTTP or `/eve/v1/info` endpoints (no session/model call).

## Diagnosis (framework-eval-debugging skill, pitfalls 16 / 19 / 21)

The 7-pass / 2-fail signature (exactly `smoke` + `auth-valid`) is the
**documented KNOWN-CONFIGURATION failure**, not a code regression.
`MODEL_SELECTION_FAILED` is eve's own code raised when the dynamic model
resolver's `step.started` hook THROWS. That hook is where the cost gate runs,
but it also throws on a rejected session (bad bearer token) or an unreachable
store. It is a catch-all, so the string alone names no cause.

Two confirmed CONFIG causes (both are env/secret values, not repo code):

- **(A) Bearer-token mismatch** — the GitHub Actions secret `EVE_EVAL_AUTH_TOKEN`
  does not equal the deployment's `EVE_API_KEY`, so the session the eval opens
  is rejected. Discriminator: `auth-invalid` PASSES (sends a bad token and
  asserts status >= 400, which proves auth IS enforced) while `auth-valid`
  FAILS (the "valid" token is the wrong one). This matches the observed output
  exactly.
- **(B) Armed cost gate without caps** — `DF_COST_BUDGET_DRIVER` is set but
  `DF_COST_BUDGET_ORCHESTRATOR_USD` (and/or the other caps) are unset, so
  `governor.admit()` returns `not_configured` and the refusal surfaces as
  `MODEL_SELECTION_FAILED`. Also consistent with the 7/9 signature.

## What rules a code regression in or out

The user tied this to "the previous merge". Tracing the two recent security
merges:

- **#476 (SSRF, #304)** hardened `resolveApiOrigin` to fail-closed 502 when no
  trusted origin is configured. On Vercel the `VercelPlatformAdapter`
  (`platform.ts:99-102`) populates `context.apiOrigin` from `VERCEL_URL`, so the
  proxy resolves to the deployment URL and does NOT 502. #476 therefore does
  not break production session creation. Confirmed by reading `route.ts` +
  `platform.ts`.
- **#475 (#471 auth)** added origin-aware redirects but did not change the
  session/proxy path.

So a code regression from those merges is NOT supported by the code. The
decisive check is the production log line below.

## Confirmation (one grep in the Vercel function logs)

Grep the production function logs for the structured refusal ADR 0058 added:

```
[dark-factory] cost gate refused category=... reason=<X> ...
```

- If present with `reason=not_configured` / `budget_exceeded` -> cause (B); read
  the `df_cost_budgets` row (spend vs cap vs reserved) to pick the lever.
- If ABSENT -> the throw is not the cost gate -> cause (A) (session rejected on
  the bearer token). Confirm `EVE_EVAL_AUTH_TOKEN` equals the production
  `EVE_API_KEY`.

## Fix (configuration — applied by the operator, out of code scope)

- **(A):** Set the GitHub Actions secret `EVE_EVAL_AUTH_TOKEN` to the exact
  value of the production `EVE_API_KEY` (Vercel -> Project Settings ->
  Environment Variables, Production). NOTE: Preview and Production carry
  different `EVE_API_KEY`s; if the failing eval targets Production, use the
  Production value. A secret change needs no redeploy.
- **(B):** In Vercel prod env, provision the per-call-site caps
  `DF_COST_BUDGET_ORCHESTRATOR_USD` (and `DEVELOPER` / `TESTER` / `PR_REVIEW`)
  to non-negative numerics — OR, if cost governance is not meant to be armed in
  prod, set `DF_COST_BUDGET_DRIVER` to `console` / leave it unset. A cap change
  needs a redeploy to take effect.

## Code change (only if the log reveals a genuine code fault)

If the log shows a resolver throw that is neither the gate nor auth (for
example an unreachable store or a model-resolution bug introduced by a merge),
that is the real regression and will be fixed in-repo with a RED test. No code
change is warranted for causes (A) / (B).

## Verification

Re-run the production eval suite; `smoke` must reach 2/2 and `auth-valid` 1/1,
with the other seven evals still green.
