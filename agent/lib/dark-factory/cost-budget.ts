/**
 * Dark Factory — canonical cost budget types, price table, and estimation.
 *
 * One provider-neutral cost governance contract. Token budgets are converted
 * to USD via a model price table; the hard ceiling is always a USD amount per
 * period. No prompts or completion content is stored here.
 */

/** Canonical surfaces the budget governs. */
export const COST_CATEGORIES = [
  "orchestrator",
  "developer",
  "tester",
  "pr-review",
] as const;

export type CostCategory = (typeof COST_CATEGORIES)[number];

/**
 * Returns true for the four canonical categories; rejects empty, typos, and
 * casing variants. Used by callers to validate category at the seam.
 */
export function isCostCategory(value: unknown): value is CostCategory {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    COST_CATEGORIES.includes(value as CostCategory)
  );
}

/** Billing/tracking period. Default: monthly YYYY-MM, UTC. */
export const DEFAULT_COST_BUDGET_PERIOD = "YYYY-MM";

/** One per-(period, category) hard ceiling. */
export interface CostBudget {
  category: CostCategory;
  period: string;
  capUsd: number;
  spentUsd: number;
  callCount: number;
  /**
   * Cost currently reserved by in-flight LLM calls but not yet settled.
   * Optional so callers that only read cap/spent stay valid.
   */
  reservedUsd?: number;
  /**
   * Present only on a TENANT-scoped budget. Absent means the global,
   * non-tenant budget (#229) — the two are distinct rows, never merged.
   */
  tenantId?: string;
}

/**
 * Validates a fully materialized `CostBudget`. Kept distinct from `createCostBudget`
 * so callers can reuse this pure check on values read back from a store.
 */
export function isCostBudget(
  value: unknown,
): value is CostBudget {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.category !== "string") return false;
  if (!isCostCategory(v.category)) return false;
  if (typeof v.period !== "string") return false;
  if (v.period.trim() === "") return false;
  if (typeof v.capUsd !== "number" || !Number.isFinite(v.capUsd)) return false;
  if (v.capUsd < 0) return false;
  if (typeof v.spentUsd !== "number" || !Number.isFinite(v.spentUsd)) return false;
  if (v.spentUsd < 0) return false;
  if (typeof v.callCount !== "number" || !Number.isInteger(v.callCount)) return false;
  if (v.callCount < 0) return false;
  if (v.reservedUsd !== undefined) {
      if (typeof v.reservedUsd !== "number" || !Number.isFinite(v.reservedUsd)) return false;
      if (v.reservedUsd < 0) return false;
    }
    if (v.tenantId !== undefined) {
      if (typeof v.tenantId !== "string" || v.tenantId.trim() === "") return false;
    }
    return true;
  }

/** Name of the env var holding the unsecured cost-unit price table. */
const DF_MODEL_PRICE_PREFIX = "DF_MODEL_PRICE_";

/**
 * Resolve a canonical `<provider/model>` identifier to a per-1k-token USD price
 * table. Unknown/unset models return `null` — the governor must then refuse the
 * call (fail-closed), never guess.
 */
export interface ModelPrice {
  inputUsdPer1k: number;
  outputUsdPer1k: number;
}

/**
 * Default price table for known models. Operators may override individual
 * entries via `DF_MODEL_PRICE_<stableId>` env, or keep the defaults here.
 */
export const modelPriceTable: Record<string, ModelPrice> = {
  "deepseek/deepseek-chat": {
    inputUsdPer1k: 0.0001,
    outputUsdPer1k: 0.0003,
  },
};

/**
 * Normalize and look up a model id. Strips surrounding whitespace; unknown
 * returns null.
 */
export function resolvePrice(model: string | null | undefined): ModelPrice | null {
  if (typeof model !== "string" || model.trim() === "") return null;
  const normalized = model.trim().toLowerCase();
  const envOverride = process.env[`${DF_MODEL_PRICE_PREFIX}${normalized.replace(/[^A-Za-z0-9]/g, "_")}`];
  if (envOverride !== undefined) {
    const parts = envOverride.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length !== 2) return null;
    const [inStr, outStr] = parts;
    const inP = parseFloat(inStr);
    const outP = parseFloat(outStr);
    if (!Number.isFinite(inP) || !Number.isFinite(outP) || inP < 0 || outP < 0)
      return null;
    return { inputUsdPer1k: inP, outputUsdPer1k: outP };
  }
  const known = modelPriceTable[normalized];
  if (!known) return null;
  // Deep copy so callers never mutate the canonical table.
  return { ...known };
}

