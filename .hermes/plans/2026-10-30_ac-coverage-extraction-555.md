# 555 - the AC-coverage rule must read the criteria the story actually states

## Goal

Make the coverage check non-vacuous for the formats stories are written in, and stop it validating against
acceptance criteria that only look like criteria (the issue's five ACs).

## Verified findings

The extractor (`plan-validator.ts:80`) has exactly ONE consumer - the coverage rule at `:357` - and the story text
it reads is `issueData.body` (`scripts/dark-factory-runner.ts:829`, `:789`, `agent/lib/dark-factory/architect-agent.ts:937`).
So the issue's own body decides whether the rule checks anything, and the blast radius of changing the extractor is
contained to that one rule.

Run against the real bodies of issues this Factory has worked or is about to:

| Issue | `requiredAcs` | `AC<n>` labels | `- [ ]` bullets | Coverage rule |
| --- | --- | --- | --- | --- |
| #499 | `[]` | 0 | 4 | checks nothing |
| #518 | `[AC6]` | 1 | 4 | checks the wrong thing |
| #344, #380, #502, #553, #555 | `[AC1..ACn]` | 4 to 11 | 0 | checks them |

Two distinct failures:

1. **vacuous** - criteria written as `- [ ]` bullets yield no ids, so the loop iterates nothing and a plan is told
   it covers everything;
2. **actively wrong** - #518 returned `[AC6]` because the body mentions "AC6" once in PROSE while its four real
   criteria are checkbox bullets. The rule then demands a mapping for a criterion the story never stated and ignores
   the four it did.

## The design, chosen because it fixes both

**Scope extraction to the acceptance-criteria section, and read that section's own lists.**

- Find the section by heading (`/acceptance criteria/i`, any depth) and take its content up to the next heading of
  the same or a higher level.
- Inside it, accept explicit `AC<n>` ids as today, and ALSO ordered bullets or checkboxes, numbered `AC1..ACn` in
  order - the treatment `- Given` bullets already get, applied to the form this repository actually writes.
- Outside the section, nothing is a criterion, which is what stops a passing mention from becoming one.
- No such section: no required criteria. The rule checks what the story states and nothing more.

One rule covers both failures: everything outside the section stops counting, and the section's own bullets stop
being invisible.

## Soundness, at the level of the test rather than the run

A story that states no criteria must not invalidate every plan (the issue's AC3), so non-vacuity belongs to the
extraction's own tests, not to a run-time refusal: each recognized shape gets a case, and the criteria-in-section
case asserts a NON-EMPTY result, so a future format drift fails loudly instead of quietly reducing the rule to a
no-op again.

## Global constraints

- #502's rule is untouched: the presence requirement and its three messages stay as they are (the issue's AC5).
- The extractor's signature and return type do not change; it stays pure and is still called once.
- No change to the architect's prompt or the plan schema.

## Tasks

1. Section-scoped extraction with ordered-bullet support, RED first on the #499 shape (vacuous) and the #518 shape
   (phantom criterion).
2. Tests: a case per recognized shape, the checkbox-section case asserting non-empty, the phantom-mention case
   asserting the mention is NOT a criterion, and the control that a criteria-free story yields none.
3. Re-run the coverage rule's existing tests, and confirm #502's suite still passes unmodified.

## Validation

- The validator suite plus the full DSN-enabled suite (expect the single known artefact failure).
- cspell and markdownlint over the changed files; no new docs, so no ADR index work.

## Review focus

1. Section detection is the risky part: headings at different depths, a criteria list with no heading at all, and
   bullets inside a fenced code block. The third is where a naive parse invents criteria.
2. Numbering bullets `AC1..ACn` invents ids. That is deliberate and matches what `- Given` already did, but it means
   an explicit `AC3` in the same section must line up with the third bullet rather than duplicating it.
3. The rule still cannot check a story whose criteria are stated in prose with no heading. That limit should be
   stated in the issue rather than discovered later.

## Decisions

1. **Scope**: the acceptance-criteria section **(recommended** - one rule fixes both failures**)** versus the
   current whole-body scan with more patterns added (leaves the phantom-criterion failure in place).
2. **Ids inside the section**: ordered numbering for bullets, alongside explicit `AC<n>` **(recommended)** versus
   requiring explicit labels (which would leave the checkbox style vacuous, the defect being fixed).
3. **No section found**: no required criteria **(recommended** - the rule checks what the story states**)** versus
   falling back to the whole-body scan (reintroduces the phantom).
4. **Non-vacuity**: asserted in the extraction's tests rather than refusing plans at run time **(recommended** -
   refusing would break the issue's AC3 control**)**.
