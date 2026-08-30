# Update README with webhook flow (issue #41)

> **For Hermes:** Use test-driven-development (RED → GREEN → verify).

**Goal:** Document the GitHub webhook → Release Manager subagent → `releasenotes.md`
automation flow in `README.md`, so an operator can configure it end-to-end
(payload URL, secret, events, required env vars, repo config).

**Context / why:** Issue #39 showed the webhook handler silently swallowed Eve API
failures, so release notes were never written on PR merge. The fix (PR #40) now
surfaces the failure. But the *trigger* itself — a GitHub webhook delivering
`pull_request` events to `/api/github/webhook` — was never documented, so it's
easy to deploy without wiring it up. This plan adds the missing docs.

**Architecture (the flow being documented):**
```
GitHub PR event (opened/synchronize/reopened/closed)
   → GitHub Webhook (Settings → Webhooks)
   → POST https://<deploy>/api/github/webhook
   → app/api/github/webhook/route.ts (verifies GH_WEBHOOK_SECRET, calls Eve API)
   → POST /eve/v1/session  (triggers Release Manager subagent)
   → read_current_notes / write_release_notes tools
   → PUT repos/{owner}/{repo}/contents/releasenotes.md  (via GH_RELEASE_TOKEN)
```

**Tech stack:** Markdown docs + a vitest contract test that asserts the README
actually contains the required webhook documentation (so the docs can't silently
rot).

---

## Tasks (TDD)

### Task 1: Write failing contract test (RED)

**Objective:** Prove the README does not yet document the webhook flow.

**Files:**
- Create: `tests/readme-webhook.test.ts`
- Test target: `README.md`

**Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf-8");

describe("README documents the GitHub webhook release-notes flow (issue #41)", () => {
  it("documents the webhook payload URL", () => {
    expect(readme).toContain("/api/github/webhook");
  });
  it("documents the GH_WEBHOOK_SECRET env var", () => {
    expect(readme).toContain("GH_WEBHOOK_SECRET");
  });
  it("documents the GH_RELEASE_TOKEN env var (writes releasenotes.md)", () => {
    expect(readme).toContain("GH_RELEASE_TOKEN");
  });
  it("documents subscribing to Pull request events", () => {
    expect(readme.toLowerCase()).toContain("pull request");
  });
  it("links the webhook to release-manager.config.json", () => {
    expect(readme).toContain("release-manager.config.json");
  });
});
```

**Step 2: Run test to verify failure**

Run: `node_modules/.bin/vitest run tests/readme-webhook.test.ts`
Expected: FAIL — README is missing `/api/github/webhook`, `GH_WEBHOOK_SECRET`,
`GH_RELEASE_TOKEN`, etc.

**Step 3: Commit the RED test**

```bash
git add tests/readme-webhook.test.ts
git commit -m "test(docs): assert README documents webhook release-notes flow"
```

### Task 2: Add the webhook documentation (GREEN)

**Objective:** Make the README describe the flow so the contract test passes.

**Files:**
- Modify: `README.md` (add a "Release Notes Automation" section, e.g. after
  "Deployment")

**Step 1: Write minimal doc content**

Add a section covering:

```md
## Release Notes Automation

When a pull request is opened, synchronized, reopened, or merged, a GitHub
webhook delivers a `pull_request` event to the agent, which triggers the
Release Manager subagent to update `releasenotes.md`.

### How it works

1. GitHub sends a `pull_request` webhook event to `/api/github/webhook`.
2. `app/api/github/webhook/route.ts` verifies the `GH_WEBHOOK_SECRET` signature
   and calls the Eve API (`POST /eve/v1/session`).
3. The Release Manager subagent reads the current `releasenotes.md` (via the
   `read_current_notes` tool) and writes the updated file (via the
   `write_release_notes` tool) using `GH_RELEASE_TOKEN`.
4. The target repo must be listed in `release-manager.config.json`.

### Configure the GitHub webhook

In the repo (**Settings → Webhooks → Add webhook**):

| Field          | Value                                                |
| -------------- | ---------------------------------------------------- |
| Payload URL    | `https://<your-deployment>/api/github/webhook`       |
| Content type   | `application/json`                                   |
| Secret         | same value as the `GH_WEBHOOK_SECRET` env var        |
| Events         | "Let me select individual events" → **Pull requests** |

Replace `<your-deployment>` with your app URL (e.g.
`https://agent-eve-gold.vercel.app`).

### Required environment variables (deployment)

| Variable             | Required | Description                                             |
| -------------------- | -------- | ------------------------------------------------------- |
| `GH_WEBHOOK_SECRET`  | Yes      | Shared secret for webhook signature verification        |
| `GH_RELEASE_TOKEN`   | Yes      | GitHub PAT used by the Release Manager to write notes   |
| `EVE_API_KEY`        | Yes      | Bearer token for the Eve API session call               |
```

**Step 2: Run test to verify pass**

Run: `node_modules/.bin/vitest run tests/readme-webhook.test.ts`
Expected: PASS (5/5)

**Step 3: Run full suite + typecheck for regressions**

```bash
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit
```

**Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document GitHub webhook release-notes automation flow (#41)"
```

### Task 3: Push for review

```bash
git push -u origin HEAD
```

Open PR referencing `Closes #41`.

---

## Files likely to change
- `README.md` (add "Release Notes Automation" section)
- `tests/readme-webhook.test.ts` (new contract test)

## Validation
- `node_modules/.bin/vitest run tests/readme-webhook.test.ts` → 5 passed
- `node_modules/.bin/vitest run` → no regressions
- `node_modules/.bin/tsc --noEmit` → clean

## Risks / open questions
- The deployment URL in the docs uses `agent-eve-gold.vercel.app` (from the
  repo's "About" section). Confirm that is the intended public deployment.
- `GH_WEBHOOK_SECRET` must match between the GitHub webhook config and the
  Vercel env var, or deliveries fail signature verification (handler returns 401).
- Unrelated known issue: the chat UI currently 401s with "Unauthorized: invalid
  or missing API key" in preview/prod because `app/api/eve/v1/[...slug]/route.ts`
  requires the browser to present `Authorization: Bearer <EVE_API_KEY>`, which
  the chat client never sends. That is a separate bug (not covered by this plan).
