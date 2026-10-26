/**
 * Pure decisions behind the `df:cost-budget` operator CLI (follow-up to #478).
 *
 * Kept out of the script so it can be unit-tested without executing `main()`.
 */

import { isCostCategory, type CostCategory } from "./cost-budget";
import { utcMonth } from "./cost-governor";

export interface ParsedCostBudgetArgs {
  command: string;
  flags: Record<string, string>;
}

/** A configuration or input error, distinct from a runtime failure. */
export class CostBudgetAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostBudgetAdminError";
  }
}

/** `YYYY-MM`, matching the governor's own concrete-period test. */
const CONCRETE_PERIOD = /^\d{4}-\d{2}$/;

/** The categories a budget row can exist for, for the error message and usage. */
const SUPPORTED_CATEGORIES = "orchestrator, developer, tester, pr-review";

/**
 * Split `argv` into a command and `--name value` flags.
 *
 * A flag whose value is missing (or is itself another flag) is an error rather
 * than a silent empty string, so `--cap --period` cannot write a bogus cap.
 */
export function parseCostBudgetArgs(argv: string[]): ParsedCostBudgetArgs {
  const [command = "", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CostBudgetAdminError(`Missing value for --${name}`);
    }
    flags[name] = value;
    i += 1;
  }
  return { command, flags };
}

/**
 * The period to act on: a concrete `DF_COST_BUDGET_PERIOD` when one is
 * configured, else the current UTC month.
 *
 * Mirrors the governor's own resolution, so the CLI can never target a
 * different period than the gate reads.
 */
export function resolveBudgetPeriod(
  env: Record<string, string | undefined>,
  now: Date = new Date(),
): string {
  const configured = (env.DF_COST_BUDGET_PERIOD ?? "").trim();
  return CONCRETE_PERIOD.test(configured) ? configured : utcMonth(now);
}

/**
 * The cap after a top-up.
 *
 * Refuses a non-finite amount, and a result below zero: an operator typo must
 * not silently *reduce* the ceiling they meant to raise.
 */
export function computeToppedUpCap(
  currentCapUsd: number,
  amountUsd: number,
): number {
  if (!Number.isFinite(amountUsd)) {
    throw new CostBudgetAdminError("Top-up amount must be a finite number.");
  }
  const next = currentCapUsd + amountUsd;
  if (!Number.isFinite(next) || next < 0) {
    throw new CostBudgetAdminError(
      `Top-up would set the cap to ${next}, which is negative; refusing.`,
    );
  }
  return next;
}

/** Validate an operator-supplied category, or throw `CostBudgetAdminError`. */
export function toCostCategory(value: string): CostCategory {
  if (!isCostCategory(value)) {
    throw new CostBudgetAdminError(
      `Unknown cost category ${JSON.stringify(value)}. Supported: ${SUPPORTED_CATEGORIES}.`,
    );
  }
  return value;
}
