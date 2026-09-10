# Plan: Complete #61 — Option B dedup + parent-link the new story issue

- **Date:** 2026-09-10
- **Branch:** `feat/story-parent-link-61`
- **Issue:** #61 (final tasks — associated with #61, not a new number)

## Goal

Two final hardening tasks for the user-story pipeline (#61):

1. **Option B — dedup at publish time.** Before creating a new `[Story]` issue,
   check whether one has *already* been created for this source issue and skip if
   so. This closes the gap left by Option A (which keys off the `user-story-added`
   label): a partial-failure run can leave a child issue with no completion label,
   so re-triggering would otherwise mint a duplicate.

2. **Parent-link the new story issue to its source issue.** (a) Add a clickable
   cross-reference link in the child body, and (b) set the source issue as the
   child's formal parent via GitHub sub-issues, so the relationship is visible
   from both issues.

## Context / current state

`agent/lib/backlog-provider.ts` (`GitHubProvider.publish`) already:
- builds a child body starting with the *text* `#<sourceIssueNumber>` (in a
  blockquote — not a reliable link),
- `POST /repos/{owner}/{repo}/issues` to create the child, returning
  `{ html_url, number }`,
- calls `finalizeSourceIssue`, which posts a `📄 User story generated for this
  issue: <url>` comment on the **source** issue (idempotent via `hasComment`) and
  transitions the labels.

Option A (`fix/story-dedup-guard`, merged as PR #95) already prevents re-trigger
when the source issue carries `user-story-added`. Option B below is the stronger
guard at the single point where the child is actually created.

## Design

### Task 1 — Option B: skip when a child already exists

In `GitHubProvider.publish`, before `POST /issues`, when `sourceIssueNumber` is
set, check the source issue's comments for an existing child-link marker. If
found, return `{ delivered: false, duplicate: true, ... }` and do **not** create.

- The marker is the fixed prefix of the child-link comment:
  `📄 User story generated for this issue:` (extracted to a shared constant, see
  Task 2). Reuse the existing `hasComment` helper against this fixed prefix.
- Reuses the comment-check pattern already proven in `finalizeSourceIssue`; the
  child-link comment is posted exactly once after a successful create, so it is a
  reliable "already linked" signal for sequential re-triggers.
- Not a hard lock (GitHub offers no atomic compare-and-set for issues), so a true
  concurrent double-fire is still theoretically possible — but accidental /
  sequential duplicates are eliminated, which is the stated goal.

### Task 2 — parent-link the child to the source issue

**(a) Cross-reference link (body).** Change the child body's opening line from the
bare `#<sourceIssueNumber>` to a markdown link to the source issue:
`[#<n>](https://github.com/<owner>/<repo>/issues/<n>)`. Owner/repo are already
known; no extra call. GitHub renders this as a link and cross-references it, so
the source issue's timeline shows the child.

**(b) Formal parent (sub-issues, GraphQL).** After the child is created, set the
source issue as the child's parent via GitHub's sub-issues GraphQL API:
- Get the source issue's `node_id` (`GET /repos/{o}/{r}/issues/{sourceNumber}` →
  `node_id`) and the child's `node_id` (already in the `POST /issues` response).
- `POST https://api.github.com/graphql` with the `addSubIssue` mutation
  (`issueId` = source, `subIssueId` = child). This makes the child appear under
  the source issue's "Sub-issues" / "Linked issues" section.
- Best-effort: on failure, surface a `warning` (like the existing finalization
  steps) rather than failing the publish — the child issue still exists and the
  cross-reference link from (a) still holds.

## Tasks (TDD, vertical slices)

1. **RED→GREEN** — Option B: a publish for a source issue that already has a
   `📄 User story generated …` comment returns `duplicate: true` and performs **no**
   `POST /issues`.
2. **RED→GREEN** — cross-reference: the created child body opens with a markdown
   link `[#<n>](https://github.com/<owner>/<repo>/issues/<n>)` (not the bare
   `#<n>` text). Extract the child-link comment prefix into a shared constant used
   by both `finalizeSourceIssue` and the Option B check.
3. **RED→GREEN** — parent: after a successful create, a GraphQL `addSubIssue` call
   is made with the source `node_id` as `issueId` and the child `node_id` as
   `subIssueId`; a GraphQL failure yields a `warning`, not a throw.
4. **Verify** — full suite, `tsc --noEmit`, cspell on changed files.

## Files likely to change

- `agent/lib/backlog-provider.ts` — Option B check, cross-ref link, GraphQL
  parent-link, shared comment-marker constant.
- `tests/backlog-provider.test.ts` — new cases for each behavior (mock `fetch`
  for the comment check and the GraphQL call).

## Validation

- `npx vitest run` full suite green (baseline 140, +~3 new).
- `npx tsc --noEmit` clean; cspell clean on changed files.
- Live (manual, post-merge): create a story for a fresh `needs-story` issue and
  confirm (a) the child body links back to the source, (b) the child appears as a
  sub-issue of the source, (c) re-triggering the same source produces no second
  child.

## Risks / open questions

- **GraphQL sub-issue schema is the main unknown.** The exact mutation/field names
  (`addSubIssue` / `AddSubIssueInput` `issueId`+`subIssueId`) will be confirmed
  against the GitHub GraphQL schema during implementation; the unit test asserts
  the request *shape* (URL + JSON body), and the live smoke test confirms real
  behavior.
- **Token scope:** sub-issues need issue-write (`public_repo`/`repo`), already
  exercised by issue creation; no new scope expected.
- **Sub-issues availability:** relies on GitHub's GA sub-issues GraphQL surface;
  if unavailable in this repo, (b) degrades to a `warning` while (a) still links.
- **Race window:** Option B is check-then-act; concurrent double-fires are not
  fully excluded (no atomic CAS on issues). Accepted as out of scope.
