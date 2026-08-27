# Release Manager — Implementation Plan

**Issue:** #19
**Branch:** `feat/release-manager`

## Goal

Create a "Release Manager" subagent that auto-generates release notes on PR events, and add an `ARCHITECTURE.md` browsable at `/architecture`.

## Architecture

The system adds three capabilities to agent-eve:

1. **Release Manager subagent** (`agent/subagents/release-manager/`) — an Eve declared subagent with its own instructions and tools for generating `releasenotes.md` from PR data
2. **GitHub webhook handler** (`app/api/github/webhook/route.ts`) — receives PR events and triggers the release-notes workflow via the root agent
3. **Architecture route** (`app/architecture/page.tsx`) — renders `ARCHITECTURE.md` with Mermaid.js diagrams on the web

### Data Flow (PR → Release Notes)

```
GitHub PR event → /api/github/webhook → Root agent delegates to Release Manager
→ Release Manager fetches PR/issues from GitHub API
→ Generates/formats releasenotes.md
→ Commits/pushes updated releasenotes.md
```

### Architecture Page Flow

```
Browser → GET /architecture → Next.js SSR renders ARCHITECTURE.md with Mermaid
→ Client-side Mermaid renders diagrams
```

---

## Step-by-Step Plan

### Phase 1: Infrastructure & Tests

#### Task 1.1: Install dependencies

- `npm install mermaid react-markdown remark-gfm`
- `npm install --save-dev @types/react-markdown`

#### Task 1.2: Create test fixture helpers

- Create `e2e/architecture.spec.ts` — test the `/architecture` page
- Create an Eve eval for the Release Manager tool existence

#### Task 1.3: Update `.gitignore`

