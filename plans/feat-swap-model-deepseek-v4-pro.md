# Swap Model to DeepSeek V4 Pro Implementation Plan

> **For Hermes:** Use the TDD workflow (test-driven-development skill) to implement this plan.

**Goal:** Change the Eve agent's model from `gpt-4o` (OpenRouter via `@ai-sdk/openai`) to `deepseek/deepseek-v4-pro`.

**Architecture:** Single file change in `agent/agent.ts` — swap the model string passed to `openrouter.chat()` and update the context window token count to match DeepSeek V4 Pro's 1M token context window.

**Technical Strategy:** Minimal change — only the model name and `modelContextWindowTokens` value need to change. The `@ai-sdk/openai` provider works identically since DeepSeek is OpenAI-compatible and routes through the same OpenRouter base URL.

**Testing Blueprint:** Update the smoke eval to verify the agent still boots and responds. Run evals against local dev server (RED first with the old model assertion, then GREEN after the model swap).

---

## Current State

- **File:** `agent/agent.ts`
- **Model:** `gpt-4o` via `openrouter.chat("gpt-4o")`
- **Context window:** `128_000`
- **Provider:** `createOpenAI({ baseURL: "https://openrouter.ai/api/v1", name: "openrouter" })`

## Target State

- **Model:** `deepseek/deepseek-v4-pro` via `openrouter.chat("deepseek/deepseek-v4-pro")`
- **Context window:** `1_048_576` (1M tokens — confirmed from OpenRouter API)

---

## Tasks

### Task 1: Write failing eval — assert model id changes

**Objective:** Write an eval that reads the agent info and asserts the model is `deepseek/deepseek-v4-pro`. It will fail RED against the current agent.

**Files:**
- Create: `evals/model-check.eval.ts`

**Step 1: Write failing test**

```ts
// evals/model-check.eval.ts
import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description: "Verifies the agent uses deepseek/deepseek-v4-pro model.",
  tags: ["production"],
  async test(t) {
    const infoResponse = await t.target.fetch("/eve/v1/info", {
      headers: { authorization: "Bearer " + process.env.EVE_EVAL_AUTH_TOKEN },
    });
    const info = await infoResponse.json();
    const modelId = info?.agent?.model?.id;
    t.check(
      modelId,
      satisfies((id: string) => id.includes("deepseek-v4-pro"), "model is deepseek-v4-pro"),
    );
  },
});
```

**Step 2: Run test to verify RED**

```bash
npx eve eval model-check --url http://localhost:8399
```
Expected: FAIL — model is `openrouter/gpt-4o`, not `deepseek-v4-pro`.

**Step 3: Commit**

```bash
git add evals/model-check.eval.ts
git commit -m "test: add model-check eval asserting deepseek-v4-pro"
```

---

### Task 2: Swap model in agent.ts

**Objective:** Change `gpt-4o` to `deepseek/deepseek-v4-pro` and update context window.

**Files:**
- Modify: `agent/agent.ts`

**Step 1: Change the model**

In `agent/agent.ts`:

```ts
export default defineAgent({
  model: openrouter.chat("deepseek/deepseek-v4-pro"),
  modelContextWindowTokens: 1_048_576,
});
```

**Step 2: Run build to verify TypeScript compiles**

```bash
npm run build
npx tsc --noEmit
```
Expected: both pass.

---

### Task 3: Deploy and verify GREEN

**Objective:** Build, deploy to Vercel, and run evals to confirm everything passes.

**Step 1: Build and deploy**

```bash
npx vercel pull --yes --token $VERCEL_TOKEN
npx vercel build --token $VERCEL_TOKEN
npx vercel deploy --prebuilt --prod --token $VERCEL_TOKEN
```

**Step 2: Run local evals (excluding production-tagged evals)**

```bash
npx eve eval --exclude-tag production
```
Expected: smoke eval passes 2/2.

**Step 3: Run production evals against live deployment**

```bash
EVE_EVAL_AUTH_TOKEN="eve_sk_..." npx eve eval \
  --url https://agent-eve-gold.vercel.app
```
Expected: ALL evals GREEN — including the new model-check eval.

---

### Task 4: Commit, push, create PR

**Files:**
- Modified: `agent/agent.ts` (model swap + context window)
- Created: `evals/model-check.eval.ts`

```bash
git add agent/agent.ts evals/model-check.eval.ts
git commit -m "feat: swap model from gpt-4o to deepseek/deepseek-v4-pro

- Change openrouter.chat('gpt-4o') to openrouter.chat('deepseek/deepseek-v4-pro')
- Update modelContextWindowTokens from 128_000 to 1_048_576
- Add model-check.eval.ts to verify the model id at runtime
- Verified: 1M token context window (from OpenRouter model API)"

git push -u origin HEAD
gh pr create --title "feat: swap model to deepseek/deepseek-v4-pro" --body "Closes #4"
```

---

## Verification Checklist

- [ ] `model-check.eval.ts` written first — verifies RED against old model
- [ ] `agent/agent.ts` updated — model string + context window changed
- [ ] `npm run build` passes
- [ ] `npx tsc --noEmit` passes
- [ ] Local evals pass (smoke)
- [ ] Production evals pass (all evals against live URL, including model-check)
- [ ] PR created linking to issue #4