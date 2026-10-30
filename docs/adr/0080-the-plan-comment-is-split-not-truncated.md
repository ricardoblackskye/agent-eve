# 0080 - The plan comment is split, not truncated

- **Date:** 2026-10-29
- **Status:** Accepted

## Context

`postPlanComment` posts the plan a human approves before anything is coded, and the same comment is what a
resumed run reads its plan back from (#365). The body was `marker + estimate section + human markdown + machine
block`, and the last two EACH carry the whole plan, so the body was roughly twice the plan.

Measured through the real renderers on a plan at the Architect's output budget
(`ARCHITECT_OUTPUT_TOKENS = 8_000`): human markdown 32,387 and machine block 32,901, giving a body of 66,354
against GitHub's 65,536-character limit - over by 818. The issue's own fixture measured 67,297. GitHub answers
such a post with a raw 422, and the runner fails closed on a plan nobody can read, so the failure is a dead run
rather than a degraded comment.

Bounding the body means choosing what to drop, and each of the three options costs something real:

1. **Truncate the human rendering.** The reviewer would approve a partial plan while the resumed run executed the
   full one, which breaks #365. #538 already refused truncation for the same reason.
2. **Move the machine block into its own comment.** Keeps both halves whole at the cost of the read-back
   contract changing.
3. **Bound the plan at its source** (`ARCHITECT_OUTPUT_TOKENS`, target-file count). Works arithmetically, but
   changes what the Architect may produce rather than what the comment carries, and leaves the doubling in place.

## Decision

**Option 2: the machine block gets its own comment.**

- The human comment keeps `PLAN_COMMENT_MARKER` plus the cost section and the normalised rendering; the block
  carries `PLAN_BLOCK_MARKER`. `findPlanComment` still finds the plan, so a retry still updates rather than stacks.
- `parsePlanFromComments(comments)` reads the pair, and still reads a plan posted as ONE comment, because tickets
  already carry that shape. The legacy path is not optional.
- One canonical budget, `MAX_COMMENT_CHARS` (60000), shared with `sprint-delivery` so the two cannot drift, and
  `GITHUB_COMMENT_LIMIT` (65536) recorded beside it.
- Either comment over the budget refuses BEFORE the network, naming the limit and the measured size, rather than
  letting GitHub answer with a 422 that names nothing (AC4).

Measured after the split: human 33,343 and block 33,011, each about 51% of the limit.

## Consequences

- Both premises hold: the human approves the plan in full, and the resumed run reads the plan in full.
- **The bound is per comment, not per plan.** A plan can now be about twice as large before anything refuses.
  That is the point of the change, and it is stated rather than implied: the ceiling is one comment's worth per
  half, and the pre-flight names which half exceeded it.
- The read-back contract changed, and is backward compatible: a single-comment plan still parses, so tickets that
  predate this keep resuming.
- Cost: a plan now occupies two comments, and the machine block appears on the ticket as its own collapsed block
  rather than folded into the plan comment.
- The worst case is derived from the Architect's output budget, so the assertion that pins it reads that constant
  rather than hard-coding a fixture size.
