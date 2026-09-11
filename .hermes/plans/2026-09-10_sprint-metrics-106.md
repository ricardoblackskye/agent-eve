# Sprint Metrics Analysis — Implementation Plan (#106)

> **For Hermes:** use subagent-driven-development to implement this plan task-by-task; each task is RED → GREEN → REFACTOR with a commit.

**Goal:** Add a "sprint metrics" capability so that, when an issue is labeled `generate-sprint-report`, Agent Eve reads the repo's GitHub Kanban board (Projects V2), computes delivery metrics (cycle time, throughput, WIP), and delivers a senior-management-ready report to that issue.

**Architecture:** Mirror the existing story-generation flow — a webhook label trigger → a new `sprint-reporter` subagent → tools backed by `agent/lib/` modules. The Projects data fetch and metric computation are pure, unit-tested logic behind a provider seam; the *report rendering* (markdown first, PDF second) is a separate, swappable concern.

**Tech stack:** Next.js + Eve (`defineAgent` / `defineTool`), GitHub GraphQL (Projects V2) via `fetch`, Vitest for TDD, `pdf-lib` (lightweight, pure-JS — added in R2).

---

## Context (existing pattern to imitate)

- **Subagent** = `agent/subagents/<name>/agent.ts` (`defineAgent`) + `tools/*.ts` (`defineTool` + zod input + `execute`). e.g. `product-owner/tools/publish_story.ts`.
- **Trigger** = `.github/workflows/...` webhook route `app/api/github/webhook/route.ts`; the `issues` branch runs `isStoryTrigger` (from `agent/lib/story-trigger.ts`) and delegates to a subagent via the Eve session.
- **No existing PDF / Projects / GraphQL code** (only the sub-issue GraphQL query added in #61's `backlog-provider.ts`).

## Release split

This is a large feature with two *new* external integrations (Projects GraphQL + PDF) and an API-level delivery constraint. I recommend splitting:

| Release | Scope                                                                                                                 | Why deferred                                                                      |
|---------|-----------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------|
| **R1**  | Label trigger + Projects V2 fetch + metrics (cycle time / throughput / WIP) + **markdown** report posted to the issue | Proves the data pipeline + token scope before investing in PDF; no new heavy deps |
| **R2**  | **PDF** rendering (`pdf-lib`) + hosting/linking the PDF, kept alongside the markdown summary                          | `pdf-lib` dep + a delivery/hosting decision                                       |

R1 fully validates the riskiest parts (Projects access, `read:project` scope, metric correctness). R2 is rendering + delivery on top of already-correct numbers.

---

## R1 — data pipeline + markdown report

### Task 1 — trigger detection (RED→GREEN)

- **New constant + detector** in `agent/lib/sprint-trigger.ts`: `SPRINT_REPORT_LABEL = "generate-sprint-report"`; `isSprintReportTrigger(payload)` returns true on `labeled` with that label (case-insensitive), false otherwise (mirror `story-trigger.ts`). No re-trigger guard needed for R1 (see Risks).
- **Wire into the webhook** `issues` branch: if not a story trigger but `isSprintReportTrigger`, delegate to `sprint-reporter` (similar message-building to the existing product-owner delegation, with the same prompt-injection sanitization).
- **Tests:** `tests/sprint-trigger.test.ts` (label / unrelated-label / case-insensitive / pull_request), `tests/...` webhook route test asserting the delegate message targets `sprint-reporter`.

### Task 2 — Projects V2 client (RED→GREEN)

- **New** `agent/lib/sprint-projects.ts`: `fetchBoard(token, boardUrlOrProjectNumber)` → GraphQL `organization/repository projectsV2` lookup, then list `ProjectV2` status-field options + `items` (with their status + closed/created timestamps).
- **Token:** read `GH_SPRINT_TOKEN ?? GH_RELEASE_TOKEN` (same pattern as `backlog-provider.ts`). Requires **`read:project` scope** — see Risks (this is a *new* credential requirement).
- **Tests:** mock `fetch` for the GraphQL POST; assert the query + node-list shape, and that a non-`read:project` 403 surfaces a clear error (mirror `checkGitHubTokenScope` pattern).

### Task 3 — metrics computation (RED→GREEN)

- **New** `agent/lib/sprint-metrics.ts`: pure functions over the board snapshot —
  - **cycle time** = (moved-to-Done time) − (moved-to-In-Progress time) per completed item (avg/median + list),
  - **throughput** = count of items completed in the window (and per-day),
  - **WIP** = count currently "In Progress".
- **Tests:** deterministic fixtures (no network), assert exact avg/median/counts.

### Task 4 — markdown report + issue delivery (RED→GREEN)

- **New** `agent/lib/sprint-report.ts`: `renderMarkdown(metrics)` → a management-ready markdown block (summary numbers + a table).
- **New** `agent/subagents/sprint-reporter/agent.ts` + `tools/generate_sprint_report.ts`: the tool fetches the board, computes metrics, renders markdown, and posts it as a comment on the triggering issue (idempotent: skip if a matching report comment already exists — reuse the `hasComment`/CHILD_LINK pattern from `backlog-provider.ts`).
- **Tests:** tool returns the rendered markdown; a mocked `fetch` captures the comment POST.

### Task 5 — docs + full validation

- README subsection ("Sprint Metrics Report" — the label, trigger, and required `read:project` token).
- `npm test` full suite green; `tsc --noEmit`; cspell/prettier clean.

## R2 — PDF rendering + delivery (sketch; plan in full detail later)

1. Add `pdf-lib` (pure JS, no browser — avoids the Playwright/chromium weight in a serverless function).
2. `agent/lib/sprint-report.ts` gains `renderPdf(metrics)` → `Uint8Array`.
3. **Delivery**: GitHub issue comments cannot carry binary attachments via API. Upload the PDF to the repo (`PUT /repos/{o}/{r}/contents/reports/sprint-<date>.pdf`) or Vercel Blob, then post a comment that links it alongside the markdown summary. (Exact host = a decision below.)

## Files likely to change

- `agent/lib/sprint-trigger.ts`, `agent/lib/sprint-projects.ts`, `agent/lib/sprint-metrics.ts`, `agent/lib/sprint-report.ts` (new)
- `agent/subagents/sprint-reporter/agent.ts`, `agent/subagents/sprint-reporter/tools/generate_sprint_report.ts` (new)
- `app/api/github/webhook/route.ts` (extend `issues` branch)
- `tests/sprint-*` (new), `README.md`
- `package.json` (R2: `pdf-lib`)

## Validation

- `npm test` → full suite green (all new modules covered).
- `tsc --noEmit`, cspell, prettier clean.
- Live (post-merge, needs the token): label an issue → a markdown (R1) / linkable PDF (R2) report appears, with cycle time / throughput / WIP presentable.

## Risks / decisions needed (please weigh in)

1. **PDF delivery — GitHub cannot attach a binary to an issue via API.** The issue says "attach as a pdf", but the realistic mechanism is *generate the PDF, host it (repo contents / Vercel Blob / a release asset), and link it from a comment* (with a markdown summary inline). **Decision: which host?** (repo `contents` is simplest and keeps everything in-repo.)
2. **New token scope.** Projects V2 GraphQL needs **`read:project`** (or `project`), which the current `GH_RELEASE_TOKEN`/`GH_STORY_TOKEN` likely lacks. **Decision: provision a token with `read:project` and expose it as `GH_SPRINT_TOKEN`.** This is a hard prerequisite for live testing.
3. **Which board.** "Default GitHub Kanban board" → resolve the repo's linked Projects V2 (or the org's board). **Decision: auto-detect the repo's default board, or allow the issue body/env to name the project number.**
4. **Cycle-time source.** Precise moved-to-In-Progress → moved-to-Done timing needs Projects item field-change history/timeline; if GitHub's timeline API is limited, we fall back to `updatedAt`-based approximation (documented). **Accept a documented approximation if history isn't cleanly available?**
5. **Release split** — confirm R1 (markdown) → R2 (PDF) split is OK, vs. doing it all in one branch.