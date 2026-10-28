/**
 * Dark Factory — the plan comment on the ticket (#365, Task 11).
 *
 * The plan only reached the branch, and only after the run had finished. Posting it as a comment right
 * after planning means a reviewer can see the intent BEFORE any code exists, even if the run later fails.
 *
 * The comment is marked so a retry can find its own work: a second run updates the existing comment
 * instead of stacking another one on the ticket.
 */

import type { PlanCostEstimate } from "./plan-cost-estimate";

/** The marker identifying this Factory's own plan comment, whatever the plan says. */
export const PLAN_COMMENT_MARKER = "<!-- dark-factory:plan -->";

/** A markdown code fence. A constant because the block writes one and the parser looks for it. */
const FENCE = "```";

/**
 * The collapsed machine-readable block (#365 R4).
 *
 * It is appended LAST and closes the comment, which is what makes parsing unambiguous: `parsePlanFromComment`
 * anchors on the end of the body and on the last opening tag, so plan text containing "<details>" cannot
 * be mistaken for the block.
 */
const DETAILS_OPEN = "<details>";
const DETAILS_CLOSE = "</details>";

/** A comment as the ticket API returns it. */
export interface PlanCommentRecord {
  id: number;
  body?: string | null;
}

/** The subset of the issue writer this module needs, so it can be tested without any network. */
export interface PlanCommentTarget {
  listComments(
    owner: string,
    repo: string,
    issue: number,
  ): Promise<{ ok: boolean; comments?: PlanCommentRecord[]; error?: string }>;
  postComment(
    owner: string,
    repo: string,
    issue: number,
    body: string,
  ): Promise<{ ok: boolean; id?: number; error?: string }>;
  editComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string,
  ): Promise<{ ok: boolean; id?: number; error?: string }>;
}

export interface PostPlanCommentOptions {
  owner: string;
  repo: string;
  issue: number;
  markdown: string;
  /**
   * The plan itself, for the machine (#365 R4).
   *
   * A resumed dispatch is a fresh process with no workspace, so the plan it codes against has to survive
   * the wait on the ticket. The comment carries the human rendering AND this, so the thing the human
   * approved is the thing the resumed run reads back.
   *
   * REQUIRED, not optional (#373). It was optional, the runner omitted it, and the omission compiled and ran:
   * the comment then carried the human markdown with no machine-readable block, so the resumed run could not
   * read back the plan it had posted and stopped. A promise to pass it is not a fix; a compile error is.
   */
  plan: unknown;
  /**
   * The plan's cost estimate (#488), rendered into the human part under the marker.
   *
   * Optional, and absence is meaningful: no estimate renders no section, so a run that could not price
   * its plan still posts a readable comment rather than a placeholder nobody can interpret.
   */
  estimate?: PlanCostEstimate | null;
}

export type PlanCommentResult =
  | { ok: true; action: "created" | "updated"; id?: number }
  | { ok: false; action: "failed"; error: string };

/**
 * The comment body: the marker, then the plan.
 *
 * The marker leads so a human opening the ticket sees the plan immediately; an HTML comment renders as
 * nothing, so putting it first costs no visual noise while making the comment findable by a retry.
 */
export function planCommentBody(
  markdown: string,
  plan?: unknown,
  estimate?: PlanCostEstimate | null,
): string {
  // #488: the estimate sits directly under the marker, so whoever decides whether to approve meets the
  // forecast BEFORE committing to read the plan. No estimate, no section - never a placeholder, because
  // a reader cannot tell a placeholder from a measurement (see renderCostEstimateSection).
  const section = renderCostEstimateSection(estimate);
  const human = section
    ? `${PLAN_COMMENT_MARKER}\n\n${section}\n\n${markdown}`
    : `${PLAN_COMMENT_MARKER}\n\n${markdown}`;
  if (plan === undefined) {
    return human;
  }

  // Escaped so plan TEXT cannot become plan STRUCTURE. Both cases were caught by the tests here:
  // a rationale containing "</details>" would close the block early, and one containing a fence would
  // truncate the JSON payload at the first fence the parser found. These are valid JSON escapes that
  // decode back, so the round-trip stays exact.
  const json = JSON.stringify(plan)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/`/g, "\\u0060");

  return [
    human,
    "",
    DETAILS_OPEN,
    "<summary>Machine-readable plan (read back when this run resumes)</summary>",
    "",
    `${FENCE}json`,
    json,
    FENCE,
    "",
    DETAILS_CLOSE,
  ].join("\n");
}

/**
 * Money as a human reads it: two decimals, never exponent notation (#488).
 *
 * A non-finite value becomes 0 rather than "NaN": this section is cosmetic, and a broken number must
 * not render as nonsense in the one place a human is deciding whether to approve a run.
 */
function formatUsd(usd: number): string {
  const value = Number.isFinite(usd) ? usd : 0;
  return `$${value.toFixed(2)}`;
}

/**
 * The estimate section of the plan comment (#488, epic #453).
 *
 * Returns an empty string when there is no estimate. The ABSENCE of a section is the only honest
 * rendering of an absence: a placeholder ("unknown", "$0") reads as a measurement, and a reader
 * cannot tell a placeholder from a real zero. A COMPUTED estimate is always rendered, including a
 * zero band — suppressing one would make "computed, and zero" indistinguishable from "no estimate",
 * leaving one silence to carry two meanings.
 *
 * The middle figure (`expectedUsd`) is deliberately NOT rendered. It is the single number that reads
 * as a quote, and this is a forecast shown to somebody deciding whether to spend the money.
 */
export function renderCostEstimateSection(
  estimate?: PlanCostEstimate | null,
): string {
  if (!estimate) {
    return "";
  }
  return [
    `**Estimated cost: ${formatUsd(estimate.lowUsd)} – ${formatUsd(estimate.highUsd)}** ` +
      `(class \`${estimate.costClass}\`, confidence \`${estimate.confidence}\`)`,
    "",
    "Advisory only — a forecast from the plan's shape, not a quote. It does not block approval.",
  ].join("\n");
}

