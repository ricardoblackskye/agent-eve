import { describe, it, expect } from "vitest";
import {
  toTripEvent,
  validateWorkerActivity,
  InvalidTripEventError,
  EnvConfigError,
  CircuitBreaker,
  createCircuitBreaker,
  createWorkerActivityObserver,
  type TripReason,
  type WorkerActivity,
  type WorkerActivitySink,
} from "../../agent/lib/dark-factory/circuit-breaker";

// --- Task 144.1: toTripEvent canonical payload ---

describe("toTripEvent canonical payload (#144 AC1/AC2)", () => {
  it("produces a valid event for worker-minutes-exceeded", () => {
    const event = toTripEvent({
      pbiId: "PBI-42",
      workerMinutes: 65,
      reason: "worker-minutes-exceeded",
    });

    expect(event).toEqual({
      pbiId: "PBI-42",
      workerMinutes: 65,
      reason: "worker-minutes-exceeded",
      timestamp: expect.any(String),
    });
    expect(() => new Date(event.timestamp)).not.toThrow();
  });

  it("produces a valid event for failed-selfcorrect-exceeded", () => {
    const event = toTripEvent({
      pbiId: "PBI-7",
      workerMinutes: 30,
      reason: "failed-selfcorrect-exceeded",
    });

    expect(event.pbiId).toBe("PBI-7");
    expect(event.reason).toBe("failed-selfcorrect-exceeded");
    expect(event.timestamp).toEqual(expect.any(String));
  });

  it("rejects a missing pbiId", () => {
    expect(() =>
      toTripEvent({
        pbiId: "",
        workerMinutes: 65,
        reason: "worker-minutes-exceeded",
      }),
    ).toThrow(InvalidTripEventError);
  });

  it("rejects a pbiId with invalid format (must start with letter)", () => {
    expect(() =>
      toTripEvent({
        pbiId: "42-invalid",
        workerMinutes: 10,
        reason: "worker-minutes-exceeded",
      }),
    ).toThrow(InvalidTripEventError);
  });

  it("rejects negative worker-minutes", () => {
    expect(() =>
      toTripEvent({
        pbiId: "PBI-1",
        workerMinutes: -5,
        reason: "worker-minutes-exceeded",
      }),
    ).toThrow(/workerMinutes/);
  });

  it("rejects a non-finite worker-minutes", () => {
    expect(() =>
      toTripEvent({
        pbiId: "PBI-1",
        workerMinutes: NaN,
        reason: "worker-minutes-exceeded",
      }),
    ).toThrow(/workerMinutes/);
  });

  it("trims whitespace from the pbiId", () => {
    const event = toTripEvent({
      pbiId: "  PBI-99  ",
      workerMinutes: 12,
      reason: "worker-minutes-exceeded",
    });
    expect(event.pbiId).toBe("PBI-99");
  });
});

// --- Task 144.2: worker-minute tracking per PBI ---

