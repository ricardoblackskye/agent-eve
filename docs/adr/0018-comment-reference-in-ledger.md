# 0018 — Store a comment reference, not the question text, in the run ledger

- **Date:** 2026-10-06
- **Status:** Accepted

## Context

#260 asks that an agent's blocker question be visible on the corresponding
GitHub issue without duplicating the content twice — once in the Dark Factory
ledger and again on GitHub — and without the ledger ever holding free-form
worker text that has to be manually reconciled.

GitHub is already the system of record for the question: the worker reporter
posts the question as an issue comment, idempotently, keyed by run via a
`reporter:${runId}` StateStore entry. The ledger already records the event
(`worker.question`, status `blocked`); it just discards the single piece that
links the event back to the comment it produced.

Two designs were on the table:

- **Option A — reference only.** Persist `commentReference { provider, id, url }`
  on the `worker.question` event and render a link from the run-detail timeline.
- **Option B — duplicate content.** Persist the question text in a separate
  `questions` collection and render it inline.

## Decision

We adopt **Option A**. `RunEvent` gains an optional `commentReference`
(`{ provider: "github"; id: number; url: string }`), populated only on
`worker.question` events by `RunHistoryWorkerReporter` _after_ the inner reporter
has actually posted (or edited) the comment. The ledger never stores the question
body.

The UI renders a "View on GitHub" link from the event's `commentReference.url`;
the issue board keeps its existing `blocked` grouping ("waiting on PO") and now
points at the comment instead of a copied string.

## Consequences

- The ledger stays content-free; the duplication and drift between the ledger and
  GitHub is eliminated.
- The run-detail timeline links straight to the GitHub comment, so a developer
  answering the question lands on the exact thread.
- A new optional field on `RunEvent` maps onto the existing `RunEventRow` shape
  (`runEventToRow` spreads the full event), so **no database migration** is
  required.
- The event only ever carries a reference for comments that were actually posted;
  if the post fails, the run is still recorded `blocked` and the failure is
  surfaced (never swallowed) — the `commentReference` is simply absent.
- `provider` is pinned to `"github"`. Adding GitLab or another provider means
  extending the discriminated union and the validator, not touching the UI.
