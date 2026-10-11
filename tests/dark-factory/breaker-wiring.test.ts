import { describe, it, expect } from "vitest";
import {
  PBI_ID_PREFIX,
  createCodingLoopBreaker,
  pbiIdForIssue,
} from "../../agent/lib/dark-factory/breaker-wiring";
import { createCircuitBreaker } from "../../agent/lib/dark-factory/circuit-breaker";

describe("circuit-breaker wiring (#312)", () => {
  it("derives the breaker key from the ISSUE, not the run id", () => {
    expect(PBI_ID_PREFIX).toBe("pbi-");
    expect(pbiIdForIssue(312)).toBe("pbi-312");
  });

  it("produces a PBI id the breaker accepts, unlike a run id", () => {
    const breaker = createCircuitBreaker({ DF_MIN_DURATION_MS: "0" });

    expect(() =>
      breaker.recordWorkerActivity({
        pbiId: pbiIdForIssue(312),
        durationMs: 1,
        status: "success",
      }),
    ).not.toThrow();

    // A run id is NOT usable as a PBI id — this is exactly why we key on the issue.
    expect(() =>
      breaker.recordWorkerActivity({
        pbiId: "ricardoblackskye/agent-eve#312",
        durationMs: 1,
        status: "success",
      }),
    ).toThrow();
  });

  it("refuses an issue number that cannot form a PBI id", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => pbiIdForIssue(bad)).toThrow(/issue/i);
    }
  });

  it("binds a breaker into the coding loop's narrow seam", () => {
    const breaker = createCircuitBreaker({
      DF_MAX_WORKER_MINUTES_PER_PBI: "1",
      DF_MIN_DURATION_MS: "0",
    });
    const wiring = createCodingLoopBreaker(breaker, 312);

    expect(wiring.pbiId).toBe("pbi-312");
    expect(wiring.isTripped(wiring.pbiId)).toBe(false);

    wiring.recordActivity({ pbiId: wiring.pbiId, durationMs: 1, status: "success" });

    expect(wiring.isTripped(wiring.pbiId)).toBe(true);
  });
});