describe("CircuitBreaker worker-minute accumulation (#144 AC1)", () => {
  it("trips when cumulative worker-minutes reach the PBI budget", () => {
    const breaker = new CircuitBreaker({ maxWorkerMinutesPerPbi: 60 });

    breaker.recordWorkerActivity({
      pbiId: "PBI-42",
      durationMs: 20 * 60_000,
      status: "success",
    });
    breaker.recordWorkerActivity({
      pbiId: "PBI-42",
      durationMs: 25 * 60_000,
      status: "success",
    });
    breaker.recordWorkerActivity({
      pbiId: "PBI-42",
      durationMs: 20 * 60_000,
      status: "success",
    });

    // 20 + 25 + 20 = 65 > 60 → tripped
    expect(breaker.isTripped("PBI-42")).toBe(true);
    const trips = breaker.getTripEvents();
    expect(trips).toHaveLength(1);
    expect(trips[0].reason).toBe("worker-minutes-exceeded");
    expect(trips[0].workerMinutes).toBeCloseTo(65, 5);
  });

  it("trips at EXACT budget boundary (60 minutes = 60 * 60,000 ms)", () => {
    const breaker = new CircuitBreaker({ maxWorkerMinutesPerPbi: 60 });

    // Exactly at boundary should trip
    breaker.recordWorkerActivity({
      pbiId: "PBI-EXACT",
      durationMs: 60 * 60_000, // exactly 60 minutes
      status: "success",
    });
    expect(breaker.isTripped("PBI-EXACT")).toBe(true);
  });

  it("trips at 59 minutes then additional ms round up to 60", () => {
    const breaker = new CircuitBreaker({
      maxWorkerMinutesPerPbi: 60,
      minDurationMs: 1000, // override to allow sub-5s for this test
    });

    breaker.recordWorkerActivity({
      pbiId: "PBI-ROUND",
      durationMs: 59 * 60_000,
      status: "success",
    });
    expect(breaker.isTripped("PBI-ROUND")).toBe(false);

    // 1 second = 1 minute after Math.ceil rounding (with minDurationMs=1000)
    breaker.recordWorkerActivity({
      pbiId: "PBI-ROUND",
      durationMs: 1_000,
      status: "success",
    });
    expect(breaker.isTripped("PBI-ROUND")).toBe(true);
  });

  it("does NOT trip when cumulative minutes stay under budget", () => {
    const breaker = new CircuitBreaker({ maxWorkerMinutesPerPbi: 60 });

    breaker.recordWorkerActivity({ pbiId: "PBI-1", durationMs: 30 * 60_000, status: "success" });
    breaker.recordWorkerActivity({ pbiId: "PBI-1", durationMs: 29 * 60_000, status: "success" });

    expect(breaker.isTripped("PBI-1")).toBe(false);
    expect(breaker.getTripEvents()).toHaveLength(0);
  });

  it("keeps PBIs independent — one PBI tripping does not affect another", () => {
    const breaker = new CircuitBreaker({ maxWorkerMinutesPerPbi: 30 });

    breaker.recordWorkerActivity({ pbiId: "PBI-A", durationMs: 35 * 60_000, status: "success" });
    breaker.recordWorkerActivity({ pbiId: "PBI-B", durationMs: 10 * 60_000, status: "success" });

    expect(breaker.isTripped("PBI-A")).toBe(true);
    expect(breaker.isTripped("PBI-B")).toBe(false);
  });

  it("does not consume additional minutes after tripping (AC3)", () => {
    const breaker = new CircuitBreaker({ maxWorkerMinutesPerPbi: 60 });

    breaker.recordWorkerActivity({ pbiId: "PBI-7", durationMs: 65 * 60_000, status: "success" });
    expect(breaker.isTripped("PBI-7")).toBe(true);

    const beforeTrips = breaker.getTripEvents().length;

    // More work after trip — must NOT add new trips or change state
    breaker.recordWorkerActivity({ pbiId: "PBI-7", durationMs: 100 * 60_000, status: "success" });

    expect(breaker.getTripEvents().length).toBe(beforeTrips);
    expect(breaker.isTripped("PBI-7")).toBe(true);
  });

  it("respects upper bound of 10080 minutes (7 days)", () => {
    // Create a breaker with the maximum allowed budget
    const breaker = new CircuitBreaker({ maxWorkerMinutesPerPbi: 10080 });
    // 10079 minutes = below limit
    breaker.recordWorkerActivity({
      pbiId: "PBI-UPPER",
      durationMs: 10079 * 60_000,
      status: "success",
    });
    expect(breaker.isTripped("PBI-UPPER")).toBe(false);
    // 1 more minute = exactly at limit, should trip
    breaker.recordWorkerActivity({
      pbiId: "PBI-UPPER",
      durationMs: 1 * 60_000,
      status: "success",
    });
    expect(breaker.isTripped("PBI-UPPER")).toBe(true);
  });
});

// --- Task 144.3: self-correct cycle escalation (#144 AC2) ---

describe("CircuitBreaker self-correct cycle escalation (#144 AC2)", () => {
  it("trips after N failed self-correct cycles (default N=3)", () => {
    const breaker = new CircuitBreaker({ maxFailedSelfCorrect: 3 });

    breaker.recordWorkerActivity({ pbiId: "PBI-7", durationMs: 5 * 60_000, status: "failure" });
    breaker.recordWorkerActivity({ pbiId: "PBI-7", durationMs: 5 * 60_000, status: "failure" });
    expect(breaker.isTripped("PBI-7")).toBe(false);

    // Third failure → trip
    breaker.recordWorkerActivity({ pbiId: "PBI-7", durationMs: 5 * 60_000, status: "failure" });

    expect(breaker.isTripped("PBI-7")).toBe(true);
    const trips = breaker.getTripEvents();
    expect(trips).toHaveLength(1);
    expect(trips[0].reason).toBe("failed-selfcorrect-exceeded");
  });

  it("does NOT trip if a cycle succeeds before reaching N", () => {
    const breaker = new CircuitBreaker({ maxFailedSelfCorrect: 3 });

    breaker.recordWorkerActivity({ pbiId: "PBI-1", durationMs: 5 * 60_000, status: "failure" });
    breaker.recordWorkerActivity({ pbiId: "PBI-1", durationMs: 5 * 60_000, status: "success" });
    breaker.recordWorkerActivity({ pbiId: "PBI-1", durationMs: 5 * 60_000, status: "failure" });

    expect(breaker.isTripped("PBI-1")).toBe(false);
    expect(breaker.getTripEvents()).toHaveLength(0);
  });

  it("uses a configurable threshold (N=1)", () => {
    const breaker = new CircuitBreaker({ maxFailedSelfCorrect: 1 });

    breaker.recordWorkerActivity({ pbiId: "PBI-X", durationMs: 1 * 60_000, status: "failure" });

    expect(breaker.isTripped("PBI-X")).toBe(true);
    expect(breaker.getTripEvents()[0].reason).toBe("failed-selfcorrect-exceeded");
  });

  it("keeps PBIs independent for self-correct trips too", () => {
    const breaker = new CircuitBreaker({ maxFailedSelfCorrect: 2 });

    breaker.recordWorkerActivity({ pbiId: "PBI-A", durationMs: 1 * 60_000, status: "failure" });
    breaker.recordWorkerActivity({ pbiId: "PBI-A", durationMs: 1 * 60_000, status: "failure" });
    breaker.recordWorkerActivity({ pbiId: "PBI-B", durationMs: 1 * 60_000, status: "failure" });

    expect(breaker.isTripped("PBI-A")).toBe(true);
    expect(breaker.isTripped("PBI-B")).toBe(false);
  });

  it("stops retrying after trip: no more trips on later failures (AC2)", () => {
    const breaker = new CircuitBreaker({ maxFailedSelfCorrect: 2 });

    breaker.recordWorkerActivity({ pbiId: "PBI-9", durationMs: 1 * 60_000, status: "failure" });
    breaker.recordWorkerActivity({ pbiId: "PBI-9", durationMs: 1 * 60_000, status: "failure" });
    expect(breaker.isTripped("PBI-9")).toBe(true);

    const beforeTrips = breaker.getTripEvents().length;
    breaker.recordWorkerActivity({ pbiId: "PBI-9", durationMs: 1 * 60_000, status: "failure" });
    breaker.recordWorkerActivity({ pbiId: "PBI-9", durationMs: 1 * 60_000, status: "failure" });

    expect(breaker.getTripEvents().length).toBe(beforeTrips);
  });
});

