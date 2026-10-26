/**
 * Pure decisions behind the `df:cost-budget` operator CLI (follow-up to #478).
 *
 * Kept out of the script so it can be unit-tested without executing `main()`.
 */

import type { CostCategory } from "./cost-budget";

export interface ParsedCostBudgetArgs {
  command: string;
  flags: Record<string, string>;
}

export function parseCostBudgetArgs(_argv: string[]): ParsedCostBudgetArgs {
  throw new Error("not implemented");
}

export function resolveBudgetPeriod(
  _env: Record<string, string | undefined>,
  _now: Date = new Date(),
): string {
  throw new Error("not implemented");
}

export function computeToppedUpCap(_currentCapUsd: number, _amountUsd: number): number {
  throw new Error("not implemented");
}

export function toCostCategory(_value: string): CostCategory {
  throw new Error("not implemented");
}
