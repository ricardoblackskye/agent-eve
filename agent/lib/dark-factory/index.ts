/**
 * Dark Factory — R1 wiring (issues #134, #138, #140).
 *
 * Single place where the seam adapters are chosen from the environment, so the
 * orchestrator never imports a concrete adapter directly. Every factory is
 * fail-closed: an unset driver yields the refusing default rather than a
 * silently non-persistent in-process store.
 */

import { ConsoleStateProvider, SqliteStateAdapter, type StateStore } from "./state";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "./dispatch";
import type { DispatchObserver } from "./dispatch";
import type { MetricsStore } from "./metrics";

export { createMetricsStore } from "./metrics";

/**
 * Adapt the dispatch attempt stream into the observability store (#140 AC4).
 *
 * Only TERMINAL events are recorded, because a `TaskMetric` describes a
 * completed task: `iterations` is the attempt count and `fixCycles` the number
 * of fail->retry cycles that preceded the outcome, so a dispatch that succeeded
 * on the second attempt is `{iterations: 2, fixCycles: 1, status: "success"}`.
 */
export function createDispatchObserver(recorder: MetricsStore): DispatchObserver {
  return async (metric) => {
    if (metric.status !== "succeeded" && metric.status !== "failed") return;
    await recorder.record("dispatch", {
      iterations: metric.attempt,
      fixCycles: Math.max(0, metric.attempt - 1),
      status: metric.status === "succeeded" ? "success" : "failure",
    });
  };
}

/**
 * Read the dispatch retry policy from the environment. A malformed numeric
 * value is a configuration error and throws: silently falling back to the
 * default would hide an operator's intent to change retry behaviour.
 */
export function createRetryPolicy(
  env: Record<string, string | undefined> = process.env,
): RetryPolicy {
  return {
    maxRetries: readInt(
      "DF_DISPATCH_MAX_RETRIES",
      env.DF_DISPATCH_MAX_RETRIES,
      DEFAULT_RETRY_POLICY.maxRetries,
      0,
    ),
    baseDelayMs: readInt(
      "DF_DISPATCH_BASE_DELAY_MS",
      env.DF_DISPATCH_BASE_DELAY_MS,
      DEFAULT_RETRY_POLICY.baseDelayMs,
      0,
    ),
    backoffMultiplier: DEFAULT_RETRY_POLICY.backoffMultiplier,
  };
}

/** Parse a non-negative integer env var, throwing on garbage (naming the var). */
function readInt(name: string, raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(
      `${name} must be an integer >= ${min} (received ${JSON.stringify(raw)}).`,
    );
  }
  return parsed;
}

/**
 * Choose the execution-memory store from the environment.
 *
 * `DF_STATE_DRIVER` unset/empty -> fail-closed `console` provider (refuses every
 * write rather than pretending to persist). `sqlite` -> the file-backed adapter,
 * which requires `DF_STATE_DB_PATH`. Anything else is a configuration error and
 * throws rather than silently degrading to a store that loses state.
 */
export function createStateStore(
  env: Record<string, string | undefined> = process.env,
): StateStore {
  const driver = (env.DF_STATE_DRIVER || "").trim();
  if (driver === "") return new ConsoleStateProvider();

  if (driver === "sqlite") {
    const dbPath = (env.DF_STATE_DB_PATH || "").trim();
    if (!dbPath) {
      throw new Error(
        "DF_STATE_DRIVER=sqlite requires DF_STATE_DB_PATH (filesystem path to the SQLite database).",
      );
    }
    return new SqliteStateAdapter(dbPath);
  }

  throw new Error(
    `Unknown DF_STATE_DRIVER '${driver}'. Supported drivers: sqlite (leave unset for the fail-closed console default).`,
  );
}