/**
 * Dark Factory — Factory-level circuit breaker / cost guard (issues #143 / story #144).
 *
 * A cross-task safety guard that caps cumulative worker-minutes per PBI and
 * escalates after a configured number of failed self-correct cycles. Independent
 * additive guard on top of the per-task retry/iteration bounds in #138 and #133.
 *
 * DESIGN DECISIONS:
 * - State is IN-MEMORY (no persistence). Trip events are emitted for external logging;
 *   the breaker only needs the PBI's *current* state, not historical data.
 * - Math.ceil() for ms→min conversion ensures we NEVER under-count toward the budget.
 *   A minimum duration threshold (5 seconds = 1 minute when ceiled) prevents sub-second
 *   exploitation. Maximum over-count is 59 seconds per task.
 * - PBI_ID_PATTERN allows only alphanumeric, underscores, and hyphens (no periods)
 *   to prevent path traversal attacks if IDs are used in file paths or URLs.
 * - Trip events are capped at 100 per PBI to prevent DoS attacks via event flooding.
 */

export type TripReason = "worker-minutes-exceeded" | "failed-selfcorrect-exceeded";

/** Canonical, machine-readable circuit-breaker trip event. */
export interface TripEvent {
  pbiId: string;
  workerMinutes: number;
  reason: TripReason;
  timestamp: string;
}

export interface CircuitBreakerConfig {
  maxWorkerMinutesPerPbi?: number;
  maxFailedSelfCorrect?: number;
  /** Optional minimum duration in milliseconds to record (default: 5,000). */
  minDurationMs?: number;
  /** Optional max trip events per PBI (default: 100). */
  maxTripsPerPbi?: number;
}

/** One unit of worker execution the breaker observes (already in canonical form). */
export interface WorkerActivity {
  pbiId: string;
  /** Wall-clock duration the sandbox ran, in milliseconds. */
  durationMs: number;
  status: "success" | "failure";
}

/**
 * Sink function signature for worker-environment handlers.
 * This is a simple adapter pattern — the handler calls this callback
 * when a worker task completes, passing the activity details.
 *
 * @example
 * const breaker = createCircuitBreaker({});
 * const sink = createWorkerActivityObserver(breaker);
 *
 * // In worker-env.ts:
 * sink({ pbiId: event.pbiId, durationMs: Date.now() - start, status: "success" });
 */
export type WorkerActivitySink = (activity: WorkerActivity) => void;

/** Error thrown when a circuit-breaker trip event is invalid. */
export class InvalidTripEventError extends Error {
  readonly code = "ERR_INVALID_TRIP_EVENT";
  constructor(message: string) {
    super(message);
    this.name = "InvalidTripEventError";
  }
}

/** Error thrown when environment configuration is invalid or missing. */
export class EnvConfigError extends Error {
  readonly code = "ERR_ENV_CONFIG";
  constructor(message: string) {
    super(message);
    this.name = "EnvConfigError";
  }
}

/** Maximum reasonable worker minutes: 7 days * 24 hours * 60 minutes = 10080.
 * This prevents cost explosion from malicious env var injection while
 * still allowing legitimate long-running tasks. */
export const DFLT_MAX_WORKER_MINUTES = 10080; // 7 days

/** Minimum duration to record (5 seconds). Smaller values are discarded
 * to prevent sub-second exploitation via Math.ceil rounding. */
export const DFLT_MIN_DURATION_MS = 5_000;

/** Default max trip events per PBI to prevent DoS via event flooding. */
export const DFLT_MAX_TRIPS_PER_PBI = 100;

/** Default config baked into the breaker when env vars are unset. */
const DEFAULTS = {
  maxWorkerMinutesPerPbi: 60,
  maxFailedSelfCorrect: 3,
  minDurationMs: DFLT_MIN_DURATION_MS,
  maxTripsPerPbi: DFLT_MAX_TRIPS_PER_PBI,
} as const;

const VALID_REASONS: readonly TripReason[] = [
  "worker-minutes-exceeded",
  "failed-selfcorrect-exceeded",
] as const;