- Add `releasenotes.md` to `.gitignore` (auto-generated, shouldn't be committed directly)

---

### Phase 2: ARCHITECTURE.md + /architecture Route

#### Task 2.1: Create ARCHITECTURE.md

- `ARCHITECTURE.md` at repo root with Mermaid.js diagrams covering:
  - System overview (Vercel → Next.js → Eve Agent → OpenRouter)
  - Request flow (browser → proxy → Eve agent → model)
  - Channel auth flow (Vercel OIDC → bearer → localDev)
  - Deployment diagram (Preview vs Production, protection bypass)

#### Task 2.2: Create `/architecture` page

- `app/architecture/page.tsx` — reads and renders `ARCHITECTURE.md`
- Uses `react-markdown` with `remark-gfm` for GitHub-flavored markdown
- Uses `next/dynamic` with SSR disabled for the Mermaid component
- Matches the dark theme of the existing chat

#### Task 2.3: Add `releasenotes.md` route (future)

- Stub `app/releasenotes/page.tsx` that renders the generated release notes

#### Task 2.4: Write E2E test for architecture page

- Visit `/architecture`, check it loads and renders content
- Check for Mermaid diagram rendering in DOM

---

### Phase 3: Release Manager Subagent

#### Task 3.1: Create subagent structure

```
agent/subagents/release-manager/
├── agent.ts          — defineAgent with description + model
├── instructions.md   — prompt for the Release Manager role
└── tools/            (future — GitHub API tools when needed)
```

#### Task 3.2: Create GitHub webhook route

- `app/api/github/webhook/route.ts` — POST handler for GitHub webhook events
- Validates `x-hub-signature-256` (HMAC-SHA256 with a secret)
- On `pull_request` events (opened, synchronize, closed):
  - Calls the root Eve agent with a task to generate release notes
  - Passes PR number, title, body, labels, commits etc.
- On `push` events to main:
  - Generates cumulated release notes

#### Task 3.3: Create release notes generation tool

- `agent/tools/generate-release-notes.ts` — tool that:
  - Accepts PR data (number, title, body, labels, commits, changed files)
  - Categorizes changes: features, bug fixes, CI, docs, chores
  - Extracts business value from PR body
  - Formats into `releasenotes.md`
  - Writes the file

#### Task 3.4: Create release notes commit tool

- A tool or instruction to commit and push `releasenotes.md` back to the repo
- Uses GitHub API (not git on the server) for simplicity

---

### Phase 4: Extensibility for Other Repos

#### Task 4.1: Repo configuration

- `release-manager.config.json` — config file mapping repos to their config:
  ```json
  {
    "repos": {
      "ricardoblackskye/agent-eve": {
        "webhook_secret_env": "GH_WEBHOOK_SECRET_AGENT_EVE",
        "token_env": "GH_TOKEN_AGENT_EVE",
        "release_notes_path": "releasenotes.md"
      }
    }
  }
  ```

#### Task 4.2: Multi-repo support in webhook

- The webhook handler reads `x-github-event` and `x-hub-signature-256` headers
- Looks up repo in config, validates with correct secret
- Calls the appropriate Eve agent with repo-specific context

---

## Files to Change

| File                                              | Action                             | Phase |
| ------------------------------------------------- | ---------------------------------- | ----- |
| `ARCHITECTURE.md`                                 | **Create**                         | 2     |
| `app/architecture/page.tsx`                       | **Create**                         | 2     |
| `app/architecture/arch.css`                       | **Create**                         | 2     |
| `agent/subagents/release-manager/agent.ts`        | **Create**                         | 3     |
| `agent/subagents/release-manager/instructions.md` | **Create**                         | 3     |
| `agent/tools/generate-release-notes.ts`           | **Create**                         | 3     |
| `app/api/github/webhook/route.ts`                 | **Create**                         | 3     |
| `release-manager.config.json`                     | **Create**                         | 4     |
| `package.json`                                    | **Modify** (add deps)              | 1     |
| `.gitignore`                                      | **Modify** (add `releasenotes.md`) | 1     |
| `e2e/architecture.spec.ts`                        | **Create**                         | 2     |
| `evals/release-manager.eval.ts`                   | **Create**                         | 3     |

---

## Test Plan

### E2E Tests (Playwright)

| Test                                    | File                       | What it validates                                |
| --------------------------------------- | -------------------------- | ------------------------------------------------ |
| `architecture page loads`               | `e2e/architecture.spec.ts` | `/architecture` returns 200 and renders headings |
| `architecture contains Mermaid diagram` | `e2e/architecture.spec.ts` | Page contains `.mermaid` or SVG elements         |

### Evals (Eve framework)

| Eval                              | File                            | What it validates                                |
| --------------------------------- | ------------------------------- | ------------------------------------------------ |
| `Release Manager subagent exists` | `evals/release-manager.eval.ts` | `/eve/v1/info` includes release-manager subagent |

### RED Verification

- Playwright tests for `/architecture` will fail until the route exists
- The Release Manager eval will fail until the subagent directory is created

---

## Verification

```bash
# Phase 2
npm run dev
curl http://localhost:3000/architecture    # Should render ARCHITECTURE.md

# Phase 3
npm run dev
curl http://localhost:3000/eve/v1/info     # Should show release-manager subagent

# Full
npm run typecheck
npm run build
npx eve eval --strict --url http://localhost:3000
```

---

## Risks & Open Questions

1. **GitHub webhook in preview vs production** — webhooks only reach production deployments. For preview testing, we can trigger manually or skip webhook validation.
2. **Release notes committing** — the agent needs a GitHub token with push access. Should use an existing `GITHUB_TOKEN` or a dedicated `GH_RELEASE_TOKEN`.
3. **Agent calling itself from webhook** — the webhook handler will need to call the Eve agent API (POST `/eve/v1/session`) with a bearer token, same as the browser proxy does. This is already set up.
4. **Mermaid rendering** — `remark-mermaid` may need additional setup. Fallback: render markdown with raw Mermaid code blocks that the browser renders via the Mermaid JS library.
