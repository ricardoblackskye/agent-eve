/**
 * Dark Factory — tenant usage report (#213, epic #212 R1).
 *
 * Operator-only, read-only aggregation of measured usage and cost BY TENANT
 * over a time window. Counts only — no prompt or completion text.
 *
 * Two invariants carry the whole report:
 *  - Unattributed usage lands in its OWN `unassigned` bucket. It is never folded
 *    into a customer's total, because unattributed spend is not any customer's
 *    spend.
 *  - An unmeasured value stays ABSENT, so the UI renders `—` rather than `0`.
 *    A `0` asserts we measured zero, which is a different and false claim.
 *
 * A malformed window is a CALLER error (400), deliberately distinguished from
 * an unavailable ledger (503): conflating the two sends an operator hunting for
 * a database outage when they simply typed a bad date.
 */
import type {
  UsageAggregate,
  UsageStore,
  UsageTenantTotals,
} from "./usage-store";
import { normalizeUsageWindow } from "./usage-query";

export interface TenantUsageReport {
  from?: string;
  to?: string;
  totals: UsageAggregate["totals"];
  /** Attributed tenants only, sorted by tenant id. */
  byTenant: UsageTenantTotals[];
  /** Usage carrying no tenant — its own bucket, never a customer's total. */
  unassigned: UsageTenantTotals;
  /** Events carrying no measurement at all — rendered `—`, never `0`. */
  unmeasured: number;
}

export type TenantUsageQueryResult =
  | { ok: true; report: TenantUsageReport }
  | { ok: false; status: 400 | 503; error: string };

export interface TenantUsageParams {
  from?: string;
  to?: string;
  /** Restrict to a single tenant. Absent means every tenant. */
  tenantId?: string;
}

export async function queryTenantUsage(
  store: UsageStore,
  params: TenantUsageParams = {},
): Promise<TenantUsageQueryResult> {
  let window: { from?: string; to?: string };
  try {
    window = normalizeUsageWindow(params);
  } catch (error) {
    return {
      ok: false,
      status: 400,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const read = await store.aggregate({
    ...window,
    ...(params.tenantId !== undefined ? { tenantId: params.tenantId } : {}),
  });

  if (!read.ok || read.value === null) {
    return {
      ok: false,
      status: 503,
      error: read.error ?? "Usage ledger is unavailable",
    };
  }

  return {
    ok: true,
    report: {
      ...window,
      totals: read.value.totals,
      byTenant: read.value.byTenant,
      unassigned: read.value.unassigned,
      unmeasured: read.value.unmeasured,
    },
  };
}