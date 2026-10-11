# 0022 — A comment answer resumes a parked run, and the answer reaches the factory as DATA

- **Date:** 2026-10-10
- **Status:** Accepted

## Context

When a Dark Factory run cannot proceed without a human decision it parks: the stage
throws `ParkedRunError`, the run becomes `blocked`, and the worker posts the question as
a ticket comment that promises *"Reply here and the run resumes; it will not consume
further iterations while it waits."*

That promise was **not implemented**. `issue_comment` appeared nowhere in the repository
and the webhook routed only `issues` and `pull_request`, so a reply was dropped on the
floor. The only way to resume a parked run was a separate, undocumented action: clearing
the `needs-answer` label.

The machinery to resume already existed and was tested. `decideDarkFactoryTrigger` returns
a `resume` decision for a cleared question label, and `runDarkFactoryDispatch` claims a
`resume` control delivery (idempotent; `RunControlTransition = "abort" | "resume"`),
requires the active run to be `blocked`, writes `run.resumed` and re-handoffs. The gap
was purely inbound.

## Decision

The comment that answers a parked question is now an inbound trigger, handled by the same
decide-then-dispatch path as a label.

- **A comment can only RESUME, never start.** No comment payload can produce a `trigger`
  decision, so a reply can never launch fresh work.
- **The answer reaches the factory as DATA.** The bounded comment body is carried on the
  decision and rendered into the handoff inside a fenced block, explicitly labelled as
  user-supplied data that must not be obeyed — the same defence already applied to the
  issue brief, because this answer flows to an agent that then writes code.
- **The answer is never persisted.** The ledger keeps only the question's
  `commentReference`; the answer text lives in the handoff message alone, honouring the
  run-history no-raw-content rule.
- **Idempotency is keyed on the COMMENT id** (`comment:<id>`), not the GitHub delivery id,
  so re-delivering the same answer cannot resume twice, while a genuinely new comment is
  a new answer.
- **Correlation is by issue plus arrival order, not by a thread.** GitHub issue comments
  are flat — there is no thread id to match on. The blocked-run requirement inside
  dispatch is what turns an unrelated comment into a no-op.
- **The label-clearing path remains**, but is now the legacy path; the comment reply is
  the documented one.

## Consequences

- The behaviour the question comment advertises is real: a human replying on the ticket
  resumes the run, and the factory receives their answer.
- Two resume paths now exist (a cleared `needs-answer` label, and a comment reply). That is
  deliberate for one release so the new path can be proven; the label path should be
  retired once it is, and until then both are idempotent through the same control delivery.
- Any comment by an allow-listed actor on a parked issue counts as the answer, because
  ordering is implicit. A comment that is not really an answer will therefore resume the
  run. That is accepted for UAT; tightening it would require matching the reply to the
  question, with a thread id GitHub issue comments do not have.
- The webhook gains one more inbound surface, so the two allow-list gates are load-bearing
  here exactly as they are for a label: unset configuration refuses rather than allows.