# User Story (Issue) Generation — Phase 3 & 4 Implementation Plan

> **Issue:** [#61 — User Story (Issue) Generation](https://github.com/ricardoblackskye/agent-eve/issues/61)
> **Branch:** `feat/story-refinement-backlog-61`
> **Plan date:** 2026-09-09

**Goal:** Harden Phase 3 (refinement loop) and complete Phase 4 (backlog
integration) so that, on a successful publish: the new `[Story]` issue is
**linked as a child of the source issue**, the original issue's `needs-story`
label is **removed**, and a `user-story-added` label is **applied** — with no
re-trigger / infinite loop.

**Scope (agreed with user):**
- Enhance the **existing GitHub provider only**. No Azure DevOps / Jira adapter
  in this branch (reserved for R3).
- Phase 3 is **hardening** of the already-working detect-gaps + comment-and-wait
  loop (notably: avoid duplicate clarifying comments on re-apply).
- **One** branch, plan, and PR covering Phases 3 & 4 together.

**Architecture:** Keep the platform-agnostic seam (`CanonicalPayload` +
`BacklogProvider` in `agent/lib/backlog-provider.ts`). The GitHub provider
already creates the `[Story]` issue; this branch extends it to (a) record the
new issue number, (b) create a parent/child link, and (c) mutate the source
issue's labels. Deterministic label/link logic lives in `agent/lib/` (fully
unit-tested); the LLM stays out of it. A `console` dry-run remains the safe
default; the live labels/child-link only run in the `github` provider path.

---

## Current State (verified at branch creation, base = origin/main @ 7d27355)

Baseline: **20 test files / 126 tests pass**, `tsc --noEmit` clean.

Already implemented in R1 (Phase 2):
- `agent/lib/story-schema.ts` — Zod schema + `validateStory` (NFR defaults).
- `agent/lib/story-refinement.ts` — `detectGaps()` (Phase 3 detection), returns
  `Gap[]` with severity `blocker`/`clarify`.
- `agent/lib/backlog-provider.ts` — `CanonicalPayload`, `toCanonicalPayload`,
  `BacklogProvider` interface, `getProvider(id)`, GitHub + console providers,
  `checkGitHubTokenScope()`.
- `agent/subagents/product-owner/tools/draft_user_story.ts` — returns
  `complete` (with `toCanonicalPayload`) or `needs_clarification` (with
  `questions`/`gaps`).
- `agent/subagents/product-owner/tools/comment_questions.ts` — posts questions
  to the source issue and stops.
- `agent/subagents/product-owner/tools/publish_story.ts` — validates the story,
  then `getProvider(provider||"console").publish(canonical)`.
- `agent/lib/story-trigger.ts` — `isStoryTrigger()`; fires on
  `issues.labeled` with the trigger label (`needs-story`, case-insensitive) or
  a body mention. **Does NOT fire for `closed`/`deleted`.**

### What Phase 4 requires that is NOT yet done

