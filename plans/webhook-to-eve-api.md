# #22 — Wire GitHub Webhook to Eve API

**Issue:** #22
**Branch:** `feat/webhook-to-eve-api`

## Goal

The webhook handler at `app/api/github/webhook/route.ts` currently logs PR events and acknowledges them. It needs to call the Eve agent API (`POST /eve/v1/session`) to trigger the Release Manager subagent to generate release notes.

## Approach

The webhook handler will use the same auth pattern as the browser proxy:
- `Authorization: Bearer ${EVE_API_KEY}` header
- `x-vercel-protection-bypass` header for preview environments
- Call to the same origin (production) or localhost (dev)

The handler constructs a structured task message for the Eve agent, which the root agent will delegate to the Release Manager subagent.

## Files

| File | Action | What it does |
|------|--------|-------------|
| `app/api/github/webhook/route.ts` | **Modify** | Replace the `console.log` placeholder with an Eve API call |
| `evals/webhook.eval.ts` | **Create** | Test that the webhook handler validates HMAC and calls the API |

## Implementation Details

### Webhook PR Event Flow

On `pull_request` events (opened, synchronize, closed/merged):
1. Validate HMAC signature (already done)
2. Parse PR data (already done)
3. Build a release-notes task message
4. Call `POST /eve/v1/session` with bearer auth + bypass header

### Message Format

```ts
const message = `Generate release notes for a PR change:

Repository: ${prData.repo}
PR #${prData.number} (${prData.action}): ${prData.title}
${prData.body ? `Description: ${prData.body.slice(0, 500)}` : ''}
Labels: ${prData.labels.join(', ') || 'none'}
Base branch: ${prData.baseBranch}
Head branch: ${prData.headBranch}

Update releasenotes.md with a new entry for this change.`;
```

### API Call

```ts
const targetUrl = `${request.nextUrl.origin}/eve/v1/session`;
const headers: Record<string, string> = {
  authorization: `Bearer ${process.env.EVE_API_KEY}`,
  'content-type': 'application/json',
};
const bypass = process.env.VERCEL_PROTECTION_BYPASS;
if (bypass) {
  headers['x-vercel-protection-bypass'] = bypass;
}

const apiResponse = await fetch(targetUrl, {
  method: 'POST',
  headers,
  body: JSON.stringify({ message }),
});
```

## Test Plan

### Eve Eval — `evals/webhook.eval.ts`

A production eval that:
1. Calls `GET /api/github/webhook` and asserts `405 Method Not Allowed` (POST-only)
2. Sends a simulated ping event and asserts `""pong""`
3. Tests that an unauthenticated POST (no signature) returns a validation error

Cannot fully test the real PR → Eve API flow in CI without a GitHub webhook secret and real EVE_API_KEY configured — that's a deployment verification, not a CI one.

### TDD Workflow

```
Phase 2: Write eval tests → verify RED
Phase 3: User gate → wait for approval
Phase 4: Implement webhook → Eve API call
Phase 4.5: Verify typecheck + build + evals
```

## Verification

```bash
npm run typecheck
npm run build                  # Should still compile clean
npm run dev
# Simulate a ping event locally:
curl -X POST http://localhost:3000/api/github/webhook \
  -H "x-github-event: ping" \
  -H "Content-Type: application/json" \
  -d '{}'
# Expected: {"ok":true,"message":"pong"}

# Simulate a PR event locally (no signature required in dev because GH_WEBHOOK_SECRET not set):
curl -X POST http://localhost:3000/api/github/webhook \
  -H "x-github-event: pull_request" \
  -H "Content-Type: application/json" \
  -d '{"action":"opened","pull_request":{"number":42,"title":"test","body":"","html_url":"https://github.com/test/repo/pull/42","labels":[],"base":{"ref":"main"},"head":{"ref":"feat/test"}},"repository":{"full_name":"test/repo"}}'
```