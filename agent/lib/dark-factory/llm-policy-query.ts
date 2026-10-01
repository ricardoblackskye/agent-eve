/**
 * Dark Factory — effective LLM policy report (#208, epic #206 R7.2).
 *
 * Pure shaping for the operator dashboard: resolves the canonical policy and
 * reports, per LLM surface, the model that will be used and whether the thinking
 * level actually reached the provider.
 *
 * Read-only, and never returns a secret — the policy carries no credentials, and
 * the surface models are ids, not keys.
 */

import { applyThinkingPolicy } from "./llm-policy-adapter";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_THINKING_LEVEL,
  isLlmPolicyConfigured,
  resolveLlmPolicy,
  type ThinkingLevel,
} from "./llm-policy";

export type LlmPolicySurfaceName = "orchestrator" | "worker" | "pr-review";

export interface LlmPolicySurfaceInput {
  surface: LlmPolicySurfaceName;
  /** The model this surface uses when the policy sets no override. */
  defaultModel: string;
}

export interface LlmPolicySurfaceView {
  surface: LlmPolicySurfaceName;
  model: string;
  thinkingLevel: ThinkingLevel;
  /** True when the level actually reached the provider for this surface. */
  applied: boolean;
  /** Why it did not, when it did not. */
  reason?: string;
  /** True when no policy is configured, so the surface keeps its own defaults. */
  legacy: boolean;
}

export interface LlmPolicyReport {
  /** True when any `DF_LLM_*` variable is set. */
  configured: boolean;
  thinkingLevel: ThinkingLevel;
  maxSteps: number;
  /** Present only when the policy sets an override. */
  model?: string;
  surfaces: LlmPolicySurfaceView[];
}

/**
 * Build the effective-policy report.
 *
 * A malformed policy THROWS rather than reporting the defaults: showing an
 * operator a tidy `medium` when their configured value is rejected would be
 * exactly the silent misconfiguration this release removes.
 */
export function buildLlmPolicyReport(
  env: Record<string, string | undefined>,
  surfaces: LlmPolicySurfaceInput[],
): LlmPolicyReport {
  const configured = isLlmPolicyConfigured(env);
  const policy = configured ? resolveLlmPolicy(env) : null;

  const views: LlmPolicySurfaceView[] = surfaces.map((input) => {
    if (!policy) {
      return {
        surface: input.surface,
        model: input.defaultModel,
        thinkingLevel: DEFAULT_THINKING_LEVEL,
        applied: false,
        legacy: true,
      };
    }

    const applied = applyThinkingPolicy(input.defaultModel, policy);
    return {
      surface: input.surface,
      model: applied.model,
      thinkingLevel: policy.thinkingLevel,
      applied: applied.applied,
      ...(applied.reason !== undefined ? { reason: applied.reason } : {}),
      legacy: false,
    };
  });

  return {
    configured,
    thinkingLevel: policy?.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
    maxSteps: policy?.maxSteps ?? DEFAULT_MAX_STEPS,
    ...(policy?.model !== undefined ? { model: policy.model } : {}),
    surfaces: views,
  };
}
