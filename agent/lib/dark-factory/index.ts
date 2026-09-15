/**
 * Dark Factory — wiring hub (R1: #134, #138, #140 · R2: #135, #142).
 *
 * Single place where the seam adapters are chosen from the environment, so the
 * orchestrator never imports a concrete adapter directly. Every factory is
 * fail-closed: an unset driver yields the refusing default rather than a
 * silently non-persistent in-process store — and, for R2, an unset token yields
 * a broker that refuses to issue a lease, and an unset provider yields an
 * honest dry-run that never claims isolation.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { ConsoleStateProvider, SqliteStateAdapter, type StateStore } from "./state";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "./dispatch";
import type { DispatchObserver } from "./dispatch";
import type { MetricsStore } from "./metrics";

export { createMetricsStore } from "./metrics";

// R2 seams re-exported so index.ts stays the single import surface (mirrors the
// createMetricsStore re-export above). Factories live next to their seam so the
// canonical shapes and their env wiring stay in one module.
export { createCredentialBroker } from "./credentials";
export { createWorkerProvider, createWorkerHandler } from "./worker-env";

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
 * Canonicalise the configured SQLite path and, when `DF_STATE_DB_DIR` is set,
 * refuse anything that resolves outside that directory.
 *
 * `DF_STATE_DB_PATH` comes from the environment, which is operator-controlled
 * configuration rather than request input (the same trust boundary as the GitHub
 * tokens this repo already reads from env), so the default trusts the operator.
 * The optional sandbox root is defence in depth for deployments that want to
 * bound where state may be written — and it follows the fail-closed shape of the
 * `STORY_ALLOWED_REPOS` allow-list: once configured, an escaping path is
 * REFUSED rather than silently used. Canonicalising also means an error message
 * names the real target, not a `../..`-laden string.
 *
 * Note: this is lexical (like `path.resolve`). A symlink inside the sandbox that
 * points outside it is not detected — that is a filesystem/container concern
 * (R2's worker privilege boundary), not something path string math can solve.
 */
export function resolveStateDbPath(rawPath: string, sandboxRoot?: string): string {
  const resolved = resolve(rawPath);
  const root = (sandboxRoot || "").trim();
  if (root === "") return resolved;

  const resolvedRoot = resolve(root);
  // Containment is decided by path.relative, NOT startsWith(resolvedRoot + sep):
  // relative() follows the PLATFORM's case sensitivity (Node's win32
  // implementation compares case-insensitively, matching a case-insensitive
  // filesystem, while POSIX stays case-sensitive), whereas a raw prefix compare
  // false-rejected a legitimate path whose drive letter differed in case
  // ('c:\x' vs 'C:\x'). It also handles a different drive/root correctly by
  // returning an absolute path.
  const rel = relative(resolvedRoot, resolved);
  const inside =
    rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
  if (inside) return resolved;

  throw new Error(
    `DF_STATE_DB_PATH '${resolved}' resolves outside DF_STATE_DB_DIR '${resolvedRoot}'. ` +
      "Refusing to open a state store outside the configured sandbox root.",
  );
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
    return new SqliteStateAdapter(resolveStateDbPath(dbPath, env.DF_STATE_DB_DIR));
  }

  throw new Error(
    `Unknown DF_STATE_DRIVER '${driver}'. Supported drivers: sqlite (leave unset for the fail-closed console default).`,
  );
}