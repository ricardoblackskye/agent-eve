/**
 * Dark Factory — how a human's reply to a parked plan is read (#378).
 *
 * Until this existed, a comment on a parked plan was decoded as a RESUME and nothing else: the resume
 * path reads the frozen plan back off the ticket and codes against it, so a reply saying "the target
 * file is wrong, please update the plan" changed nothing while appearing to honour the human. The only
 * way to change a plan was a fresh run, which loses the thread of the original approval.
 *
 * Approval is OPT-IN and fail-closed. Only explicit approval wording counts; every other reply is
 * revision feedback. Deciding the other way round — treating an unclassifiable reply as approval —
 * would code against a plan no human accepted.
 */

export type PlanResponseKind = "approval" | "revision";

export interface PlanResponseDecision {
  kind: PlanResponseKind;
  /** Human-readable and bounded; always explains the outcome. */
  reason: string;
  /** The allow-list entry that matched, when the decision is an approval. */
  matched?: string;
}

export function classifyPlanResponse(_commentBody: string): PlanResponseDecision {
  throw new Error("not implemented");
}

export function resolveMaxPlanRevisions(
  _env: Record<string, string | undefined> = process.env,
): number {
  throw new Error("not implemented");
}