export type PlanParseResult =
  | { ok: true; plan: unknown }
  | { ok: false; error: string };

/**
 * Read the plan back out of a plan comment (#365 R4).
 *
 * Fails CLOSED. A comment from before this release carries no block, and a resumed run must stop rather
 * than code against a guessed plan — re-planning would be worse still, because the human approved the plan
 * they read, not a fresh one.
 */
export function parsePlanFromComment(commentBody: string): PlanParseResult {
  const body = (commentBody ?? "").replace(/\s+$/, "");
  if (!body.includes(PLAN_COMMENT_MARKER)) {
    return { ok: false, error: "this comment is not a Dark Factory plan comment" };
  }
  if (!body.endsWith(DETAILS_CLOSE)) {
    return {
      ok: false,
      error:
        "the plan comment carries no machine-readable plan (the marker is present, so the comment is ours; the block that carries the plan is missing)",
    };
  }

  const block = body.slice(body.lastIndexOf(DETAILS_OPEN));
  const fence = `${FENCE}json`;
  const fenceAt = block.indexOf(fence);
  if (fenceAt === -1) {
    return { ok: false, error: "the machine-readable plan block has no JSON fence" };
  }
  const afterFence = block.slice(fenceAt + fence.length);
  const closeAt = afterFence.indexOf(FENCE);
  if (closeAt === -1) {
    return { ok: false, error: "the machine-readable plan block is not closed" };
  }

  try {
    return { ok: true, plan: JSON.parse(afterFence.slice(0, closeAt).trim()) };
  } catch (error) {
    return {
      ok: false,
      error: `the machine-readable plan is not valid JSON: ${(error as Error).message}`,
    };
  }
}

/** This Factory's plan comment on a ticket, if it already has one. */
export function findPlanComment(
  comments: PlanCommentRecord[],
): PlanCommentRecord | undefined {
  return comments.find(
    (comment) =>
      typeof comment.body === "string" && comment.body.includes(PLAN_COMMENT_MARKER),
  );
}

/**
 * Post the plan on the ticket, updating this Factory's own comment if it is already there.
 *
 * Returns a result rather than throwing: whether a plan that cannot be posted should stop a run is the
 * caller's policy, not this function's. The runner fails closed on it, because a plan nobody can read
 * before coding is the exact defect this exists to fix.
 */
export async function postPlanComment(
  target: PlanCommentTarget,
  options: PostPlanCommentOptions,
): Promise<PlanCommentResult> {
  const body = planCommentBody(options.markdown, options.plan, options.estimate);

  const listed = await target.listComments(options.owner, options.repo, options.issue);
  if (!listed.ok) {
    return {
      ok: false,
      action: "failed",
      error: `could not read the ticket's comments: ${listed.error ?? "unknown error"}`,
    };
  }

  const existing = findPlanComment(listed.comments ?? []);
  if (existing) {
    // Update in place. Posting again would stack one comment per attempt on the ticket.
    const updated = await target.editComment(
      options.owner,
      options.repo,
      existing.id,
      body,
    );
    if (!updated.ok) {
      return {
        ok: false,
        action: "failed",
        error: `could not update the plan comment: ${updated.error ?? "unknown error"}`,
      };
    }
    return { ok: true, action: "updated", id: updated.id ?? existing.id };
  }

  const posted = await target.postComment(
    options.owner,
    options.repo,
    options.issue,
    body,
  );
  if (!posted.ok) {
    return {
      ok: false,
      action: "failed",
      error: `could not post the plan comment: ${posted.error ?? "unknown error"}`,
    };
  }
  return { ok: true, action: "created", id: posted.id };
}
