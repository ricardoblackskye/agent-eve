# Switch chat + code-review model to deepseek/deepseek-v4-pro (#47)

> **For Hermes:** Use test-driven-development (RED → GREEN → verify) for the
> implementation phase. Two human gates: plan approval (Phase 3) and PR
> authorization (Phase 6).

## Goal

Stop the chat `Provider returned error`, the eval `MODEL_CALL_FAILED`, and the
"Automated PR Review (Fallback Mode)" comments by switching the failing
`nvidia/nemotron-3-ultra-550b-a55b:free` OpenRouter model to
`deepseek/deepseek-v4-pro` in **both** the chat agent and the code-review
script. Issue #47 explicitly asks for `deepseek/deepseek-v4-pro`.

Out of scope (separate issue): the `multi-repo-config` eval failure
(`known repo returns ok: true` → false).

## Root cause (verified, Phase 1)

- `agent/chat-model.ts` line 4 hardcodes the chat model
  `nvidia/nemotron-3-ultra-550b-a55b:free`. After PR #46 the chat uses the REAL
  model, so when OpenRouter errors on that model the user sees
  `Provider returned error` and the `smoke`/`auth-valid` evals fail with
  `MODEL_CALL_FAILED: The model did not return a response`.
- `scripts/pr-reviewer.js` calls OpenRouter with `model: process.env.MODEL_NAME`
  (`pr-reviewer.yml` line 28 = same nemotron model). On any OpenRouter failure it
  posts the "Automated PR Review (Fallback Mode)" comment (lines 109–138). Same
  failing model → same symptom.
- Both share the nemotron free model as the single point of failure. Switching
  both to a working model (deepseek-v4-pro) resolves all three symptoms.

## Intended fix (minimal)

1. `agent/chat-model.ts`: `MODEL_ID = "deepseek/deepseek-v4-pro"`.
2. `.github/workflows/pr-reviewer.yml`: `MODEL_NAME: "deepseek/deepseek-v4-pro"`.
3. `evals/model-check.eval.ts`: the production eval asserts
   `modelId.includes("nemotron-3-ultra")` (line 15) — must be updated to
   `deepseek` or the production `model-check` eval will fail after the switch.

The `resolveChatModel()` fallback-to-mock (when `OPENROUTER_API_KEY` unset)
stays; mock modelId also updated so local/eval runs keep reporting the right id.

## OpenRouter model id convention

- Chat (`agent/chat-model.ts`) uses `openrouter.chat(MODEL_ID)` from
  `@ai-sdk/openai` with baseURL `https://openrouter.ai/api/v1`. The OpenRouter
  slug form `deepseek/deepseek-v4-pro` is correct here.
- The code-review script posts directly to
  `https://openrouter.ai/api/v1/chat/completions` with
  `model: process.env.MODEL_NAME`. Same `deepseek/deepseek-v4-pro` slug.

Note: `deepseek/deepseek-v4-pro` availability/quota depends on the
`OPENROUTER_API_KEY` in use. If OpenRouter returns an error for this slug, the
symptoms return — but that is a credential/quota matter, not a code bug. The
`model-check` eval will surface a wrong-model id if the slug is wrong.

---

## Tasks (TDD for the model-check eval assertion update)

### Task 1 — RED: failing eval assertion

**Objective:** Prove the production `model-check` eval still pins the old model
id after the switch. The eval asserts `modelId.includes("nemotron-3-ultra")`;
once we switch the chat to deepseek, the production `/eve/v1/info` reports
`deepseek/deepseek-v4-pro`, so the eval must change to `deepseek`.

**Step 1:** Write `tests/model-check-id.test.ts` asserting the model id the
chat reports contains `deepseek` (mirrors the eval's predicate, runs offline
against `resolveChatModel()`'s id). This fails now because the constant is still
`nemotron-3-ultra`.

```ts
import { describe, it, expect } from "vitest";
import { resolveChatModel } from "../agent/chat-model";

describe("chat model id (issue #47)", () => {
  it("reports a deepseek model id", () => {
    const model = resolveChatModel() as any;
    expect(String(model?.modelId ?? "")).toContain("deepseek");
  });
});
```

**Step 2:** Run → FAIL (current id is nemotron-3-ultra-550b-a55b:free).

**Step 3:** Commit RED test.

### Task 2 — GREEN: switch the model + update eval assertion

**Files to change:**
- `agent/chat-model.ts`: `MODEL_ID = "deepseek/deepseek-v4-pro"` (also used by mock).
- `.github/workflows/pr-reviewer.yml`: `MODEL_NAME: "deepseek/deepseek-v4-pro"`.
- `evals/model-check.eval.ts` line 15: `id.includes("nemotron-3-ultra")` →
  `id.includes("deepseek")`, and update description line 6 + message line 16.

**Step:** Run `tests/model-check-id.test.ts` → PASS. Run full suite → no new
regressions. `tsc --noEmit` clean.

**Step:** Commit (model switch + eval assertion + test).

### Task 3 — Push for review (Phase 6 gate)

After TDD done and **authorized**, push and create PR referencing `Closes #47`.

---

## Files likely to change
- `agent/chat-model.ts` (model id)
- `.github/workflows/pr-reviewer.yml` (MODEL_NAME)
- `evals/model-check.eval.ts` (eval assertion)
- `tests/model-check-id.test.ts` (new test)

## Validation
- `node_modules/.bin/vitest run tests/model-check-id.test.ts` → pass
- `node_modules/.bin/vitest run` → no NEW regressions (pre-existing
  `pr-reviewer.test.ts` x2 and the #41 README doc test x5 remain)
- `node_modules/.bin/tsc --noEmit` → clean

## Risks / open questions
- `OPENROUTER_API_KEY` must be present (CI secret + Vercel) or the chat still
  errors and the code-review script still falls back. This fixes the *model
  choice*, not missing credentials.
- If OpenRouter doesn't serve `deepseek/deepseek-v4-pro` for the key in use, the
  symptoms recur. The `model-check` eval (now `includes("deepseek")`) will catch
  a wrong/absent slug at deploy time.
- `multi-repo-config` eval failure is intentionally NOT addressed here (separate
  issue per user decision).
