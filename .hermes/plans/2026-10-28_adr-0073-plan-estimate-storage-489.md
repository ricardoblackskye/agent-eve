# Plan — #489 docs(df): ADR 0069, and the decision that was actually taken

## Goal

Close #489 honestly. Two things are true at once: the ADR it asks for (`0069-plan-cost-estimates-are-advisory-bands.md`)
**already exists, is `Accepted`, indexed and correctly structured**, and one of the decisions it records **is not the
decision that shipped**. An accepted ADR is never edited, so the fix is a NEW record that supersedes it — and the gaps
the audit found must be satisfied without rewriting history.

Deliverable: **ADR 0073** (the storage decision as taken), `0069`'s status set to `Superseded by 0073` (the one
sanctioned line), the index rows updated, and **two guards** so neither the supersession chain nor the drift that
caused this can regress silently.

## Verified findings

| #  | Finding                                                                                                                                                                                                                                                                                 | Evidence                                                                                                                                              |
|----|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| F1 | ADR 0069 exists, `Accepted`, linked from the index, correct format, covers all eight decisions from the issue                                                                                                                                                                           | `docs/adr/0069-*.md`; `docs/adr/README.md:125`; `tests/adr-integrity.test.ts` green                                                                   |
| F2 | Its storage decision is **not what shipped**: it says the estimate "lives on `RunSummary`" and rejects a separate store because that "would need four provider implementations for v1"                                                                                                  | `0069` Decision, bullet 4                                                                                                                             |
| F3 | `RunSummary` carries **no** estimate field, under any name                                                                                                                                                                                                                              | `grep -nE "planId\|planRevision\|costClass\|confidence\|lowUsd\|expectedUsd\|highUsd\|estimate\|band" agent/lib/dark-factory/run-history.ts` → 0 hits |
| F4 | The estimate is persisted in the **plan ledger**: `df_plans` + `df_plan_estimates`, keyed by `run_id`, stamped with `estimator_version`, carrying the band, class, confidence, `revision_factor`, `history_samples`, file/task counts, with `(period, cost_class)` and `run_id` indexes | `plan-ledger.ts:98` (`PlanLedger`); `run-history-postgres.ts:178` (DDL); live: 5 rows                                                                 |
| F5 | The ledger has **two** implementations (postgres + sqlite), not four — the premise that decided F2's alternative no longer holds                                                                                                                                                        | `grep -rln "df_plan_estimates" agent/lib/dark-factory/*.ts`                                                                                           |
| F6 | The ledger also exposes an **accuracy seam**: `listEstimateAccuracy(period?)` reading the `df_plan_estimate_accuracy` view, which joins the estimate to `df_run_summaries.cost_usd` and computes **`signed_error_usd`**                                                                 | `plan-ledger.ts:87`; `run-history-postgres.ts:208`                                                                                                    |
| F7 | That view yields **0 rows** in practice: no run-level actual is written                                                                                                                                                                                                                 | live: `df_run_summaries.cost_usd` NULL on all runs; `df_run_events.cost_usd` 0 rows; view 0 rows                                                      |
| F8 | The convention is explicit and the set is pristine: **never edit an accepted ADR**, status vocabulary is exactly `Accepted` or `Superseded by NNNN`, numbers must run **without gaps**, and there are **0 supersessions** today — this will be the first                                | guard comment `tests/adr-integrity.test.ts:80`; `docs/adr/template.md:24`; index status column: 72 × `Accepted`                                       |

## Intended fix

