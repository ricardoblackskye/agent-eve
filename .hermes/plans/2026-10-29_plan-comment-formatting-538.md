# 538 - render the plan comment for a comment, not for a file

**Goal:** make the Architect's plan comment readable. Today it embeds the plan *file's* markdown verbatim, so a
21,471-character comment opens with a page-sized H1 and five section-sized H2s, and the **Files to change** table
is dragged off the side by a single 651-character cell.

**Approach:** normalise the markdown at the one boundary that already exists - `planCommentBody()` - and leave the
plan file exactly as it is. Enforcement rather than advice: the Architect is asked for structure by prompt and is
not reliable about presentation, so a prompt rule is a suggestion while a normalizer is a guarantee.

---

## Verified findings

| where                                           | what                                                                                                                                                                                            |
|-------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `plan-comment.ts:92-102`                        | `planCommentBody(markdown, plan?, estimate?)` composes `marker + estimate section + markdown`. **No heading or table handling exists here at all** - the defect, and the single place to fix it |
| `plan-file.ts:155`                              | the title is an **H1**: `# Plan: ...`                                                                                                                                                           |
| `plan-file.ts:163,167,172,197,208`              | five **H2** sections: Goal, Approach, Tasks, Files to change, Acceptance criteria                                                                                                               |
| `plan-file.ts:175`                              | task headings are **H3** (`### n. title`) - so the file uses three levels and the comment must shift them                                                                                       |
| `plan-file.ts:197-204`                          | the Files table, whose generic cells are the Architect's free-text `rationale`                                                                                                                  |
| `plan-file.ts:206-216`                          | the Acceptance criteria table, whose cells are short by construction                                                                                                                            |
| `scripts/dark-factory-runner.ts:943`            | `postPlanComment(...)` - the only caller                                                                                                                                                        |
| measured on the real comment (`WebFeedPOC#176`) | 21,471 chars, 91 lines, h1=1, h2=5; Files table longest cell **651** (rows 691 and 501), Acceptance table longest **68**                                                                        |

## The two rules

**Headings.** A comment has no page title, so the H1 becomes a **bold line** and every heading below it is demoted
one level (H2 -> H3, H3 -> H4). That satisfies both halves of the acceptance criteria at once - no H1 or H2 in the
comment, and H3 as the highest level - while keeping the plan's own shape, since the tasks still sit under their
sections.

**Table cells.** A prose cell longer than a configured limit stops being a table cell: the row keeps its File and
Action, and the full rationale moves below the table as a list keyed by the file. **Nothing is truncated** - the
rationale is the useful part, and a shortened one would be a worse lie than a wide table. A short rationale is left
exactly where it is, so plans that read well today are untouched.

## Global constraints

- **The plan FILE is byte-identical.** Its scale is correct there; a test pins the file renderer's output so a
  future "tidy-up" cannot quietly change it.
- **The machine payload is untouched.** The comment's JSON payload fence and the marker/`<details>` contract that
  makes it idempotent by `(runId, kind)` are load-bearing; the normalizer applies to the human text only.
- **The normalizer is pure.** Markdown in, markdown out, no I/O - the boundary already has the text in hand.
- **Short plans must be provably unchanged**, not merely "probably fine".
- No new dependency; no secret in any output.

## Review focus

- **The demotion must not double-apply.** A re-post renders the same markdown again; a normalizer that demotes an
  already-demoted string would walk every heading to H6 across retries. Assert that normalizing twice equals
  normalizing once when the input is the *file's* markdown, and that the comment is rebuilt from the file's
  markdown rather than from its own output.
- **The table rule must key on the right cell.** Only prose columns move; an acceptance-criteria table of short
  cells must come out byte-identical, and a row that is long only in its `File` or `Action` column must not be
  mistaken for prose.
- **The limit must be a named constant, not a magic number**, and the tests must exercise both sides of it - one
  cell just under, one just over.
- **Markdown validity is not optional**: the demoted and reflowed comment must still pass the repo's own
  markdownlint rules on the generated catalogue, since the factory lints its own PRs.

## Tasks

### Task 1 - the heading rule

**Files:** `agent/lib/dark-factory/plan-comment.ts`, tests `tests/dark-factory/plan-comment-formatting.test.ts`.

A pure `normaliseCommentMarkdown(markdown)` that turns the leading H1 into a bold line and demotes every heading
below it by one. RED: the real plan file's markdown produces no H1 and no H2, contains H3 where it had H2, H4 where
it had H3, and leaves the body text untouched.

### Task 2 - the table-cell rule

**Files:** same module, same test file.

A row whose prose cell exceeds the limit moves that cell's content below its table as a list keyed by the first
column. RED: the 651-character rationale leaves the table and reappears in full below it, the table row survives
with File and Action, a short rationale does not move, and the acceptance-criteria table is unchanged.

### Task 3 - wire it at the boundary, and pin the file

**Files:** `plan-comment.ts` (`planCommentBody`), `tests/dark-factory/plan-comment.test.ts`, its snapshot.

The human body is `marker + estimate + normalised markdown`; the machine payload is untouched. RED: the posted
comment has no H1/H2 with the estimate section included (the estimate is ours, so it must obey the same rule), and
the plan file's render is asserted byte-identical to a recorded fixture.

### Task 4 - the measured proof against the real comment

Re-render the *actual* markdown from `WebFeedPOC#176` (21,471 chars, one 651-character cell) through the
normalizer and report the numbers: headings, longest cell, and total characters. Delivered as a test fixture built
from that measurement so the evidence lives in the repository rather than in a transcript.

### Task 5 - docs

The plan-comment surface on the local-runs page (or the module catalogue entry) states that a comment is rendered
for a comment: no page-sized headings, no runaway table cells.

---

## Validation

- Full suite green with no new failures, `tsc --noEmit --incremental false` clean, and the pinned linters over
  **every changed file** with the CI-matched cspell version.
- **The Postgres legs must RUN**: export the five `DF_*_TEST_DATABASE_URL` variables.
- The plan file's byte-identity test is the guard that this stayed at the comment boundary.

## Decisions (agreed at GATE 1)

1. **The heading rule** - H1 becomes a bold line and everything below is demoted one level (recommended: satisfies
   both acceptance criteria and preserves the plan's shape) versus collapsing H1 and H2 to H3, which matches the
   issue's wording literally but loses the title/section distinction, versus demoting by two (H1->H3, H2->H4),
   which puts sections deeper than the title.
2. **Where the normalizer lives** - a pure function in `plan-comment.ts`, applied to the human markdown only
   (recommended: the boundary is the single seam and the acceptance criteria pin the file as byte-identical)
   versus teaching `plan-file.ts` to render differently per surface, which is the original defect.
3. **The table rule** - move a long prose cell below its table, keyed by the row's first column, keeping the row
   (recommended) versus truncating it (the issue explicitly rejects this) versus always moving prose, which
   changes plans that read well today.
4. **The threshold** - a named constant around **120 characters**, env-overridable, justified by the measurement
   (the real long cell was 651 while the acceptance table topped out at 68) versus 80 (an MD013 echo that would
   move many ordinary phrases) versus 200 (closer to the observed worst case, so it would have missed it).
5. **#518 in the same PR** - no (recommended: the character limit is a different mechanism at the same boundary,
   and it already has its own issue and a "relates to" link) versus doing both at once.