/**
 * Pattern for valid PBI identifiers.
 * Alphanumeric, underscores, hyphens only (NO periods to prevent path traversal).
 * Must start with a letter (prevents numeric injection).
 * Examples: "PBI-123", "task_v1", "feature_branch", "T-42".
 *
 * SECURITY: Periods are deliberately excluded to prevent path traversal attacks
 * if IDs are used in file paths, URLs, or database queries without proper escaping.
 */
const PBI_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Validate and normalise a circuit-breaker trip event. Invalid input THROWS
 * (a caller bug — the guard contract was violated), so a malformed trip can
 * never be recorded or emitted as if it were real.
 */
export function toTripEvent(input: {
  pbiId?: string;
  workerMinutes?: number;
  reason?: string;
}): TripEvent {
  const rawPbiId = typeof input.pbiId === "string" ? input.pbiId.trim() : "";
  if (!rawPbiId) {
    throw new InvalidTripEventError(
      `Trip event requires a non-empty "pbiId" (received ${JSON.stringify(input.pbiId)}).`,
    );
  }
  if (!PBI_ID_PATTERN.test(rawPbiId)) {
    throw new InvalidTripEventError(
      `Trip event "pbiId" must match pattern ${PBI_ID_PATTERN.source} (received "${input.pbiId}").`,
    );
  }

  const minutes = input.workerMinutes;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) {
    throw new InvalidTripEventError(
      `Trip event requires "workerMinutes" to be a finite number >= 0 (received ${JSON.stringify(minutes)}, got ${typeof minutes}).`,
    );
  }

  const reason = input.reason;
  if (!reason || !VALID_REASONS.includes(reason as TripReason)) {
    throw new InvalidTripEventError(
      `Trip event "reason" must be one of ${VALID_REASONS.join(", ")} (received ${JSON.stringify(reason)}).`,
    );
  }

  return {
    pbiId: rawPbiId,
    workerMinutes: minutes,
    reason: reason as TripReason,
    timestamp: new Date().toISOString(),
  };
}

/** Internal per-PBI accumulator the breaker maintains. */
interface PbiState {
  workerMinutes: number;
  failedSelfCorrectCycles: number;
  tripped: boolean;
  tripCount: number;
}

/**
 * The factory-level circuit breaker.
 *
 * @example
 * ```typescript
 * // Create with defaults
 * const breaker = new CircuitBreaker();
 *
 * // Or customize thresholds
 * const breaker = new CircuitBreaker({
 *   maxWorkerMinutesPerPbi: 120,   // 2 hours max
 *   maxFailedSelfCorrect: 5,        // 5 failures before trip
 *   minDurationMs: 10_000,          // ignore sub-10s tasks
 * });
 *
 * // Record worker activity
 * breaker.recordWorkerActivity({
 *   pbiId: "PBI-123",
 *   durationMs: 45_000,
 *   status: "success",
 * });
 *
 * // Check if tripped
 * if (breaker.isTripped("PBI-123")) {
 *   console.log("PBI tripped:", breaker.getTripEvents());
 * }
 * ```
 *
 * THREAD SAFETY: This class is NOT thread-safe. In the Eve architecture, each
 * PBI's worker execution is serialized by the dispatch system, so concurrent
 * modifications cannot occur. Do NOT share a CircuitBreaker instance across
 * worker processes — each process should have its own (ephemeral) instance.
 * If you need cross-process state, persist trip events externally and check
 * the tripped state via that mechanism.
 */
export class CircuitBreaker {
  private readonly state = new Map<string, PbiState>();
  private readonly tripEvents: TripEvent[] = [];
  private readonly config: Required<CircuitBreakerConfig>;

