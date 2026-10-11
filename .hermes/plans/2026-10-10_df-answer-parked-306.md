# Plan — #306: answer a parked question and resume the run

**Branch:** `feat/df-answer-parked-306` (off `origin/main` @ `82d5f82`)
**Issue:** [#306](https://github.com/ricardoblackskye/agent-eve/issues/306) — split A of #273
**Epic:** #267 (Dark Factory — Pre-UAT Readiness)
**Date:** 2026-10-10

## Goal

A human replying to a parked run's question comment resumes the run. This is the
behaviour the question comment **already promises** on the ticket ("Reply here and
the run resumes; it will not consume further iterations while it waits") and is
currently unimplemented.

## Verified today — do NOT rebuild

- `decideDarkFactoryTrigger` **already** returns `kind: "resume"` (`trigger.ts:85`,
  `247-253`) — but only for one input: "the question label (`needs-answer`) was
  cleared on repo#issue".
- `runDarkFactoryDispatch` **already** implements the resume branch
  (`entry.ts:566`), commented *"resume: only ever after a human answered (never
  implied by a re-delivery)"*. It claims a `resume` control delivery
  (`RunControlTransition = "abort" | "resume"`), requires the active run to be
  `blocked`, writes `run.resumed` (blocked to running), re-handoffs, and HELDs the
  three degenerate cases: already-completed delivery, no blocked run, and already
  terminal.
- Parking records a `worker.question` event carrying a `commentReference`
  `{ provider: "github", id, url }` — the reference to the question comment, never
  its text (`worker-reporter.ts:355-412`).
- The authorisation gates exist and fail closed: `DF_WORKER_ALLOWED_REPOS` and
  `DF_TRIGGER_ALLOWED_USERS` (the sender), both checked before anything happens
  (`trigger.ts:196-221`).

## Verified gap

`issue_comment` appears **nowhere** in the repository, and the webhook routes only
`issues` and `pull_request` (`route.ts:385`). So a reply is ignored entirely and
the promise printed in the question comment is unimplemented. The ONLY resume path
today is a separate, undocumented action: clearing the `needs-answer` label.

## Intended fix — reuse everything, add the inbound adapter

1. **`trigger.ts`** — accept an `issue_comment` payload shape and decide `resume`
   for a `created` comment from an authorised sender on a dark-factory issue. A
   comment must NEVER decide `trigger` (a comment must not start new work).
2. **`app/api/github/webhook/route.ts`** — add an `issue_comment` branch mirroring
   the existing `issues` branch: resolve the repo config, call
   `decideDarkFactoryTrigger(data, process.env)`, then `runDarkFactoryDispatch`.
   Signature verification and the repo-config lookup already happen upstream.
3. **Idempotency** — key the resume delivery on the **comment id**
   (`comment:<id>`), not the GitHub delivery id, so re-delivering the same comment
   can never double-resume. A genuinely new comment is a new answer, and the
   existing HELD guards already make a second answer while the run is running a
   no-op (the active run is no longer `blocked`).
4. **The answer reaches the stage** — carry the bounded answer text into the
   handoff message only. It is NEVER persisted in the ledger: the ledger keeps the
   reference, per the run-history no-raw-content rule.
5. **Keep the label-clearing resume path working** — this adds the documented
   behaviour, it does not replace the existing one.

## Tasks (TDD, one RED to GREEN cycle each)

- **T1 — trigger decision.** `tests/dark-factory/trigger.test.ts`: a `created`
  comment from an allowed sender decides `resume`; a comment from a disallowed
  sender is `refused`; a comment on a repo outside `DF_WORKER_ALLOWED_REPOS` is
  `refused`; a comment can NEVER decide `trigger`; an edited/deleted comment is
  `not-a-trigger`.
- **T2 — webhook branch.** `tests/webhook-handler.test.ts`: an `issue_comment`
  event routes through decide + dispatch and surfaces the outcome; an unrelated
  action or repo is ignored without dispatching.
- **T3 — idempotency.** The same comment id twice yields exactly one resume; a
  second (different) answer while the run is running is HELD, not a second resume.
- **T4 — docs and ADR.** Record the answer path (and the no-raw-content rule for
  the answer text) in an ADR; update the flow docs if they describe resuming.

## Files likely to change

- `agent/lib/dark-factory/trigger.ts` (payload shape + comment decision)
- `app/api/github/webhook/route.ts` (the `issue_comment` branch)
- `tests/dark-factory/trigger.test.ts`, `tests/webhook-handler.test.ts`
- `docs/adr/0022-*.md` + `docs/adr/README.md` (index row)
- maybe `docs/pages/flow-run-lifecycle.md` (if it documents resuming)

## Validation

- `npx vitest run` (full suite), `npx tsc --noEmit --incremental false`
- `DF_PLATFORM_PROVIDER=generic npm run build`
- cspell on changed files; markdownlint + markdown-table-formatter on changed `.md`
- doc-drift guards (`tests/doc-drift-guards.test.ts`, `tests/adr-integrity.test.ts`)
- Rebase onto the current `origin/main` immediately before opening the PR

## Risks / open questions

- **Does the answer have to reach the agent?** The promise implies yes; a resume
  that discards the answer may be useless. This plan carries the answer into the
  handoff only (bounded, never persisted). Confirm that is the intent.
- **Refuse vs ignore for a disallowed commenter.** The existing gates `refuse` with
  a reason; I will mirror that so the webhook log explains itself.
- **Two resume paths.** After this, both a cleared `needs-answer` label and a
  comment reply resume a run. Say if the label path should be retired later.
- **Comment threading.** GitHub issue comments are FLAT: a "reply" is just another
  comment on the issue. Correlation is therefore by issue plus ordering (the
  comment arrives after the parked question) and is enforced by the existing
  blocked-run requirement in dispatch, not by a thread id.