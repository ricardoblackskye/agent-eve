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
 *   A minimum duration threshold (5 seconds) prevents sub-second exploitation.
 *   Maximum over-count is: 59,999ms rounds up to 1 minute (59,999 < 60,000 < 120,000).
 * - PBI_ID_PATTERN allows only alphanumeric, underscores, and hyphens (no periods)
 *   to prevent path traversal attacks if IDs are used in file paths or URLs.
 *   **IMPORTANT**: When constructing file paths or URLs, use encodeURIComponent()
 *   or similar encoding for additional safety, even with pattern restrictions.
 * - Trip events are capped at 100 per PBI to prevent DoS attacks via event flooding.
 */

export type TripReason = "worker-minutes-exceeded" | "failed-selfcorrect-exceeded";

/**
 * ISO 8601 timestamp for a circuit-breaker trip event.
 * Format: YYYY-MM-DDTHH:mm:ss.sssZ
 */
export type TripTimestamp = string;

/** Canonical, machine-readable circuit-breaker trip event. */
export interface TripEvent {
  pbiId: string;
  workerMinutes: number;
  reason: TripReason;
  /** ISO 8601 timestamp in UTC (format: YYYY-MM-DDTHH:mm:ss.sssZ). */
  timestamp: TripTimestamp;
}