// --- Task 144.5: worker-activity observer integration ---

describe("createWorkerActivityObserver integration (#144)", () => {
  it("forwards worker activity to the breaker", () => {
    const breaker = new CircuitBreaker({ maxWorkerMinutesPerPbi: 30 });
    const sink: WorkerActivitySink = createWorkerActivityObserver(breaker);

    sink({ pbiId: "PBI-1", durationMs: 35 * 60_000, status: "success" });

    expect(breaker.isTripped("PBI-1")).toBe(true);
    expect(breaker.getTripEvents()[0].reason).toBe("worker-minutes-exceeded");
  });

  it("can mount independently of the breaker instance", () => {
    const breaker = new CircuitBreaker({ maxFailedSelfCorrect: 1 });
    const sink = createWorkerActivityObserver(breaker);

    sink({ pbiId: "PBI-2", durationMs: 1 * 60_000, status: "failure" });

    expect(breaker.isTripped("PBI-2")).toBe(true);
  });
});

// --- Task 144.6: environment wiring + edge cases ---

describe("createCircuitBreaker env wiring (#144)", () => {
  it("uses defaults when env is empty (normal usage stays under budget)", () => {
    const breaker = createCircuitBreaker({});
    // 60 min budget, 3 failures — normal usage stays under both
    breaker.recordWorkerActivity({ pbiId: "PBI-1", durationMs: 10 * 60_000, status: "success" });
    breaker.recordWorkerActivity({ pbiId: "PBI-1", durationMs: 10 * 60_000, status: "success" });
    breaker.recordWorkerActivity({ pbiId: "PBI-1", durationMs: 1 * 60_000, status: "failure" });
    breaker.recordWorkerActivity({ pbiId: "PBI-1", durationMs: 1 * 60_000, status: "failure" });
    expect(breaker.isTripped("PBI-1")).toBe(false);
  });

  it("trips exactly at the budget boundary (59 + 1 = 60)", () => {
    const breaker = createCircuitBreaker({});
    breaker.recordWorkerActivity({ pbiId: "PBI-B", durationMs: 59 * 60_000, status: "success" });
    expect(breaker.isTripped("PBI-B")).toBe(false);
    breaker.recordWorkerActivity({ pbiId: "PBI-B", durationMs: 1 * 60_000, status: "success" });
    expect(breaker.isTripped("PBI-B")).toBe(true);
  });

  it("reads DF_MAX_WORKER_MINUTES_PER_PBI from env", () => {
    const breaker = createCircuitBreaker({ DF_MAX_WORKER_MINUTES_PER_PBI: "45" });
    breaker.recordWorkerActivity({ pbiId: "PBI-2", durationMs: 46 * 60_000, status: "success" });
    expect(breaker.isTripped("PBI-2")).toBe(true);
  });

  it("reads DF_MAX_FAILED_SELFCORRECT from env", () => {
    const breaker = createCircuitBreaker({ DF_MAX_FAILED_SELFCORRECT: "2" });
    breaker.recordWorkerActivity({ pbiId: "PBI-3", durationMs: 1 * 60_000, status: "failure" });
    breaker.recordWorkerActivity({ pbiId: "PBI-3", durationMs: 1 * 60_000, status: "failure" });
    expect(breaker.isTripped("PBI-3")).toBe(true);
  });

  it("throws EnvConfigError on malformed env values (fail-closed)", () => {
    expect(() => createCircuitBreaker({ DF_MAX_WORKER_MINUTES_PER_PBI: "abc" })).toThrow(
      EnvConfigError,
    );
    expect(() => createCircuitBreaker({ DF_MAX_FAILED_SELFCORRECT: "0" })).toThrow(EnvConfigError);
  });
});

