/**
 * Dark Factory — worker LLM policy contract (#208, epic #206 R7.2).
 *
 * The sandbox never receives a credential. Instead it receives the NON-SECRET
 * LLM policy governing its calls, so a worker's thinking level and step bound
 * match the orchestrator's. Returns `null` when no policy is configured, so an
 * unconfigured deployment's sandbox is unchanged.
 *
 * The injected names are the canonical `DF_LLM_*` variables, so a sandbox can
 * call `resolveLlmPolicy(process.env)` and reach the same answer rather than
 * re-deriving the mapping — one definition of the policy, not two.
 */

import {
  isLlmPolicyConfigured,
  POLICY_MAX_STEPS_VAR,
  POLICY_MODEL_VAR,
  POLICY_THINKING_LEVEL_VAR,
  resolveLlmPolicy,
  type ThinkingLevel,
} from "./llm-policy";

export interface WorkerPolicyEnv {
  thinkingLevel: ThinkingLevel;
  maxSteps: number;
  /** Non-secret env values injected into the sandbox (names/values, no secrets). */
  env: Record<string, string>;
}

/**
 * Build the policy contract for a worker task. `null` means "no policy
 * configured" — the worker must then run exactly as before rather than
 * inventing a policy.
 *
 * A malformed policy THROWS rather than injecting defaults: the sandbox must
 * never silently run with a level the operator did not ask for.
 */
export function buildWorkerPolicyEnv(
  env: Record<string, string | undefined> = process.env,
): WorkerPolicyEnv | null {
  if (!isLlmPolicyConfigured(env)) return null;

  const policy = resolveLlmPolicy(env);

  return {
    thinkingLevel: policy.thinkingLevel,
    maxSteps: policy.maxSteps,
    env: {
      [POLICY_THINKING_LEVEL_VAR]: policy.thinkingLevel,
      [POLICY_MAX_STEPS_VAR]: String(policy.maxSteps),
      ...(policy.model !== undefined
        ? { [POLICY_MODEL_VAR]: policy.model }
        : {}),
    },
  };
}
