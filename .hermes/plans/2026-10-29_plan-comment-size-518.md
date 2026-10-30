# 518 - the plan comment can exceed GitHub's 65,536-character body limit

## Goal

Make the plan comment bounded below GitHub's limit for a plan at `ARCHITECT_OUTPUT_TOKENS`, without weakening
#365's premise that the plan the human approves is the plan the run executes. Record the trade-off in an ADR
(AC2), test the measured worst case and the resume round-trip at size (AC3), and turn any remaining over-limit
case into a failure that NAMES the limit rather than a raw 422 (AC4).

## Verified findings

| Where | State |
| `planCommentBody` (`plan-comment.ts:204`) | the body is marker + cost section + human markdown + a `<details>` machine block. The last two EACH carry the whole plan, which is what doubles it |
| `parsePlanFromComment` (`:294`) | anchors on the END of the comment - `body.endsWith(DETAILS_CLOSE)` plus `lastIndexOf(DETAILS_OPEN)`. So the block must be the last thing in the comment, and moving it anywhere else is a read-back change, exactly as the issue says |
| size handling | none anywhere on this path: the body is built, posted, and GitHub's answer is whatever it is |
| in-repo precedent | `agent/lib/sprint-delivery.ts:28` already carries `MAX_COMMENT_CHARS = 60000; // GitHub's comment limit is 65536` - privately, not shared |
| #538's precedent | its docblock records that the human rendering is normalised while the machine payload is left byte-exact, because a resumed run reads the plan back out of it |

### Measured worst case (my own run, through the real renderers)

| | chars | vs 65,536 |
| `renderPlanFile(plan)` (human markdown) | 32,387 | 49% |
| `JSON.stringify(plan)` | 32,901 | 50% |
| full body as built today | **66,354** | **over by 818** |
| the human part alone | 33,343 | 51%, fits |
| the machine block alone | 33,011 | 51%, fits |
| resume round-trip on that body | parses today | baseline for AC3 |

The issue's own measurement is 33,320 / ~33k / 67,297 (67,455 with the cost section). Mine lands 1.4% lower on a
slightly different fixture, so the plan quotes the issue's figure as the worst case and uses mine as an
independent reproduction. Both are over.

## Options, against the evidence

1. **Truncate the human rendering.** Cheapest, and rejected: the reviewer would approve a partial plan while the
   resumed run reads the full one back, which breaks #365. #538 already refused this for the same reason.
2. **Move the machine block into its own comment.** Measured: each half then sits at ~51% of the limit, so the
   body is bounded by construction rather than by luck, and both halves stay whole - the human approves exactly
   what the run executes. The cost is the read-back stitch this issue names, contained in `findPlanComment` /
   `parsePlanFromComment` and the resume path, and it must keep reading a legacy single-comment plan.
3. **Bound the plan at its source** (`ARCHITECT_OUTPUT_TOKENS`, target-file count). It works arithmetically - a
   halved plan is roughly 33k combined - but it changes what the Architect may produce rather than what the
   comment carries, and it leaves the doubling in place with no explicit ceiling.

**Recommended: option 2**, plus AC4's pre-flight refusal so that even a single rendering over the limit fails
loudly with the limit in the message.

## Global constraints

- #365: the human comment must carry the plan in full. No truncation of what the human reads.
- #373: the machine block stays byte-exact, because the resume parses it.
- Backward compatibility: tickets that already carry ONE plan comment must keep resuming.
- The marker `PLAN_COMMENT_MARKER` stays on the human comment, so `findPlanComment` still finds the plan.

## Tasks

1. One shared comment-budget constant, exported, with the safety margin stated - replacing the private duplicate
   in `sprint-delivery.ts` so the two cannot drift.
2. Split the body: the human comment keeps marker + cost section + normalised markdown; the machine block becomes
   its own comment carrying its own marker.
3. Teach the read-back to stitch: parse the block from the sibling comment, and still parse a single legacy
   comment unchanged.
4. The pre-flight refusal (AC4): a body over the budget fails with a message naming the limit and the measured
   size, never a raw 422.
5. Tests (AC3): a worst-case fixture built from `ARCHITECT_OUTPUT_TOKENS` (40 tasks x 400 chars, 24 target files x
   500 chars, a 2,000-char approach), asserting the bound, the split, and the resume round-trip at size.
6. The ADR (AC2) recording option 2 and the trade-off it accepts, naming what option 1 and option 3 cost.
7. Docs: whatever documents the plan comment and the resume contract.

## Validation

- The plan-comment and resume suites, then the full DSN-enabled suite (expect the single known artefact).
- A local proof: build the worst-case plan and show the two comments' sizes and a successful round-trip.
- cspell and markdownlint over every changed file.

## Review focus

- The split changes a contract that has already shipped: existing tickets carry one comment. The legacy path is
  therefore not optional, and a test must pin it rather than trust it.
- The bound is on a single comment, not on the plan. Two comments mean the plan can be twice as large as today
  before anything fails - which is the point, and it must be stated in the ADR rather than left implied.
- The worst case is derived from the Architect's output budget, so it moves if that constant moves. The test should
  read the constant rather than hard-code the fixture size.

## Decisions

1. The approach: split the machine block (recommended, measured at ~51% per half) versus truncate the human
   rendering (breaks #365) versus bound the plan at its source.
2. The machine comment's marker: a new exported `PLAN_BLOCK_MARKER` (recommended) versus locating the block by
   position or fence (fragile - the parse already depends on position).
3. Legacy: keep reading a single-comment plan (recommended) versus migrate existing tickets.
4. The constant's home: one shared exported budget (recommended - the number is already duplicated privately)
   versus a private copy in `plan-comment.ts`.
5. AC4's shape: a pre-flight check returning a named error (recommended) versus surfacing GitHub's 422.
