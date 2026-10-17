# 0041 — A plan is approved only by explicit approval wording

- **Date:** 2026-10-17
- **Status:** Accepted

## Context

The plan-approval gate parks a run after it posts its plan and waits for a human (#365). The park
advertises two ways to begin: reply on the issue, or remove the `needs-answer` label. The resume path
then reads the frozen plan back off the ticket and codes against it.

That left the MEANING of a reply undecided. A reply is free text: it can be an approval, a request to
change the plan, a question, or an unrelated remark ("thanks, what is the ETA?"). Treating any reply as
approval is the worst available reading, because the plan a human is about to change is then the plan
that gets built - and the run looks like it honored the human while doing the opposite.

## Decision

- Approval is OPT-IN and fail-closed. Only explicit approval wording counts, and the allow-list lives in
  ONE exported constant (`PLAN_APPROVAL_PHRASES`) so the ticket wording and the tests agree on it.
- The test is a WHOLE-MESSAGE match after normalizing emphasis, quotes, case and trailing punctuation.
  Containment is wrong in the one direction that matters: "Approved, but also update the header" carries
  an approval AND a request, and it is the request that must win.
- Everything else is a revision.
- Clearing `needs-answer` remains an approval. It is an explicit human act, and the parked question
  advertises it.
- One accepted cost: an incidental comment spends a revision round. That round is bounded by 0042 and can
  never produce unapproved code.

## Consequences

- A reply carrying any request is feedback, so a plan is never built from a reply the human was amending.
- A vaguely worded genuine approval ("ok then", "fine") is read as feedback and re-parks. The human sees
  the run parked again and can say "Approved". Annoying, never unsafe, and the allow-list is a one-line
  extension with a test.
- A model that SCORES whether a reply is a revision is the recorded follow-up. It would replace the
  wording list without changing this posture, which is why the list is one constant rather than logic
  spread through the resume path.
