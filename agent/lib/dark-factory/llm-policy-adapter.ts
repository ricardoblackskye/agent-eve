/**
 * Dark Factory — LLM policy provider adapter (#208, epic #206 R7.2).
 *
 * Maps the canonical `LlmPolicy` onto provider request parameters. The policy
 * itself carries no vendor fields, so a provider change means a new adapter, not
 * a change to `LlmPolicy`.
 *
 * Degradation is REPORTED, never silent: a model that cannot reason receives no
 * reasoning parameters and the result says so, so the dashboard can show the
 * no-op rather than implying the level took effect.
 */

import type { LlmPolicy, ThinkingLevel } from "./llm-policy";

export interface AppliedPolicy {
  /** The model to use: the policy override when present, else the input model. */
  model: string;
  reasoning?: { effort: ThinkingLevel };
  /** True when the requested thinking level actually reached the provider. */
  applied: boolean;
  /** Why the level was not applied, when it was not. */
  reason?: string;
}

/**
 * Models known to support provider-side reasoning, matched by prefix.
 *
 * Anything NOT listed is treated as incapable. That direction is deliberate:
 * assuming capability would send reasoning parameters to a model that rejects
 * them, turning a config typo into a hard call failure — whereas assuming
 * incapability degrades to a documented no-op.
 *
 * The two entries this project actually relies on are evidenced in
 * `scripts/pr-reviewer.ts`: `deepseek-v4.1-flash` is documented there as a
 * REASONING model, and `deepseek-chat` as a NON-reasoning model (#87).
 */
const REASONING_CAPABLE_PREFIXES = [
  "deepseek/deepseek-v4",
  "deepseek/deepseek-reasoner",
  "openai/o1",
  "openai/o3",
  "anthropic/claude-3.7",
  "anthropic/claude-sonnet-4",
  "google/gemini-2.5",
];

/** Whether the model can be sent provider-side reasoning parameters. */
export function supportsReasoning(model: string): boolean {
  const id = (model ?? "").trim().toLowerCase();
  if (id === "") return false;
  return REASONING_CAPABLE_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * Map a policy onto provider parameters.
 *
 * `off` is an INSTRUCTION, not a degradation: it produces no reasoning parameter
 * and still counts as applied. Only a model that cannot reason yields
 * `applied: false`, and it carries a reason naming the model.
 *
 * Only `reasoning.effort` is ever emitted. OpenRouter rejects a request carrying
 * both `effort` and `max_tokens` with HTTP 400 (documented in
 * `scripts/pr-reviewer.ts`), so that combination is impossible by construction.
 */
export function applyThinkingPolicy(
  model: string,
  policy: LlmPolicy,
): AppliedPolicy {
  const resolved = (policy.model ?? model).trim();

  if (policy.thinkingLevel === "off") {
    return { model: resolved, applied: true };
  }

  if (!supportsReasoning(resolved)) {
    return {
      model: resolved,
      applied: false,
      reason:
        `${resolved} does not support provider-side reasoning; thinking level ` +
        `'${policy.thinkingLevel}' was not applied.`,
    };
  }

  return {
    model: resolved,
    reasoning: { effort: policy.thinkingLevel },
    applied: true,
  };
}