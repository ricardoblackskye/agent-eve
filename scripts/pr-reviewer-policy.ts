/**
 * PR-reviewer LLM policy integration (#208, epic #206 R7.2).
 *
 * Keeps the policy wiring out of the 650-line reviewer script so it can be unit
 * tested — the same split used for the cost-budget and usage-ledger wiring.
 *
 * The policy is OPT-IN. With no `DF_LLM_*` variable set, the reviewer keeps its
 * existing behaviour exactly (`PR_REVIEW_MODEL` plus the reasoning `max_tokens`
 * cap), so an unconfigured deployment is unchanged.
 */

import { applyThinkingPolicy } from "../agent/lib/dark-factory/llm-policy-adapter";
import {
  isLlmPolicyConfigured,
  resolveLlmPolicy,
  type ThinkingLevel,
} from "../agent/lib/dark-factory/llm-policy";

export interface ReviewRequestPolicy {
  model: string;
  /** Present only when the policy applied a thinking level. */
  reasoning?: { effort: ThinkingLevel };
  /** True when the requested level actually reached the provider. */
  applied: boolean;
  /** Why the level was not applied, when it was not. */
  reason?: string;
  /**
   * True when no policy is configured, so the caller must keep its legacy
   * `PR_REVIEW_*` behaviour rather than deriving anything from the policy.
   */
  legacy: boolean;
}

/**
 * Resolve the review request's model and reasoning parameters.
 *
 * A malformed policy THROWS rather than falling back to the legacy path: an
 * operator who mistyped a level must not be silently reviewed with defaults.
 */
export function resolveReviewRequestPolicy(
  env: Record<string, string | undefined>,
  fallbackModel: string,
): ReviewRequestPolicy {
  if (!isLlmPolicyConfigured(env)) {
    return { model: fallbackModel, applied: false, legacy: true };
  }

  const applied = applyThinkingPolicy(fallbackModel, resolveLlmPolicy(env));

  return {
    model: applied.model,
    ...(applied.reasoning !== undefined
      ? { reasoning: applied.reasoning }
      : {}),
    applied: applied.applied,
    ...(applied.reason !== undefined ? { reason: applied.reason } : {}),
    legacy: false,
  };
}
