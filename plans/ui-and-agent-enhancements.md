# UI and Agent Enhancements

**Issue:** #10
**Branch:** `feat/ui-and-agent-enhancements`

## Changes

### 1. Model Swap: deepseek-v4-pro → nvidia/nemotron-3-ultra-550b-a55b:free

**Files:**

- `agent/agent.ts` — change model string
- `evals/model-check.eval.ts` — update assertion to match new model

**Details:**
The agent model is defined in `agent/agent.ts` at line 11:

```ts
model: openrouter.chat("deepseek/deepseek-v4-pro"),
```

Change to:

```ts
model: openrouter.chat("nvidia/nemotron-3-ultra-550b-a55b:free"),
```

The model-check eval at `evals/model-check.eval.ts` hardcodes the old model string;
update the satisfaction check to match the new model ID.

### 2. Chat Label: "assistant" → "Eve"

**File:** `app/chat.tsx`

**Details:**
Currently line 42 renders the raw `msg.role` value:

```tsx
<strong>{msg.role}</strong>
```

This shows "assistant" for AI messages. Change to display "Eve" when role is "assistant"
while keeping "user" as-is for user messages. E.g.:

```tsx
<strong>{msg.role === "assistant" ? "Eve" : msg.role}</strong>
```

### 3. Avatar Image at Top Right of Chat

**Files:**

- `public/images/eve-avatar.jpg` — avatar image asset (source: issue attachment)
- `app/chat.tsx` — add avatar element to header
- `app/globals.css` — style the avatar

**Details:**
Add a 40×40 circular avatar image to the right side of the chat header, showing the
personality/character image from the issue. The CSS should:

- Use `display: flex; justify-content: space-between` on the header
- Style the avatar as a 40px circle with object-fit: cover
- Position it on the right side of the header
- Add a subtle border/shadow for visual polish

**Image source:** https://github.com/user-attachments/assets/e464c914-8312-4f1c-a019-b98da520b426
Saved to `public/images/eve-avatar.jpg` (~2.3MB JPEG at high resolution; consider optimizing).

## Test Plan

### Evals (Eve framework — run with `npx eve eval`)

| Eval File                   | Change                                                                  | RED check                | GREEN check                  |
| --------------------------- | ----------------------------------------------------------------------- | ------------------------ | ---------------------------- |
| `evals/model-check.eval.ts` | Update assertion from `deepseek-v4-pro` to `nemotron-3-ultra-550b-a55b` | Fails with current model | Passes after agent.ts change |
| `evals/frontend.eval.ts`    | No change needed — already checks for "Eve Agent" heading               | —                        | —                            |

### Playwright E2E (`e2e/chat.spec.ts`)

| Test                                                       | What it validates                                                    | Status                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------ |
| `renders ready chat controls without an error`             | Existing — still valid, heading still "Eve Agent"                    | Keep                                       |
| `uses the browser proxy health endpoint`                   | Existing — still valid                                               | Keep                                       |
| `sends a message through the proxy and receives an answer` | Existing — asserts on `.message.assistant` selector                  | **Update** — or add a `.message.eve` class |
| **New: `displays "Eve" label for assistant messages`**     | After sending a message, the AI response shows "Eve" not "assistant" | New                                        |
| **New: `shows avatar image in header`**                    | The header contains an `<img>` with `alt="Eve"` and the correct src  | New                                        |

### Existing test compatibility notes

Current E2E assertions that will be affected:

- Line 49: `page.locator(".message.assistant p")` — still works if we keep the CSS class `.assistant` and only change the label text. **Recommendation: keep the CSS class as-is, only change the displayed text.**
- No other existing assertions reference "assistant" text directly.

## TDD Workflow

Following the project's TDD workflow:

```
Phase 1.5: MegaLinter Pre-Flight  →  No MegaLinter config — skip
Phase 2:   TEST WRITING           →  Update model-check eval + Playwright tests, verify RED
Phase 3:   USER GATE              →  Stop, report RED, wait for approval
Phase 4:   IMPLEMENT              →  Write production code, make all tests GREEN
Phase 4.5: Verify                 →  Confirm all checks pass, no regressions
```

## Definition of Done

- [ ] `agent/agent.ts` uses `nvidia/nemotron-3-ultra-550b-a55b:free`
- [ ] `evals/model-check.eval.ts` asserts new model ID
- [ ] AI message labels show "Eve" instead of "assistant"
- [ ] Avatar image appears in the chat header
- [ ] All evals pass (`npx eve eval --strict`)
- [ ] All E2E tests pass (`npm run test:e2e`)
- [ ] TypeScript compiles (`npm run typecheck`)
- [ ] Build succeeds (`npm run build`)
