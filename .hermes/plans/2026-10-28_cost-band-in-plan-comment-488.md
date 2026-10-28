# #488 — show the cost band in the plan comment

Part of epic **#453**. Plan branch: `feat/df-cost-band-in-plan-comment-488`, based on `origin/main` @ `a078db3`.

## Goal

Surface the plan's cost estimate where the human decision actually happens: the plan comment posted on the
ticket before approval (#365). This is v1's ONLY surface — there is no ledger UI, so if the band is not in
this comment, nothing shows it to a human.

## Acceptance criteria (from the issue)

- [ ] AC1 The plan comment renders band (`$low–$high`), class (`XS`–`XL`) and confidence in human-readable form.
- [ ] AC2 It states plainly that the figure is **advisory** and does not block approval.
- [ ] AC3 A run with no estimate renders **without** the section — never "unknown", never `$0`.
- [ ] AC4 Wording does not imply precision: no single "expected cost is $X" phrasing.
- [ ] AC5 Snapshot test on the rendered comment body, covering both the with-estimate and without-estimate cases.
- [ ] AC6 The comment stays within GitHub's body size limits for a large plan.

## Current state (verified by reading the tree at `a078db3`)

| Piece          | Where                                              | What it does today                                                                                                                 |
|----------------|----------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------|
| comment body   | `agent/lib/dark-factory/plan-comment.ts:83`        | marker, then human markdown, then an escaped `<details>` JSON block appended LAST                                                  |
| parser         | `agent/lib/dark-factory/plan-comment.ts:123`       | anchors on the END of the body (`endsWith("</details>")`)                                                                          |
| poster         | `agent/lib/dark-factory/plan-comment.ts:175`       | lists comments, edits its own (found by marker) or posts                                                                           |
| human markdown | `scripts/dark-factory-runner.ts:862`               | `renderPlanFile(executionPlan, { issueUrl })` — carries no cost                                                                    |
| estimate       | `agent/lib/dark-factory/plan-cost-estimate.ts:149` | `estimatePlanCost({ plan, model, history?, resolvePrice? })` → `{ lowUsd, expectedUsd, highUsd, costClass, confidence, features }` |
| size guard     | none for this comment                              | precedent: `agent/lib/sprint-delivery.ts:28` uses `MAX_COMMENT_CHARS = 60000` (GitHub's limit is 65536)                            |

**The ordering wrinkle (#487, Option B — approved).** The estimate is persisted AFTER the comment is posted, so
the comment cannot read the stored band back. It must be computed IN MEMORY before rendering — and the SAME
computed value should feed the persistence call, or the comment and the ledger can disagree.

## Intended fix

1. `renderCostEstimateSection(estimate?: PlanCostEstimate | null): string` in `plan-comment.ts` — a pure
   renderer. Returns `""` when there is no usable estimate (AC3). Otherwise a compact advisory block
   (AC1, AC2, AC4).
2. `planCommentBody(markdown, plan, estimate?)` gains the optional estimate and inserts the rendered section
   directly under the marker.
3. `postPlanComment(...)` options gain the same optional estimate and pass it through.
4. The runner computes the estimate ONCE before posting (best-effort — a failure logs and yields no section)
   and passes that one value to both the comment and the persistence call.

### Decisions (labelled, for review)

- **[Decision] placement:** directly under the marker, so the band is visible before a reviewer commits to
  reading the plan. The marker still leads (an existing test asserts it) and the machine block still ends the
  body (the round-trip depends on it).
- **[Decision] `expectedUsd` is NOT rendered.** AC4 forbids a single-figure phrasing, so the comment shows the
  band only. The ledger still stores `expected_usd` (#486) for the calibration work in #490.
- **[Decision] the renderer lives in `plan-comment.ts`, not a new module.** A new file under
  `agent/lib/dark-factory/` must be referenced from a `docs/pages/*.md` page or the doc-drift guard fails, and
  a comment section is part of the comment renderer.
- **[Decision] AC6 mechanism:** keep the section's size FIXED (it never scales with the plan) and assert the
  rendered body stays within the limit for a large plan. Deliberately NOT truncating the human markdown:
  `parsePlanFromComment` anchors on the END of the body, so truncating the tail would break the resume
  round-trip and fail closed — a resumed run would stop.
- **[Decision, settled at GATE 1] a zero band still renders.** An estimate whose `lowUsd` and `highUsd`
  are both 0 renders `$0.00 – $0.00` like any other computed estimate; a COMPUTED estimate is never
  suppressed. AC3's `$0` prohibition is about the ABSENT case, and suppressing a real estimate would make
  "computed, and zero" indistinguishable from "no estimate" — one silence carrying two meanings. The RED
  tests pin both halves: a zero band RENDERS the section, and only a MISSING estimate omits it.
- **ADR:** none in this issue. #489 owns ADR 0069 (bands are advisory and get calibrated) — recorded here so
  the same decision is not written twice.

## Tasks (TDD)

| Task | RED                                                                                                                                                                                                                                             | GREEN                                                                         |
|------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------|
| 1    | `tests/dark-factory/plan-cost-section.test.ts`: band, class and confidence render; an absent estimate yields `""`; never "unknown" and never `$0`; no single-figure "expected cost is $X"; the wording says advisory and that it does not block | `renderCostEstimateSection` plus a `formatUsd` helper                         |
| 2    | `tests/dark-factory/plan-comment.test.ts`: the section sits under the marker; the human rendering stays above the machine block; the round-trip still parses; no estimate ⇒ no section; a full snapshot of the body for both cases (AC5)        | `planCommentBody(markdown, plan, estimate?)` and the `postPlanComment` option |
| 3    | runner wiring: the estimate is computed BEFORE `postPlanComment(` and the SAME value reaches persistence; a throwing estimate ⇒ a comment with no section and the run continues                                                                 | the runner computes once, best-effort                                         |
| 4    | AC6: a large plan's rendered body stays within the limit                                                                                                                                                                                        | bound and assert                                                              |
| 5    | —                                                                                                                                                                                                                                               | docs: `docs/pages/flow-cost-governance.md` records the surface                |

## Files likely to change

- `agent/lib/dark-factory/plan-comment.ts` — the renderer, the body builder, the poster option.
- `scripts/dark-factory-runner.ts` — compute once, pass to the comment and the ledger.
- `tests/dark-factory/plan-cost-section.test.ts` (new) and `tests/dark-factory/plan-comment.test.ts`.
- `docs/pages/flow-cost-governance.md` — the human surface for the advisory band.
- `.hermes/plans/2026-10-28_cost-band-in-plan-comment-488.md` — this file.

## Validation

```bash
npx tsc -p tsconfig.json --noEmit --incremental false
npx vitest run
npx eve build
npx -y cspell@9.1.1 --no-progress -c .cspell.json <changed files>
npx -y markdown-table-formatter@1.6.1 --check <changed markdown>
npx -y markdownlint-cli@0.45.0 -c <config.json> <changed markdown>
```

Plus a real `df:local-run` against the local Postgres, because the deliverable IS a rendered comment — a unit
test on the string is not the same as seeing the band on the ticket.

## Risks and open questions

1. **[Risk] a large plan may ALREADY exceed 65536.**
   Task 4 begins by MEASURING the current worst case rather than assuming. If today's body can already exceed
   the limit, that is a pre-existing gap: it gets its own follow-up issue, and #488 only guarantees its own
   section does not make it worse. It is not silently widened into this change.
2. **[Risk] the estimate could be computed twice and disagree.**
   Computing once for the comment and again inside the persistence path could yield different bands (different
   history or price resolution). Task 3 passes ONE value to both, and the test asserts the wiring.
3. **[Risk] the wording IS the deliverable (AC2, AC4).**
   The test asserts the absence of a single-figure sentence, not merely the presence of a band — a comment that
   says "expected cost is $0.20" and a band would satisfy a weaker test while failing the criterion.
