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

/** Not implemented yet (RED stub for #365 Task 11). */
export function planCommentBody(_markdown: string): string {
  throw new Error("planCommentBody is not implemented");
}

/** Not implemented yet (RED stub for #365 Task 11). */
export function findPlanComment(
  _comments: PlanCommentRecord[],
): PlanCommentRecord | undefined {
  throw new Error("findPlanComment is not implemented");
}

/** Not implemented yet (RED stub for #365 Task 11). */
export async function postPlanComment(
  _target: PlanCommentTarget,
  _options: PostPlanCommentOptions,
): Promise<PlanCommentResult> {
  throw new Error("postPlanComment is not implemented");
}