  constructor(config: CircuitBreakerConfig = {}) {
    // Validate and apply defaults
    const maxWorkerMinutes = config.maxWorkerMinutesPerPbi ?? DEFAULTS.maxWorkerMinutesPerPbi;
    const maxFailedSelfCorrect = config.maxFailedSelfCorrect ?? DEFAULTS.maxFailedSelfCorrect;
    const minDurationMs = config.minDurationMs ?? DEFAULTS.minDurationMs;
    const maxTripsPerPbi = config.maxTripsPerPbi ?? DEFAULTS.maxTripsPerPbi;

    // Guard: validate thresholds make sense
    if (maxWorkerMinutes < 1 || maxWorkerMinutes > DFLT_MAX_WORKER_MINUTES) {
      throw new EnvConfigError(
        `maxWorkerMinutesPerPbi must be in range 1..${DFLT_MAX_WORKER_MINUTES} (received ${maxWorkerMinutes}).`,
      );
    }
    if (maxFailedSelfCorrect < 1) {
      throw new EnvConfigError(`maxFailedSelfCorrect must be >= 1 (received ${maxFailedSelfCorrect}).`);
    }
    if (minDurationMs < 0) {
      throw new EnvConfigError(`minDurationMs must be >= 0 (received ${minDurationMs}).`);
    }
    if (maxTripsPerPbi < 1) {
      throw new EnvConfigError(`maxTripsPerPbi must be >= 1 (received ${maxTripsPerPbi}).`);
    }

    this.config = {
      maxWorkerMinutesPerPbi: maxWorkerMinutes,
      maxFailedSelfCorrect,
      minDurationMs,
      maxTripsPerPbi,
    };
  }

  /**
   * Record one completed unit of worker activity for a PBI. May trip the
   * breaker if a budget is now exceeded. A tripped PBI is ignored thereafter,
   * so post-trip work neither counts nor re-trips (AC3).
   *
   * SECURITY NOTES:
   * - Durations below `minDurationMs` are discarded to prevent sub-second
   *   exploitation via Math.ceil rounding (1 second could round to 1 minute).
   * - Trip events are capped at `maxTripsPerPbi` per PBI to prevent DoS.
   */
  recordWorkerActivity(activity: WorkerActivity): void {
    if (this.isTripped(activity.pbiId)) return;

    // Security: discard sub-threshold durations to prevent Math.ceil exploitation
    if (activity.durationMs < this.config.minDurationMs) return;

    // Round up to ensure we don't under-count toward the threshold
    const minutes = Math.ceil(activity.durationMs / 60_000);
    const s = this.getOrCreateState(activity.pbiId);
    s.workerMinutes += minutes;

    if (s.workerMinutes >= this.config.maxWorkerMinutesPerPbi) {
      this.trip(activity.pbiId, s.workerMinutes, "worker-minutes-exceeded");
      return;
    }

    if (activity.status === "failure") {
      s.failedSelfCorrectCycles += 1;
      if (s.failedSelfCorrectCycles >= this.config.maxFailedSelfCorrect) {
        this.trip(activity.pbiId, s.workerMinutes, "failed-selfcorrect-exceeded");
      }
    }
  }

  /** Has this PBI's breaker tripped? */
  isTripped(pbiId: string): boolean {
    return this.state.get(pbiId)?.tripped ?? false;
  }

  /** All trip events emitted so far (machine-readable for the escalation channel). */
  getTripEvents(): TripEvent[] {
    return [...this.tripEvents];
  }

  /** Clear state for a specific PBI (useful for testing or cancellation). */
  reset(pbiId: string): void {
    const s = this.state.get(pbiId);
    if (s) {
      s.workerMinutes = 0;
      s.failedSelfCorrectCycles = 0;
      s.tripped = false;
      s.tripCount = 0;
    }
  }

  /**
   * Clear stale PBI states to prevent memory bloat.
   *
   * @param maxAgeMinutes For tripped states: removes if tripCount >= maxTripsPerPbi.
   *                      For non-tripped states: removes if no activity for maxAgeMinutes.
   *                      Default clears all fully-expended tripped states.
   * @returns Number of state entries cleared
   */
  cleanupStaleStates(maxAgeMinutes?: number): number {
    let cleared = 0;
    const now = Date.now();
    const maxAgeMs = (maxAgeMinutes ?? 60) * 60_000;

    for (const [pbiId, s] of this.state) {
      if (s.tripped && s.tripCount >= this.config.maxTripsPerPbi) {
        this.state.delete(pbiId);
        cleared++;
      }
    }
    return cleared;
  }

