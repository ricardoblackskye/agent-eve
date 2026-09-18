/**
 * #158 — latency and cost on `TaskMetric`, and as DECIDE guardrails.
 *
 * #146 step 1 names latency and cost as self-improvement inputs, but #140's
 * `TaskMetric` carried neither, so the R4a controller could only use success rate
 * (objective) and mean iterations/fix-cycles (guardrails). Cost is what the #144
 * circuit breaker exists to bound: a loop that cannot see it can "improve" success
 * rate by spending unboundedly.
 *
 * The rule these tests exist to hold: **an unmeasured metric is ABSENT, never 0.**
 * "Not measured" and "measured zero" are different facts, and a fabricated 0 would
 * drag every mean toward a number nobody observed.
 */
import { describe, it, expect } from "vitest";
import {
  InMemoryMetricsStore,
  BufferedMetricsRecorder,
  InvalidMetricsError,
  toTaskMetric,
  type MetricsStore,
  type MetricsWriteResult,
  type TaskMetric,
} from "../../agent/lib/dark-factory/metrics";
import {
  measureBenchmark,
  observeTaskType,
  summarizeRecords,
  decide,
  SelfImprovementConfigError,
  type BenchmarkCase,
  type ImprovementBenchmark,
  type Measurement,
} from "../../agent/lib/dark-factory/self-improve";

/** A store that rejects the first `failures` writes, to exercise the no-loss decorator. */
class FlakyStore implements MetricsStore {
  id = "flaky";
  attempts = 0;
  readonly seen: TaskMetric[] = [];
  constructor(private readonly failures: number) {}
  async record(
    taskType: string,
    data: {
      iterations: number;
      fixCycles: number;
      status: "success" | "failure";
      latencyMs?: number;
      costUsd?: number;
    },
  ): Promise<MetricsWriteResult> {
    this.attempts += 1;
    if (this.attempts <= this.failures) {
      return { ok: false, mode: "blocked", providerId: this.id, error: "backend down" };
    }
    const record = toTaskMetric(taskType, data);
    this.seen.push(record);
    return { ok: true, mode: "live", providerId: this.id, record };
  }
  successRateByType(): number | null {
    return null;
  }
  getRecords(): TaskMetric[] {
    return [...this.seen];
  }
}

const LONG_OUTPUT =
  "Intent: keep the factory honest about what it spends. Acceptance: given a completed " +
  "task, when the metric is recorded, then its latency and cost are carried without loss.";

function benchCase(over: Partial<BenchmarkCase> = {}): BenchmarkCase {
  return {
    id: "case-1",
    taskType: "coding",
    output: LONG_OUTPUT,
    iterations: 3,
    fixCycles: 1,
    ...over,
  };
}

function benchmark(over: Partial<ImprovementBenchmark> = {}): ImprovementBenchmark {
  return {
    version: "test-1",
    gate: { minChars: 120, requiredSections: ["intent", "acceptance"], refusalMarkers: [] },
    cases: [benchCase(), benchCase({ id: "case-2", iterations: 5, fixCycles: 2 })],
    ...over,
  } as ImprovementBenchmark;
}

const measurement = (objective: number, guardrails: Record<string, number>): Measurement => ({
  fixtureVersion: "test-1",
  objective,
  guardrails,
});

describe("#158 cycle 1-2: the new fields are optional and round-trip unchanged", () => {
  it("a record with no latency/cost carries NEITHER key (absent, not zero)", async () => {
    const store = new InMemoryMetricsStore();
    const res = await store.record("coding", { iterations: 3, fixCycles: 1, status: "success" });
    expect(res.ok).toBe(true);
    const record = store.getRecords()[0];
    expect("latencyMs" in record).toBe(false);
    expect("costUsd" in record).toBe(false);
  });

  it("stores and reads back finite latency and cost", async () => {
    const store = new InMemoryMetricsStore();
    await store.record("coding", {
      iterations: 3,
      fixCycles: 1,
      status: "success",
      latencyMs: 12_500,
      costUsd: 0.42,
    });
    const record = store.getRecords()[0];
    expect(record.latencyMs).toBe(12_500);
    expect(record.costUsd).toBe(0.42);
  });
});

describe("#158 cycle 3-4: validation sits at the single contract point", () => {
  it.each([
    ["negative latency", { latencyMs: -1 }],
    ["NaN latency", { latencyMs: Number.NaN }],
    ["infinite latency", { latencyMs: Number.POSITIVE_INFINITY }],
    ["string latency", { latencyMs: "120" as unknown as number }],
    ["negative cost", { costUsd: -0.01 }],
    ["NaN cost", { costUsd: Number.NaN }],
    ["a latency beyond the sane bound", { latencyMs: 1e12 }],
    ["a cost beyond the sane bound", { costUsd: 1e6 }],
  ])("refuses %s with InvalidMetricsError", (_label, over) => {
    expect(() =>
      toTaskMetric("coding", { iterations: 1, fixCycles: 0, status: "success", ...over }),
    ).toThrow(InvalidMetricsError);
  });

  it("names the offending field so the caller can act on it", () => {
    expect(() =>
      toTaskMetric("coding", { iterations: 1, fixCycles: 0, status: "success", latencyMs: -5 }),
    ).toThrow(/latencyMs/);
  });

  it("accepts ZERO as a measurement (measured nothing is not the same as unmeasured)", () => {
    const record = toTaskMetric("coding", {
      iterations: 1,
      fixCycles: 0,
      status: "success",
      latencyMs: 0,
      costUsd: 0,
    });
    expect(record.latencyMs).toBe(0);
    expect(record.costUsd).toBe(0);
  });
});