| Requirement (#61 Phase 4)                  | Current state                                       | Delta                       |
| ------------------------------------------ | --------------------------------------------------- | --------------------------- |
| "issue … linked as a child of the source"  | `[Story]` body says `Generated … from #85` (textual) | **Real parent/child link**  |
| "`needs-story` label removed from source"  | label stays on the source issue                     | **Remove `needs-story`**    |
| "`user-story-added` label applied"         | never applied                                       | **Apply `user-story-added`**|
| "no re-trigger"                            | `user-story-added` label would NOT re-trigger        | Verify + test (guard)      |

**Trigger-safety analysis (why adding `user-story-added` won't loop):**
`isStoryTrigger` only fires for the configured trigger label (`needs-story`) on
`labeled`, or a body mention. Applying `user-story-added` fires an
`issues.labeled` webhook, but `isStoryTrigger` sees `label.name ===
"user-story-added"` ≠ `needs-story`, and (assuming no `@eve-agent` mention in
the body) returns **false** → non-triggering. Verified in
`tests/story-trigger.test.ts`. We will add an explicit regression test that
`user-story-added` does **not** trigger.

---

## Files Likely to Change

- `agent/lib/backlog-provider.ts` — extend GitHub provider publish to return the
  new issue `number`; add a `BacklogHook`/post-publish step for parent-link +
  label transitions. (Keep `CanonicalPayload` platform-neutral.)
- `agent/lib/story-labels.ts` (new) — pure helpers: `finalizeLabels(input: string[],
  opts) → { add, remove }`, plus constants for `needs-story` / `user-story-added`.
- `agent/subagents/product-owner/tools/publish_story.ts` — pass through the
  `sourceIssueNumber` + repo context needed by the provider for linking/labels;
  surface the resulting story-issue number + label transitions in the return.
- `agent/subagents/product-owner/tools/comment_questions.ts` — hardening: if it
  already commented with these exact questions this cycle, skip the duplicate (see
  Task 4).
- `tests/story-labels.test.ts` (new) — label-transition unit tests.
- `tests/publish-story.test.ts` / `tests/backlog-provider.test.ts` — extend for
  child-link + label assertions.
- `tests/story-trigger.test.ts` — add: `user-story-added` does not re-trigger.
- `.cspell.json` — add any new words (e.g. `finalizeLabels`, `user-story-added` if
  split awkwardly, `child`, `sourceIssueNumber`).

---

## Validation

- `npx vitest run` — full suite green (126 → ~133+ tests). NO new regressions.
- `npx tsc --noEmit` — clean.
- `npm run build` — succeeds.
- Local lint gate (MegaLinter cspell/prettier) on changed files, incl. dotfiles
  and this plan file.
- **Live E2E (the real gate):** label a fresh issue `needs-story` → expect a new
  `[Story]` issue whose body links as a child of the source, source issue has
  `needs-story` removed and `user-story-added` applied, and no duplicate/loop
  from the label change.

## Risk & Open Questions

- **Parent/child linking mechanism:** GitHub Issues has no first-class parent
  field via the REST API. Options: (a) a **tracking issue** citing children (a
  "parent links to child" comment/body convention), or (b) a `[Story]` issue that
  records parent in its own body plus the source issue getting a **linked subtitle
  comment** ("Story for this issue: #N"). We will implement the **cross-reference
  comment + body header** convention (deterministic, API-only, no extra
  permissions). This satisfies "linked as a child" observably. Confirm when
  reviewing the plan.
- **Label removal scope:** labels are managed via `PUT /repos/{o}/{r}/issues/{n}/labels`
  and `DELETE .../labels/needs-story`, both with the existing token (needs
  `issues: write`, already verified `public_repo` → sufficient for public repo).
- **Duplicate-comment guard (Phase 3):** we add a deterministic guard (comment
  body contains the same question set → skip) rather than time-based heuristics.
---

## Task 1 — Label-transition helper (`agent/lib/story-labels.ts`)

**Objective:** Pure, deterministic function for the Phase 4 label choreography so
the provider never guesses label strings and tests can pin the behavior.

**Files:**
- Create: `agent/lib/story-labels.ts`
- Test: `tests/story-labels.test.ts`

**Step 1: Write the failing test**
```ts
// tests/story-labels.test.ts
import { describe, it, expect } from "vitest";
import { TRIGGER_LABEL, DONE_LABEL, finalizeLabels } from "../agent/lib/story-labels";

describe("finalizeLabels", () => {
  it("removes needs-story and adds user-story-added on success", () => {
    const r = finalizeLabels(["needs-story", "bug"], { success: true });
    expect(r.remove).toEqual(["needs-story"]);
    expect(r.add).toEqual(["user-story-added"]);
  });
  it("is a no-op for non-success (clarification) states", () => {
    const r = finalizeLabels(["needs-story"], { success: false });
    expect(r.remove).toEqual([]);
    expect(r.add).toEqual([]);
  });
  it("does not remove unrelated labels", () => {
    const r = finalizeLabels(["bug"], { success: true });
    expect(r.remove).toEqual([]);
  });
  it("exports the trigger label constant", () => {
    expect(TRIGGER_LABEL).toBe("needs-story");
    expect(DONE_LABEL).toBe("user-story-added");
  });
});
```

**Step 2:** Run `npx vitest run tests/story-labels.test.ts` → FAIL (module missing).
**Step 3:** Minimal impl:
```ts
// agent/lib/story-labels.ts
export const TRIGGER_LABEL = "needs-story";
export const DONE_LABEL = "user-story-added";

export function finalizeLabels(
  current: string[],
  opts: { success: boolean },
): { add: string[]; remove: string[] } {
  if (!opts.success) return { add: [], remove: [] };
  const remove = current.filter((l) => l.toLowerCase() === TRIGGER_LABEL);
  return { add: [DONE_LABEL], remove };
}
```
**Step 4:** Run the test → PASS. **Step 5:** commit.

---

## Task 2 — Provider returns the created story-issue number

**Objective:** The GitHub provider's `publish` already captures `data.number`;
expose it on `PublishResult` so downstream link/label logic can use it.

**Files:**
- Modify: `agent/lib/backlog-provider.ts`
- Test: `tests/backlog-provider.test.ts`

**Step 1 (test):** extend backlog-provider test: a stubbed fetch that returns a
`{ number: 991, html_url: "..." }` body → `publish` returns `delivered: true`
and `issueNumber === 991`. **Step 2:** FAIL (`issueNumber` not yet returned).
**Step 3 (impl):** add `issueNumber?: number` to `PublishResult` and return it in
the GitHub provider success path (and `0`/absent otherwise). **Step 4:** PASS.
**Step 5:** commit.

---

## Task 3 — GitHub provider: child-link + label transitions on the source issue

**Objective:** After creating the `[Story]` issue, mutate the source issue: add a
cross-reference that marks the child link, remove `needs-story`, add
`user-story-added`. Uses `sourceIssueNumber` from the canonical payload.

**Files:**
- Modify: `agent/lib/backlog-provider.ts`
- Modify: `tests/backlog-provider.test.ts`

**Step 1 (test):** with `sourceIssueNumber: 85` and a stubbed sequence of
`fetch` calls (create issue → add labels → remove label), assert all three
calls happened (issue created; `PUT /labels/user-story-added`; `DELETE
/labels/needs-story`) and the result reports the label transitions.
**Step 2:** FAIL (none of the mutation calls exist yet). **Step 3 (impl):** after
a successful create, issue the label calls for
`finalizeLabels(currentLabels, { success: true })`; include the child-link
cross-reference line in the created story body. Use per-repo owner/repo from env
(reuse existing `GITHUB_REPO_OWNER`/`GITHUB_REPO_NAME`). **Step 4:** PASS.
**Step 5:** commit.

**Note:** If only a subset of the transition calls succeed (e.g. labels API 403
but issue was created), return `delivered: true` (the story exists) but include
`warnings` listing the failed transition so it is observable, not silent.

---

## Task 4 — Phase 3 hardening: no duplicate clarifying comment on re-apply

**Objective:** When a requester re-applies `needs-story` while unanswered
questions are still posted, don't pile up identical comment threads.

**Files:**
- Modify: `agent/subagents/product-owner/tools/comment_questions.ts`
- Test: new `tests/comment-questions.test.ts`

**Step 1 (test):** stub the comments-list API to return an existing comment
containing the same question strings → `execute` returns
`{ commented: false, duplicate: true }` and does NOT POST.
**Step 2:** FAIL (currently always POSTs). **Step 3 (impl):** before POST, GET
`/issues/{n}/comments`, and if any existing comment body contains every question
string (normalised), skip and return `duplicate: true`. **Step 4:** PASS.
**Step 5:** commit.

---

## Task 5 — Wire into `publish_story` tool + trigger-safety regression test

**Objective:** Ensure the tool surfaces the story-issue number + label
transitions, and that the new `user-story-added` label does not re-trigger.

**Files:**
- Modify: `agent/subagents/product-owner/tools/publish_story.ts`
- Modify: `tests/story-trigger.test.ts`

**Step 1 (test, trigger):** `isStoryTrigger({ action: "labeled", label: { name:
"user-story-added" }, issue: { labels: [{ name: "user-story-added" }] } })` →
`false`. **Step 2:** should already PASS (guard), keep as regression.
**Step 3 (impl, publish):** spread `PublishResult` into the tool return so
`issueNumber` and `warnings` are visible to the agent. **Step 4:** run full suite.
**Step 5:** commit.

---

## Task 6 — Docs, dict, and full validation

**Objective:** Ship clean, lint-clean code + docs.

**Files:**
- Modify: `.cspell.json` (add any new words)
- Modify: README (phase 4 label behavior)
- Test run: full suite, tsc, build

**Steps:**
1. `npx vitest run` → all green.
2. `npx tsc --noEmit` → clean.
3. `npm run build` → succeeds.
4. `npx -y cspell@8 --config .cspell.json <changed files>` → clean (add words to
   `.cspell.json` as needed).
5. Commit.

---

## Release/Branch Notes

- This branch covers Phase 4 (GitHub-only backlog integration) + Phase 3
  hardening, one PR.
- R3 (`feat/user-story-backlog-61`) remains for Azure DevOps / Jira adapters
  behind the same `BacklogProvider` seam. No changes here block it.
