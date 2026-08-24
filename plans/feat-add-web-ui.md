# Add Web UI to Eve Agent — Implementation Plan

> **For Hermes:** Use TDD workflow (test-driven-development skill) to implement this plan task-by-task.

**Issue:** #6
**Docs:** https://eve.dev/docs/guides/frontend/nextjs

**Goal:** Add a browser-based chat UI for the Eve agent using Next.js App Router and Eve's `useEveAgent` React hook, served as a single project via `withEve()`.

**Architecture:** The `withEve()` helper from `eve/next` wraps the Next.js config so the agent routes mount at `/eve/v1/*` under the same origin. The browser calls `useEveAgent()` which talks to those same-origin routes. No CORS, no separate deployment.

**Technical Strategy:**
- Add Next.js 15+ as a dependency
- Create `next.config.ts` wrapping with `withEve()` — auto-discovers the `agent/` directory
- Create App Router layout + chat page (`app/layout.tsx`, `app/page.tsx`)
- Chat page uses `useEveAgent` with bearer token auth (passed via `NEXT_PUBLIC_EVE_API_KEY` env var for MVP)
- Update `package.json` scripts: `npm run dev` → runs both Next.js and Eve dev servers
- Add a simple frontend eval to verify the page loads
- Deploy to Vercel — single project, both Next.js and Eve deploy together

**Auth Approach (MVP):** The agent uses a custom bearer token. For the browser, `useEveAgent` accepts an `auth` option with a bearer token resolver. We'll expose the token via `NEXT_PUBLIC_EVE_API_KEY` env var so the client component can pass it. This works for a private MVP where the deployment URL is not public.

**Testing Blueprint:**
- Add a playwright-style smoke eval that loads the chat page and checks it renders
- All existing Eve evals must still pass (model-check, smoke, auth-valid, auth-invalid)

---

## Tasks

### Task 1: Install Next.js dependencies

**Objective:** Add Next.js, React, and related deps to the project.

**Files:**
- Modify: `package.json`

**Steps:**
```bash
npm install next@latest react@latest react-dom@latest
npm install -D @types/react @types/react-dom @types/node
```

Update `package.json` scripts:
```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "eve:build": "eve build",
    "typecheck": "tsc --noEmit"
  }
}
```

**Note:** `withEve()` auto-starts the Eve dev server when `next dev` runs. `next build` runs `eve build` under the hood. The old `eve build` / `eve dev` scripts remain available as `eve:build` / via npx.

**Commit:** `git add package.json package-lock.json && git commit -m "chore: add Next.js dependencies"`

---

### Task 2: Create Next.js config with withEve()

**Objective:** Wire up `withEve()` so the agent routes mount under the Next.js app.

**Files:**
- Create: `next.config.ts`
- Delete/unlink: the old `agent/` can stay as-is — `withEve()` discovers it automatically

```ts
// next.config.ts
import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {};

export default withEve(nextConfig);
```

**Verify:**
```bash
npx tsc --noEmit
```
Expected: compiles clean.

**Commit:** `git add next.config.ts && git commit -m "feat: add next.config.ts with withEve()"`

---

### Task 3: Create App Router layout

**Objective:** Set up the basic Next.js App Router structure.

**Files:**
- Create: `app/layout.tsx`
- Create: `app/globals.css`

```tsx
// app/layout.tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Eve Agent",
  description: "Chat with Eve Agent",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

```css
/* app/globals.css */
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}
body {
  font-family: system-ui, -apple-system, sans-serif;
  background: #0a0a0a;
  color: #e5e5e5;
  min-height: 100vh;
}
```

Also update `tsconfig.json` to include the `app/` directory:
```json
{
  "include": ["agent/**/*.ts", "evals/**/*.ts", "app/**/*.ts", "app/**/*.tsx", "next-env.d.ts"]
}
```

**Verify:** `npx tsc --noEmit`

**Commit:** `git add app/ tsconfig.json && git commit -m "feat: add App Router layout"`

---

### Task 4: Create chat page with useEveAgent

**Objective:** Build the chat UI component.

**Files:**
- Create: `app/page.tsx`
- Create: `app/chat.tsx` (client component)

```tsx
// app/chat.tsx
"use client";

import { useEveAgent } from "eve/react";
import { useState, useRef, type FormEvent } from "react";

const API_KEY = process.env.NEXT_PUBLIC_EVE_API_KEY;