1. **`docs/adr/0073-plan-estimates-live-in-the-plan-ledger.md`** — Context: 0069 chose `RunSummary` to avoid four
   provider implementations; what was actually built (#486) is the plan ledger, for two implementations, because an
   estimate is a property of a **plan revision** and the ledger already existed for plans. It also records F6/F7 —
   the accuracy seam and signed-error column exist, and have no data yet. Decision: plan estimates are persisted in
   the plan ledger keyed by `run_id` and stamped with the estimator version; `RunSummary` carries the run's
   **actual** cost, not the estimate. Consequences: the divergence stood from #486 until an audit found it; the
   accuracy view needs a run-level actual written before it can report (#490); the by-stage split needs #492; and this
   is the set's first supersession, so the chain rules are now exercised. The seven decisions of 0069 that still hold
   are **re-affirmed explicitly**, so superseding the record does not retire them by accident.
2. **`0069`'s status line** → `Superseded by 0073`. Body byte-identical; proven with a one-line diff.
3. **`docs/adr/README.md`** — a row for 0073, and 0069's status cell updated.
4. **Two guards** (below), added to `tests/adr-integrity.test.ts`, which already owns the supersession-chain rule.

## Tasks (TDD)

**Task 1 — RED: the storage claim must resolve against the shipped schema.**
Assert ADR 0073 exists, that its named persistence identifiers (`df_plans`, `df_plan_estimates`, `estimator_version`,
`run_id`) all appear in the store DDL, with a non-vacuity anchor (the identifier list is non-empty) and a control (a
fabricated identifier is NOT found). RED fails on the missing file. GREEN = the ADR + its index row.

**Task 2 — RED: the supersession chain must be symmetric.**
For every ADR whose status is `Superseded by NNNN`, the successor must **back-reference** the superseded number — the
existing guard only checks the successor *exists*. Non-vacuity anchor: at least one superseded ADR exists in the set.
RED fails on that anchor (nothing is superseded yet) even though 0073 is present — the two tasks RED at different
moments, so neither green is a false RED. GREEN = `0069`'s status line + 0073's back-reference + the index cell.

**REFACTOR** — none expected; this is a documentation contract, so the guard is the test.

## Files likely to change

- `docs/adr/0073-plan-estimates-live-in-the-plan-ledger.md` (new)
- `docs/adr/0069-plan-cost-estimates-are-advisory-bands.md` (status line ONLY)
- `docs/adr/README.md` (new row + 0069's status cell)
- `tests/adr-integrity.test.ts` (two rules)
- `.hermes/plans/2026-10-28_adr-0073-plan-estimate-storage-489.md` (this plan)

## Validation

- The ADR guards (`tests/adr-integrity.test.ts`) and the docs tree guards, run as the LAST action before pushing.
- `markdownlint` (MD040 fences, MD026 heading punctuation, MD047 trailing newline) and the PINNED
  `markdown-table-formatter@1.6.1` on the changed markdown — the index table is the risk, so check the churn with
  a total and a whitespace-ignored changed-line count, and keep the new row inside the existing column widths.
- `cspell` over every changed `.md`, and `markdown-link-check` (the new ADR links to #453/#492/#490 and to 0069).
- `tsc --noEmit` and the full suite, for the test file change.
- Proof of immutability: `git diff docs/adr/0069-*.md` must show exactly one changed line (the status).

## Risks / open questions

1. **Two of #489's ACs cannot be retro-fitted into 0069** — "each decision states the alternative rejected and why",
   and "links back to #453 and the issues it governs" — without editing an accepted ADR. This plan satisfies the
   *intent* in 0073 (alternatives stated; links to the epic and the governed issues) and relies on the supersession
   pointer for reachability from 0069. **Fork:** a minimal additive edit to 0069 (links only, no decision change) is
   technically possible and the repo has edited an accepted ADR before (a cspell reword, `8d2a49b`), but I recommend
   against it: the guard's own comment forbids it. Your call.
2. **Superseding all of 0069** retires seven decisions that still hold; 0073 re-affirms them in a short list so the
   record stays complete. The alternative — leaving 0069 `Accepted` and noting the divergence — was rejected because
   it leaves two conflicting records with no pointer, which is the exact drift the guard prevents.
3. **F6/F7 (the accuracy seam with no data) is adjacent to #490**, not strictly part of a storage decision. I propose
   recording it in 0073 because it is the honest consequence of where the actual lives; say the word and I will cut it
   to a one-line consequence instead.
4. The status vocabulary is closed (`Accepted | Superseded by NNNN`), so "partially superseded" cannot be expressed.
   If partial supersession should be possible, that is a second, separate change to the guard and the template.

## Settled at GATE 1

All four open questions were resolved before implementation, in the direction recommended above.

1. **0069's body is not edited.** Its two ACs that cannot be met — the rejected-alternative prose, and links back to #453 and
   the issues it governs — are satisfied in 0073, with reachability from 0069 provided by the supersession pointer.
   The links-only workaround was considered and rejected: the guard's own comment forbids editing an accepted ADR, and
   the one precedent (`8d2a49b`, a cspell reword) is a wording fix rather than a semantic edit.
2. **0073 supersedes all of 0069, and re-affirms the seven decisions that still hold**, so superseding the record
   cannot silently retire decisions that remain in force.
3. **0073 records the accuracy-seam finding (F6/F7)** — the view, its `signed_error_usd` column, and the fact that it
   returns 0 rows today because no run-level actual is written. It is the honest consequence of where the actual
   lives, and it names #490 as the follow-on.
4. **Partial supersession is out of scope.** The status vocabulary is closed (`Accepted` or `Superseded by NNNN`); if
   "one decision changed" ever needs expressing, it is a separate change to `tests/adr-integrity.test.ts` and
   `docs/adr/template.md`, filed on its own.

## Task 1 RED (named, for approval)

`tests/adr-integrity.test.ts` gains the storage-claim rule: ADR 0073 must exist, and every persistence identifier it
names (`df_plans`, `df_plan_estimates`, `estimator_version`, `run_id`) must appear in the shipped store DDL — with a
non-vacuity anchor that the identifier list is non-empty, and a control that a fabricated identifier is NOT found.
It fails on the missing file, so the RED is real rather than vacuous.
