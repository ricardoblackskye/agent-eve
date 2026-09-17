import { describe, it, expect } from "vitest";
import {
  isCycleDue,
  nextRunAt,
  objectiveTrend,
  runScheduledCycle,
  DEFAULT_INTERVAL_MINUTES,
  SelfImprovementConfigError,
  type CadenceWatermark,
  type CycleResult,
  type LedgerEntry,
  type SelfImprovementController,
} from "../../agent/lib/dark-factory/self-improve";

function ledgerEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    at: "2026-09-17T00:00:00.000Z",
    cycleId: "cycle-1",
    surfaceId: "iteration-bound",
    hypothesis: "raising the bound should help",
    fromVersion: "iteration-bound@v1",
    toVersion: "iteration-bound@v2",
    fixtureVersion: "1",
    verdict: "accept",
    reason: "objective improved",
    objective: { before: 0.5, after: 0.6 },
    guardrails: { before: {}, after: {} },
    ...overrides,
  };
}

// --- R4b: cadence is a decision function, not a timer ---------------------

describe("isCycleDue (#146 R4b cadence)", () => {
  const now = "2026-09-17T12:00:00.000Z";

  it("is due when no cycle has ever run", () => {
    expect(isCycleDue({ lastRunAt: null, now, intervalMinutes: 60 })).toBe(
      true,
    );
  });

  it("is due when the watermark is older than the interval", () => {
    expect(
      isCycleDue({
        lastRunAt: "2026-09-17T10:00:00.000Z",
        now,
        intervalMinutes: 60,
      }),
    ).toBe(true);
  });

  it("is not due while the interval is still running", () => {
    expect(
      isCycleDue({
        lastRunAt: "2026-09-17T11:30:00.000Z",
        now,
        intervalMinutes: 60,
      }),
    ).toBe(false);
  });

  it("is due exactly at the interval boundary", () => {
    expect(
      isCycleDue({
        lastRunAt: "2026-09-17T11:00:00.000Z",
        now,
        intervalMinutes: 60,
      }),
    ).toBe(true);
  });

  it("accepts a Date for now as well as an ISO string", () => {
    expect(
      isCycleDue({
        lastRunAt: "2026-09-17T10:00:00.000Z",
        now: new Date(now),
        intervalMinutes: 60,
      }),
    ).toBe(true);
  });

  it("throws on an unparseable watermark instead of guessing", () => {
    expect(() =>
      isCycleDue({ lastRunAt: "not-a-date", now, intervalMinutes: 60 }),
    ).toThrow(SelfImprovementConfigError);
  });

  it("throws on a non-positive or non-finite interval", () => {
    for (const intervalMinutes of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() =>
        isCycleDue({ lastRunAt: null, now, intervalMinutes }),
      ).toThrow(SelfImprovementConfigError);
    }
  });
});

describe("nextRunAt (#146 R4b cadence)", () => {
  it("adds the interval to the last run", () => {
    expect(nextRunAt("2026-09-17T11:00:00.000Z", 60)).toBe(
      "2026-09-17T12:00:00.000Z",
    );
  });

  it("agrees with isCycleDue at the computed instant", () => {
    const last = "2026-09-17T11:00:00.000Z";
    const due = nextRunAt(last, 90);

    expect(isCycleDue({ lastRunAt: last, now: due, intervalMinutes: 90 })).toBe(
      true,
    );
    expect(
      isCycleDue({
        lastRunAt: last,
        now: new Date(Date.parse(due) - 1).toISOString(),
        intervalMinutes: 90,
      }),
    ).toBe(false);
  });
});

// --- R4b / AC6: the objective over N cycles ------------------------------

describe("objectiveTrend (#146 AC6)", () => {
  it("reports an empty trend for an empty ledger rather than throwing", () => {
    expect(objectiveTrend([])).toEqual({
      series: "all",
      points: [],
      first: null,
      last: null,
      delta: null,
      accepted: 0,
      rejected: 0,
      improving: false,
    });
  });

  it("reports the cumulative delta across cycles, not a single step", () => {
    const trend = objectiveTrend([
      ledgerEntry({
        cycleId: "c1",
        at: "2026-09-17T00:00:00.000Z",
        objective: { before: 0.5, after: 0.6 },
      }),
      ledgerEntry({
        cycleId: "c2",
        at: "2026-09-17T01:00:00.000Z",
        objective: { before: 0.6, after: 0.75 },
      }),
      ledgerEntry({
        cycleId: "c3",
        at: "2026-09-17T02:00:00.000Z",
        objective: { before: 0.75, after: 0.55 },
        verdict: "reject",
      }),
    ]);

    expect(trend.points.map((p) => p.cycleId)).toEqual(["c1", "c2", "c3"]);
    expect(trend.points.map((p) => p.objective)).toEqual([0.6, 0.75, 0.55]);
    expect(trend.first).toBe(0.6);
    expect(trend.last).toBe(0.55);
    expect(trend.delta).toBe(-0.05);
    expect(trend.accepted).toBe(2);
    expect(trend.rejected).toBe(1);
    expect(trend.improving).toBe(false);
  });

  it("reports improving when the objective is genuinely higher than it started", () => {
    const trend = objectiveTrend([
      ledgerEntry({ cycleId: "c1", objective: { before: 0.4, after: 0.6 } }),
      ledgerEntry({ cycleId: "c2", objective: { before: 0.6, after: 0.8 } }),
    ]);

    expect(trend.delta).toBe(0.2);
    expect(trend.improving).toBe(true);
  });

  it("filters to one surface and reports that series name", () => {
    const trend = objectiveTrend(
      [
        ledgerEntry({ cycleId: "c1", surfaceId: "iteration-bound" }),
        ledgerEntry({ cycleId: "c2", surfaceId: "skill-set" }),
      ],
      { surfaceId: "skill-set" },
    );

    expect(trend.series).toBe("skill-set");
    expect(trend.points.map((p) => p.cycleId)).toEqual(["c2"]);
    expect(trend.first).toBe(trend.last);
  });
});

