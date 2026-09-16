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

export class InvalidTripEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTripEventError";
  }
}

const VALID_REASONS: readonly TripReason[] = [
  "worker-minutes-exceeded",
  "failed-selfcorrect-exceeded",
] as const;

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
  const pbiId = typeof input.pbiId === "string" ? input.pbiId.trim() : "";
  if (!pbiId) {
    throw new InvalidTripEventError(
      `Trip event requires a non-empty "pbiId" (received ${JSON.stringify(input.pbiId)}).`,
    );
  }

  const minutes = input.workerMinutes;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) {
    throw new InvalidTripEventError(
      `Trip event requires "workerMinutes" to be a finite number >= 0 (received ${JSON.stringify(minutes)}).`,
    );
  }

  const reason = input.reason;
  if (!reason || !VALID_REASONS.includes(reason as TripReason)) {
    throw new InvalidTripEventError(
      `Trip event "reason" must be one of ${VALID_REASONS.join(", ")} (received ${JSON.stringify(reason)}).`,
    );
  }

  return {
    pbiId,
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
 */
export class CircuitBreaker {
  private readonly state = new Map<string, PbiState>();
  private readonly tripEvents: TripEvent[] = [];
  private readonly config: Required<CircuitBreakerConfig>;

  constructor(config: CircuitBreakerConfig = {}) {
    this.config = {
      maxWorkerMinutesPerPbi: config.maxWorkerMinutesPerPbi ?? 60,
      maxFailedSelfCorrect: config.maxFailedSelfCorrect ?? 3,
    };
  }

  /**
   * Record one completed unit of worker activity for a PBI. May trip the
   * breaker if a budget is now exceeded. A tripped PBI is ignored thereafter,
   * so post-trip work neither counts nor re-trips (AC3).
   */
  recordWorkerActivity(activity: WorkerActivity): void {
    if (this.isTripped(activity.pbiId)) return;

    const minutes = activity.durationMs / 60_000;
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
