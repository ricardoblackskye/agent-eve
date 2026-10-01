/**
 * Dark Factory — usage dashboard report (#209, epic #206 R7.3).
 *
 * Pure shaping for the operator dashboard: validates the time window, reads the
 * ledger through the seam, and hands back a report whose unmeasured values stay
 * ABSENT so the UI renders `—` instead of a misleading `0`.
 *
 * Operator-only and read-only. Counts only — no prompt or completion text.
 *
 * A malformed window is a CALLER error (400) and is deliberately distinguished
 * from an unavailable ledger (503): conflating the two would send an operator
 * hunting for a database outage when they simply typed a bad date.
 */

import type {
  UsageAggregate,
  UsageDayTotals,
  UsageModelTotals,
  UsageRunTotals,
  UsageStore,
} from "./usage-store";

export interface UsageReport {
  /** Inclusive lower bound actually applied, when one was given. */
  from?: string;
  /** Exclusive upper bound actually applied, when one was given. */
  to?: string;
  totals: UsageAggregate["totals"];
  byModel: UsageModelTotals[];
  byDay: UsageDayTotals[];
  byRun: UsageRunTotals[];
  /** Events carrying no measurement at all — shown as `—`, never `0`. */
  unmeasured: number;
}

export interface UsageQueryParams {
  from?: string;
  to?: string;
  runId?: string;
  model?: string;
}

export type UsageQueryResult =
  | { ok: true; report: UsageReport }
  | { ok: false; status: 400 | 503; error: string };

export class InvalidUsageWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUsageWindowError";
  }
}

/** Normalise one window bound; an empty string means "not supplied". */
function normalizeBound(
  value: string | undefined,
  field: "from" | "to",
): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (text === "") return undefined;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw new InvalidUsageWindowError(`"${field}" must be an ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

/**
 * Normalise and validate a usage window.
 *
 * Shared by every usage report so the 400 semantics cannot drift between
 * them: two copies would be two chances to disagree about what a valid
 * window is.
 */
export function normalizeUsageWindow(params: {
  from?: string;
  to?: string;
}): { from?: string; to?: string } {
  const from = normalizeBound(params.from, "from");
  const to = normalizeBound(params.to, "to");
  if (from !== undefined && to !== undefined && from >= to) {
    throw new InvalidUsageWindowError('"to" must be later than "from"');
  }
  return {
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  };
}

export async function queryUsage(
  store: UsageStore,
  params: UsageQueryParams = {},
): Promise<UsageQueryResult> {
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
  const { from, to } = window;

  const read = await store.aggregate({
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(params.runId !== undefined ? { runId: params.runId } : {}),
    ...(params.model !== undefined ? { model: params.model } : {}),
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
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      totals: read.value.totals,
      byModel: read.value.byModel,
      byDay: read.value.byDay,
      byRun: read.value.byRun,
      unmeasured: read.value.unmeasured,
    },
  };
}