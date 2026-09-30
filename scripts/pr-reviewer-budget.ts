/**
 * PR-reviewer cost-budget integration.
 *
 * Keeps the budget wiring out of the 600-line reviewer script so it can be unit
 * tested. Governance is OPT-IN: when no budget backend is configured the
 * reviewer behaves exactly as before.
 */

import {
  createCostBudgetStore,
  isCostGovernanceConfigured,
} from "../agent/lib/dark-factory/cost-budget-store";
import {
  createCostGovernor,
  type CostGovernor,
  type CostGovernorRefusal,
} from "../agent/lib/dark-factory/cost-governor";

/** Thrown when the budget refuses the review call, so the caller can post the
 * structural fallback with a cause-accurate reason. */
export class ReviewBudgetRefusal extends Error {
  readonly reason: CostGovernorRefusal;
  constructor(reason: CostGovernorRefusal, detail?: string) {
    super(detail ?? `LLM cost budget refused the PR review call (${reason}).`);
    this.name = "ReviewBudgetRefusal";
    this.reason = reason;
  }
}

/** Returns a governor only when a real backend is configured; else `null`. */
export function createReviewGovernor(
  env: Record<string, string | undefined> = process.env,
): CostGovernor | null {
  if (!isCostGovernanceConfigured(env)) return null;
  return createCostGovernor(createCostBudgetStore(env), env);
}

/** Rough input-token estimate from prompt characters (~4 chars/token). */
export function estimateInputTokens(promptChars: number): number {
  return Math.max(1, Math.ceil(Math.max(0, promptChars) / 4));
}

export interface ReviewAdmission {
  /** Present only when a governor is active and admitted the call. */
  reservationId?: string;
}

/**
 * Admit the review call. Throws `ReviewBudgetRefusal` when refused; returns an
 * empty admission when governance is disabled.
 */
export async function admitReviewCall(
  governor: CostGovernor | null,
  model: string,
  promptChars: number,
  maxOutputTokens: number,
): Promise<ReviewAdmission> {
  if (!governor) return {};
  const decision = await governor.admit({
    category: "pr-review",
    model,
    inputTokens: estimateInputTokens(promptChars),
    outputTokens: Math.max(0, maxOutputTokens),
  });
  if (!decision.admitted || !decision.reservationId) {
    throw new ReviewBudgetRefusal(decision.reason ?? "budget_unavailable", decision.error);
  }
  return { reservationId: decision.reservationId };
}

/** OpenRouter reports USD cost on `usage.cost` (or `usage.total_cost`). */
export function extractOpenRouterCost(data: unknown): number | undefined {
  const usage = (data as { usage?: Record<string, unknown> } | null | undefined)?.usage;
  if (!usage) return undefined;
  const candidate = usage.cost ?? usage.total_cost;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

/** Reconcile the reservation; a no-op when governance is disabled. */
export async function settleReviewCall(
  governor: CostGovernor | null,
  reservationId: string | undefined,
  actualCostUsd: number | undefined,
): Promise<void> {
  if (!governor || !reservationId) return;
  await governor.settle(reservationId, actualCostUsd ?? null);
}