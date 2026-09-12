# Plan: Story created in wrong repo — publish ignores source owner/repo (Issue #119)

## Goal
When an issue is labeled `needs-story` in any repo, the generated `[Story]` issue
must be created in **that issue's own repo/backlog**, not always in
`ricardoblackskye/agent-eve`. Currently `GitHubProvider.publish()` hardcodes the
target owner/repo, so stories leak into the "Eve backlog".

## Root cause (confirmed)
- `route.ts` (webhook) correctly computes the source `owner`/`repo` and sends
  them in the Product Owner message.
- `publish_story` tool has **no** `owner`/`repo` inputs and does not forward them.
- `backlog-provider.ts` `GitHubProvider.publish()` hardcodes:
  ```ts
  const owner = process.env.GITHUB_REPO_OWNER || "ricardoblackskye";
  const repo  = process.env.GITHUB_REPO_NAME  || "agent-eve";
  ```
  All story issues are created in `agent-eve`. Finalization/linking also targets
  the hardcoded owner/repo, so child-link comments & sub-issue links land on the
  wrong repo too.

## Fix (seam-respecting — canonical payload carries no provider state, only ids)
1. **`agent/lib/backlog-provider.ts`**
   - `CanonicalPayload` gains optional `owner?: string; repo?: string;`
   - `GitHubProvider.publish()` derives:
     `const owner = payload.owner ?? process.env.GITHUB_REPO_OWNER ?? "ricardoblackskye";`
     `const repo  = payload.repo  ?? process.env.GITHUB_REPO_NAME  ?? "agent-eve";`
     Applied to: issue create URL, dedup `hasChildSubIssue`/`hasComment` reads,
     `finalizeSourceIssue`, `linkParent`. (Defaults preserve `agent-eve` behavior
     when unset — no regression for existing callers.)
2. **`agent/subagents/product-owner/tools/publish_story.ts`**
   - Add optional `owner`/`repo` inputs; forward into the canonical payload.
3. **`app/api/github/webhook/route.ts`** (story branch ~line 434-440)
   - Instruct the subagent to call `publish_story` with `owner`/`repo` extracted
     from the webhook message's `Repository (verified identifier): owner/repo`.

## TDD steps (RED → GREEN)
1. **RED** — add failing tests:
   - `tests/backlog-provider.test.ts`: `GitHubProvider` creates issue at
     `repos/{payload.owner}/{payload.repo}/issues` when payload carries them;
     falls back to env/`agent-eve` when absent.
   - `tests/publish-story.test.ts`: `publish_story` forwards `owner`/`repo` into
     the provider payload.
   - `tests/story-webhook.test.ts` (or extend existing): message includes the
     source `owner/repo` and instructs `publish_story` with them.
2. **GREEN** — implement the 3 edits above.
3. **Verify**: `npm test` green; existing `publish-story`/`backlog` suite unchanged.

## Acceptance
- Labeling `needs-story` on `ricardoblackskye/WebFeedPOC` (board
  `users/ricardoblackskye/projects/1`) creates the `[Story]` issue **in
  WebFeedPOC**, not `agent-eve`.
- `npm test` passes (unit). E2E/CI via PR #120 checks.

## Branch / naming
- Branch: `fix/story-publish-source-repo` (no `#`, per repo convention).
- Plan filename: `2026-09-11_story-publish-source-repo-119.md`.
- PR will be #120 (issue #119).
