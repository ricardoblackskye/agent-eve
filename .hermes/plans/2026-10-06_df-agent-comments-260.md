# Plan — #260 Dark Factory agent questions/blockers surfaced to the Product Owner

**Issue:** https://github.com/ricardoblackskye/agent-eve/issues/260
**Epic:** #178 (Dark Factory Task Progress board) — child sub-issue
**Branch:** `feat/df-agent-comments-260` (no `#` in name)
**Approach:** AI SDLC TDD — plan → GATE 1 (this file) → approve → RED→GREEN → PR
**Date:** 2026-10-06

## Goal

When the Developer or Tester agent raises a question or blocker mid-run, the run is
marked `blocked`, a comment is posted on the source GitHub issue, and the run-detail
view (and the board) links the viewer straight to that comment — so a blocked run is
actionable, not silently stalled. Per the agreed decision, **the GitHub issue comment
is the system of record**; the run ledger stores only a *reference* to it (id + url),
never the free-text question.

## Root cause (verified by code reading, not assumed)

The comment-posting machinery already exists but is **not connected**:

1. **Dormant reporter.** `createWorkerReporter` (`agent/lib/dark-factory/worker-reporter.ts:524`)
   builds the `GitHubCommentReporter` (posts/edits issue comments, idempotent via
   `record.commentIds[<kind>]`, fail-closed behind `DF_REPORTER_PROVIDER=github` + a
   `StateStore`). It is *exported, documented, and unit-tested* — but has **no call
   site anywhere in the run pipeline** (grep for `createWorkerReporter(` in `agent/`,
   `app/`, `scripts/` returns nothing outside def/export/test/doc). So today no agent
   question is ever posted to GitHub. This is the "not wired up" gap.
2. **Discarded reference.** Even if wired, `RunHistoryWorkerReporter.report()`
   (`worker-reporter.ts:296`) appends the `worker.question` event *first*, then delegates
   to the inner reporter and **ignores its returned `commentId`**. And `RunEvent`
   (`run-history.ts:81`) has **no field** for a comment reference. So the ledger can
   never carry the link, and the UI cannot render it.
3. **No UI surface.** `toDetailView` (`app/dark-factory/ui/view-model.ts`) renders each
   timeline entry as `label` + `stage · status` only — no link. (The board's BLOCKED
   category already exists with hint "needs intervention", so the board half is mostly
   present; it just lacks the link-out.)

Net: the infrastructure is ~80% built from the earlier #162 work; #260 is the wiring +
reference-threading + UI link that makes it reachable from a real run.

## Intended fix

1. **Wire the reporter into the run pipeline.** Locate where the orchestrator currently
   records worker progress/completion and construct `createWorkerReporter(env, { store,
   runHistory })` there. Fail-closed by design: `ConsoleReporter` (writes nothing) unless
   `DF_REPORTER_PROVIDER=github` **and** a real `StateStore` is supplied.
2. **Thread the comment reference through the ledger.** Add `commentReference?: { provider:
   "github"; id: number; url: string }` to `RunEvent`; pass it through `toRunEvent`; have
   `RunHistoryWorkerReporter` capture the inner `GitHubCommentReporter` result and append the
   `worker.question` event **with** the reference. Reorder so the run is recorded `blocked`
   even when the GitHub post fails (honesty rule).
3. **Return the url.** `GitHubCommentReporter.report()` already returns `commentId`; add
   `commentUrl` built from `https://github.com/<owner>/<repo>/issues/<issue>#issuecomment-<id>`.
4. **Surface the link.** `toDetailView` + the detail timeline render a link for any
   `worker.question` event carrying `commentReference`; the board BLOCKED tile gains the
   "waiting on the Product Owner" link-out.

## ADRs to add (decided now, written with the implementation)

- **ADR (new): Comment reference, not content, in the ledger.** The GitHub issue comment is
  the system of record for agent questions/blockers (Option A). The run ledger stores only a
  reference (`provider`, `id`, `url`), preserving the deliberate content-free `RunEvent`
  contract ("no raw prompts or free-form issue content"). Rationale: keeps the ledger
  aggregative/portable and avoids storing free-form author text. Status: Accepted.
- Reference **ADR 0002** (`docs/adr/0002-r1-records-r2-refuses.md`) for the trusted-side /
  fail-closed posture already in force — do **not** duplicate it; just cite it.