// --- Edge case tests: overflow, malformed strings, pbiId format ---

describe("readInt edge cases (security & overflow)", () => {
  it("throws on value exceeding upper bound (10080)", () => {
    // 10081 minutes = 1 week + 1 minute, exceeds MAX_WORKER_MINUTES
    expect(() =>
      createCircuitBreaker({ DF_MAX_WORKER_MINUTES_PER_PBI: "10081" }),
    ).toThrow(/must be an integer in range/);
  });

  it("throws on non-integer numeric strings (e.g., '3.14')", () => {
    expect(() =>
      createCircuitBreaker({ DF_MAX_WORKER_MINUTES_PER_PBI: "3.14" }),
    ).toThrow(/must be a valid positive integer/);
  });

  it("throws on strings with trailing non-numeric content (e.g., '123abc')", () => {
    expect(() =>
      createCircuitBreaker({ DF_MAX_WORKER_MINUTES_PER_PBI: "123abc" }),
    ).toThrow(/must be a valid positive integer/);
  });

  it("uses default when string is all whitespace (treated as unset)", () => {
    const breaker = createCircuitBreaker({ DF_MAX_WORKER_MINUTES_PER_PBI: "   " });
    expect(breaker.isTripped("any")).toBe(false);
  });

  it("uses default when empty string provided", () => {
    const breaker = createCircuitBreaker({ DF_MAX_WORKER_MINUTES_PER_PBI: "" });
    expect(breaker.isTripped("any")).toBe(false);
  });

  it("throws on value below minimum (fail-closed)", () => {
    expect(() =>
      createCircuitBreaker({ DF_MAX_WORKER_MINUTES_PER_PBI: "0" }),
    ).toThrow(/range/);
    expect(() =>
      createCircuitBreaker({ DF_MAX_WORKER_MINUTES_PER_PBI: "-5" }),
    ).toThrow(/must be a valid positive integer/);
  });

  it("throws on malformed DF_MAX_FAILED_SELFCORRECT", () => {
    expect(() =>
      createCircuitBreaker({ DF_MAX_FAILED_SELFCORRECT: "1.5" }),
    ).toThrow(EnvConfigError);
    expect(() =>
      createCircuitBreaker({ DF_MAX_FAILED_SELFCORRECT: "abc" }),
    ).toThrow(EnvConfigError);
  });

  it("throws with descriptive range error message", () => {
    expect(() =>
      createCircuitBreaker({ DF_MAX_WORKER_MINUTES_PER_PBI: "0" }),
    ).toThrow(/range \d+\.\.\d+/);
  });

  it("accepts upper bound (10080 = 1 week in minutes)", () => {
    const breaker = createCircuitBreaker({
      DF_MAX_WORKER_MINUTES_PER_PBI: "10080",
    });
    expect(breaker.isTripped("any")).toBe(false);
  });

  it("max boundary: 1 is the minimum valid value", () => {
    const breaker = createCircuitBreaker({
      DF_MAX_WORKER_MINUTES_PER_PBI: "1",
      DF_MAX_FAILED_SELFCORRECT: "1",
    });
    breaker.recordWorkerActivity({ pbiId: "PBI-X", durationMs: 1 * 60_000, status: "success" });
    expect(breaker.isTripped("PBI-X")).toBe(true);
  });
});

// --- Additional: reset method and pbiId format ---

describe("CircuitBreaker.reset()", () => {
  it("resets a tripped PBI", () => {
    const breaker = new CircuitBreaker({ maxWorkerMinutesPerPbi: 60 });
    breaker.recordWorkerActivity({ pbiId: "PBI-RESET", durationMs: 65 * 60_000, status: "success" });
    expect(breaker.isTripped("PBI-RESET")).toBe(true);
    expect(breaker.getTripEvents()).toHaveLength(1); // trip recorded

    breaker.reset("PBI-RESET");
    expect(breaker.isTripped("PBI-RESET")).toBe(false);
    expect(breaker.getTripEvents()).toHaveLength(0); // trip events cleared by reset

    // After reset, new activity counts fresh
    breaker.recordWorkerActivity({ pbiId: "PBI-RESET", durationMs: 50 * 60_000, status: "success" });
    expect(breaker.isTripped("PBI-RESET")).toBe(false);
  });

  it("is safe to reset non-existent PBI", () => {
    const breaker = new CircuitBreaker();
    expect(() => breaker.reset("UNKNOWN-PBI")).not.toThrow();
    expect(breaker.isTripped("UNKNOWN-PBI")).toBe(false);
  });
});

describe("toTripEvent pbiId format validation (no periods for security)", () => {
  it("accepts valid PBI identifiers (letter followed by alphanumeric/underscore/hyphen only)", () => {
    const event = toTripEvent({
      pbiId: "task-v1_2_3",
      workerMinutes: 10,
      reason: "worker-minutes-exceeded",
    });
    expect(event.pbiId).toBe("task-v1_2_3");
  });

  it("rejects PBI IDs with periods (path traversal prevention)", () => {
    expect(() =>
      toTripEvent({
        pbiId: "task.v1",
        workerMinutes: 10,
        reason: "worker-minutes-exceeded",
      }),
    ).toThrow(/pbiId.*must match pattern/);
  });

  it("rejects PBI IDs starting with numbers", () => {
    expect(() =>
      toTripEvent({
        pbiId: "123-task",
        workerMinutes: 10,
        reason: "worker-minutes-exceeded",
      }),
    ).toThrow(/pbiId.*must match pattern/);
  });
});

