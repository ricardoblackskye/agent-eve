import { describe, it, expect } from "vitest";
import {
  toTripEvent,
  InvalidTripEventError,
  CircuitBreaker,
  createCircuitBreaker,
  createWorkerActivityObserver,
  type TripReason,
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

  it("rejects an unknown reason", () => {
    expect(() =>
      toTripEvent({
        pbiId: "PBI-1",
        workerMinutes: 10,
        reason: "budget-blown" as TripReason,
      }),
    ).toThrow(/reason/);
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

// --- Task 144.6: environment wiring ---

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

  it("trips exactly at the budget boundary (59.9 + 0.1 = 60)", () => {
    const breaker = createCircuitBreaker({});
    breaker.recordWorkerActivity({ pbiId: "PBI-B", durationMs: 59.9 * 60_000, status: "success" });
    expect(breaker.isTripped("PBI-B")).toBe(false);
    breaker.recordWorkerActivity({ pbiId: "PBI-B", durationMs: 0.1 * 60_000, status: "success" });
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

  it("throws on malformed env values (fail-closed, not default)", () => {
    expect(() => createCircuitBreaker({ DF_MAX_WORKER_MINUTES_PER_PBI: "abc" })).toThrow(
      /DF_MAX_WORKER_MINUTES_PER_PBI/,
    );
    expect(() => createCircuitBreaker({ DF_MAX_FAILED_SELFCORRECT: "0" })).toThrow(
      /DF_MAX_FAILED_SELFCORRECT/,
    );
  });
});
