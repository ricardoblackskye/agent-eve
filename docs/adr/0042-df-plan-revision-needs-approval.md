# 0042 — A plan revision re-parks, is capped at five rounds, and the deployed path holds

- **Date:** 2026-10-17
- **Status:** Accepted

## Context

With approval opt-in (0041), every non-approval reply is feedback - but a resumed run never re-plans.
`--resume` reads the frozen plan back off the ticket, and the architect is not merely ignored on that
path: it is never called. So a reply such as "the target file is wrong, please update the plan" changed
nothing while appearing to honor the human. The only way to change a plan was a fresh run - remove and
re-add the trigger label - which loses the thread of the original approval.

Two paths reach a parked plan. The runner (`scripts/dark-factory-runner.ts`) plans and codes in-process.
The deployed webhook path (`agent/lib/dark-factory/entry.ts`) resumes by handing off to the agent session,
which has no planning stage of its own.

## Decision

- A revision AMENDS the plan. `ArchitectAgent.amendPlan` takes the story, the CURRENT plan and the
  feedback, and returns a corrected plan through the SAME parse-validate-self-correct loop as `planStory`
  - a second, separately written loop would be a second untested gate on the same output.
- The amended plan UPDATES the plan comment in place and the run PARKS AGAIN.
  `parksForHumanApproval({ resuming, revision })` returns true for a revision, which is what makes the
  coding phase unreachable on that path rather than merely unvisited.
- Revision rounds are CAPPED at `DF_MAX_PLAN_REVISIONS` (default 5). The count is durable: one
  `run.resumed` event per round, because a round IS the human's reply. The ledger permits a BLOCKED run
  only `run.resumed` or `run.terminal` — the rule that stops a parked run accumulating work while it
  waits — so a dedicated event was refused by the ledger during a live run, correctly, and the design
  was changed rather than the guard widened. The event id is derived from the run and the reply, so a
  re-delivered reply records once while a genuinely new reply is a new round. Past the cap the run ends
  terminally with a message naming the cap and the variable.
- The re-park is a DIFFERENT park, so it needs a distinct question event id. With the id stable per run,
  the second park's write would be deduped and the run would never return to `blocked` for the next
  reply — a dead end that only appears on the SECOND round.
- The ledger is read FAIL-CLOSED (an uncountable ledger refuses, because assuming zero would let a round
  through a cap the operator believes is enforced) and written FAIL-OPEN (a round that cannot be recorded
  is logged loudly and the run still parks, because coding is unreachable without an approval, so a failed
  record can only under-count the cap).
- The DEPLOYED path ships the GUARD only. A revision reply there is HELD with a reason: that path cannot
  amend, and it must not hand off a resume that would code against a plan the human has just asked to
  change. Full amendment there is a separate change.
- The reply reaches the runner from `--answer-file` - a FILE rather than an argument value, keeping human
  text out of the process list and out of shell quoting. A named file that cannot be read REFUSES rather
  than being degraded to "no answer", because "no answer" means the label was cleared, i.e. an approval.

## Consequences

- Iterating on a plan before the sandbox costs one architect call per round and needs no fresh run, so the
  approval thread survives the iteration.
- The cap makes an incidental or chatty reply BOUNDED rather than merely safe: five rounds, then a
  terminal, legible stop that names how to raise it.
- The deployed path will hold a revision reply it could in principle honor later. That is a deliberate,
  visible gap rather than a silent resume.
- **No new event type was needed, and the ledger's state machine stays untouched.** The first design
  added `run.plan_revised` to a closed union; the live end-to-end run showed both why that was wrong and
  why the alternative is better — the reply already had a truthful event to be recorded as. The
  unit suite could not have caught it: the store stubs accepted any page limit and enforced no
  transitions, so only a run against the real store could refuse it.