describe("#158 cycle 5-7: observation means are computed over MEASURED samples only", () => {
  it("reports mean latency and cost when the samples carry them", () => {
    const records: TaskMetric[] = [
      { taskType: "coding", iterations: 2, fixCycles: 0, status: "success", latencyMs: 100, costUsd: 0.1 },
      { taskType: "coding", iterations: 4, fixCycles: 1, status: "failure", latencyMs: 300, costUsd: 0.3 },
    ];
    const summary = summarizeRecords(records);
    expect(summary.meanLatencyMs).toBe(200);
    expect(summary.meanCostUsd).toBe(0.2);
  });

  it("OMITS them entirely when no sample carries them", async () => {
    const store = new InMemoryMetricsStore();
    await store.record("coding", { iterations: 2, fixCycles: 0, status: "success" });
    const observation = observeTaskType(store, "coding", 1);
    expect(observation).not.toBeNull();
    expect("meanLatencyMs" in (observation as object)).toBe(false);
    expect("meanCostUsd" in (observation as object)).toBe(false);
  });

  it("with a MIX, means over the measured ones only (a missing value is not a zero)", () => {
    const records: TaskMetric[] = [
      { taskType: "coding", iterations: 1, fixCycles: 0, status: "success", latencyMs: 100, costUsd: 1 },
      { taskType: "coding", iterations: 1, fixCycles: 0, status: "success" },
      { taskType: "coding", iterations: 1, fixCycles: 0, status: "success", latencyMs: 300, costUsd: 1 },
    ];
    const summary = summarizeRecords(records);
    // Over the two measured samples: (100 + 300) / 2, NOT 400 / 3.
    expect(summary.meanLatencyMs).toBe(200);
    expect(summary.meanCostUsd).toBe(1);
    expect(summary.samples).toBe(3);
  });
});

describe("#158 cycle 13: the no-loss decorator must not DROP the new fields", () => {
  it("retains latency/cost through a failure and delivers them on flush()", async () => {
    const backend = new FlakyStore(1);
    const recorder = new BufferedMetricsRecorder(backend);
    const res = await recorder.record("coding", {
      iterations: 2,
      fixCycles: 1,
      status: "success",
      latencyMs: 9_000,
      costUsd: 0.75,
    });
    expect(res.ok).toBe(false);
    expect(recorder.pending()[0].latencyMs).toBe(9_000);
    expect(recorder.pending()[0].costUsd).toBe(0.75);

    const flushed = await recorder.flush();
    expect(flushed.ok).toBe(true);
    expect(backend.seen[0].latencyMs).toBe(9_000);
    expect(backend.seen[0].costUsd).toBe(0.75);
  });
});

describe("#158 cycle 14-15: latency/cost reach DECIDE through the MEASURE step", () => {
  it("puts meanLatencyMs/meanCostUsd into the guardrails when the benchmark measures them", () => {
    const measured = measureBenchmark(
      benchmark({
        cases: [
          benchCase({ latencyMs: 100, costUsd: 0.5 }),
          benchCase({ id: "case-2", iterations: 5, fixCycles: 2, latencyMs: 300, costUsd: 1.5 }),
        ],
      }),
    );
    expect(measured.guardrails.meanLatencyMs).toBe(200);
    expect(measured.guardrails.meanCostUsd).toBe(1);
    expect(measured.guardrails.meanIterations).toBe(4);
  });

  it("omits those guardrail keys when no case measures them", () => {
    const measured = measureBenchmark(benchmark());
    expect("meanLatencyMs" in measured.guardrails).toBe(false);
    expect("meanCostUsd" in measured.guardrails).toBe(false);
  });

  it("refuses a benchmark case whose latency/cost is beyond the sane bound", () => {
    expect(() =>
      measureBenchmark(benchmark({ cases: [benchCase({ latencyMs: 1e12 })] })),
    ).toThrow(SelfImprovementConfigError);
    expect(() =>
      measureBenchmark(benchmark({ cases: [benchCase({ costUsd: 1e6 })] })),
    ).toThrow(SelfImprovementConfigError);
  });
});

describe("#158 cycle 9-10: a latency regression beyond tolerance is rejected", () => {
  it("rejects even though the objective improved", () => {
    const before = measurement(0.5, { meanLatencyMs: 100 });
    const after = measurement(0.9, { meanLatencyMs: 400 });
    const decision = decide(before, after, { guardrailTolerance: 50 });
    expect(decision.verdict).toBe("reject");
    expect(decision.reason).toMatch(/meanLatencyMs/);
  });

  it("accepts a regression WITHIN tolerance (not a hair-trigger)", () => {
    const before = measurement(0.5, { meanLatencyMs: 100 });
    const after = measurement(0.9, { meanLatencyMs: 140 });
    expect(decide(before, after, { guardrailTolerance: 50 }).verdict).toBe("accept");
  });

  it("accepts a cost-aware change that improves the objective and does not regress cost", () => {
    const before = measurement(0.5, { meanCostUsd: 1 });
    const after = measurement(0.9, { meanCostUsd: 0.8 });
    expect(decide(before, after).verdict).toBe("accept");
  });

  it("does not treat a newly-visible cost guardrail as a regression", () => {
    const before = measurement(0.5, { meanIterations: 4 });
    const after = measurement(0.9, { meanIterations: 4, meanCostUsd: 9 });
    expect(decide(before, after).verdict).toBe("accept");
  });
});