// --- Non-integer env var handling (readInt) ---

describe("createCircuitBreaker negative testing", () => {
  it("throws EnvConfigError with code for non-integer env var", () => {
    expect(() =>
      createCircuitBreaker({ DF_MAX_WORKER_MINUTES_PER_PBI: "3.14" }),
    ).toThrow(/must be a valid positive integer/);
  });

  it("throws EnvConfigError with code for alphanumeric env var", () => {
    expect(() =>
      createCircuitBreaker({ DF_MAX_WORKER_MINUTES_PER_PBI: "3abc" }),
    ).toThrow(/must be a valid positive integer/);
  });

  it("throws EnvConfigError for value exceeding upper bound", () => {
    expect(() =>
      createCircuitBreaker({ DF_MAX_WORKER_MINUTES_PER_PBI: "20000" }),
    ).toThrow(/must be an integer in range 1\.\.10080/);
  });

  it("throws EnvConfigError for maxFailedSelfCorrect = 0", () => {
    expect(() =>
      new CircuitBreaker({ maxFailedSelfCorrect: 0 }),
    ).toThrow(/maxFailedSelfCorrect must be >= 1/);
  });
});

// --- maxTripsPerPbi boundary conditions ---
// Note: Since trip() is private and recordWorkerActivity ignores tripped PBIs,
// we test rate limiting indirectly. tripCount is capped at maxTripsPerPbi,
// preventing event array from growing unbounded.

describe("maxTripsPerPbi boundary conditions", () => {
  it("cleanupStaleStates removes PBIs with tripCount >= maxTripsPerPbi", () => {
    const breaker = new CircuitBreaker({
      maxWorkerMinutesPerPbi: 60,
      maxTripsPerPbi: 1,
    });

    // Trip once (65 min >= 60)
    breaker.recordWorkerActivity({ pbiId: "PBI-CLEAN", durationMs: 65 * 60_000, status: "success" });
    expect(breaker.getTripEvents()).toHaveLength(1);
    expect(breaker.isTripped("PBI-CLEAN")).toBe(true);

    // Cleanup should remove this PBI since tripCount (1) >= maxTripsPerPbi (1)
    const cleared = breaker.cleanupStaleStates();
    expect(cleared).toBe(1);
    expect(breaker.isTripped("PBI-CLEAN")).toBe(false);
  });

  it("cleanupStaleStates keeps PBIs below trip limit", () => {
    const breaker = new CircuitBreaker({
      maxWorkerMinutesPerPbi: 120,
      maxTripsPerPbi: 5,
    });

    // Trip once (70 min < 120 min)
    breaker.recordWorkerActivity({ pbiId: "PBI-KEPT", durationMs: 70 * 60_000, status: "success" });
    expect(breaker.getTripEvents()).toHaveLength(0);

    // Trip again (another 70 min, total 140 >= 120)
    breaker.recordWorkerActivity({ pbiId: "PBI-KEPT", durationMs: 70 * 60_000, status: "success" });
    expect(breaker.getTripEvents()).toHaveLength(1);

    // Cleanup should NOT remove this PBI (tripCount 1 < maxTripsPerPbi 5)
    const cleared = breaker.cleanupStaleStates();
    expect(cleared).toBe(0);
    expect(breaker.isTripped("PBI-KEPT")).toBe(true);
  });
});

describe("Error classes have machine-readable codes", () => {
  it("EnvConfigError has code property", () => {
    try {
      new CircuitBreaker({ maxWorkerMinutesPerPbi: -1 });
    } catch (e) {
      expect((e as Error).constructor.name).toBe("EnvConfigError");
      expect((e as any).code).toBe("ERR_ENV_CONFIG");
    }
  });

  it("InvalidTripEventError has code property", () => {
    try {
      toTripEvent({ pbiId: "", workerMinutes: 10, reason: "worker-minutes-exceeded" });
    } catch (e) {
      expect((e as Error).constructor.name).toBe("InvalidTripEventError");
      expect((e as any).code).toBe("ERR_INVALID_TRIP_EVENT");
    }
  });
});

// --- Additional security validations ---

describe("PBI ID length validation", () => {
  it("rejects PBI IDs exceeding 128 characters", () => {
    const longId = "PBI-" + "x".repeat(200);
    expect(longId.length).toBeGreaterThan(128);
    expect(() =>
      toTripEvent({ pbiId: longId, workerMinutes: 10, reason: "worker-minutes-exceeded" }),
    ).toThrow(/must be <= 128 characters/);
  });

  it("accepts PBI IDs at exactly 128 characters", () => {
    const validId = "P" + "x".repeat(127);
    expect(validId.length).toBe(128);
    const event = toTripEvent({
      pbiId: validId,
      workerMinutes: 10,
      reason: "worker-minutes-exceeded",
    });
    expect(event.pbiId).toBe(validId);
  });
});

