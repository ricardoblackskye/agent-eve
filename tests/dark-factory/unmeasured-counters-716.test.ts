/**
 * #716 - a counter that was never measured must not be recorded as zero.
 *
 * Every run's summary reports `iterationCount` and `fixCycleCount` as `0`, including runs whose own log shows
 * `Coding Iteration 2/10` and two files written across iterations. The write paths coerce the omission to zero,
 * so a reader cannot tell UNMEASURED from GENUINELY ZERO - and the contract already states the rule, at
 * `agent/lib/dark-factory/definition-of-done.ts:331`:
 *
 *     Only provide metrics observed by the caller; omitted values stay unmeasured.
 *
 * The CONTROL matters as much as the case: a summary that was given a real count must still record it, so the
 * check cannot pass by discarding its input.
 */
import { describe, expect, it } from "vitest";

import { buildAttemptSummary } from "../../agent/lib/dark-factory/run-attempt-summary";

const BASE = {
  runId: "run-716",
  repo: "owner/repo",
  issue: 716,
  status: "succeeded" as const,
  createdAt: "2026-11-26T00:00:00.000Z",
};

describe("#716 an unmeasured counter is not a zero", () => {
  it("records no count when none was observed, rather than inventing zero", () => {
    const summary = buildAttemptSummary({ ...BASE });

    // `0` is a MEASUREMENT - it claims the loop iterated zero times. Nothing measured this run, so the honest
    // value is absent. Asserting `not.toBe(0)` first makes the failure read as the defect it is.
    expect(summary.iterationCount).not.toBe(0);
    expect(summary.iterationCount).toBeUndefined();
    expect(summary.fixCycleCount).not.toBe(0);
    expect(summary.fixCycleCount).toBeUndefined();
  });

  it("still records a count it was actually given", () => {
    const summary = buildAttemptSummary({ ...BASE, iterationCount: 3 });

    expect(summary.iterationCount).toBe(3);
  });
});