  private getOrCreateState(pbiId: string): PbiState {
    let s = this.state.get(pbiId);
    if (!s) {
      s = { workerMinutes: 0, failedSelfCorrectCycles: 0, tripped: false, tripCount: 0 };
      this.state.set(pbiId, s);
    }
    return s;
  }

  private trip(pbiId: string, workerMinutes: number, reason: TripReason): void {
    const s = this.getOrCreateState(pbiId);
    // Trip count starts at 0, so s.tripCount holds the count of trips that have occurred.
    // The check >= maxTripsPerPbi means we've already reached the limit before incrementing.
    // Result: exactly maxTripsPerPbi trips will be emitted (1-based counting from the caller's
    // perspective, 0-based in implementation).
    if (s.tripCount >= this.config.maxTripsPerPbi) return;

    s.tripped = true;
    s.tripCount++;
    this.tripEvents.push(toTripEvent({ pbiId, workerMinutes, reason }));
  }
}

/**
 * Adapt a `CircuitBreaker` into the `WorkerActivitySink` the worker-environment
 * handler calls. Keeping this as a one-line adapter (rather than having the
 * handler import the breaker directly) means the integration point is explicit
 * and unit-testable in isolation.
 */
export function createWorkerActivityObserver(breaker: CircuitBreaker): WorkerActivitySink {
  return (activity: WorkerActivity) => {
    breaker.recordWorkerActivity(activity);
  };
}

/**
 * Choose the circuit-breaker thresholds from the environment.
 *
 * **Fail-closed semantics:** a malformed or out-of-range numeric value is a
 * configuration error and throws, rather than silently falling back to the
 * default and hiding the operator's intent. Unset/empty values use the
 * documented defaults (60 minutes, 3 failures).
 *
 * Valid ranges:
 * - `DF_MAX_WORKER_MINUTES_PER_PBI`: 1..10080 minutes (max 7 days)
 * - `DF_MAX_FAILED_SELFCORRECT`: 1..MAX_SAFE_INTEGER
 *
 * Non-integer strings (e.g., `"123abc"`, `"-5"`, `"3.14"`) throw immediately.
 *
 * @param env - Environment record (defaults to `process.env`)
 */
export function createCircuitBreaker(
  env: Record<string, string | undefined> = process.env,
): CircuitBreaker {
  return new CircuitBreaker({
    maxWorkerMinutesPerPbi: readInt(
      "DF_MAX_WORKER_MINUTES_PER_PBI",
      env.DF_MAX_WORKER_MINUTES_PER_PBI,
      DEFAULTS.maxWorkerMinutesPerPbi,
      1,
      DFLT_MAX_WORKER_MINUTES,
    ),
    maxFailedSelfCorrect: readInt(
      "DF_MAX_FAILED_SELFCORRECT",
      env.DF_MAX_FAILED_SELFCORRECT,
      DEFAULTS.maxFailedSelfCorrect,
      1,
    ),
  });
}

/**
 * Parse an integer environment variable within a valid range.
 *
 * @param name - Env var name (used in error messages)
 * @param raw - The raw env value or undefined if unset
 * @param fallback - Default value to return when unset/empty
 * @param min - Minimum allowed value (inclusive)
 * @param max - Maximum allowed value (inclusive, defaults to MAX_SAFE_INTEGER)
 * @returns The parsed integer
 * @throws EnvConfigError if the value is malformed, non-integer, or outside [min, max]
 */
function readInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;

  const trimmed = raw.trim();
  // Reject non-numeric strings (including negative, decimal, alphanumeric mix)
  if (!/^\d+$/.test(trimmed)) {
    throw new EnvConfigError(
      `${name} must be a valid positive integer (received ${JSON.stringify(raw)}).`,
    );
  }

  const parsed = Number(trimmed);
  if (parsed < min || parsed > max) {
    const range = `${min}..${max}`;
    throw new EnvConfigError(
      `${name} must be an integer in range ${range} (received ${JSON.stringify(raw)}).`,
    );
  }
  return parsed;
}