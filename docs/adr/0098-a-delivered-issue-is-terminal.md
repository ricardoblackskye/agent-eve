# 0098 — A delivered issue is terminal, and asks for sign-off

- **Date:** 2026-11-25
- **Status:** Accepted

## Context

An operator watching a finished issue could not tell what the factory wanted. After a run had delivered
its work and opened a pull request, the issue page showed three signals that said otherwise: `df:done` had
been removed and `df:running` added, a comment announced a dispatched pipeline and an execution plan being
synthesized, and `needs-answer` appeared.

The cause was not one bug but an overlap. `OUTCOME_LABELS` — "what a fresh start CLEARS" — contained
`done`, so any dispatch, including one started from the CLI, removed the delivered label. `RETRIGGER_REFUSED_LABELS`
refused that for the LABEL path, which is why the same operation was impossible by one route and automatic by
another. And `needs-answer` was carrying two different requests: a parked plan needs permission to START,
while a delivered result needs a human to accept it.

A first reading of the report blamed the retirement path, because retiring a stale claim was observed to
leave a ticket unlabelled. Measurement disproved it: a delivered run has already released its claim, so
retirement refuses it with `no-claim` and touches nothing. The clearing at dispatch was the whole of it.
That distinction decides this record, because the plausible repair — have retirement restore a terminal
label — would have changed the wrong layer and left the real defect in place.

## Decision

A delivered issue is a terminal state, and it is legible from its labels alone.

1. **A delivered issue carries `awaiting-signoff` beside `df:done`.** It is an instruction to a human, so it
   joins the vocabulary outside the `df:` family for the same reason `needs-answer` sits there. `needs-answer`
   keeps its own single meaning: a parked plan needs approval before coding starts.
2. **A delivered state is never cleared.** `done` is not an outcome a fresh attempt clears, and a dispatch
   against a delivered ticket is refused rather than re-started — on every path, including the CLI, which is
   the route the original report came through. A refusal names the state it refused on; it is not reported as
   a fault in the work.
3. **The sign-off vocabulary is its own and fail-closed.** `Approved` and `Rejected` decide a delivered run,
   matched as a whole message: a reply carrying a request as well as an approval decides nothing. Plan idioms
   such as "ship it" are permission to start, not to accept.
4. **Retiring applies no terminal label, and that is correct.** A parked run is the only one retirement can
   touch, and its retirement is neither a success nor a failure. A delivered run cannot be retired at all,
   so retirement is never the path by which a delivered state is lost.

## Consequences

A finished issue now reads as finished without opening the comment thread, and the factory's most reassuring
state no longer looks like a call to action.

The cost is a second instruction label to keep distinct, and a refusal path that operators will meet when
they deliberately re-dispatch a delivered ticket — so an explicit override is wanted, which must preserve
the delivered state rather than clear it.

Two follow-ons are forced and are not done here. Nothing yet READS a sign-off reply: the classifier exists,
while what closes a pull request or returns an issue for re-planning does not, because no watcher consumes
issue comments today. And a comment that names which check failed is rendered, but not yet wired to the
check state it describes.

The record also fixes a vocabulary confusion for later readers: `done` is the Definition of Done's verdict,
while a ledger row's status is `succeeded`. They are different vocabularies, and treating one as the other
is refused by the ledger's own validation.
