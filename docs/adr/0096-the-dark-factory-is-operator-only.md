# 0096: The dark factory is operator-only, and fails closed

Date: 2026-11-23

Status: Accepted

## Context

The dark factory pages rendered for any viewer. The read API resolved a viewer and refused, so a
signed-in person who was not an operator saw a shell and a set of panels that could not load, rather
than being told they were not entitled.

Entitlement here is a membership, not a session. A session carries an email; a membership binds that
email to a role and a status, and it is operator-managed: a customer never provisions its own scope.

## Decision

The dark factory layout resolves the viewer before it renders, and refuses anything that is not an
active operator. A refusal renders no navigation, so no link is offered that would end in a refusal.
The gate uses the same resolver the read API uses, so the shell and the data cannot disagree about who
is entitled.

## Consequences

- Entitlement is one membership row, read on every request, so a revocation or a suspension takes
  effect on the next request rather than waiting out a stale claim.
- One decision covers every page beneath the layout, including pages added later.
- The operator is not special-cased. Their membership was verified before the gate was written, and
  the admitted case is asserted beside the refusals, so a gate that refuses everyone fails the suite.