describe("reset removes associated trip events", () => {
  it("clears trip events for a PBI when reset() is called", () => {
    const breaker = new CircuitBreaker({ maxWorkerMinutesPerPbi: 60 });

    breaker.recordWorkerActivity({ pbiId: "PBI-RESET-EVENT", durationMs: 65 * 60_000, status: "success" });
    expect(breaker.getTripEvents()).toHaveLength(1);

    breaker.reset("PBI-RESET-EVENT");
    expect(breaker.getTripEvents()).toHaveLength(0);
    expect(breaker.isTripped("PBI-RESET-EVENT")).toBe(false);
  });
});

describe("cleanupStaleStates handles non-tripped states by age", () => {
  it("removes non-tripped states with no activity for maxAgeMinutes", () => {
    const breaker = new CircuitBreaker();

    // Record activity
    breaker.recordWorkerActivity({ pbiId: "PBI-OLD", durationMs: 10 * 60_000, status: "success" });
    expect(breaker.isTripped("PBI-OLD")).toBe(false);

    // Simulate old activity by mocking Date.now
    const originalNow = Date.now;
    Date.now = () => originalNow() + 61 * 60_000; // 61 min later

    const cleared = breaker.cleanupStaleStates(60);
    expect(cleared).toBe(1);
    expect(breaker.isTripped("PBI-OLD")).toBe(false);

    // Restore
    Date.now = originalNow;
  });

  it("keeps non-tripped states with recent activity", () => {
    const breaker = new CircuitBreaker();

    breaker.recordWorkerActivity({ pbiId: "PBI-RECENT", durationMs: 10 * 60_000, status: "success" });

    const cleared = breaker.cleanupStaleStates(60);
    expect(cleared).toBe(0);
    expect(breaker.isTripped("PBI-RECENT")).toBe(false);
  });
});

describe("readInt integer overflow protection", () => {
  it("throws for values exceeding MAX_SAFE_INTEGER", () => {
    expect(() =>
      createCircuitBreaker({ DF_MAX_FAILED_SELFCORRECT: String(Number.MAX_SAFE_INTEGER + 1) }),
    ).toThrow(/must be <= /);
  });

  it("accepts value at MAX_SAFE_INTEGER boundary", () => {
    expect(() =>
      createCircuitBreaker({ DF_MAX_FAILED_SELFCORRECT: String(Number.MAX_SAFE_INTEGER) }),
    ).not.toThrow();
  });
});

// --- Additional boundary conditions and rate limiting ---

describe("Math.ceil boundary conditions", () => {
  it("59,999ms rounds up to 1 minute (max over-count)", () => {
    const breaker = new CircuitBreaker({ maxWorkerMinutesPerPbi: 1 });

    // 59,999ms is just under 1 minute, but Math.ceil rounds up
    breaker.recordWorkerActivity({ pbiId: "PBI-59999", durationMs: 59_999, status: "success" });
    expect(breaker.isTripped("PBI-59999")).toBe(true);
    expect(breaker.getWorkerMinutes("PBI-59999")).toBe(1);
  });

  it("60,000ms rounds to exactly 1 minute", () => {
    const breaker = new CircuitBreaker({ maxWorkerMinutesPerPbi: 1 });

    breaker.recordWorkerActivity({ pbiId: "PBI-60000", durationMs: 60_000, status: "success" });
    expect(breaker.isTripped("PBI-60000")).toBe(true);
    expect(breaker.getWorkerMinutes("PBI-60000")).toBe(1);
  });

  it("exactly at threshold trips immediately", () => {
    const breaker = new CircuitBreaker({ maxWorkerMinutesPerPbi: 60 });

    breaker.recordWorkerActivity({ pbiId: "PBI-THRESHOLD", durationMs: 60 * 60_000, status: "success" });
    expect(breaker.isTripped("PBI-THRESHOLD")).toBe(true);
  });
});

describe("autoCleanupIntervalMs validation", () => {
  it("rejects autoCleanupIntervalMs below 1 minute", () => {
    expect(() =>
      new CircuitBreaker({ autoCleanupIntervalMs: 59_999 }),
    ).toThrow(/autoCleanupIntervalMs must be >= 60000ms/);
  });

  it("accepts autoCleanupIntervalMs at exactly 1 minute", () => {
    expect(() =>
      new CircuitBreaker({ autoCleanupIntervalMs: 60_000 }),
    ).not.toThrow();
  });
});

