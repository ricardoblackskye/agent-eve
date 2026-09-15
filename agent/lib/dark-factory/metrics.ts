/**
 * Dark Factory — Observability / Self-Improvement (issues #139 / story #140).
 *
 * STUB — implementation pending (TDD RED).
 */

export type TaskStatus = "success" | "failure";

/** Canonical, provider-agnostic metric record for one completed task. */
export interface TaskMetric {
  taskType: string;
  iterations: number;
  fixCycles: number;
  status: TaskStatus;
}

export interface MetricsWriteResult {
  ok: boolean;
  mode: "live" | "dry-run" | "blocked";
  providerId: string;
  record?: TaskMetric;
  error?: string;
}

export interface MetricsStore {
  id: string;
  record(
    taskType: string,
    data: { iterations: number; fixCycles: number; status: TaskStatus },
  ): Promise<MetricsWriteResult>;
  /** Success rate for a task type: K/N rounded to two decimals, null if none. */
  successRateByType(type: string): number | null;
  getRecords(): TaskMetric[];
}

export class InvalidMetricsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMetricsError";
  }
}

/** A single step in a test-fail -> fix loop. */
export type FixEvent = "test-fail" | "test-fix";

/**
 * Count real test-fail -> fix cycles. A cycle is one fix that resolves an
 * outstanding failure, so an unmatched failure (never fixed) and an unmatched
 * fix (nothing was failing) both count zero — the exact observed count required
 * by AC2, not a heuristic over array length.
 */
export function countFixCycles(events: FixEvent[]): number {
  let pendingFails = 0;
  let cycles = 0;
  for (const event of events) {
    if (event === "test-fail") {
      pendingFails += 1;
    } else if (pendingFails > 0) {
      pendingFails -= 1;
      cycles += 1;
    }
  }
  return cycles;
}

/** Business rounding used by every success-rate view (two decimals). */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Validate and normalise an incoming metric. Invalid input THROWS (a caller
 * bug — the ingestion contract was violated), whereas a store that cannot
 * persist returns `ok: false` (an operational failure the caller must not
 * mistake for a stored record). See `MUST NOT lose records` in #140.
 */
export function toTaskMetric(
  taskType: string,
  data: { iterations: number; fixCycles: number; status: TaskStatus },
): TaskMetric {
  const type = typeof taskType === "string" ? taskType.trim() : "";
  if (!type) {
    throw new InvalidMetricsError(
      `Metric record requires a non-empty "taskType" (received ${JSON.stringify(taskType)}).`,
    );
  }
  const { iterations, fixCycles, status } = data;
  if (!Number.isInteger(iterations) || iterations < 0) {
    throw new InvalidMetricsError(
      `Metric record requires "iterations" to be an integer >= 0 (received ${JSON.stringify(iterations)}).`,
    );
  }
  if (!Number.isInteger(fixCycles) || fixCycles < 0) {
    throw new InvalidMetricsError(
      `Metric record requires "fixCycles" to be an integer >= 0 (received ${JSON.stringify(fixCycles)}).`,
    );
  }
  if (status !== "success" && status !== "failure") {
    throw new InvalidMetricsError(
      `Metric record requires "status" to be "success" or "failure" (received ${JSON.stringify(status)}).`,
    );
  }
  return { taskType: type, iterations, fixCycles, status };
}

export class InMemoryMetricsStore implements MetricsStore {
  id = "memory";

  private readonly records: TaskMetric[] = [];

  async record(
    taskType: string,
    data: { iterations: number; fixCycles: number; status: TaskStatus },
  ): Promise<MetricsWriteResult> {
    const record = toTaskMetric(taskType, data);
    this.records.push(record);
    return { ok: true, mode: "live", providerId: this.id, record };
  }

  successRateByType(type: string): number | null {
    const matching = this.records.filter((record) => record.taskType === type);
    if (matching.length === 0) return null;
    const successes = matching.filter((record) => record.status === "success").length;
    return round2(successes / matching.length);
  }

  getRecords(): TaskMetric[] {
    return [...this.records];
  }
}

/**
 * Metrics recorder that adds a no-loss retry buffer around ANY `MetricsStore`.
 *
 * Deliberately a DECORATOR rather than a separate `RetryQueue` fed by callers:
 * the "MUST NOT lose metric records" constraint then lives in exactly one place
 * and holds for every store (in-memory today, Redis/pgvector later) without each
 * caller remembering to enqueue. It composes with — and is tested against — a
 * failing backend in isolation (see the `FlakyStore` suite), so retry semantics
 * are still verifiable without a real outage; splitting the buffer out would
 * scatter the guarantee across layers with nothing left to enforce it.
 *
 * `record()` validates input (a caller bug throws), writes through, and on a
 * store failure retains the record for `flush()` while returning `ok: false`, so
 * an unsaved metric is never reported as stored.
 */
export class BufferedMetricsRecorder {
  id = "buffered";
  private readonly store: MetricsStore;
  private readonly buffer: TaskMetric[] = [];

  constructor(store: MetricsStore) {
    this.store = store;
  }

  /**
   * Record a completed task. A store failure is NOT swallowed: the record is
   * retained in the buffer and the result is `ok: false`, so a caller can never
   * mistake an unsaved metric for a persisted one (the "MUST NOT lose metric
   * records" constraint). `flush()` retries the retained records.
   */
  async record(
    taskType: string,
    data: { iterations: number; fixCycles: number; status: TaskStatus },
  ): Promise<MetricsWriteResult> {
    const record = toTaskMetric(taskType, data);
    const res = await this.store.record(record.taskType, {
      iterations: record.iterations,
      fixCycles: record.fixCycles,
      status: record.status,
    });
    if (res.ok) return res;

    this.buffer.push(record);
    return {
      ...res,
      record,
      error: `${res.error ?? "unknown error"} — record buffered for retry; it is not lost.`,
    };
  }

  /** Records retained because the backend rejected them. */
  pending(): TaskMetric[] {
    return [...this.buffer];
  }

  /** Retry every retained record; only cleared once it reached the backend. */
  async flush(): Promise<MetricsWriteResult> {
    const stillFailing: TaskMetric[] = [];
    for (const record of this.buffer) {
      const res = await this.store.record(record.taskType, {
        iterations: record.iterations,
        fixCycles: record.fixCycles,
        status: record.status,
      });
      if (!res.ok) stillFailing.push(record);
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
      error: `${stillFailing.length} metric record(s) still unsaved (${flushedCount} flushed).`,
    };
  }
}

/**
 * Choose the metrics store from the environment.
 *
 * Unlike the state store (where a missing driver must REFUSE, because silently
 * losing execution memory breaks the dark factory's loop), the R1 metrics
 * default is the in-memory adapter: the observability ACs are satisfiable
 * in-process, and the "MUST NOT lose records" constraint is enforced by
 * `BufferedMetricsRecorder` surfacing every failed write as `ok: false`.
 * An unknown driver still throws rather than degrading silently.
 */
export function createMetricsStore(
  env: Record<string, string | undefined> = process.env,
): MetricsStore {
  const driver = (env.DF_METRICS_DRIVER || "").trim();
  if (driver === "" || driver === "memory") return new InMemoryMetricsStore();

  throw new Error(
    `Unknown DF_METRICS_DRIVER '${driver}'. Supported drivers: memory (leave unset for the in-memory default).`,
  );
}