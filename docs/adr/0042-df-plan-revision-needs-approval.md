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
  `run.plan_revised` event per round, recorded under an id derived from the run and the reply, so a
  re-delivered reply records once while a genuinely new reply is a new round. Past the cap the run ends
  terminally with a message naming the cap and the variable.
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
- `run.plan_revised` is a schema-visible addition to a CLOSED event union, so the union, the accepted
  list, the status rule and the module docs move together. Skipping the docs leaves `doc-drift-guards`
  failing, which is the guard doing its job.
