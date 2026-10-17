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

/**
 * The ONE allow-list, so the ticket wording and the tests agree on it.
 *
 * Entries are already NORMALIZED (lowercase, no emphasis, no surrounding punctuation), because the
 * comparison is a whole-message equality after normalization. Extending the list is a one-line change
 * with a test — the alternative, a model that scores the reply, is a recorded follow-up rather than a
 * reason to guess here.
 */
export const PLAN_APPROVAL_PHRASES: readonly string[] = [
  "approved",
  "approve",
  "i approve",
  "i approve the plan",
  "approve the plan",
  "lgtm",
  "looks good",
  "go ahead",
  "proceed",
  "ship it",
];

/** Default cap on revision rounds. Overridable by `DF_MAX_PLAN_REVISIONS`. */
export const DEFAULT_MAX_PLAN_REVISIONS = 5;

/** The environment variable that overrides the revision cap. */
export const MAX_PLAN_REVISIONS_ENV = "DF_MAX_PLAN_REVISIONS";

/**
 * Normalize a reply so wording and formatting cannot decide the outcome.
 *
 * Emphasis markers, backticks, surrounding quotes, whitespace runs, case and trailing punctuation are
 * all noise: a human typing `**Approved**` has approved. Normalizing first also means the allow-list
 * does not need a variant per formatting style.
 */
function normalizePlanResponse(raw: string): string {
  return (raw ?? "")
    .replace(/`/g, "")
    .replace(/[*_~]/g, "")
    .trim()
    .replace(/^["'\u201c\u201d\u2018\u2019]+/, "")
    .replace(/["'\u201c\u201d\u2018\u2019]+$/, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/[.!?,;:\s]+$/, "")
    .trim();
}

/**
 * Decide whether a reply approves the plan or asks for a revision.
 *
 * The approval test is a WHOLE-MESSAGE match. Containment would be wrong in the one direction that
 * matters: "Approved, but also update the header" contains an approval and a request, and coding
 * against a plan that is about to change is the failure this module exists to prevent. So a reply
 * carrying anything else is feedback.
 */
export function classifyPlanResponse(commentBody: string): PlanResponseDecision {
  const normalized = normalizePlanResponse(commentBody);

  if (normalized === "") {
    return {
      kind: "revision",
      reason:
        "the reply was empty, so there is nothing to approve; treating it as plan feedback (fail-closed)",
    };
  }

  const matched = PLAN_APPROVAL_PHRASES.find((phrase) => phrase === normalized);
  if (matched !== undefined) {
    return {
      kind: "approval",
      reason: `the reply is an explicit approval ('${matched}')`,
      matched,
    };
  }

  return {
    kind: "revision",
    reason:
      "the reply is not an explicit approval, so it is treated as plan feedback (approval is opt-in)",
  };
}

/**
 * Resolve the revision cap.
 *
 * A blank value counts as unsent and falls through to the default; a supplied-but-invalid one is
 * REFUSED. Defaulting a malformed value would silently run with a different cap than the one asked
 * for, which is worse than refusing — the operator would believe the environment said `2` while the
 * run used `5`.
 */
export function resolveMaxPlanRevisions(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = (env[MAX_PLAN_REVISIONS_ENV] ?? "").trim();
  if (raw === "") return DEFAULT_MAX_PLAN_REVISIONS;

  const malformed = !/^\d+$/.test(raw) || Number(raw) <= 0;
  if (malformed) {
    throw new Error(
      `${MAX_PLAN_REVISIONS_ENV} must be a positive integer (received "${raw}").`,
    );
  }
  return Number(raw);
}
