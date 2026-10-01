/**
 * Dark Factory — LLM usage ledger store seam (#209, epic #206 R7.3).
 *
 * The write/read contract every driver implements, plus an in-memory default
 * and a no-loss buffered decorator. Mirrors the run-history seam: results are
 * structured (`{ok, mode, providerId, …}`) rather than thrown, so a store
 * outage surfaces as `ok: false` instead of terminating the caller.
 *
 * Recording is OPT-IN: an unset driver resolves to the in-memory adapter, which
 * keeps everything in-process and writes nowhere external.
 */

import { normalizeRunDateRange } from "./run-history";
import { toUsageEvent, type UsageEvent } from "./usage-ledger";

export interface UsageWriteResult {
  ok: boolean;
  mode: "live" | "blocked";
  providerId: string;
  event?: UsageEvent;
  error?: string;
}

export interface UsageReadResult<T> {
  ok: boolean;
  mode: "live" | "blocked";
  providerId: string;
  value: T | null;
  error?: string;
}

export interface UsageQuery {
  /** Inclusive lower bound for `ts`. */
  from?: string;
  /** Exclusive upper bound for `ts`. */
  to?: string;
  runId?: string;
  model?: string;
  /** Restrict to a single tenant. Absent means no tenant filter. */
  tenantId?: string;
}

export interface UsageModelTotals {
  model: string;
  calls: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}

export interface UsageDayTotals {
  date: string;
  calls: number;
  costUsd?: number;
}

export interface UsageRunTotals {
  runId: string;
  calls: number;
  costUsd?: number;
}

/**
 * Totals for one tenant bucket.
 *
 * `tenantId` is ABSENT for the unassigned bucket: that is a genuine "no
 * tenant", never a placeholder id that could collide with a real tenant.
 * Every sum stays absent unless something was actually measured.
 */
export interface UsageTenantTotals {
  tenantId?: string;
  calls: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  /** Events in this bucket that carried no measurement at all. */
  unmeasured: number;
}

/**
 * Aggregated usage for a window.
 *
 * Every sum is OPTIONAL: a sum is present only when at least one event carried
 * that measurement. `unmeasured` counts events that carried none of them, so the
 * dashboard can show `—` rather than a misleading `0`.
 */
export interface UsageAggregate {
  totals: {
    calls: number;
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number;
    durationMs?: number;
  };
  byModel: UsageModelTotals[];
  byDay: UsageDayTotals[];
  byRun: UsageRunTotals[];
  /** Attributed tenants only. Unassigned usage is NOT in here. */
  byTenant: UsageTenantTotals[];
  /**
   * Usage carrying no tenant. Its own bucket, never folded into a
   * customer's total: unattributed spend is not any customer's spend.
   */
  unassigned: UsageTenantTotals;
  unmeasured: number;
}

export interface UsageStore {
  id: string;
  record(event: UsageEvent): Promise<UsageWriteResult>;
  aggregate(query?: UsageQuery): Promise<UsageReadResult<UsageAggregate>>;
  close(): void | Promise<void>;
}

/** Running sums for one grouping key, tracking which measures were observed. */
interface Accumulator {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  hasTokensIn: boolean;
  hasTokensOut: boolean;
  hasCost: boolean;
  hasDuration: boolean;
  unmeasured: number;
}

function newAccumulator(): Accumulator {
  return {
    calls: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    durationMs: 0,
    hasTokensIn: false,
    hasTokensOut: false,
    hasCost: false,
    hasDuration: false,
    unmeasured: 0,
  };
}

function addToAccumulator(acc: Accumulator, event: UsageEvent): void {
  acc.calls += 1;
  if (isUnmeasured(event)) acc.unmeasured += 1;
  if (event.tokensIn !== undefined) {
    acc.tokensIn += event.tokensIn;
    acc.hasTokensIn = true;
  }
  if (event.tokensOut !== undefined) {
    acc.tokensOut += event.tokensOut;
    acc.hasTokensOut = true;
  }
  if (event.costUsd !== undefined) {
    acc.costUsd += event.costUsd;
    acc.hasCost = true;
  }
  if (event.durationMs !== undefined) {
    acc.durationMs += event.durationMs;
    acc.hasDuration = true;
  }
}

