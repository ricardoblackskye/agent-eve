/**
 * Dark Factory — Observability / Self-Improvement (issues #139 / story #140).
 *
 * The sensor: a canonical, provider-agnostic metric record per completed task,
 * a store seam, and a no-loss retry decorator.
 *
 * This module is a pure PRODUCER of metrics. It imports no consumer and must
 * not: naming or depending on a reader here would invert the dependency.
 */

export type TaskStatus = "success" | "failure";

/** Canonical, provider-agnostic metric record for one completed task. */
export interface TaskMetric {
  taskType: string;
  iterations: number;
  fixCycles: number;
  status: TaskStatus;
  /**
   * Wall-clock latency of the task, when it was MEASURED. Absent means "not
   * measured" and is deliberately different from `0` (#158): defaulting a
   * missing measurement to zero would drag every mean toward a number nobody
   * observed.
   */
  latencyMs?: number;
  /** Cost of the task in USD, when it was measured. Absent = not measured. */
  costUsd?: number;
}

/**
 * The ingestion contract: what a caller may pass to `record()`.
 *
 * Named so the two stores cannot drift — before #158 this shape was written out
 * verbatim in both `InMemoryMetricsStore` and `BufferedMetricsRecorder`.
 */
export interface TaskMetricInput {
  iterations: number;
  fixCycles: number;
  status: TaskStatus;
  /** Optional: absent means "not measured", never zero-filled. */
  latencyMs?: number;
  costUsd?: number;
}

/** Upper bound for a measured latency (24h): beyond it the number is nonsense. */
export const MAX_METRIC_LATENCY_MS = 86_400_000;
/** Upper bound for a measured cost, per task, in USD. */
export const MAX_METRIC_COST_USD = 1000;

export interface MetricsWriteResult {
  ok: boolean;
  mode: "live" | "dry-run" | "blocked";
  providerId: string;
  record?: TaskMetric;
  error?: string;
}

export interface MetricsStore {
  id: string;
  record(taskType: string, data: TaskMetricInput): Promise<MetricsWriteResult>;
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
export function toTaskMetric(taskType: string, data: TaskMetricInput): TaskMetric {
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
  // Latency and cost are OPTIONAL and are validated HERE, at the single contract
  // point, rather than in each store (#158) — a second validation site is how
  // two stores start disagreeing about what is acceptable.
  const record: TaskMetric = { taskType: type, iterations, fixCycles, status };
  const latency = assertOptionalMeasurement(data.latencyMs, "latencyMs", MAX_METRIC_LATENCY_MS);
  if (latency !== undefined) record.latencyMs = latency;
  const cost = assertOptionalMeasurement(data.costUsd, "costUsd", MAX_METRIC_COST_USD);
  if (cost !== undefined) record.costUsd = cost;
  return record;
}

/**
 * Validate an OPTIONAL measurement.
 *
 * Absent stays absent: "not measured" and "measured zero" are different facts.
 * A present value must be a finite number within `[0, max]`, so NaN, Infinity,
 * negatives and absurd magnitudes are refused rather than stored — a nonsense
 * metric is worse than a missing one, because it silently moves an average.
 */
function assertOptionalMeasurement(
  value: unknown,
  field: string,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    throw new InvalidMetricsError(
      `Metric record requires "${field}" to be a finite number in [0, ${max}] when present ` +
        `(received ${JSON.stringify(value)}).`,
    );
  }
  return value;
}

/**
 * Re-send shape for the no-loss decorator.
 *
 * It must carry EVERY field: an explicit shape that omitted the new ones would
 * silently DROP latency and cost on every buffered record — precisely the class
 * of loss this decorator exists to prevent (#158).
 */
function toInput(record: TaskMetric): TaskMetricInput {
  return {
    iterations: record.iterations,
    fixCycles: record.fixCycles,
    status: record.status,
    latencyMs: record.latencyMs,
    costUsd: record.costUsd,
  };
}

export class InMemoryMetricsStore implements MetricsStore {
  id = "memory";

  private readonly records: TaskMetric[] = [];

  async record(taskType: string, data: TaskMetricInput): Promise<MetricsWriteResult> {
    const record = toTaskMetric(taskType, data);
    this.records.push(record);
    return { ok: true, mode: "live", providerId: this.id, record };
  }

  successRateByType(type: string): number | null {
    const matching = this.records.filter((record) => record.taskType === type);
    if (matching.length === 0) return null;
    const successes = matching.filter(
      (record) => record.status === "success",
    ).length;
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
  async record(taskType: string, data: TaskMetricInput): Promise<MetricsWriteResult> {
    const record = toTaskMetric(taskType, data);
    const res = await this.store.record(record.taskType, toInput(record));
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
      const res = await this.store.record(record.taskType, toInput(record));
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
