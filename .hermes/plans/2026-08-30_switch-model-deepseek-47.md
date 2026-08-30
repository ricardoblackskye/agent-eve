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

Additionally (user request, 2026-08-30): **make the model id configurable via
environment variables** rather than hardcoded in source, so future model changes
are a config change (no code edit / redeploy of logic).

Out of scope (separate issue): the `multi-repo-config` eval failure
(`known repo returns ok: true` → false).

## Root cause (verified, Phase 1)

- `agent/chat-model.ts` line 4 hardcodes the chat model
  `nvidia/nemotron-3-ultra-550b-a55b:free`. After PR #46 the chat uses the REAL
  model, so when OpenRouter errors on that model the user sees
  `Provider returned error` and the `smoke`/`auth-valid` evals fail with
  `MODEL_CALL_FAILED: The model did not return a response`.
- `scripts/pr-reviewer.js` calls OpenRouter with `model: process.env.MODEL_NAME`
  (`pr-reviewer.yml` line 28 = same nemotron model, hardcoded in YAML). On any
  OpenRouter failure it posts the "Automated PR Review (Fallback Mode)" comment
  (lines 109–138). Same failing model → same symptom.
- Both share the nemotron free model as the single point of failure. Switching
  both to a working model (deepseek-v4-pro) resolves all three symptoms.
- The model id is currently hardcoded in two places (TS const + YAML). Making it
  env-driven removes the need to edit source to change models.

## Intended fix (minimal, env-driven)

### 1. Chat model — `agent/chat-model.ts`
Read the model id from an env var with a `deepseek/deepseek-v4-pro` default,
instead of a hardcoded constant. Read it **lazily inside `resolveChatModel()`**
so the value reflects runtime env and is unit-testable.

```ts
const DEFAULT_MODEL_ID = "deepseek/deepseek-v4-pro";

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  name: "openrouter",
});

export function resolveChatModel() {
  const modelId = process.env.EVE_CHAT_MODEL ?? DEFAULT_MODEL_ID;
  const mock = mockModel({
    modelId,
    respond: ({ lastUserMessage }) =>
      `I can help you with that! You asked: "${lastUserMessage}"`,
  });
  return process.env.OPENROUTER_API_KEY ? openrouter.chat(modelId) : mock;
}
```

- Env var: **`EVE_CHAT_MODEL`** (set in Vercel for prod/preview; optional — defaults to deepseek).
- The mock's `modelId` also uses the resolved id, so `/eve/v1/info` reports the
  configured id and the `model-check` eval stays consistent in both modes.

### 2. Code-review model — `.github/workflows/pr-reviewer.yml`
The script already reads `process.env.MODEL_NAME` (no script change needed).
Source that env from a **repo Actions variable** with a deepseek fallback, so
changing the review model is a repo config change:

```yaml
MODEL_NAME: ${{ vars.MODEL_NAME || 'deepseek/deepseek-v4-pro' }}
```

- Set `MODEL_NAME` as a repo variable (Settings → Secrets and variables →
  Actions → Variables) to override without editing YAML.
- Falls back to deepseek-v4-pro when the var is unset.

### 3. `evals/model-check.eval.ts`
The production eval asserts `modelId.includes("nemotron-3-ultra")` (line 15) —
update to `deepseek` (or a substring shared by the default) so the production
`model-check` eval doesn't fail after the switch.

## OpenRouter model id convention
- Chat uses `openrouter.chat(modelId)` with baseURL `https://openrouter.ai/api/v1`;
  the OpenRouter slug `deepseek/deepseek-v4-pro` is correct here.
- The review script posts directly to `.../chat/completions` with
  `model: process.env.MODEL_NAME`; same `deepseek/deepseek-v4-pro` slug.
- `deepseek/deepseek-v4-pro` availability/quota depends on `OPENROUTER_API_KEY`.
  If OpenRouter errors for this slug, symptoms return — credential/quota matter,
  not a code bug. The `model-check` eval will catch a wrong/absent slug.

---

## Tasks (TDD for env-driven model selection)

### Task 1 — RED: failing model-id test

**Objective:** Prove the chat model id is NOT yet env-driven / is still nemotron.

**Step 1:** Write `tests/model-check-id.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveChatModel } from "../agent/chat-model";

describe("chat model id (issue #47)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses EVE_CHAT_MODEL when set", () => {
    vi.stubEnv("EVE_CHAT_MODEL", "deepseek/deepseek-v4-pro");
    const model = resolveChatModel() as any;
    expect(String(model?.modelId ?? "")).toContain("deepseek");
  });

  it("falls back to the default deepseek model id when unset", () => {
    vi.unstubAllEnvs();
    const model = resolveChatModel() as any;
    expect(String(model?.modelId ?? "")).toContain("deepseek");
  });
});
```

**Step 2:** Run → FAIL (current `MODEL_ID` is hardcoded `nemotron-3-ultra-...`).

**Step 3:** Commit RED test.

### Task 2 — GREEN: env-driven model + eval assertion

**Files to change:**
- `agent/chat-model.ts`: lazy `process.env.EVE_CHAT_MODEL ?? "deepseek/deepseek-v4-pro"`.
- `.github/workflows/pr-reviewer.yml`: `MODEL_NAME: ${{ vars.MODEL_NAME || 'deepseek/deepseek-v4-pro' }}`.
- `evals/model-check.eval.ts` line 15: `includes("nemotron-3-ultra")` → `includes("deepseek")` (also update description line 6 + message line 16).

**Step:** Run `tests/model-check-id.test.ts` → PASS (2/2). Run full suite → no new
regressions. `tsc --noEmit` clean.

**Step:** Commit (env-driven model + YAML var + eval assertion + test).

### Task 3 — Push for review (Phase 6 gate)

After TDD done and **authorized**, push and create PR referencing `Closes #47`.

---

## Files likely to change
- `agent/chat-model.ts` (env-driven model id)
- `.github/workflows/pr-reviewer.yml` (MODEL_NAME from repo var)
- `evals/model-check.eval.ts` (eval assertion)
- `tests/model-check-id.test.ts` (new test)

## Validation
- `node_modules/.bin/vitest run tests/model-check-id.test.ts` → 2 pass
- `node_modules/.bin/vitest run` → no NEW regressions (pre-existing
  `pr-reviewer.test.ts` x2 and the #41 README doc test x5 remain)
- `node_modules/.bin/tsc --noEmit` → clean

## Risks / open questions
- `OPENROUTER_API_KEY` must be present (CI secret + Vercel) or the chat still
  errors and the code-review script still falls back. This fixes the *model
  choice/config*, not missing credentials.
- If OpenRouter doesn't serve `deepseek/deepseek-v4-pro` for the key in use, the
  symptoms recur. The `model-check` eval (now `includes("deepseek")`) will catch
  a wrong/absent slug at deploy time.
- Env var names chosen: `EVE_CHAT_MODEL` (chat) and `MODEL_NAME` (review, via repo
  variable). Say the word if you'd prefer a single unified var name.
- `multi-repo-config` eval failure is intentionally NOT addressed here (separate
  issue per user decision).
