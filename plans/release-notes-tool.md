# #23 — GitHub File-Write Tool for Release Manager

**Issue:** #23
**Branch:** `feat/release-notes-tool`

## Goal

Create a tool for the Release Manager subagent that can write `releasenotes.md` to the repo via the GitHub Contents API.

## Approach

Create a tool at `agent/subagents/release-manager/tools/write_release_notes.ts` that:

- Accepts markdown content, optional commit message, and optional PR number
- Uses GitHub Contents API (`PUT /repos/{owner}/{repo}/contents/releasenotes.md`) to create/update the file
- Uses `GH_RELEASE_TOKEN` environment variable for auth
- Falls back gracefully if token is not configured

## Files

| File                                                           | Action     | What it does                                                                    |
| -------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------- |
| `agent/subagents/release-manager/tools/write_release_notes.ts` | **Create** | The tool — Zod-schema input, GitHub API call                                    |
| `agent/subagents/release-manager/tools/read_current_notes.ts`  | **Create** | Companion tool — reads current `releasenotes.md` so the agent can prepend to it |
| `evals/release-notes-tool.eval.ts`                             | **Create** | Production eval to verify tools exist in the subagent                           |

## Implementation

### Tool 1: `write_release_notes`

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Write release notes content to releasenotes.md in the GitHub repository. " +
    "Creates the file if it doesn't exist, updates it if it does. " +
    "Requires GH_RELEASE_TOKEN environment variable. Pass content as pre-formatted markdown.",
  inputSchema: z.object({
    content: z.string().min(1, "Content is required"),
    commitMessage: z.string().optional().default("docs: update release notes"),
    prNumber: z.number().optional(),
  }),
  async execute({ content, commitMessage, prNumber }) {
    // ... implementation
  },
});
```

### Tool 2: `read_current_notes`

A companion tool so the Release Manager can first read existing `releasenotes.md`, then prepend new content.

```ts
export default defineTool({
  description:
    "Read the current content of releasenotes.md from the GitHub repository. " +
    "Returns the file content and SHA (needed for updates).",
  inputSchema: z.object({}),
  async execute() {
    // ... GET /repos/{owner}/{repo}/contents/releasenotes.md
  },
});
```

### GitHub API Details

Both tools use:

- **Endpoint:** `https://api.github.com/repos/{owner}/{repo}/contents/releasenotes.md`
- **Auth:** `Authorization: Bearer ${GH_RELEASE_TOKEN}`
- **Read (GET):** Returns `{ content: base64, sha: string }` or 404
- **Write (PUT):** Body `{ message, content: base64, sha? }` — SHA required for updates, omitted for creates

The owner/repo is derived from `process.env.VERCEL_GIT_REPO_OWNER` and `_REPO_SLUG`, or falls back to the webhook context.

## Test Plan

### Eve Eval — `evals/release-notes-tool.eval.ts`

A production eval that:

1. Hits `/eve/v1/info` and checks the release-manager subagent has the `write_release_notes` tool
2. Checks it also has `read_current_notes` tool

### TDD Workflow

```
Phase 2: Write eval tests → verify RED
Phase 3: User gate → wait for approval
Phase 4: Implement both tools
Phase 4.5: Verify typecheck + build + evals GREEN
```

## Verification

```bash
npm run typecheck
npm run build
npm run dev
npx eve eval --strict --url http://localhost:3000
# release-notes-tool eval should be GREEN
```