/**
 * Estimated USD cost for one LLM call, given a model id and approximate token
 * counts. Returns 0 when the model price is unknown (callers must then enforce
 * the store-level/policy-level refusal; this function is pure estimation).
 */
export function estimateCost(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = resolvePrice(model);
  if (!price) return 0;
  const inTokens = Math.max(0, inputTokens);
  const outTokens = Math.max(0, outputTokens);
  const inCost = (inTokens / 1000) * price.inputUsdPer1k;
  const outCost = (outTokens / 1000) * price.outputUsdPer1k;
  return inCost + outCost;
}

/**
 * Parsed result from `validateCostBudgetEnv`.
 */
export interface ResolvedCostBudgetEnv {
  period: string;
  categories: Record<CostCategory, number>;
}

/**
 * Fail-closed: throws `CostBudgetEnvError` when a required cap is missing,
 * non-numeric, or negative. Empty string and "abc" both fail.
 */
export class CostBudgetEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostBudgetEnvError";
  }
}

function parseCap(key: string, raw: string | undefined): number {
  if (raw === undefined || raw === undefined) {
    return NaN;
  }
  if (raw.trim() === "") return NaN;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return n;
}

/**
 * Convert raw env into a canonical resolved budget config usable by the
 * store factory and governor. Unrecognized keys are ignored.
 */
export function createCostGovernanceEnv(
  env: Record<string, string | undefined> = {},
): ResolvedCostBudgetEnv {
  const period =
    typeof env.DF_COST_BUDGET_PERIOD === "string" && env.DF_COST_BUDGET_PERIOD.trim() !== ""
      ? env.DF_COST_BUDGET_PERIOD.trim()
      : DEFAULT_COST_BUDGET_PERIOD;

  return {
    period,
    categories: {
      orchestrator: parseCap("DF_COST_BUDGET_ORCHESTRATOR_USD", env.DF_COST_BUDGET_ORCHESTRATOR_USD),
      developer: parseCap("DF_COST_BUDGET_DEVELOPER_USD", env.DF_COST_BUDGET_DEVELOPER_USD),
      tester: parseCap("DF_COST_BUDGET_TESTER_USD", env.DF_COST_BUDGET_TESTER_USD),
      "pr-review": parseCap("DF_COST_BUDGET_PR_REVIEW_USD", env.DF_COST_BUDGET_PR_REVIEW_USD),
    },
  };
}

/**
 * Fail-closed validation of the parsed env. Throws when any required cap is
 * missing, non-numeric, or negative so a misconfigured deployment cannot start
 * and silently lose budget control.
 */
export function validateCostBudgetEnv(
  env: Record<string, string | undefined> = {},
): ResolvedCostBudgetEnv {
  const resolved = createCostGovernanceEnv(env);
  const missing: string[] = [];
  if (Number.isNaN(resolved.categories.orchestrator))
    missing.push("DF_COST_BUDGET_ORCHESTRATOR_USD");
  if (Number.isNaN(resolved.categories.developer))
    missing.push("DF_COST_BUDGET_DEVELOPER_USD");
  if (Number.isNaN(resolved.categories.tester))
    missing.push("DF_COST_BUDGET_TESTER_USD");
  if (Number.isNaN(resolved.categories["pr-review"]))
    missing.push("DF_COST_BUDGET_PR_REVIEW_USD");
  if (missing.length > 0) {
    throw new CostBudgetEnvError(
      `DF cost-budget requires non-negative numeric caps for: ${missing.join(", ")}.`,
    );
  }
  return resolved;
}

/**
 * Helper: create a `CostBudget` from parsed env + store snapshot. Used after
 * the store is wired; kept pure for tests.
 */
export function createCostBudget(
  category: CostCategory,
  period: string,
  capUsd: number,
  spentUsd: number,
  callCount: number,
): CostBudget {
  return { category, period, capUsd, spentUsd, callCount };
}

/** Fail-closed config error for the budget store factory. */
export class CostBudgetConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostBudgetConfigurationError";
  }
}
