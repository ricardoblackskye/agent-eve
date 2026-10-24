/**
 * Dark Factory — LLM cost governor.
 *
 * Sits between an LLM call site and the budget store. It estimates the call's
 * maximum cost from the model price table, reserves it against the category's
 * cap, and reconciles the actual cost afterwards. Every refusal is a structured
 * result (never a thrown crash) so a call site can short-circuit cleanly.
 *
 * FAIL-CLOSED: an unconfigured cap, an unknown model price, or an unavailable
 * store all refuse the call rather than letting it run unbounded.
 */

import {
  type CostBudget,
  type CostCategory,
  createCostGovernanceEnv,
  estimateCost,
  resolvePrice,
} from "./cost-budget";
import {
  type CostBudgetStore,
  costBudgetId,
} from "./cost-budget-store";

/** Why a call was refused. Machine-readable for run status/UI. */
export type CostGovernorRefusal =
  | "not_configured"
  | "unpriced_model"
  | "budget_exceeded"
  | "budget_unavailable"
  | "tenant_unconfigured";

export interface CostGovernorDecision {
  admitted: boolean;
  /** Present only when admitted. */
  reservationId?: string;
  estimatedUsd?: number;
  period?: string;
  reason?: CostGovernorRefusal;
  error?: string;
  /**
   * Echoed when the decision was made for a tenant, so a refusal is
   * attributable to the customer rather than a generic error (#230).
   */
  tenantId?: string;
}

export interface CostGovernorAdmitInput {
  category: CostCategory;
  /** Provider model id; `null`/unknown is refused, never estimated at zero. */
  model: string | null | undefined;
  inputTokens: number;
  outputTokens: number;
  /**
   * The attributed customer tenant (#229). Absent governs the GLOBAL budget;
   * present governs that tenant's operator-provisioned budget.
   */
  tenantId?: string;
}

export interface CostGovernorSettleResult {
  ok: boolean;
  error?: string;
}

export interface CostGovernor {
  readonly id: string;
  /** The active billing period key for a given instant (UTC `YYYY-MM`). */
  period(now?: Date): string;
  admit(input: CostGovernorAdmitInput): Promise<CostGovernorDecision>;
  settle(reservationId: string, actualCostUsd: number | null): Promise<CostGovernorSettleResult>;
  /** Read-only budget rows, for the operator dashboard. */
  status(period?: string): Promise<CostBudget[]>;
}

/** `YYYY-MM` in UTC. */
export function utcMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/**
 * #457 - the reaper's schedule. A reservation covers ONE model call, so 30 minutes is far
 * beyond any legitimate call (Vercel's maximum function duration is 900 s) and far inside the
 * 11 days a stranded reservation survived in production. ADR 0054 states plainly that this
 * TTL is a guess: too short reaps a live call and lets a slow turn overspend; too long
 * strands budget.
 */
export const RESERVATION_TTL_MS = 30 * 60 * 1000;

/** At most one reap per process per interval: one extra store round trip, not one per turn. */
export const REAP_INTERVAL_MS = 10 * 60 * 1000;

const CONCRETE_PERIOD = /^\d{4}-\d{2}$/;

export function createCostGovernor(
  store: CostBudgetStore,
  env: Record<string, string | undefined> = process.env,
): CostGovernor {
  const resolved = createCostGovernanceEnv(env);
  const configuredPeriod = resolved.period;

  /**
   * Epoch ms of the last reap THIS process ran; `0` means never, so the first admission in
   * every process reaps. Per governor instance, so two governors never share the throttle.
   */
  let lastReapMs = 0;

  const resolvePeriod = (now: Date = new Date()): string =>
    CONCRETE_PERIOD.test(configuredPeriod) ? configuredPeriod : utcMonth(now);

  return {
    id: `governor:${store.id}`,

    period: resolvePeriod,

    async admit(input: CostGovernorAdmitInput): Promise<CostGovernorDecision> {
      const period = resolvePeriod();
      const cap = resolved.categories[input.category];
      if (typeof cap !== "number" || !Number.isFinite(cap)) {
        return {
          admitted: false,
          reason: "not_configured",
          period,
          error: `No cost cap configured for category '${input.category}'.`,
        };
      }
      if (!resolvePrice(input.model)) {
        return {
          admitted: false,
          reason: "unpriced_model",
          period,
          error: `No price is known for model '${String(input.model)}'; refusing an unbounded call.`,
        };
      }
      const estimatedUsd = estimateCost(input.model, input.inputTokens, input.outputTokens);

      // A TENANT budget is operator-provisioned: an unprovisioned tenant is
      // refused with its own reason, never auto-created, so a missing customer
      // cap cannot silently fail open. The GLOBAL budget is materialized from
      // the env caps, exactly as before.
      if (input.tenantId) {
        const existing = await store.listTenantBudgets(input.tenantId, period);
        if (!existing.ok) {
          return {
            admitted: false,
            reason: "budget_unavailable",
            period,
            tenantId: input.tenantId,
            error: existing.error ?? "Cost budget store is unavailable.",
          };
        }
        if (existing.value.length === 0) {
          return {
            admitted: false,
            reason: "tenant_unconfigured",
            period,
            tenantId: input.tenantId,
            error: `No budget is configured for tenant '${input.tenantId}' in ${period}.`,
          };
        }
      } else {
        const ensured = await store.ensureBudget(period, input.category, cap);
        if (!ensured.ok) {
          return {
            admitted: false,
            reason: "budget_unavailable",
            period,
            error: ensured.error ?? "Cost budget store is unavailable.",
          };
        }
      }

      // #457 - schedules the reaper that ADR 0054 Slice B shipped but nothing called. The
      // leak is created only by processes that admit, so the release belongs here too; reaping
      // BEFORE the reservation means the freed budget is available to this very call. It is
      // throttled per process so a turn does not pay a store round trip, and best-effort so a
      // store that cannot reap still reports its own admission refusal.
      const nowMs = Date.now();
      if (nowMs - lastReapMs >= REAP_INTERVAL_MS) {
        lastReapMs = nowMs;
        try {
          await store.reapStaleReservations(RESERVATION_TTL_MS);
        } catch {
          // Swallowed on purpose: the backstop must never veto the call it protects.
        }
      }

      const reserved = await store.reserve(
        period,
        input.category,
        estimatedUsd,
        input.tenantId,
      );
      if (!reserved.ok || !reserved.reservationId) {
        const exceeded = /exceed/i.test(reserved.error ?? "");
        return {
          admitted: false,
          reason: exceeded ? "budget_exceeded" : "budget_unavailable",
          period,
          ...(input.tenantId ? { tenantId: input.tenantId } : {}),
          error: reserved.error ?? "Cost budget reservation was refused.",
        };
      }

      return {
        admitted: true,
        reservationId: reserved.reservationId,
        estimatedUsd,
        period,
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      };
    },

    async settle(
      reservationId: string,
      actualCostUsd: number | null,
    ): Promise<CostGovernorSettleResult> {
      const settled = await store.settle(reservationId, actualCostUsd);
      return settled.ok ? { ok: true } : { ok: false, error: settled.error };
    },

    async status(period?: string): Promise<CostBudget[]> {
      const read = await store.listBudgets(period ?? resolvePeriod());
      return read.ok ? read.value : [];
    },
  };
}

/** Budget row key helper, re-exported for callers that store reservation ids. */
export { costBudgetId };