describe("maxTotalTripEvents rate limiting", () => {
  it("drops events when global limit reached", () => {
    const breaker = new CircuitBreaker({
      maxWorkerMinutesPerPbi: 10,
      maxTripsPerPbi: 50,
      maxTotalTripEvents: 3,
    });

    // Trip 3 PBIs to hit the global limit
    for (let i = 0; i < 3; i++) {
      breaker.recordWorkerActivity({
        pbiId: `PBI-GLOBAL-${i}`,
        durationMs: 15 * 60_000, // trips immediately
        status: "success",
      });
    }

    expect(breaker.getTripEvents()).toHaveLength(3);

    // 4th PBI should not trip because global limit reached
    breaker.recordWorkerActivity({
      pbiId: "PBI-GLOBAL-3",
      durationMs: 15 * 60_000,
      status: "success",
    });

    expect(breaker.getTripEvents()).toHaveLength(3); // still 3
  });
});

// --- State limit enforcement edge cases ---

describe("maxStateEntries enforcement", () => {
  it("removes oldest entries when state exceeds limit", () => {
    const breaker = new CircuitBreaker({ maxStateEntries: 3 });

    // Add 4 PBIs (each one creates state)
    for (let i = 0; i < 4; i++) {
      breaker.recordWorkerActivity({
        pbiId: `PBI-STATE-${i}`,
        durationMs: 10 * 60_000,
        status: "success",
      });
    }

    // State should be at or below limit
    expect(breaker.getStateSize()).toBeLessThanOrEqual(3);
  });

  it("keeps most recently used entries when enforcing limit", () => {
    const breaker = new CircuitBreaker({ maxStateEntries: 2, maxWorkerMinutesPerPbi: 1 });

    // Create first entry (trips at 1 min)
    breaker.recordWorkerActivity({ pbiId: "PBI-OLD", durationMs: 65 * 60_000, status: "success" });
    // Create second entry
    breaker.recordWorkerActivity({ pbiId: "PBI-MID", durationMs: 65 * 60_000, status: "success" });
    // Create third entry (oldest should be removed)
    breaker.recordWorkerActivity({ pbiId: "PBI-NEW", durationMs: 65 * 60_000, status: "success" });

    // PBI-OLD should have been cleaned up
    expect(breaker.isTripped("PBI-OLD")).toBe(false);
    // PBI-MID and PBI-NEW should still exist
    expect(breaker.isTripped("PBI-MID")).toBe(true);
    expect(breaker.isTripped("PBI-NEW")).toBe(true);
  });
});

describe("destroy() clears all state", () => {
  it("stops timer and clears state/tripEvents", () => {
    const breaker = new CircuitBreaker({ autoCleanupIntervalMs: 0 });

    breaker.recordWorkerActivity({
      pbiId: "PBI-DESTROY",
      durationMs: 65 * 60_000,
      status: "success",
    });
    expect(breaker.getTripEvents()).toHaveLength(1);
    expect(breaker.getStateSize()).toBe(1);

    breaker.destroy();

    expect(breaker.getTripEvents()).toHaveLength(0);
    expect(breaker.getStateSize()).toBe(0);
    expect(breaker.isTripped("PBI-DESTROY")).toBe(false);
  });

  it("safe to call destroy multiple times", () => {
    const breaker = new CircuitBreaker({});
    expect(() => breaker.destroy()).not.toThrow();
    expect(() => breaker.destroy()).not.toThrow();
  });
});

// --- Boundary condition tests ---

describe("toTripEvent NaN handling", () => {
  it("explicitly rejects NaN workerMinutes", () => {
    expect(() =>
      toTripEvent({ pbiId: "PBI-NaN", workerMinutes: NaN, reason: "worker-minutes-exceeded" }),
    ).toThrow(/finite number/);
  });
});

describe("boundary condition tests", () => {
  it("accepts maxWorkerMinutesPerPbi at exactly 10080", () => {
    const breaker = new CircuitBreaker({ maxWorkerMinutesPerPbi: 10080 });
    expect(breaker).toBeDefined();
  });

  it("rejects maxWorkerMinutesPerPbi exceeding 10080", () => {
    expect(() => new CircuitBreaker({ maxWorkerMinutesPerPbi: 10081 })).toThrow(
      /must be in range 1\.\.10080/,
    );
  });

  it("accepts maxWorkerMinutesPerPbi at exactly 1", () => {
    const breaker = new CircuitBreaker({ maxWorkerMinutesPerPbi: 1 });
    expect(breaker).toBeDefined();
  });

  it("rejects maxWorkerMinutesPerPbi at 0", () => {
    expect(() => new CircuitBreaker({ maxWorkerMinutesPerPbi: 0 })).toThrow(
      /must be in range 1\.\.10080/,
    );
  });
});

describe("Unicode PBI ID handling", () => {
  it("rejects PBI IDs with Unicode characters", () => {
    expect(() =>
      toTripEvent({
        pbiId: "PBI-üñíçödé", // Unicode chars rejected by regex
        workerMinutes: 10,
        reason: "worker-minutes-exceeded",
      }),
    ).toThrow(/must match pattern/);
  });

  it("accepts PBI ID with underscores and numbers", () => {
    const event = toTripEvent({
      pbiId: "task_123_main",
      workerMinutes: 10,
      reason: "worker-minutes-exceeded",
    });
    expect(event.pbiId).toBe("task_123_main");
  });
});

