# #440 — `model-check` asserts a model id the framework deliberately removes

**Issue:** #440
**Branch:** `fix/model-check-eval-440` (off `main` @ `1198368`, the #441 merge)
**Status:** plan — awaiting GATE 1

## Acceptance

1. The Preview Evals `model-check` gate goes **green** with cost governance left **armed**.
2. It still **fails when the configured model is wrong** — the fix must not turn it into a
   check that passes for any input.
3. It **never fails with `Cannot read properties of undefined`**; a missing field is reported
   as a missing field.

## Verified root cause

`evals/model-check.eval.ts` reads `info?.agent?.model?.id` and passes it to a predicate that
calls `.includes`. `AgentInfoResultSchema` (the runtime contract for `/eve/v1/info`, in
`node_modules/eve/dist/src/client/agent-info-schema.d.ts`) defines `agent.model` as a union:

|                | static                      | governed                                         |
|----------------|-----------------------------|--------------------------------------------------|
| `routing.kind` | `"gateway"` or `"external"` | `"dynamic"`                                      |
| `id`           | `z.ZodString` (required)    | `z.ZodOptional<z.ZodNever>` — must be **absent** |

The governed branch is selected by `agent/agent.ts:63-78` whenever the LLM call policy or the
cost gate is configured, and `governed-model.ts:37-52` resolves the model per `step.started`
via `defineDynamic`. So `id` being absent is **correct behaviour**, not a fault: the eval was
asserting a field the framework removes on purpose.

Cause "auth" is ruled out: `ci.yml:142-143` supplies `EVE_API_KEY` and `EVE_EVAL_AUTH_TOKEN`,
and `evals/webhook.eval.ts:97` shows the harness's skip-when-unavailable precedent, which
`model-check` never adopted.

## Decision for GATE 1 — what should the check assert?

- **Option A (recommended):** pass when the model is a deepseek id **or** `routing.kind` is
  `"dynamic"`. Truthful, cheap, and it still catches a wrong *static* model. It cannot catch a
  wrong model *behind* the gate, because the schema guarantees `/eve/v1/info` will not report one.
- **Option B:** additionally assert the **resolved** model from a run/trace, so deepseek stays
  proven after the governance change. Stronger; needs a dispatch, and belongs in whichever eval
  already dispatches (rather than duplicating the setup here).

Recommendation: ship A now (it un-breaks the gate and the schema makes it defensible) and treat
B as a follow-up issue, since B cannot be verified without CI either.

## The checks to write

Assertions, in order, on the `/eve/v1/info` payload:

- **C1 — governed passes.** `routing.kind === "dynamic"` with no `id` → **pass**, and the message
  names the governed case (so the next reader does not hunt for a missing id).
- **C2 — static deepseek passes.** `id` is a string containing `deepseek` → **pass**.
- **C3 — a wrong static model FAILS.** `id` e.g. `anthropic/claude-…` → **fail**. This is the
  anti-vacuity check: it proves the fix is not "always pass".
- **C4 — a malformed or errored payload fails cleanly.** A 401 envelope or a payload with no
  `agent` → **fail** with a message naming the absent field. Must not throw: today's
  `Cannot read properties of undefined (reading 'includes')` is what made this cost a day.
- **C5 — the message states which case was proven** (static deepseek id, or governed).

## Approach

1. Extract the payload → verdict decision into a small pure function so it can be unit-tested
   with fixtures; keep the eval file itself thin, in the style of `evals/webhook.eval.ts`.
2. Unit tests for C1–C4 (C5 asserted on the returned message). C3 is the one that must be RED
   first and must fail if the predicate is loosened to a constant.
3. The eval calls the helper and reports through the existing `t.check(…, satisfies(…))` shape.

## Risks and open questions

- **The wire value is `"dynamic"`, not `"governed"`.** "Governed" is this plan's gloss, borrowed
  from `buildGovernedDynamicModel`; only `"dynamic"` may be compared against. A check on the
  literal word `governed` would never pass.
- **Locating the helper.** CORRECTED after checking: `evals/helpers/` already exists with a
  precedent (`evals/webhook.eval.ts` imports `./helpers/sign`), so extracting a helper follows
  the existing convention rather than introducing one. The alternative - inlining it - would
  leave this check with **no honest RED**, which the SDLC would have to record rather than hide.
- **Option A's blind spot is real** and must be stated in the eval's own message, not only in
  this plan: with a gate configured, a wrong model is invisible to `/eve/v1/info`.
- **Verification is CI-only.** The eval target needs `VERCEL_PROTECTION_BYPASS` and `EVE_API_KEY`;
  neither is available locally, so a local pass proves only the helper, never the gate.

## Out of scope

- Turning the cost gate off. That would make the gate green and disable the governance
  configured in the same session.
- Any change to `agent/agent.ts`, `governed-model.ts` or the schema — the framework behaviour is
  correct.
- AMM scanner work (#437, merged as #441), including the catalogue's command rows naming scripts
  this repository does not define.
