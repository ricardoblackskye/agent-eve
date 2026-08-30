# Fix chat "Unauthorized: invalid or missing API key" (#42)

> **For Hermes:** Use test-driven-development (RED → GREEN → verify).

**Goal:** The chat UI at `/` (renders `app/chat.tsx` → `useEveAgent({ host: "/api" })`)
returns `Unauthorized: invalid or missing API key` in preview/prod. Fix it so the
browser chat authenticates successfully.

**Root cause (verified by reading code):**

- `app/page.tsx` renders `<Chat />` from `app/chat.tsx`.
- `app/chat.tsx` uses `useEveAgent({ host: "/api" })` → calls the proxy route
  `app/api/eve/v1/[...slug]/route.ts`.
- That proxy route has an **inbound auth check** (lines 10–21):
  ```ts
  const API_KEY = process.env.EVE_API_KEY;
  if (API_KEY && !isHealthPath) {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
      return NextResponse.json({ error: "Unauthorized: invalid or missing API key" }, { status: 401 });
    }
  }
  ```
- `app/chat.tsx` sends **no** `Authorization` header. So when `EVE_API_KEY` is set
  (preview/prod), every chat request is rejected with 401. In local dev `EVE_API_KEY`
  is unset → the check is skipped → chat works. That is exactly the reported symptom.
- The proxy *also* injects `EVE_API_KEY` on the outbound call to `/eve/v1/*`
  (lines 30–34), so the real Eve channel accepts the forwarded request.

**Why not just remove the proxy auth check:** The proxy was deliberately written to
require inbound auth, and the production evals `auth-valid` / `auth-invalid` depend on
it (they assert a bad/valid token is accepted/rejected at `/api/eve/v1/info`). Removing
it would open the proxy to the world and break those evals. The project's own
`feat-add-web-ui.md` MVP plan specified the chat uses `NEXT_PUBLIC_EVE_API_KEY`
bearer auth — so the real bug is that `app/chat.tsx` was never wired to send it.

**Intended fix (minimal, matches plan + preserves evals):** Make the chat client send
`Authorization: Bearer <NEXT_PUBLIC_EVE_API_KEY>`, where `NEXT_PUBLIC_EVE_API_KEY`
must equal `EVE_API_KEY` in the deployment. Extract a tiny pure helper so it is
unit-testable.

**Architecture:** browser (`/`) → `app/chat.tsx` (sends `Bearer <NEXT_PUBLIC_EVE_API_KEY>`)
→ `/api/eve/v1/*` proxy (inbound check passes because keys match) → injects
`EVE_API_KEY` outbound → `/eve/v1/*` Eve channel accepts.

---

## Tasks (TDD)

### Task 1: Write failing test for the chat auth header helper (RED)

**Objective:** Prove no helper builds the `Authorization` header from
`NEXT_PUBLIC_EVE_API_KEY`.

**Files:**
- Create: `app/chat-auth.ts` (the helper — will be created in GREEN)
- Create: `tests/chat-auth.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { getEveChatHeaders } from "../app/chat-auth";

describe("chat auth header (issue #42)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("sends Bearer token when NEXT_PUBLIC_EVE_API_KEY is set", () => {
    vi.stubEnv("NEXT_PUBLIC_EVE_API_KEY", "eve_sk_test_123");
    expect(getEveChatHeaders()).toEqual({ authorization: "Bearer eve_sk_test_123" });
  });

  it("sends no header when NEXT_PUBLIC_EVE_API_KEY is unset", () => {
    vi.unstubAllEnvs();
    expect(getEveChatHeaders()).toEqual({});
  });
});
```

**Step 2: Run test to verify failure**

Run: `node_modules/.bin/vitest run tests/chat-auth.test.ts`
Expected: FAIL — cannot find module `../app/chat-auth` (module not created yet).

**Step 3: Commit the RED test**

```bash
git add tests/chat-auth.test.ts
git commit -m "test(chat): assert chat builds Bearer auth header from NEXT_PUBLIC_EVE_API_KEY"
```

### Task 2: Create the helper and wire it into the chat (GREEN)

**Objective:** Make the test pass and fix the chat.

**Files:**
- Create: `app/chat-auth.ts`
- Modify: `app/chat.tsx`

**Step 1: Create `app/chat-auth.ts`**

```ts
/**
 * Build the Authorization header the chat UI sends to the /api/eve proxy.
 *
 * The proxy (app/api/eve/v1/[...slug]/route.ts) requires
 * `Authorization: Bearer <EVE_API_KEY>`. The browser cannot hold the secret
 * EVE_API_KEY, so it uses the public counterpart NEXT_PUBLIC_EVE_API_KEY, which
 * must be set to the same value in the deployment.
 */
export function getEveChatHeaders(): Record<string, string> {
  const key = process.env.NEXT_PUBLIC_EVE_API_KEY;
  return key ? { authorization: `Bearer ${key}` } : {};
}
```

**Step 2: Wire into `app/chat.tsx`**

```ts
import { getEveChatHeaders } from "./chat-auth";

const agent = useEveAgent({
  host: "/api",
  headers: getEveChatHeaders(),
});
```

**Step 3: Run test to verify pass**

Run: `node_modules/.bin/vitest run tests/chat-auth.test.ts`
Expected: PASS (2/2)

**Step 4: Run full suite + typecheck for regressions**

```bash
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit
```

**Step 5: Commit**

```bash
git add app/chat-auth.ts app/chat.tsx
git commit -m "fix(chat): send Bearer auth header from NEXT_PUBLIC_EVE_API_KEY (#42)

The /api/eve proxy requires Authorization: Bearer <EVE_API_KEY>. The chat UI
never sent a header, so in preview/prod (EVE_API_KEY set) every request 401'd
with 'Unauthorized: invalid or missing API key'. Wire the chat to send
Bearer <NEXT_PUBLIC_EVE_API_KEY>; set NEXT_PUBLIC_EVE_API_KEY == EVE_API_KEY
in the deployment. Local dev (no EVE_API_KEY) is unchanged.

Closes #42"
```

### Task 3: Push for review

```bash
git push -u origin HEAD
```

Open PR referencing `Closes #42`.

---

## Files likely to change
- `app/chat-auth.ts` (new helper)
- `app/chat.tsx` (use the helper)
- `tests/chat-auth.test.ts` (new test)

## Validation
- `node_modules/.bin/vitest run tests/chat-auth.test.ts` → 2 passed
- `node_modules/.bin/vitest run` → no regressions
- `node_modules/.bin/tsc --noEmit` → clean
- Manual: in preview/prod with `NEXT_PUBLIC_EVE_API_KEY` set, chat returns a real
  response instead of 401.

## Deployment action required (documented in PR)
Set `NEXT_PUBLIC_EVE_API_KEY` in Vercel to the same value as `EVE_API_KEY`. Without
it the chat still 401s (keys won't match the proxy's required `EVE_API_KEY`).

## Risks / open questions
- `NEXT_PUBLIC_EVE_API_KEY` is publicly visible in the browser bundle. For a personal
  agent this is the intended MVP design (per feat-add-web-ui.md); if stronger
  isolation is wanted later, route the UI through a server-side session token
  instead. Out of scope for #42.
- `auth-invalid` / `auth-valid` evals are unchanged and still pass (proxy still
  enforces inbound auth).
