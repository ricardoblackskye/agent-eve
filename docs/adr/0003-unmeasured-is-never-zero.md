# 0003 — An unmeasured value is never zero

- **Date:** 2026-10-01
- **Status:** Accepted

## Context

Usage and cost are measured by providers, and measurement can be absent: a model
with no price entry, a provider that reports no token counts, an interrupted call.
An absent measurement rendered as `0` is indistinguishable from a genuinely free
call, and quietly understates spend.

## Decision

Render an absent measurement as an em dash, never `0`. Define
`unmeasured = total − observed`, and report it per bucket rather than as a single
global figure, so each row can be honest independently. Unknown event types are
shown literally rather than dropped.

## Consequences

- An operator can distinguish "spent nothing" from "we do not know" — the
  difference that decides whether a budget is trustworthy.
- Aggregates must carry an explicit unmeasured figure, which is more work than
  summing to a single number.
- A `0` in a report is a claim that a measurement happened. Code that defaults to
  `0` is therefore a bug, not a convenience.
