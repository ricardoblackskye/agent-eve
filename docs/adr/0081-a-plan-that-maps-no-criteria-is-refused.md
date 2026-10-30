# 0081 - A plan that maps no acceptance criteria is refused

- **Date:** 2026-10-30
- **Status:** Accepted

## Context

`ExecutionPlan.acceptanceCriteriaMap` is declared **non-optional** (`plan-validator.ts:53`), but the validator
checked it only when present (`:351`), so a plan carrying no mappings passed. The check that would otherwise have
caught it - coverage of the story's acceptance criteria - is driven by `extractStoryAcceptanceCriteria`, which
matches only `AC-?\d+` labels or `- Given` bullets. Measured on the tree at the time:

| Story format | `requiredAcs` | Valid with NO map |
| --- | --- | --- |
| `AC1:` labels | `[AC1, AC2]` | false |
| `- Given` bullets | `[AC1, AC2]` | false |
| `- [ ]` checkboxes (this repository's own issue format) | `[]` | **true** |
| prose | `[]` | **true** |

So whether the field was required depended on whether an extractor matched the story's prose.

Nor was the omission merely tolerated downstream. `evaluateAcTraceability` computed `allPassed` as
`failingAcs.length === 0`, which an empty matrix satisfies - so a plan that mapped nothing reported as **PASSED**,
an omission reading as a clean result. A real run demonstrated the cost: the architect's self-correction loop
replaced an attempt carrying three mappings with a later attempt that omitted the field, and the omission was
accepted as an improvement.

## Decision

**Refuse it.** The field's presence is a completeness requirement, not a formatting one, and the posture is
the one #378 took for plan approval: treating an unclassifiable state as acceptance means coding against a plan no human
meaningfully accepted.

- Absent, not an array, or empty: an error naming `acceptanceCriteriaMap` and the reason, one message per cause.
- `evaluateAcTraceability` reports `missingMap` and no longer reports `allPassed` for a plan that mapped nothing.
- A malformed (non-array) map is refused rather than thrown: it previously crashed the validator with
  `(plan.acceptanceCriteriaMap || []).map is not a function`, the same class of defect as #501.

## Consequences

- Plans from the Architect must carry mappings. Its prompt already asks for them, so this aligns the enforced
  contract with the requested one.
- A plan that maps nothing can no longer be approved or executed, and a retry that drops the mappings cannot be
  treated as progress.
- **The AC-coverage rule remains unsound for stories whose acceptance criteria are written as checkboxes.** It
  matches no AC ids there, so there is nothing to check. That is a defect of that rule with its own blast radius,
  tracked separately rather than fixed here.
- Fixtures and snapshots that build plans without the field now have to carry it; that is the intended change.