/** An event is "unmeasured" only when it carried no measurement at all. */
function isUnmeasured(event: UsageEvent): boolean {
  return (
    event.tokensIn === undefined &&
    event.tokensOut === undefined &&
    event.costUsd === undefined &&
    event.durationMs === undefined
  );
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Aggregate a set of events in one pass.
 *
 * Exported so the query module, the in-memory adapter and the tests all share a
 * single definition of the window/sum semantics — two copies would be two
 * chances for them to disagree about what "measured" means.
 */
export function summarizeUsage(
  events: UsageEvent[],
  query: UsageQuery = {},
): UsageAggregate {
  const { from, to } = normalizeRunDateRange(query.from, query.to);

  const selected = events.filter((event) => {
    if (from !== undefined && event.ts < from) return false;
    if (to !== undefined && event.ts >= to) return false;
    if (query.runId !== undefined && event.runId !== query.runId) return false;
    if (query.model !== undefined && event.model !== query.model) return false;
    if (query.tenantId !== undefined && event.tenantId !== query.tenantId)
      return false;
    return true;
  });

  const totalAcc = newAccumulator();
  const modelSums = new Map<string, Accumulator>();
  const daySums = new Map<string, Accumulator>();
  const runSums = new Map<string, Accumulator>();
  const tenantSums = new Map<string, Accumulator>();
  const unassignedAcc = newAccumulator();

  for (const event of selected) {
    addToAccumulator(totalAcc, event);

    if (event.tenantId === undefined) {
      addToAccumulator(unassignedAcc, event);
    } else {
      const tenantSum = tenantSums.get(event.tenantId) ?? newAccumulator();
      addToAccumulator(tenantSum, event);
      tenantSums.set(event.tenantId, tenantSum);
    }

    const modelSum = modelSums.get(event.model) ?? newAccumulator();
    addToAccumulator(modelSum, event);
    modelSums.set(event.model, modelSum);

    const day = event.ts.slice(0, 10);
    const daySum = daySums.get(day) ?? newAccumulator();
    addToAccumulator(daySum, event);
    daySums.set(day, daySum);

    const runSum = runSums.get(event.runId) ?? newAccumulator();
    addToAccumulator(runSum, event);
    runSums.set(event.runId, runSum);
  }

  const totals: UsageAggregate["totals"] = { calls: totalAcc.calls };
  if (totalAcc.hasTokensIn) totals.tokensIn = totalAcc.tokensIn;
  if (totalAcc.hasTokensOut) totals.tokensOut = totalAcc.tokensOut;
  if (totalAcc.hasCost) totals.costUsd = totalAcc.costUsd;
  if (totalAcc.hasDuration) totals.durationMs = totalAcc.durationMs;

  const byModel: UsageModelTotals[] = [...modelSums.entries()]
    .map(([model, acc]) => {
      const entry: UsageModelTotals = { model, calls: acc.calls };
      if (acc.hasTokensIn) entry.tokensIn = acc.tokensIn;
      if (acc.hasTokensOut) entry.tokensOut = acc.tokensOut;
      if (acc.hasCost) entry.costUsd = acc.costUsd;
      return entry;
    })
    .sort((left, right) => left.model.localeCompare(right.model));

  const byDay: UsageDayTotals[] = [...daySums.entries()]
    .map(([date, acc]) => {
      const entry: UsageDayTotals = { date, calls: acc.calls };
      if (acc.hasCost) entry.costUsd = acc.costUsd;
      return entry;
    })
    .sort((left, right) => left.date.localeCompare(right.date));

  const byRun: UsageRunTotals[] = [...runSums.entries()]
    .map(([runId, acc]) => {
      const entry: UsageRunTotals = { runId, calls: acc.calls };
      if (acc.hasCost) entry.costUsd = acc.costUsd;
      return entry;
    })
    .sort((left, right) => left.runId.localeCompare(right.runId));

  const byTenant: UsageTenantTotals[] = [...tenantSums.entries()]
    .map(([tenantId, acc]) => tenantEntry(tenantId, acc))
    .sort((left, right) =>
      (left.tenantId ?? "").localeCompare(right.tenantId ?? ""),
    );

  return {
    totals,
    byModel,
    byDay,
    byRun,
    byTenant,
    unassigned: tenantEntry(undefined, unassignedAcc),
    unmeasured: totalAcc.unmeasured,
  };
}

/** Shape one tenant bucket, keeping every unmeasured sum ABSENT. */
function tenantEntry(
  tenantId: string | undefined,
  acc: Accumulator,
): UsageTenantTotals {
  const entry: UsageTenantTotals = {
    ...(tenantId !== undefined ? { tenantId } : {}),
    calls: acc.calls,
    unmeasured: acc.unmeasured,
  };
  if (acc.hasTokensIn) entry.tokensIn = acc.tokensIn;
  if (acc.hasTokensOut) entry.tokensOut = acc.tokensOut;
  if (acc.hasCost) entry.costUsd = acc.costUsd;
  return entry;
}

/** In-process ledger: the default when no external driver is configured. */
export class InMemoryUsageStore implements UsageStore {
  id = "memory";

  private readonly events: UsageEvent[] = [];

  async record(event: UsageEvent): Promise<UsageWriteResult> {
    const normalized = toUsageEvent(event);
    this.events.push(normalized);
    return { ok: true, mode: "live", providerId: this.id, event: normalized };
  }

  async aggregate(
    query: UsageQuery = {},
  ): Promise<UsageReadResult<UsageAggregate>> {
    return {
      ok: true,
      mode: "live",
      providerId: this.id,
      value: summarizeUsage(this.events, query),
    };
  }

  /** The recorded events, for assertions and local inspection. */
  getEvents(): UsageEvent[] {
    return [...this.events];
  }

  close(): void {}
}

/**
 * No-loss recorder around ANY `UsageStore` (#140 pattern).
 *
 * Deliberately a DECORATOR rather than a retry queue fed by callers: the "a
 * usage-store outage must not fail the task" constraint then lives in exactly
 * one place and holds for every driver without each call site remembering it.
 *
 * A store failure retains the event for `flush()` and returns `ok: false`, so an
 * unsaved event is never reported as stored.
 */
export class BufferedUsageRecorder implements UsageStore {
  id = "buffered";

  private readonly store: UsageStore;
  private readonly buffer: UsageEvent[] = [];

  constructor(store: UsageStore) {
    this.store = store;
  }

  /**
   * Validate (a caller bug THROWS), write through, and on ANY store failure
   * retain the event. The caller never sees an exception caused by the ledger.
   */
  async record(event: UsageEvent): Promise<UsageWriteResult> {
    const normalized = toUsageEvent(event);
    let result: UsageWriteResult;
    try {
      result = await this.store.record(normalized);
    } catch (error) {
      // A driver can REJECT as well as return a structured failure; both are
      // outages, so both are handled here rather than terminating the caller.
      result = {
        ok: false,
        mode: "blocked",
        providerId: this.store.id,
        error: errorDetail(error),
      };
    }

    if (result.ok) return { ...result, providerId: this.id };

    this.buffer.push(normalized);
    return {
      ok: false,
      mode: "blocked",
      providerId: this.id,
      event: normalized,
      error: `${result.error ?? "unknown error"} — record buffered for retry; it is not lost.`,
    };
  }

  /** Reads pass straight through; only writes are buffered. */
  aggregate(query: UsageQuery = {}): Promise<UsageReadResult<UsageAggregate>> {
    return this.store.aggregate(query);
  }

  /** Events retained because the backend refused them. */
  pending(): UsageEvent[] {
    return [...this.buffer];
  }

  /** Retry every retained event; only cleared once each reached the backend. */
  async flush(): Promise<UsageWriteResult> {
    const stillFailing: UsageEvent[] = [];
    for (const event of this.buffer) {
      let ok = false;
      try {
        ok = (await this.store.record(event)).ok;
      } catch {
        ok = false;
      }
      if (!ok) stillFailing.push(event);
    }

    const flushedCount = this.buffer.length - stillFailing.length;
    this.buffer.length = 0;
    this.buffer.push(...stillFailing);

    if (stillFailing.length === 0) {
      return { ok: true, mode: "live", providerId: this.id };
    }
    return {
      ok: false,
      mode: "blocked",
      providerId: this.id,
      error: `${stillFailing.length} usage event(s) still unsaved (${flushedCount} flushed).`,
    };
  }

  close(): void | Promise<void> {
    return this.store.close();
  }
}

/**
 * Record without ever risking the caller's task.
 *
 * A malformed event still THROWS, because that is a caller bug and hiding it
 * would bury the defect. Only the STORE is treated as fallible.
 */
export async function recordSafely(
  store: UsageStore,
  event: UsageEvent,
): Promise<UsageWriteResult> {
  const normalized = toUsageEvent(event);
  try {
    return await store.record(normalized);
  } catch (error) {
    return {
      ok: false,
      mode: "blocked",
      providerId: store.id,
      event: normalized,
      error: errorDetail(error),
    };
  }
}