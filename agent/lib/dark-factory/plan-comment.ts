/**
 * Dark Factory — the plan comment on the ticket (#365, Task 11).
 *
 * The plan only reached the branch, and only after the run had finished. Posting it as a comment right
 * after planning means a reviewer can see the intent BEFORE any code exists, even if the run later fails.
 *
 * The comment is marked so a retry can find its own work: a second run updates the existing comment
 * instead of stacking another one on the ticket.
 */

/** The marker identifying this Factory's own plan comment, whatever the plan says. */
export const PLAN_COMMENT_MARKER = "<!-- dark-factory:plan -->";

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
export function planCommentBody(markdown: string): string {
  return `${PLAN_COMMENT_MARKER}\n\n${markdown}`;
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
  const body = planCommentBody(options.markdown);

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
