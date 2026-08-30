# Fix chat echoes canned response (#44)

> **For Hermes:** Use test-driven-development (RED → GREEN → verify).

**Goal:** The web UI chat returns a canned echo — `I can help you with that! You asked: "<msg>"` — instead of a real LLM response. Fix it so production uses the real OpenRouter model.

**Root cause (verified):**

`agent/agent.ts` (the root chat agent) hardcodes:

```ts
model: mockModel({
  modelId: "nvidia/nemotron-3-ultra-550b-a55b:free",
  provider: "openrouter",
  respond: ({ lastUserMessage }) => `I can help you with that! You asked: "${lastUserMessage}"`,
}),
```

`mockModel` is the deterministic eval stub. Its `respond` returns exactly the
canned string the user reports in #44. This was set so CI evals pass without an
OpenRouter key (see git log: "fix: always use mockModel for evals", "fix: resolve
remaining eval failures"). It is correct for *evals*, but it is now the live
production model, so the chat never calls a real LLM.

**Intended fix (minimal, matches pr-reviewer subagent pattern):**

The `pr-reviewer` subagent already uses the real model unconditionally:
`openrouter.chat("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free")`. The root
agent should do the same in production, and only fall back to `mockModel` when
`OPENROUTER_API_KEY` is **unset** (so local dev / eval runs still need no key and
the smoke/model-check evals keep passing).

Extract a pure helper `resolveChatModel()` so the selection is unit-testable.

**Architecture:** `agent/chat-model.ts` exports `resolveChatModel()`:
- `OPENROUTER_API_KEY` set → `openrouter.chat("nvidia/nemotron-3-ultra-550b-a55b:free")`
- unset → `mockModel({ modelId, provider, respond })` (current canned responder)

`agent/agent.ts` imports and uses it.

---

## Tasks (TDD)

### Task 1: Write failing test for model selection (RED)

**Objective:** Prove `resolveChatModel()` is not yet implemented / wrong.

**Files:**
- Create: `agent/chat-model.ts` (created in GREEN)
- Create: `tests/chat-model.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveChatModel } from "../agent/chat-model";

describe("chat model selection (issue #44)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses the real model when OPENROUTER_API_KEY is set", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-...");
    const model = resolveChatModel();
    // Real OpenRouter models report provider "openrouter"; mock reports "eve-mock".
    expect((model as any).modelId ?? (model as any).provider).not.toBe("eve-mock");
  });

  it("falls back to the mock model when OPENROUTER_API_KEY is unset", () => {
    vi.unstubAllEnvs();
    const model = resolveChatModel();
    expect((model as any).provider).toBe("eve-mock");
  });
});
```

**Step 2: Run test to verify failure**

Run: `node_modules/.bin/vitest run tests/chat-model.test.ts`
Expected: FAIL — cannot find module `../agent/chat-model`.

**Step 3: Commit the RED test**

```bash
git add tests/chat-model.test.ts
git commit -m "test(agent): assert chat uses real model when OPENROUTER_API_KEY set"
```

### Task 2: Create the helper and wire it in (GREEN)

**Files:**
- Create: `agent/chat-model.ts`
- Modify: `agent/agent.ts`

**Step 1: Create `agent/chat-model.ts`**

```ts
import { mockModel } from "eve/evals";
import { createOpenAI } from "@ai-sdk/openai";

const MODEL_ID = "nvidia/nemotron-3-ultra-550b-a55b:free";
const PROVIDER = "openrouter";

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  name: "openrouter",
});

const mock = mockModel({
  modelId: MODEL_ID,
  provider: PROVIDER,
  respond: ({ lastUserMessage }) =>
    `I can help you with that! You asked: "${lastUserMessage}"`,
});

/**
 * Production chat uses the real OpenRouter model. When OPENROUTER_API_KEY is
 * unset (local dev / eval runs) we fall back to the deterministic mock so no
 * external key is required and the smoke/model-check evals still pass.
 */
export function resolveChatModel() {
  return process.env.OPENROUTER_API_KEY ? openrouter.chat(MODEL_ID) : mock;
}
```

**Step 2: Wire into `agent/agent.ts`**

```ts
import { defineAgent } from "eve";
import { resolveChatModel } from "./chat-model";

export default defineAgent({
  model: resolveChatModel(),
  modelContextWindowTokens: 1_048_576,
});
```

**Step 3: Run test to verify pass**

Run: `node_modules/.bin/vitest run tests/chat-model.test.ts`
Expected: PASS (2/2)

**Step 4: Run full suite + typecheck**

```bash
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit
```

**Step 5: Commit**

```bash
git add agent/chat-model.ts agent/agent.ts
git commit -m "fix(agent): use real OpenRouter model in prod, mock only when key unset (#44)

Root agent hardcoded mockModel, so the web UI echoed a canned reply instead
of calling a real LLM. Select the real OpenRouter model when OPENROUTER_API_KEY
is set; fall back to mock only when unset (keeps evals/local working).

Closes #44"
```

### Task 3: Push for review

```bash
git push -u origin HEAD
```

Open PR referencing `Closes #44`.

---

## Files likely to change
- `agent/chat-model.ts` (new helper)
- `agent/agent.ts` (use the helper)
- `tests/chat-model.test.ts` (new test)

## Validation
- `node_modules/.bin/vitest run tests/chat-model.test.ts` → 2 passed
- `node_modules/.bin/vitest run` → no regressions
- `node_modules/.bin/tsc --noEmit` → clean

## Risks / open questions
- Production must have `OPENROUTER_API_KEY` set, or it still uses the mock.
  The README already lists `OPENROUTER_API_KEY` as required; confirm it is set
  in Vercel (it is needed for real chat responses).
- `model-check` eval asserts the model id is reported; mock reports the same id,
  so the eval still passes either way.