// --- R4b: the scheduled runner -------------------------------------------

describe("runScheduledCycle (#146 R4b)", () => {
  function harness(options: {
    enabled?: boolean;
    watermark: string | null;
    now: string;
    intervalMinutes?: number;
    cycleResult?: CycleResult;
  }) {
    const written: string[] = [];
    let runs = 0;
    const watermark: CadenceWatermark = {
      read: async () => options.watermark,
      write: async (at) => {
        written.push(at);
      },
    };
    const controller: SelfImprovementController = {
      enabled: options.enabled ?? true,
      run: async () => {
        runs += 1;
        return (
          options.cycleResult ?? { status: "no-op", reason: "no proposal" }
        );
      },
    };
    return {
      written,
      runs: () => runs,
      options: {
        controller,
        watermark,
        intervalMinutes: options.intervalMinutes ?? 60,
        now: () => new Date(options.now),
      },
    };
  }

  it("skips when the controller is disabled, without touching the watermark", async () => {
    const h = harness({
      enabled: false,
      watermark: null,
      now: "2026-09-17T12:00:00.000Z",
    });

    const result = await runScheduledCycle(h.options);

    expect(result).toEqual({ status: "skipped", reason: "disabled" });
    expect(h.runs()).toBe(0);
    expect(h.written).toEqual([]);
  });

  it("skips when the interval has not elapsed", async () => {
    const h = harness({
      watermark: "2026-09-17T11:30:00.000Z",
      now: "2026-09-17T12:00:00.000Z",
    });

    const result = await runScheduledCycle(h.options);

    expect(result).toEqual({ status: "skipped", reason: "not due" });
    expect(h.runs()).toBe(0);
    expect(h.written).toEqual([]);
  });

  it("runs a due cycle and advances the watermark to now", async () => {
    const h = harness({
      watermark: "2026-09-17T09:00:00.000Z",
      now: "2026-09-17T12:00:00.000Z",
      cycleResult: { status: "no-op", reason: "insufficient data" },
    });

    const result = await runScheduledCycle(h.options);

    expect(result.status).toBe("ran");
    expect(h.runs()).toBe(1);
    expect(h.written).toEqual(["2026-09-17T12:00:00.000Z"]);
  });

  it("advances the watermark on the very first run", async () => {
    const h = harness({ watermark: null, now: "2026-09-17T12:00:00.000Z" });

    await runScheduledCycle(h.options);

    expect(h.written).toEqual(["2026-09-17T12:00:00.000Z"]);
  });
});

// --- R4b: the interval is configuration ----------------------------------

describe("DF_SELFIMPROVE_INTERVAL_MINUTES (#146 R4b)", () => {
  it("defaults to a daily cadence", async () => {
    const { resolveSelfImprovementEnvConfig } =
      await import("../../agent/lib/dark-factory/self-improve");

    expect(resolveSelfImprovementEnvConfig({}).intervalMinutes).toBe(
      DEFAULT_INTERVAL_MINUTES,
    );
    expect(DEFAULT_INTERVAL_MINUTES).toBe(1440);
  });

  it("parses an explicit interval", async () => {
    const { resolveSelfImprovementEnvConfig } =
      await import("../../agent/lib/dark-factory/self-improve");

    expect(
      resolveSelfImprovementEnvConfig({
        DF_SELFIMPROVE_INTERVAL_MINUTES: "60",
      }).intervalMinutes,
    ).toBe(60);
  });

  it("rejects zero, exponent and non-numeric intervals", async () => {
    const { resolveSelfImprovementEnvConfig } =
      await import("../../agent/lib/dark-factory/self-improve");

    for (const bad of ["0", "1e3", "abc", "-5"]) {
      expect(() =>
        resolveSelfImprovementEnvConfig({
          DF_SELFIMPROVE_INTERVAL_MINUTES: bad,
        }),
      ).toThrow(SelfImprovementConfigError);
    }
  });
});
