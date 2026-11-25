/**
 * Dark Factory - how a human s reply to a DELIVERED run is read (#759).
 *
 * A parked plan and a delivered result ask different questions, so they are read by different
 * classifiers: `plan-response` decides whether coding may START, and this decides whether finished
 * work is accepted or sent back. Collapsing them is what made a completed issue read as unfinished.
 *
 * Approval is OPT-IN and fail-closed, for the same reason as the plan vocabulary: only explicit wording
 * decides. A reply that carries a sign-off AND a request is NOT a sign-off - "Approved, but also update
 * the header" contains an approval and a request, and closing a pull request on the strength of that
 * would be the worst outcome this module could produce.
 */

import { normalizeHumanReply } from "./plan-response";

export type SignOffKind = "approved" | "rejected" | "none";

export interface SignOffDecision {
  kind: SignOffKind;
  /** Human-readable and bounded; always explains the outcome. */
  reason: string;
  /** The allow-list entry that matched, when a decision was reached. */
  matched?: string;
}

/**
 * The ONE allow-list, kept deliberately tight.
 *
 * `plan-response` s list carries plan idioms ("lgtm", "ship it", "go ahead") which are permission to
 * START something. Sign-off is a different act and gets its own words: extending this list is a
 * one-line change with a test, and guessing beyond it is how an unclassifiable reply gets acted on.
 */
export const SIGNOFF_APPROVED_PHRASES: readonly string[] = ["approved", "approve"];

export const SIGNOFF_REJECTED_PHRASES: readonly string[] = ["rejected", "reject"];

export function classifySignOffResponse(_commentBody: string): SignOffDecision {
  throw new Error("classifySignOffResponse is not implemented");
}