export interface CircuitBreakerConfig {
  maxWorkerMinutesPerPbi?: number;
  maxFailedSelfCorrect?: number;
  /** Minimum duration in milliseconds to record (default: 5,000).
   * Values 0..4999ms are silently ignored.
   * ENV: DF_MIN_DURATION_MS */
  minDurationMs?: number;
  /** Maximum trip events per PBI (default: 100).
   * After this limit, additional trip events are dropped for that PBI.
   * ENV: DF_MAX_TRIPS_PER_PBI */
  maxTripsPerPbi?: number;
  /** Maximum number of PBIs to track (default: 10,000).
   * Set to 0 to disable cleanup checks.
   * ENV: DF_MAX_STATE_ENTRIES */
  maxStateEntries?: number;
  /** Enable automatic cleanup interval in milliseconds (default: 0, disabled).
   * Minimum: 60,000ms (1 minute). Shorter intervals are rejected.
   * ENV: DF_AUTO_CLEANUP_INTERVAL_MS */
  autoCleanupIntervalMs?: number;
  /** Maximum total trip events across all PBIs (default: 10,000).
   * Protects against DoS via flood of unique PBIs.
   * ENV: DF_MAX_TOTAL_TRIP_EVENTS */
  maxTotalTripEvents?: number;
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
 * to prevent sub-second exploitation via Math.ceil rounding.
 * ENV: DF_MIN_DURATION_MS (default 5000) */
export const DFLT_MIN_DURATION_MS = 5_000;

/** Default max trip events per PBI to prevent DoS via event flooding.
 * ENV: DF_MAX_TRIPS_PER_PBI (default 100) */
export const DFLT_MAX_TRIPS_PER_PBI = 100;

/** Maximum PBI ID length to prevent downstream system issues with overly long IDs. */
export const PBI_ID_MAX_LENGTH = 128;

/** Default maximum PBIs to track in memory. */
export const DFLT_MAX_STATE_ENTRIES = 10_000;

/** Default maximum total trip events across all PBIs (prevents DoS via unique PIBs). */
export const DFLT_MAX_TOTAL_TRIP_EVENTS = 10_000;

/** Minimum auto-cleanup interval (1 minute) to prevent timer spam. */
export const MIN_AUTO_CLEANUP_MS = 60_000;

/** Default config baked into the breaker when env vars are unset. */
const DEFAULTS = {
  maxWorkerMinutesPerPbi: 60,
  maxFailedSelfCorrect: 3,
  minDurationMs: DFLT_MIN_DURATION_MS,
  maxTripsPerPbi: DFLT_MAX_TRIPS_PER_PBI,
  maxStateEntries: DFLT_MAX_STATE_ENTRIES,
  autoCleanupIntervalMs: 0,
  maxTotalTripEvents: DFLT_MAX_TOTAL_TRIP_EVENTS,
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
 * Maximum length: 128 characters (see PBI_ID_MAX_LENGTH).
 *
 * SECURITY: Periods are deliberately excluded to prevent path traversal attacks
 * if IDs are used in file paths, URLs, or database queries. When embedding these
 * IDs in SQL queries, ALWAYS use parameterized queries/prepared statements to
 * prevent SQL injection. The regex provides basic format validation but does not
 * replace proper escaping for database contexts.
 * Length is capped to prevent issues in downstream systems that index/log IDs.
 */
const PBI_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Validate a WorkerActivity object for strict type safety and security.
 * Separated from recordWorkerActivity for testability and maintainability.
 */
export function validateWorkerActivity(activity: WorkerActivity): void {
  if (!activity || typeof activity !== "object") {
    throw new InvalidTripEventError("WorkerActivity must be a non-null object.");
  }
  if (typeof activity.pbiId !== "string" || activity.pbiId.length === 0) {
    throw new InvalidTripEventError("WorkerActivity requires a non-empty string pbiId.");
  }
  if (activity.pbiId.length > PBI_ID_MAX_LENGTH) {
    throw new InvalidTripEventError(
      `WorkerActivity pbiId exceeds maximum length of ${PBI_ID_MAX_LENGTH} characters (received ${activity.pbiId.length}).`,
    );
  }
  if (!PBI_ID_PATTERN.test(activity.pbiId)) {
    throw new InvalidTripEventError(
      `WorkerActivity pbiId "${activity.pbiId}" must match pattern ${PBI_ID_PATTERN.source}.`,
    );
  }
  if (typeof activity.durationMs !== "number" || !Number.isFinite(activity.durationMs) || activity.durationMs < 0) {
    throw new InvalidTripEventError(
      `WorkerActivity durationMs must be a finite number >= 0 (received ${JSON.stringify(activity.durationMs)}).`,
    );
  }
  if (activity.status !== "success" && activity.status !== "failure") {
    throw new InvalidTripEventError(
      `WorkerActivity status must be "success" or "failure" (received ${JSON.stringify(activity.status)}).`,
    );
  }
}

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
  if (rawPbiId.length > PBI_ID_MAX_LENGTH) {
    throw new InvalidTripEventError(
      `Trip event "pbiId" must be <= ${PBI_ID_MAX_LENGTH} characters (received ${rawPbiId.length}).`,
    );
  }
  if (!PBI_ID_PATTERN.test(rawPbiId)) {
    throw new InvalidTripEventError(
      `Trip event "pbiId" must match pattern ${PBI_ID_PATTERN.source} (received "${input.pbiId}").`,
    );
  }

  const minutes = input.workerMinutes;
  // Explicit NaN check (isFinite also catches NaN, but being explicit is clearer)
  if (typeof minutes !== "number" || Number.isNaN(minutes) || !Number.isFinite(minutes) || minutes < 0) {
    throw new InvalidTripEventError(
      `Trip event requires "workerMinutes" to be a finite number >= 0 (received ${JSON.stringify(minutes)}, got ${typeof minutes}).`,
    );
  }
  // Worker minutes are discrete; enforce integer type
  if (!Number.isInteger(minutes)) {
    throw new InvalidTripEventError(
      `Trip event requires "workerMinutes" to be an integer (received ${minutes}).`,
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
  /** Timestamp of last activity for age-based cleanup. */
  lastActivityAt: number;
}

/**
 * The factory-level circuit breaker.
 *
 * DISTRIBUTED STATE: This class is NOT thread-safe and does NOT share state
 * across instances. Each CircuitBreaker instance maintains its own in-memory
 * state. In a distributed system where multiple instances might process the
 * same PBI, trip status is NOT synchronized - each instance will independently
 * measure and trip based on its own recorded worker minutes.
 *
 * THREAD SAFETY: This class is NOT thread-safe for same-process concurrent
 * access. In the Eve architecture, each PBI's worker execution is serialized
 * by the dispatch system, so concurrent modifications cannot occur.
 * Do NOT share a CircuitBreaker instance across worker processes — each
 * process should have its own (ephemeral) instance. If you need cross-process
 * state, persist trip events externally (e.g., via getTripEvents()) and check
 * the tripped state via that mechanism.
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
 *
 * // For time-based testing, inject Date.now via a custom implementation
 * // or test cleanup logic with explicit maxAgeMinutes parameter.
 * ```
 */
export class CircuitBreaker {
  private readonly state = new Map<string, PbiState>();
  private readonly tripEvents: TripEvent[] = [];
  private readonly config: Required<CircuitBreakerConfig>;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: CircuitBreakerConfig = {}) {
    // Validate and apply defaults
    const maxWorkerMinutes = config.maxWorkerMinutesPerPbi ?? DEFAULTS.maxWorkerMinutesPerPbi;
    const maxFailedSelfCorrect = config.maxFailedSelfCorrect ?? DEFAULTS.maxFailedSelfCorrect;
    const minDurationMs = config.minDurationMs ?? DEFAULTS.minDurationMs;
    const maxTripsPerPbi = config.maxTripsPerPbi ?? DEFAULTS.maxTripsPerPbi;
    const maxStateEntries = config.maxStateEntries ?? DEFAULTS.maxStateEntries;
    const autoCleanupIntervalMs = config.autoCleanupIntervalMs ?? DEFAULTS.autoCleanupIntervalMs;
    const maxTotalTripEvents = config.maxTotalTripEvents ?? DEFAULTS.maxTotalTripEvents;

    // Guard: validate thresholds make sense
    if (maxWorkerMinutes < 1 || maxWorkerMinutes > DFLT_MAX_WORKER_MINUTES) {
      throw new EnvConfigError(
        `maxWorkerMinutesPerPbi must be in range 1..${DFLT_MAX_WORKER_MINUTES} (received ${maxWorkerMinutes}).`,
      );
    }
    if (maxWorkerMinutes > Number.MAX_SAFE_INTEGER / 2) {
      throw new EnvConfigError(
        `maxWorkerMinutesPerPbi would risk integer overflow (${maxWorkerMinutes} > ${Number.MAX_SAFE_INTEGER / 2}).`,
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
    if (maxStateEntries < 0) {
      throw new EnvConfigError(`maxStateEntries must be >= 0 (received ${maxStateEntries}).`);
    }
    if (autoCleanupIntervalMs < 0) {
      throw new EnvConfigError(`autoCleanupIntervalMs must be >= 0 (received ${autoCleanupIntervalMs}).`);
    }
    if (autoCleanupIntervalMs > 0 && autoCleanupIntervalMs < MIN_AUTO_CLEANUP_MS) {
      throw new EnvConfigError(
        `autoCleanupIntervalMs must be >= ${MIN_AUTO_CLEANUP_MS}ms (1 minute) when > 0 (received ${autoCleanupIntervalMs}ms).`,
      );
    }
    if (maxTotalTripEvents < 1) {
      throw new EnvConfigError(`maxTotalTripEvents must be >= 1 (received ${maxTotalTripEvents}).`);
    }

    this.config = {
      maxWorkerMinutesPerPbi: maxWorkerMinutes,
      maxFailedSelfCorrect,
      minDurationMs,
      maxTripsPerPbi,
      maxStateEntries,
      autoCleanupIntervalMs,
      maxTotalTripEvents,
    };

    // Start auto-cleanup if configured
    if (autoCleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.cleanupStaleStates(60);
      }, autoCleanupIntervalMs);
    }
  }

  /**
   * Record one completed unit of worker activity for a PBI. May trip the
   * breaker if a budget is now exceeded. A tripped PBI is ignored thereafter,
   * so post-trip work neither counts nor re-trips (AC3).
   *
   * SECURITY NOTES:
   * - Durations below `minDurationMs` are discarded to prevent sub-second
   *   exploitation via Math.ceil rounding (59,999ms max rounds to 1 minute).
   * - Trip events are capped at `maxTripsPerPbi` per PBI to prevent DoS.
   * - workerMinutes addition uses Number-safe bounds to prevent overflow.
   */
  recordWorkerActivity(activity: WorkerActivity): void {
    // Delegate to validator for strict input validation
    validateWorkerActivity(activity);

    if (this.isTripped(activity.pbiId)) return;

    // Security: discard sub-threshold durations to prevent Math.ceil exploitation
    if (activity.durationMs < this.config.minDurationMs) return;

    // Round up to ensure we don't under-count toward the threshold
    // Math.ceil(x/60000) for x < 60000 gives 1 (max over-count: 59,999ms)
    // NOTE: Math.ceil is intentionally chosen over Math.floor — we bias toward
    // OVER-counting worker minutes so a PBI can never escape its budget by
    // splitting work into many sub-minute tasks. The max over-count per task is
    // 59,999ms (just under 1 minute).
    const minutes = Math.ceil(activity.durationMs / 60_000);

    // Get or create state (will fail fast on overflow later)
    const state = this.getOrCreateState(activity.pbiId);

    // Guard against memory bloat — check BEFORE adding new state so we never
    // temporarily exceed maxStateEntries.
    if (this.state.size > this.config.maxStateEntries) {
      this.enforceStateLimit();
    }

    // Overflow-safe addition with defensive trip
    this.checkedWorkerMinutesAdd(state, minutes, activity.pbiId);

    if (state.workerMinutes >= this.config.maxWorkerMinutesPerPbi) {
      this.trip(activity.pbiId, state.workerMinutes, "worker-minutes-exceeded");
      return;
    }

    if (activity.status === "failure") {
      state.failedSelfCorrectCycles += 1;
      if (state.failedSelfCorrectCycles >= this.config.maxFailedSelfCorrect) {
        this.trip(activity.pbiId, state.workerMinutes, "failed-selfcorrect-exceeded");
      }
    }
  }

  /**
   * Overflow-safe worker minutes addition.
   * Trips defensively if addition would exceed safe integer bounds.
   * This prevents both integer overflow and memory exhaustion via many tiny additions.
   */
  private checkedWorkerMinutesAdd(state: PbiState, minutes: number, pbiId: string): void {
    // Defensive bound check before adding: if current > MAX - minutes, adding would overflow
    if (state.workerMinutes > Number.MAX_SAFE_INTEGER - minutes) {
      // Would overflow — trip the breaker to prevent corruption
      this.trip(pbiId, state.workerMinutes, "worker-minutes-exceeded");
      return;
    }

    state.workerMinutes += minutes;
    state.lastActivityAt = Date.now();
  }

  /** Has this PBI's breaker tripped? */
  isTripped(pbiId: string): boolean {
    return this.state.get(pbiId)?.tripped ?? false;
  }

  /** All trip events emitted so far (machine-readable for the escalation channel). */
  getTripEvents(): TripEvent[] {
    return [...this.tripEvents];
  }

  /** Get the current cumulative worker minutes for a PBI (for monitoring). */
  getWorkerMinutes(pbiId: string): number {
    return this.state.get(pbiId)?.workerMinutes ?? 0;
  }

  /** Get the current number of tracked PBIs (for monitoring memory growth). */
  getStateSize(): number {
    return this.state.size;
  }

  /** Clear state for a specific PBI (useful for testing or cancellation).
   * Also removes associated trip events to keep state consistent. */
  reset(pbiId: string): void {
    const s = this.state.get(pbiId);
    if (s) {
      s.workerMinutes = 0;
      s.failedSelfCorrectCycles = 0;
      s.tripped = false;
      s.tripCount = 0;
      s.lastActivityAt = Date.now();
    }
    // Remove trip events for this PBI to keep tripEvents array consistent
    for (let i = this.tripEvents.length - 1; i >= 0; i--) {
      if (this.tripEvents[i].pbiId === pbiId) {
        this.tripEvents.splice(i, 1);
      }
    }
  }

  /**
   * Clear stale PBI states to prevent memory bloat.
   *
   * @param maxAgeMinutes For tripped states: removes if tripCount >= maxTripsPerPbi.
   *                      For non-tripped states: removes if no activity for maxAgeMinutes.
   *                      Set to 0 to disable age-based cleanup. Default 60 minutes.
   * @returns Number of state entries cleared
   */
  cleanupStaleStates(maxAgeMinutes: number = 60): number {
    let cleared = 0;
    const now = Date.now();
    const maxAgeMs = maxAgeMinutes * 60_000;

    for (const [pbiId, s] of this.state) {
      if (s.tripped && s.tripCount >= this.config.maxTripsPerPbi) {
        // Fully-expended tripped state → safe to remove
        this.state.delete(pbiId);
        cleared++;
      } else if (!s.tripped && maxAgeMinutes > 0 && now - s.lastActivityAt > maxAgeMs) {
        // Non-tripped state with no recent activity → remove to free memory
        this.state.delete(pbiId);
        cleared++;
      }
    }
    return cleared;
  }

  /**
   * Manual state management: enforce maxStateEntries by removing oldest PBIs.
   * Used when state map grows beyond configured limit.
   */
  private enforceStateLimit(): void {
    const entries = Array.from(this.state.entries())
      .sort((a, b) => a[1].lastActivityAt - b[1].lastActivityAt);

    // Remove oldest entries until we're under the limit
    while (this.state.size > this.config.maxStateEntries && entries.length > 0) {
      const [pbiId] = entries.shift()!;
      this.state.delete(pbiId);
    }
  }

  /**
   * Dispose the breaker and release resources.
   * Stops any auto-cleanup timer if configured and clears all in-memory state.
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.state.clear();
    this.tripEvents.length = 0;
  }

  private getOrCreateState(pbiId: string): PbiState {
    let s = this.state.get(pbiId);
    if (!s) {
      s = {
        workerMinutes: 0,
        failedSelfCorrectCycles: 0,
        tripped: false,
        tripCount: 0,
        lastActivityAt: Date.now(),
      };
      this.state.set(pbiId, s);
    }
    return s;
  }

  private trip(pbiId: string, workerMinutes: number, reason: TripReason): void {
    const s = this.getOrCreateState(pbiId);
    // Global rate limit: check total trip events first
    if (this.tripEvents.length >= this.config.maxTotalTripEvents) {
      return; // Drop event to prevent DoS via flood of unique PBIs
    }
    // Per-PBI rate limit
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
 * - `DF_MIN_DURATION_MS`: >= 0 (default 5000)
 * - `DF_MAX_TRIPS_PER_PBI`: >= 1 (default 100)
 *
 * Non-integer strings (e.g., `"123abc"`, `"-5"`, `"3.14"`) throw immediately.
 *
 * @param env - Environment record (defaults to `process.env`). For testing,
 *              pass a plain object to avoid coupling to process.env.
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
      Number.MAX_SAFE_INTEGER,
    ),
    minDurationMs: readInt(
      "DF_MIN_DURATION_MS",
      env.DF_MIN_DURATION_MS,
      DEFAULTS.minDurationMs,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    maxTripsPerPbi: readInt(
      "DF_MAX_TRIPS_PER_PBI",
      env.DF_MAX_TRIPS_PER_PBI,
      DEFAULTS.maxTripsPerPbi,
      1,
      Number.MAX_SAFE_INTEGER,
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

  // Explicit NaN check for robustness (should never happen due to regex, but defense-in-depth)
  if (Number.isNaN(parsed)) {
    throw new EnvConfigError(
      `${name} resulted in NaN (received ${JSON.stringify(raw)}).`,
    );
  }

  // Explicit overflow check against MAX_SAFE_INTEGER
  if (parsed > Number.MAX_SAFE_INTEGER) {
    throw new EnvConfigError(
      `${name} must be <= ${Number.MAX_SAFE_INTEGER} (received ${JSON.stringify(raw)}).`,
    );
  }
  if (parsed < min || parsed > max) {
    const range = `${min}..${max}`;
    throw new EnvConfigError(
      `${name} must be an integer in range ${range} (received ${JSON.stringify(raw)}).`,
    );
  }
  return parsed;
}