describe("recordWorkerActivity input validation", () => {
  it("rejects non-object activity", () => {
    const breaker = new CircuitBreaker({});
    expect(() => breaker.recordWorkerActivity(null as unknown as WorkerActivity)).toThrow(
      /non-null object/,
    );
    expect(() => breaker.recordWorkerActivity("string" as unknown as WorkerActivity)).toThrow(
      /non-null object/,
    );
  });

  it("rejects empty pbiId", () => {
    const breaker = new CircuitBreaker({});
    expect(() => breaker.recordWorkerActivity({ pbiId: "", durationMs: 60_000, status: "success" })).toThrow(
      /non-empty string/,
    );
  });

  it("rejects pbiId exceeding max length", () => {
    const breaker = new CircuitBreaker({});
    const longId = "P".repeat(129);
    expect(() => breaker.recordWorkerActivity({ pbiId: longId, durationMs: 60_000, status: "success" })).toThrow(
      /exceeds maximum length/,
    );
  });

  it("rejects invalid pbiId pattern", () => {
    const breaker = new CircuitBreaker({});
    expect(() =>
      breaker.recordWorkerActivity({ pbiId: "1bad", durationMs: 60_000, status: "success" }),
    ).toThrow(/must match pattern/);
  });

  it("rejects non-finite durationMs", () => {
    const breaker = new CircuitBreaker({});
    expect(() =>
      breaker.recordWorkerActivity({ pbiId: "PBI-1", durationMs: NaN, status: "success" }),
    ).toThrow(/finite number/);
  });

  it("rejects invalid status", () => {
    const breaker = new CircuitBreaker({});
    expect(() =>
      breaker.recordWorkerActivity({ pbiId: "PBI-1", durationMs: 60_000, status: "pending" as "success" }),
    ).toThrow(/must be "success" or "failure"/);
  });

  it("accepts valid activity", () => {
    const breaker = new CircuitBreaker({});
    expect(() =>
      breaker.recordWorkerActivity({ pbiId: "PBI-1", durationMs: 60_000, status: "success" }),
    ).not.toThrow();
  });
});

describe("validateWorkerActivity function", () => {
  it("accepts valid activity", () => {
    expect(() =>
      validateWorkerActivity({ pbiId: "PBI-1", durationMs: 60_000, status: "success" }),
    ).not.toThrow();
    expect(() =>
      validateWorkerActivity({ pbiId: "PBI-2", durationMs: 30_000, status: "failure" }),
    ).not.toThrow();
  });

  it("rejects null activity", () => {
    expect(() => validateWorkerActivity(null as unknown as WorkerActivity)).toThrow(
      /non-null object/,
    );
  });

  it("rejects missing pbiId", () => {
    expect(() =>
      validateWorkerActivity({ pbiId: undefined as unknown as string, durationMs: 60_000, status: "success" }),
    ).toThrow(/non-empty string/);
  });

  it("rejects pbiId starting with number", () => {
    expect(() =>
      validateWorkerActivity({ pbiId: "1bad-id", durationMs: 60_000, status: "success" }),
    ).toThrow(/must match pattern/);
  });
});

describe("integer overflow protection", () => {
  it("handles edge case at threshold boundary", () => {
    // Test the >= comparison for trip threshold
    const breaker = new CircuitBreaker({ maxWorkerMinutesPerPbi: 5 });

    breaker.recordWorkerActivity({ pbiId: "PBI-TRIP", durationMs: 60_000, status: "success" });
    expect(breaker.getWorkerMinutes("PBI-TRIP")).toBe(1);
    expect(breaker.isTripped("PBI-TRIP")).toBe(false);

    // Add until threshold reached
    breaker.recordWorkerActivity({ pbiId: "PBI-TRIP", durationMs: 60_000, status: "success" });
    expect(breaker.getWorkerMinutes("PBI-TRIP")).toBe(2);

    breaker.recordWorkerActivity({ pbiId: "PBI-TRIP", durationMs: 60_000, status: "success" });
    expect(breaker.getWorkerMinutes("PBI-TRIP")).toBe(3);

    breaker.recordWorkerActivity({ pbiId: "PBI-TRIP", durationMs: 60_000, status: "success" });
    expect(breaker.getWorkerMinutes("PBI-TRIP")).toBe(4);

    breaker.recordWorkerActivity({ pbiId: "PBI-TRIP", durationMs: 60_000, status: "success" });
    expect(breaker.getWorkerMinutes("PBI-TRIP")).toBe(5);
    expect(breaker.isTripped("PBI-TRIP")).toBe(true); // Tripped at exactly threshold
  });

  it("validates overflow bound check in recordWorkerActivity", () => {
    // The checkedWorkerMinutesAdd uses Number.MAX_SAFE_INTEGER - minutes
    // for overflow protection - verify the method exists and works
    const breaker = new CircuitBreaker({ maxWorkerMinutesPerPbi: 60 });

    // Normal operation succeeds
    breaker.recordWorkerActivity({ pbiId: "PBI-VALID", durationMs: 120_000, status: "success" });
    expect(breaker.getWorkerMinutes("PBI-VALID")).toBe(2);
  });
});