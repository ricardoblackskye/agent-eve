/**
 * Dark Factory — Factory-level circuit breaker / cost guard (issues #143 / story #144).
 *
 * A cross-task safety guard that caps cumulative worker-minutes per PBI and
 * escalates after a configured number of failed self-correct cycles. Independent
 * additive guard on top of the per-task retry/iteration bounds in #138 and #133.
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
}

/** One unit of worker execution the breaker observes (already in canonical form). */
export interface WorkerActivity {
  pbiId: string;
  /** Wall-clock duration the sandbox ran, in milliseconds. */
  durationMs: number;
  status: "success" | "failure";
}

/** Sink the worker-environment handler calls when a task finishes. */
export type WorkerActivitySink = (activity: WorkerActivity) => void;

/** Error thrown when a circuit-breaker trip event is invalid. */
export class InvalidTripEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTripEventError";
  }
}

/** Error thrown when environment configuration is invalid or missing. */
export class EnvConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvConfigError";
  }
}

/** Maximum reasonable worker minutes: 7 days * 24 hours * 60 minutes = 10080.
 * This prevents cost explosion from malicious env var injection while
 * still allowing legitimate long-running tasks. */
const MAX_WORKER_MINUTES = 10080; // 7 days

/** Default config baked into the breaker when env vars are unset. */
const DEFAULTS = {
  maxWorkerMinutesPerPbi: 60,
  maxFailedSelfCorrect: 3,
} as const;

const VALID_REASONS: readonly TripReason[] = [
  "worker-minutes-exceeded",
  "failed-selfcorrect-exceeded",
] as const;

/** Pattern for valid PBI identifiers: e.g., "PBI-123", "PBI_abc", "task-xyz". */
const PBI_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;

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
}

/**
 * The factory-level circuit breaker. Observes worker activity per PBI and trips
 * (halts further work + emits a `TripEvent`) when either guard is exceeded:
 *
 *  - cumulative worker-minutes >= `maxWorkerMinutesPerPbi`
 *  - failed self-correct cycles >= `maxFailedSelfCorrect`
 *
 * A tripped PBI stays halted — the breaker records no further minutes or trips
 * for it, so no additional cost is incurred after the trip (AC3). The guard is
 * INDEPENDENT of the per-task retry/iteration bounds in #138/#133: it tripped on
 * its own cap and is additive, never resetting or observing those counters.
 *
 * Note: This class is NOT thread-safe. In the Eve architecture, each PBI's
 * worker execution is serialized, so concurrent modifications cannot occur.
 */
export class CircuitBreaker {
  private readonly state = new Map<string, PbiState>();
  private readonly tripEvents: TripEvent[] = [];
  private readonly config: Required<CircuitBreakerConfig>;

  constructor(config: CircuitBreakerConfig = {}) {
    this.config = {
      maxWorkerMinutesPerPbi: config.maxWorkerMinutesPerPbi ?? DEFAULTS.maxWorkerMinutesPerPbi,
      maxFailedSelfCorrect: config.maxFailedSelfCorrect ?? DEFAULTS.maxFailedSelfCorrect,
    };
  }

  /**
   * Record one completed unit of worker activity for a PBI. May trip the
   * breaker if a budget is now exceeded. A tripped PBI is ignored thereafter,
   * so post-trip work neither counts nor re-trips (AC3).
   */
  recordWorkerActivity(activity: WorkerActivity): void {
    if (this.isTripped(activity.pbiId)) return;

    // Use integer math: convert ms to minutes, rounding up to ensure we don't
    // under-count toward the threshold.
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
    }
  }

  private getOrCreateState(pbiId: string): PbiState {
    let s = this.state.get(pbiId);
    if (!s) {
      s = { workerMinutes: 0, failedSelfCorrectCycles: 0, tripped: false };
      this.state.set(pbiId, s);
    }
    return s;
  }

  private trip(pbiId: string, workerMinutes: number, reason: TripReason): void {
    const s = this.getOrCreateState(pbiId);
    s.tripped = true;
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
      MAX_WORKER_MINUTES,
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
  // Reject non-numeric strings early (including "123abc", "3.14", "  ")
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