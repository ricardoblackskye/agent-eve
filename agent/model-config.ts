/**
 * Canonical model configuration for the Eve agent (issue #121 / #122).
 *
 * Single source of truth for which LLM the agent and its subagents use. Every
 * resolver imports `DEFAULT_MODEL_ID` / `FALLBACK_MODEL_ID` from here so a future
 * model swap is a one-line change in this file — not a search-and-replace across
 * four subagent files.
 *
 * The new model (DeepSeek V4.1 Flash) is verified to exist on OpenRouter under
 * the provider-prefixed id `deepseek/deepseek-v4.1-flash` (see
 * tests/model-availability.contract.test.ts). The previous model is retained as
 * the explicit FALLBACK so an unreachable primary degrades gracefully instead of
 * erroring.
 */

// New primary model — DeepSeek V4.1 Flash (OpenRouter provider-prefixed id).
export const DEFAULT_MODEL_ID = "deepseek/deepseek-v4.1-flash";

// Explicit fallback used only when the primary is unreachable AND a fallback is
// configured by the caller. Never applied silently.
export const FALLBACK_MODEL_ID = "deepseek/deepseek-v4-pro";

// Env var names kept here so the contract is documented in one place.
export const CHAT_MODEL_ENV = "EVE_CHAT_MODEL";
export const SUBAGENT_MODEL_ENV = "MODEL_NAME";

/**
 * Resolve the model id to use, with an explicit, testable fallback policy.
 *
 * Policy:
 *  - `envOverride` (when present and non-empty) wins — env config, no code change.
 *  - otherwise the `primary` (default new model).
 *  - when `primary` is `unreachable` AND `fallback` is provided, return `fallback`.
 *  - when `primary` is unreachable but NO `fallback` is provided, return `primary`
 *    anyway — the caller decides how to handle the outage. We must NEVER quietly
 *    serve the previous model (story AC: "no fallback ... unless ... a fallback is
 *    explicitly configured").
 */
export function resolveModelId(opts: {
  primary?: string;
  fallback?: string;
  unreachable?: boolean;
  envOverride?: string | undefined;
}): string {
  const primary = opts.primary ?? DEFAULT_MODEL_ID;
  const override = opts.envOverride?.trim();
  if (override) return override;
  if (opts.unreachable && opts.fallback) return opts.fallback;
  return primary;
}
