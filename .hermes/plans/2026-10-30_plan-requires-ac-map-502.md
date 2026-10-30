# 502 - the validator must refuse a plan with no acceptance-criteria mappings

## Goal

Make the rule fail-closed where the contract already says it is required, without refusing plans that are fine
(AC3), and record the posture in an ADR (AC6).

## Verified findings

The issue is right, and its mechanism is one step subtler than stated. `plan-validator.ts:53` declares
`acceptanceCriteriaMap` **non-optional**; `:351` validates it **only if present**. But the AC-coverage check that
would otherwise catch a missing map is driven by `extractStoryAcceptanceCriteria(storyText)` (`:337`), and that
extractor matches only `AC-?\d+` labels or `- Given` bullets (`:80-101`). Measured on the current tree:

| Story format | `requiredAcs` | `valid` for a plan with NO map |
| --- | --- | --- |
| `AC1:` labels | `[AC1, AC2]` | **false** - 2 missing-mapping errors |
| `- Given` bullets | `[AC1, AC2]` | **false** |
| `- [ ]` checkboxes (the repo's own issue format) | `[]` | **true** - the vacuous pass |
| prose | `[]` | **true** |

So a mapping-less plan passes whenever the story yields no AC ids, which is the common case for a story written in
the repository's own checkbox style. The fail-closed rule is therefore correct regardless of the story format, and
that is the argument for it: the field's presence should not depend on whether an extractor matched the prose.

Third inconsistency, not in the issue's table: `plan-file.ts:34` declares the field **optional** in the renderer's
input type, and `:206` reads it with `?? []` - the same silent degrade as `definition-of-done.ts:175`.

## The rule

Inside the validator's mapping section: if `acceptanceCriteriaMap` is absent, not an array, or empty, push an
error naming the field and the reason. One message per cause, matching the existing error style.

## AC4's mechanism

`evaluateAcTraceability` (`definition-of-done.ts:175`) must not treat a missing map as "nothing to verify". Keep
`?? []` for the mapping walk - legacy and in-flight plans still have to render - but report the absent map as its
own failure, so a plan that reaches the definition-of-done without passing the validator cannot degrade silently.

## What AC5 pins

The architect's self-correction loop replaced a plan carrying three mappings with one carrying none, and accepted
it. With the validator fail-closed, a mapping-less attempt is simply invalid, so the loop cannot treat it as an
improvement. The test pins the acceptance decision, not the wording.

## Global constraints

- **AC3 is the control case**: a plan WITH mappings must still validate, and so must every fixture plan that a
  reviewer would call complete.
- Existing fixtures and snapshots that build plans without the field will start failing. That is the intended
  contract change; update them deliberately and say which moved, rather than relaxing the rule.
- The extractor's blind spot (checkbox-style stories) is NOT fixed here. It is a adjacent rule with its own
  blast radius - see "Observed, not carried".

## Tasks

1. The fail-closed rule in `validateExecutionPlan`, RED first on a mapping-less plan.
2. `evaluateAcTraceability` reports the absent map (AC4).
3. Tests: AC1 (absent / not-an-array / empty), AC2 (the message names the field), AC3 (the control), AC5 (the
   retry that drops the map is not accepted).
4. ADR 0081: the fail-closed posture for plan completeness, with the alternative (fail-open, as today) and why it
   was rejected - the same reasoning as #378.
5. Update fixtures that legitimately need the field, and flip any that were relying on its absence.

## Validation

- The validator, definition-of-done and architect suites, then the full DSN-enabled suite (expect the single known
  artefact failure).
- Link the new ADR from the ADR index in the SAME commit - the orphan-ADR guards fail otherwise.
- cspell and markdownlint over every changed file.

## Review focus

1. Fail-closed guards are only as good as their control case: AC3 must prove a complete plan still validates, or
   the change is a regression dressed as rigour.
2. The blast radius is fixture plans, not production behaviour: nothing in the run path is expected to satisfy the
   rule differently, and any fixture that needs updating should be updated on its merits.
3. Refusing the field's absence does NOT make the AC-coverage check sound - see below.

## Observed, not carried

`extractStoryAcceptanceCriteria` misses the repository's own checkbox style (`- [ ] ...`), so the AC-coverage rule
is vacuous for those stories regardless of this change. That is a separate defect of its own rule and belongs in
its own issue rather than being widened into this one.

## Decisions

1. **The refusal's shape**: one error per cause (absent, not-an-array, empty) naming the field **(recommended)**
   versus a single generic message.
2. **AC4's mechanism**: `evaluateAcTraceability` reports the absent map **(recommended**, so a plan bypassing the
   validator still cannot degrade silently**)** versus leaving `?? []` and pinning only a test.
3. **`plan-file.ts:34`'s optional declaration**: leave it and record the inconsistency (**recommended** - it is
   the renderer's input and outside this issue's ACs**)** versus tightening it and letting the compiler find the
   callers.
4. **The ADR number**: 0081 (0080 was taken by the plan-comment split).
