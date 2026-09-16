import { describe, it, expect } from "vitest";
import {
  toTripEvent,
  InvalidTripEventError,
  type TripReason,
} from "../../agent/lib/dark-factory/circuit-breaker";

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