## Tasks (TDD phases — one behaviour per cycle)

- **T1 — ledger field (RED→GREEN).** RED: a test asserting a `worker.question` event can
  carry `commentReference`; fails (field absent). GREEN: add the field to `RunEvent` +
  `toRunEvent` passthrough + validation.
- **T2 — propagate reference (RED→GREEN).** RED: `RunHistoryWorkerReporter` propagates the
  inner reporter's `commentId`/`commentUrl` into the appended `worker.question` event;
  fails. GREEN: capture inner result, append with reference, keep blocked-recorded-on-failure.
- **T3 — wire into pipeline (RED→GREEN).** RED: a test/integration that a `question` message
  on a configured run posts a comment AND records `blocked` with the reference. GREEN:
  construct `createWorkerReporter` at the orchestrator progress/completion site with a real
  `StateStore` + `runHistory`; fail-closed when unconfigured.
- **T4 — UI link (RED→GREEN).** RED: `toDetailView` renders a link for a `worker.question`
  event with `commentReference`; fails (no link). GREEN: render anchor; add board link-out.
- **T5 — fail-closed + idempotence (RED→GREEN).** RED: missing token / off-list repo → run
  still `blocked`, GitHub error surfaced (not swallowed); same question twice → one comment.
  GREEN: assert both. (Idempotence logic already exists in `GitHubCommentReporter`; assert it
  holds after wiring.)

## Files likely to change

- `agent/lib/dark-factory/run-history.ts` — `RunEvent.commentReference?`, `toRunEvent`, validation.
- `agent/lib/dark-factory/worker-reporter.ts` — `ReportResult.commentUrl?`; `GitHubCommentReporter`
  returns url; `RunHistoryWorkerReporter` captures + reorders.
- Orchestrator/run-pipeline wiring file (first locate the progress/completion site — likely
  `agent/lib/dispatch.ts` or the orchestrator entry) — construct `createWorkerReporter`.
- `app/dark-factory/ui/view-model.ts` — timeline link render.
- `app/dark-factory/ui/components.tsx` (or board page) — BLOCKED tile link-out.
- `tests/dark-factory/worker-reporter.test.ts` — extend for reference + wiring.
- `tests/dark-factory/run-history.test.ts` — event carries reference.
- `tests/dark-factory-ui/view-model.test.ts` (or similar) — link renders.
- `docs/adr/NNNN-agent-comment-reference.md` + `docs/adr/README.md` index entry.

## Validation

- `npx vitest run tests/dark-factory tests/dark-factory-ui` — all new + existing green.
- `npx tsc --noEmit --incremental false` — clean (the bare `npm run typecheck` can cache a
  false green; use `--incremental false`).
- Local lint gate (MANDATORY before push): `npx -y cspell@8 --config .cspell.json` + the repo's
  lint tests on every changed file, including this plan doc and any dotfiles. No findings outstanding.
- Node ≥ 24 only needed if an `eve`-build step is touched; unit tests run under the bundled Node.

## Risks / open questions

- **Exact wiring site** for `createWorkerReporter` is located during T3 (the orchestrator's
  progress/completion observer). If no suitable single site exists, the reporter may need to be
  constructed once at orchestrator boot and passed down — TDD will reveal which.
- **StateStore for idempotence** must be a durable store (sqlite/postgres), not in-memory, so
  `commentIds` survives restarts; reuse the existing run-history/`StateStore` instance.
- **Comment url format** and HTML-anchor (`#issuecomment-<id>`) — verify against the writer's
  `apiBase`/owner/repo/issue, not hardcoded.
- Out of scope (per issue): the **answer/resume path** (a PO reply unblocking the run) is a
  follow-up story; a general-purpose agent comment tool; inlining question text on the board
  (Option B/C, deferred).

## Env vars (deployment prerequisite — for the user, not the code)

`DF_REPORTER_PROVIDER=github` + a `StateStore` (sqlite/postgres) + `issues: write` token
(`GH_STORY_TOKEN`/`GH_RELEASE_TOKEN`/`GITHUB_TOKEN`) + `DF_WORKER_ALLOWED_REPOS` listing the
repos a worker may comment on. Without these, behaviour degrades to the current silent dry-run
(`ConsoleReporter`) — fail-closed, never a broken run.
