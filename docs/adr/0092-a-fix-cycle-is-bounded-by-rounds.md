# 0092 - A fix cycle is bounded by the review rounds

Date: 2026-11-20

Status: Accepted

## Context

The definition of done raises findings and has to dispose of them: fix the code, or
accept the finding with a reason. That capability sat behind
`DefinitionOfDoneDeps.attemptFixes`, which was declared, documented, covered by nine test
cases — and never supplied by the composition root. Every production run therefore skipped
its whole fix/disposition path and re-read the same finding until the round budget was spent.
A pull request that was green and mergeable was recorded `failed` purely because of it.

Implementing the seam raises the questions a fix cycle forces: what limits it, and who decides
a fix actually worked.

## Decision

A fix cycle gets **no budget of its own**. `attemptFixes` is called at most once per review
round, so `DF_MAX_REVIEW_ROUNDS` — which already bounds the loop — is the only limit. A second
cap would be a second answer to one question.

A fix cycle **does not certify its own work**. It returns a `resolved` disposition and the next
round re-reads the pull request's checks; a finding that is genuinely fixed stops reappearing,
and one that is not comes straight back. Verification stays with the check, never with the
component that claims to have fixed it.

An **`error`-severity finding can never be accepted**. The definition of done refuses that
disposition itself; the fix cycle refuses it earlier and more explicitly, so the refusal is
visible where the decision is made rather than several layers away.

A pass that authored nothing, or whose push failed, **claims nothing**. A fix that is not
pushed is not a fix, and reporting it as one would tell the ledger a finding was addressed
while the pull request still carries the code the check rejected.

## Consequences

The loop's cost is already bounded and already observable: the rounds are the budget, and
`resolved_count` on each round records what the fix cycle disposed of.

A fix that breaks the build cannot reach `main`. The factory never merges; the next round's
checks go red, which is a new finding, and the run blocks. The worst outcome of a bad fix is a
red pull request, which is where a real failure already goes.

The first release permits a reasoned acceptance for warnings and notes, configurable off. It
cannot be used for errors, and every acceptance is published on the pull request, so it is a
recorded judgement rather than a silent waiver.
