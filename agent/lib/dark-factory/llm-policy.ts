/**
 * Dark Factory — canonical LLM call policy (#208, epic #206 R7.2).
 *
 * ONE provider-neutral description of how LLM calls should behave: how hard the
 * model should think, and how many steps it may take. Policy is ENV-driven and a
 * deploy-time setting — deliberately not DB-backed, unlike the R7.1 off-switch,
 * which is dynamic by nature.
 *
 * Resolution is FAIL-CLOSED: an unset value uses the documented default, but a
 * malformed or out-of-range value THROWS. A silent default is the exact failure
 * mode this module exists to remove — an operator who types `highish` must be
 * told, not quietly given `medium`.
 */

import { EnvConfigError } from "./circuit-breaker";

export { EnvConfigError };

export const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
export const DEFAULT_MAX_STEPS = 10;
/** Upper bound for a policy step count: beyond this the number is nonsense. */
export const MAX_POLICY_STEPS = 100;

export const POLICY_THINKING_LEVEL_VAR = "DF_LLM_THINKING_LEVEL";
export const POLICY_MAX_STEPS_VAR = "DF_LLM_MAX_STEPS";
export const POLICY_MODEL_VAR = "DF_LLM_MODEL";

/** Canonical, provider-agnostic LLM call policy. No vendor fields. */
export interface LlmPolicy {
  thinkingLevel: ThinkingLevel;
  maxSteps: number;
  /** Optional model override; absent means "use each surface's own default". */
  model?: string;
}

/** Read a variable as a trimmed string; an absent or blank value is "unset". */
function readVar(
  env: Record<string, string | undefined>,
  name: string,
): string {
  return (env[name] ?? "").trim();
}

function resolveThinkingLevel(
  env: Record<string, string | undefined>,
): ThinkingLevel {
  const raw = readVar(env, POLICY_THINKING_LEVEL_VAR).toLowerCase();
  if (raw === "") return DEFAULT_THINKING_LEVEL;
  if (!(THINKING_LEVELS as readonly string[]).includes(raw)) {
    throw new EnvConfigError(
      `${POLICY_THINKING_LEVEL_VAR} must be one of ${THINKING_LEVELS.join(", ")} ` +
        `(received ${JSON.stringify(env[POLICY_THINKING_LEVEL_VAR])}).`,
    );
  }
  return raw as ThinkingLevel;
}

/**
 * Digits-only validation, matching `resolveMaxIterations` in `developer-agent.ts`.
 *
 * `Number("3.0")` and `Number("1e3")` are both valid numbers but neither is a
 * sensible step count, so the shape is checked before the value — the same
 * reasoning that makes `"2.5"` a configuration error rather than a silent
 * truncation to 2.
 */
function resolveMaxSteps(
  env: Record<string, string | undefined>,
): number {
  const raw = readVar(env, POLICY_MAX_STEPS_VAR);
  if (raw === "") return DEFAULT_MAX_STEPS;
  if (!/^\d+$/.test(raw)) {
    throw new EnvConfigError(
      `${POLICY_MAX_STEPS_VAR} must be a positive integer (digits only, ` +
        `received '${raw}').`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_POLICY_STEPS) {
    throw new EnvConfigError(
      `${POLICY_MAX_STEPS_VAR} must be an integer between 1 and ${MAX_POLICY_STEPS} ` +
        `(received '${raw}').`,
    );
  }
  return value;
}

function resolveModel(
  env: Record<string, string | undefined>,
): string | undefined {
  const raw = readVar(env, POLICY_MODEL_VAR);
  return raw === "" ? undefined : raw;
}

/** Resolve the effective policy. Throws `EnvConfigError` on a malformed value. */
export function resolveLlmPolicy(
  env: Record<string, string | undefined> = process.env,
): LlmPolicy {
  const thinkingLevel = resolveThinkingLevel(env);
  const maxSteps = resolveMaxSteps(env);
  const model = resolveModel(env);
  return {
    thinkingLevel,
    maxSteps,
    ...(model !== undefined ? { model } : {}),
  };
}