export function Chat() {
  const agent = useEveAgent({
    auth: API_KEY
      ? { bearer: () => API_KEY }
      : undefined,
  });
  const [input, setInput] = useState("");
  const isBusy = agent.status === "submitted" || agent.status === "streaming";

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (text && !isBusy) {
      agent.send(text);
      setInput("");
    }
  }

  return (
    <div className="chat-container">
      <header>
        <h1>Eve Agent</h1>
        <span className={`status ${agent.status}`}>{agent.status}</span>
      </header>

      <main className="messages">
        {agent.data.messages.length === 0 && (
          <p className="placeholder">Send a message to start chatting.</p>
        )}
        {agent.data.messages.map((msg) => (
          <article key={msg.id} className={`message ${msg.role}`}>
            <strong>{msg.role}</strong>
            {msg.parts.map((part, i) =>
              part.type === "text" ? <p key={i}>{part.text}</p> : null,
            )}
          </article>
        ))}
      </main>

      <form onSubmit={onSubmit} className="composer">
        <input
          name="message"
          placeholder="Type your message..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={isBusy}
        />
        <button type="submit" disabled={isBusy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
```

```tsx
// app/page.tsx
import { Chat } from "./chat";

export default function Home() {
  return <Chat />;
}
```

Add basic styles to `globals.css`:
```css
.chat-container { display: flex; flex-direction: column; height: 100vh; max-width: 48rem; margin: 0 auto; }
header { display: flex; align-items: center; gap: 0.75rem; padding: 1rem; border-bottom: 1px solid #222; }
.status { font-size: 0.75rem; padding: 0.125rem 0.5rem; border-radius: 999px; background: #222; }
.status.streaming { background: #1a5; }
.status.error { background: #c33; }
.messages { flex: 1; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: 1rem; }
.placeholder { color: #666; text-align: center; margin-top: 4rem; }
.message { padding: 0.75rem; border-radius: 0.5rem; max-width: 80%; }
.message.user { background: #1a3a5c; align-self: flex-end; }
.message.assistant { background: #1a1a2e; align-self: flex-start; }
.message strong { display: block; font-size: 0.75rem; text-transform: uppercase; opacity: 0.6; margin-bottom: 0.25rem; }
.composer { display: flex; gap: 0.5rem; padding: 1rem; border-top: 1px solid #222; }
.composer input { flex: 1; padding: 0.75rem; border: 1px solid #333; border-radius: 0.375rem; background: #111; color: #e5e5e5; font-size: 1rem; }
.composer input:disabled { opacity: 0.5; }
.composer button { padding: 0.75rem 1.5rem; border: none; border-radius: 0.375rem; background: #1a5; color: #fff; font-size: 1rem; cursor: pointer; }
.composer button:disabled { opacity: 0.5; cursor: default; }
```

**Verify:** `npx tsc --noEmit`

**Commit:** `git add app/page.tsx app/chat.tsx && git commit -m "feat: add chat page with useEveAgent"`

---

### Task 5: Add .env.local with NEXT_PUBLIC_EVE_API_KEY

**Objective:** Make the bearer token available to the browser.

**Files:**
- Create: `.env.local` (already exists from Vercel link — update it)
- Create: `.env.example` (for documentation)

Update `.env.local`:
```
# Already set by vercel link:
# VERCEL_OIDC_TOKEN=...

# Eve API key for browser auth:
NEXT_PUBLIC_EVE_API_KEY=eve_sk_afd1abb4442ba0bd84d07ab3727cd2822a6a7313b5845e05fe94bc7fdb423b4b
```

Add `.env.example`:
```
# Eve API key for browser auth (NEXT_PUBLIC_ prefix exposes it to client code)
NEXT_PUBLIC_EVE_API_KEY=eve_sk_...

# OpenRouter API key for model access (server-side only)
OPENROUTER_API_KEY=sk-or-...
```

**Commit:** `git add .env.example && git commit -m "docs: add .env.example with NEXT_PUBLIC_EVE_API_KEY"`

---

### Task 6: Add frontend smoke eval

**Objective:** Verify the chat page renders and the agent responds via the web UI path.

**Files:**
- Modify: `evals/smoke.eval.ts` (add a check that the HTML page loads)

Since the Eve eval framework targets the agent HTTP routes, we can use `t.target.fetch` to check the Next.js page:

```ts
// evals/frontend.eval.ts
import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description: "Verifies the frontend chat page loads and returns HTML.",
  async test(t) {
    const response = await t.target.fetch("/");
    const text = await response.text();
    t.check(
      response.status,
      satisfies((s: number) => s === 200, "home page returns 200"),
    );
    t.check(
      text,
      satisfies((html: string) => html.includes("Eve Agent"), "page contains 'Eve Agent'"),
    );
  },
});
```

**Local verify:** `npx eve eval frontend --exclude-tag production --verbose`
Expected: passes (home page returns 200 with "Eve Agent" title).

**Commit:** `git add evals/frontend.eval.ts && git commit -m "test: add frontend smoke eval"`

---

### Task 7: Update tsconfig for Next.js

**Objective:** Ensure TypeScript is fully configured for Next.js App Router.

**Files:**
- Modify: `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "types": ["node"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "plugins": [{ "name": "next" }],
    "allowJs": true,
    "incremental": true
  },
  "include": ["agent/**/*.ts", "evals/**/*.ts", "app/**/*.ts", "app/**/*.tsx", "next-env.d.ts"],
  "exclude": ["node_modules"]
}
```

**Verify:** `npx tsc --noEmit` — should pass. Run `next dev` briefly to auto-generate `next-env.d.ts`.

**Commit:** `git add tsconfig.json && git commit -m "chore: update tsconfig for Next.js"`

---

### Task 8: Local verification — run everything together

**Objective:** Confirm the whole stack works locally.

```bash
# Build Eve first
npx eve build

# Start Next.js (which also starts Eve dev server)
npm run dev
```

In another terminal:
```bash
# Check the chat page loads
curl -s http://localhost:3000 | head -20
# Expected: HTML with "Eve Agent" in title

# Run Eve evals against the Next.js origin (same-origin Eve routes)
npx eve eval --url http://localhost:3000 --exclude-tag production
# Expected: all non-production evals pass
```

**Branch commit (all tasks together):**
```bash
git add -A
git commit -m "feat: add Next.js web UI with Eve agent integration"
```

---

### Task 9: Deploy to Vercel and verify production

**Objective:** Deploy the merged Next.js + Eve project to Vercel.

```bash
npx vercel pull --yes --token $VERCEL_TOKEN
npx vercel build --token $VERCEL_TOKEN
npx vercel deploy --prebuilt --prod --token $VERCEL_TOKEN
```

**Verify production:**
```bash
# Health check
curl -s https://agent-eve-gold.vercel.app/eve/v1/health
# Expected: {"ok":true,"status":"ready"}

# Chat page loads
curl -s https://agent-eve-gold.vercel.app | head -5
# Expected: HTML with "Eve Agent"

# Run all evals against production
EVE_EVAL_AUTH_TOKEN="eve_sk_..." npx eve eval \
  --url https://agent-eve-gold.vercel.app
# Expected: all 5 evals pass (smoke, auth-valid, auth-invalid, model-check, frontend)
```

---

### Task 10: Create PR

```bash
GH_TOKEN=$(gh auth token)
git remote set-url origin "https://x-access-token:${GH_TOKEN}@github.com/ricardoblackskye/agent-eve.git"
git push -u origin HEAD

gh pr create \
  --title "feat: add Next.js web UI to Eve agent" \
  --body "## Summary

Adds a browser-based chat UI for the Eve agent using Next.js App Router and Eve's \`useEveAgent\` React hook.

## Changes
- Add Next.js 15+ with React
- \`next.config.ts\` — wrapped with \`withEve()\` for single-project deploy
- \`app/layout.tsx\` + \`app/globals.css\` — dark theme layout
- \`app/page.tsx\` + \`app/chat.tsx\` — chat UI using \`useEveAgent\`
- \`evals/frontend.eval.ts\` — smoke test that the page loads
- \`tsconfig.json\` — updated for Next.js App Router

Closes #6" \
  --base main \
  --head feat/add-web-ui

git remote set-url origin https://github.com/ricardoblackskye/agent-eve.git
```

---

## Open Questions / Clarifications

1. **Auth for the browser** — The plan uses `NEXT_PUBLIC_EVE_API_KEY` (exposed client-side). This works for an MVP but means the bearer token is visible in browser dev tools. Alternative approaches:
   - Create a Next.js API route that proxies the Eve session with the server-side token (token never reaches the browser)
   - Set a signed cookie from the server side
   - Add `none()` to the auth chain for public access
   
   **Recommendation:** For the MVP, `NEXT_PUBLIC_EVE_API_KEY` is fine since this is a private project. We can harden auth later.

2. **Existing evals** — `auth-invalid.eval.ts` uses `t.target.fetch("/eve/v1/info")` with a bad token. The `withEve()` proxy should pass this through to the Eve agent unchanged — no change needed.

3. **Next.js version** — `eve@0.44.0` works with Next.js 15+. Confirm version compatibility.

4. **Existing `.env.local`** — Already exists from Vercel link. Need to check it doesn't conflict.

---

## Edge Cases Identified

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| 1 | User sends empty message | Composer button disabled, no request sent |
| 2 | Network error during streaming | `status` becomes `"error"`, error shown |
| 3 | User sends message while streaming | Composer disabled, button greyed out |
| 4 | No NEXT_PUBLIC_EVE_API_KEY set | `auth` is `undefined`, agent falls back to same-origin cookies (may fail if no cookie auth) |
| 5 | Page refresh during active chat | Session is lost (no persistence in MVP), user starts fresh |

## Verification Checklist

- [ ] Task 1: Next.js + React installed
- [ ] Task 2: `next.config.ts` created with `withEve()`
- [ ] Task 3: App Router layout + globals.css
- [ ] Task 4: Chat page + client component with `useEveAgent`
- [ ] Task 5: `.env.example` updated
- [ ] Task 6: Frontend eval written and passes
- [ ] Task 7: `tsconfig.json` updated
- [ ] Task 8: Local verification — all evals pass, chat page loads
- [ ] Task 9: Deployed to Vercel — production evals pass
- [ ] Task 10: PR created linking to issue #6