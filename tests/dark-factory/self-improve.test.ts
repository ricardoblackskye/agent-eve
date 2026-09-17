import { describe, it, expect } from "vitest";
import {
  observeTaskType,
  summarizeRecords,
  IterationBoundSurface,
  makeProposal,
  proposeFromObservation,
  InvalidProposalError,
  measureBenchmark,
  loadImprovementBenchmark,
  BenchmarkMeasurer,
  decide,
  InMemoryImprovementLedger,
  SelfImprovementConfigError,
  SupersededVersionError,
  runImprovementCycle,
  resolveSelfImprovementEnvConfig,
  createSelfImprovementController,
  type Measurement,
  type LedgerEntry,
  type Proposal,
  type TunableSurface,
  type OperatorGate,
  type CostGuard,
  type Observation,
  type SelfImprovementConfig,
} from "../../agent/lib/dark-factory/self-improve";
import { InMemoryMetricsStore } from "../../agent/lib/dark-factory/metrics";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskMetric } from "../../agent/lib/dark-factory/metrics";

/** Seed a real #140 store — no mocks, the controller must read the actual seam. */
async function seededStore(
  entries: Array<[string, number, number, "success" | "failure"]>,
): Promise<InMemoryMetricsStore> {
  const store = new InMemoryMetricsStore();
  for (const [taskType, iterations, fixCycles, status] of entries) {
    await store.record(taskType, { iterations, fixCycles, status });
  }
  return store;
}

// --- #146 AC1/AC7: OBSERVE reads the #140 metrics (no parallel store) -----

describe("observeTaskType (#146 AC1/AC7)", () => {
  it("returns null when there is not enough data to observe honestly", async () => {
    const store = await seededStore([
      ["coding", 1, 0, "success"],
      ["coding", 2, 1, "failure"],
    ]);

    expect(observeTaskType(store, "coding", 30)).toBeNull();
  });

  it("returns null for a task type the store has never seen", async () => {
    const store = await seededStore([["coding", 1, 0, "success"]]);

    expect(observeTaskType(store, "testing", 1)).toBeNull();
  });

  it("aggregates success rate and effort guardrails from the store", async () => {
    const store = await seededStore([
      ["coding", 2, 1, "success"],
      ["coding", 4, 2, "failure"],
      ["coding", 6, 3, "success"],
      ["coding", 8, 4, "success"],
    ]);

    const observation = observeTaskType(store, "coding", 4);

    expect(observation).toEqual({
      taskType: "coding",
      samples: 4,
      successRate: 0.75,
      meanIterations: 5,
      meanFixCycles: 2.5,
    });
  });

  it("does not let another task type leak into the aggregate", async () => {
    const store = await seededStore([
      ["coding", 2, 1, "success"],
      ["coding", 4, 1, "failure"],
      ["testing", 100, 99, "failure"],
    ]);

    const observation = observeTaskType(store, "coding", 2);

    expect(observation?.samples).toBe(2);
    expect(observation?.successRate).toBe(0.5);
    expect(observation?.meanIterations).toBe(3);
  });
});

describe("summarizeRecords (#146 AC1)", () => {
  it("reports zero-valued aggregates for an empty set rather than NaN", () => {
    expect(summarizeRecords([])).toEqual({
      samples: 0,
      successRate: 0,
      meanIterations: 0,
      meanFixCycles: 0,
    });
  });

  it("rounds both the rate and the means to two decimals", () => {
    const records: TaskMetric[] = [
      { taskType: "coding", iterations: 1, fixCycles: 0, status: "success" },
      { taskType: "coding", iterations: 2, fixCycles: 1, status: "success" },
      { taskType: "coding", iterations: 2, fixCycles: 1, status: "failure" },
    ];

    const summary = summarizeRecords(records);

    expect(summary.successRate).toBe(0.67);
    expect(summary.meanIterations).toBe(1.67);
    expect(summary.meanFixCycles).toBe(0.67);
  });
});

// --- #146 AC3/AC4: versioned, reversible apply (never in place) -----------

describe("IterationBoundSurface (#146 AC3/AC4)", () => {
  it("exposes the initial bound without changing it", () => {
    const surface = new IterationBoundSurface(10);

    expect(surface.id).toBe("iteration-bound");
    expect(surface.read()).toBe(10);
  });

  it("does not make a staged value live until it is applied", async () => {
    const surface = new IterationBoundSurface(10);

    const handle = await surface.stage(12);

    expect(surface.read()).toBe(10);
    expect(handle.previous).toBe(10);
    expect(handle.next).toBe(12);
    expect(handle.isApplied()).toBe(false);

    await handle.apply();

    expect(surface.read()).toBe(12);
    expect(handle.isApplied()).toBe(true);
    expect(handle.id).toBe("iteration-bound@v2");
  });

  it("restores the prior version on revert", async () => {
    const surface = new IterationBoundSurface(10);
    const handle = await surface.stage(12);
    await handle.apply();

    await handle.revert();

    expect(surface.read()).toBe(10);
    expect(handle.isApplied()).toBe(false);
  });

  it("tolerates a repeated revert (safe to retry after a failure)", async () => {
    const surface = new IterationBoundSurface(10);
    const handle = await surface.stage(12);
    await handle.apply();

    await handle.revert();
    await handle.revert();

    expect(surface.read()).toBe(10);
  });

  it("numbers each staged version so changes are auditable", async () => {
    const surface = new IterationBoundSurface(10);
    const first = await surface.stage(11);
    const second = await surface.stage(12);

    expect(first.id).toBe("iteration-bound@v2");
    expect(second.id).toBe("iteration-bound@v3");
  });

  it("refuses a bound that is not a positive integer", async () => {
    const surface = new IterationBoundSurface(10);

    await expect(surface.stage(0)).rejects.toThrow(InvalidProposalError);
    await expect(surface.stage(-1)).rejects.toThrow(InvalidProposalError);
    await expect(surface.stage(2.5)).rejects.toThrow(InvalidProposalError);
    await expect(surface.stage(Number.NaN)).rejects.toThrow(
      InvalidProposalError,
    );
  });
});

// --- #146 AC1: PROPOSE carries an explicit written hypothesis -------------

describe("makeProposal (#146 AC1)", () => {
  it("refuses a proposal with no written hypothesis", () => {
    expect(() =>
      makeProposal({
        surfaceId: "iteration-bound",
        next: 12,
        hypothesis: "   ",
        kind: "bounded-tuning",
      }),
    ).toThrow(InvalidProposalError);
  });

  it("keeps the hypothesis verbatim when it is present", () => {
    const proposal = makeProposal({
      surfaceId: "iteration-bound",
      next: 12,
      hypothesis: "more attempts should lift the success rate",
      kind: "bounded-tuning",
    });

    expect(proposal.hypothesis).toBe(
      "more attempts should lift the success rate",
    );
  });
});

describe("proposeFromObservation (#146 AC1)", () => {
  const observation = {
    taskType: "coding",
    samples: 40,
    successRate: 0.6,
    meanIterations: 5,
    meanFixCycles: 3,
  };

  it("proposes raising the bound and states the reasoning", () => {
    const surface = new IterationBoundSurface(10);

    const proposal = proposeFromObservation(observation, surface);

    expect(proposal?.surfaceId).toBe("iteration-bound");
    expect(proposal?.next).toBe(12);
    expect(proposal?.kind).toBe("bounded-tuning");
    expect(proposal?.hypothesis).toContain("iteration-bound");
    expect(proposal?.hypothesis).toContain("10");
    expect(proposal?.hypothesis).toContain("12");
    expect(proposal?.hypothesis).toContain("coding");
    expect(proposal?.hypothesis).toContain("0.6");
  });

  it("returns null when the task type is already good enough", () => {
    const surface = new IterationBoundSurface(10);

    const proposal = proposeFromObservation(
      { ...observation, successRate: 0.95 },
      surface,
    );

    expect(proposal).toBeNull();
  });
});

// --- #146 AC2: MEASURE against a fixed, deterministic benchmark -----------

describe("measureBenchmark (#146 AC2)", () => {
  it("scores the fixed case set through the reused #121 quality gate", () => {
    const measurement = measureBenchmark(loadImprovementBenchmark());

    expect(measurement.fixtureVersion).toBe("1");
    expect(measurement.objective).toBe(0.5);
    expect(measurement.guardrails.meanIterations).toBe(4.5);
    expect(measurement.guardrails.meanFixCycles).toBe(2.5);
  });

  it("produces identical numbers on every run", () => {
    const benchmark = loadImprovementBenchmark();

    expect(measureBenchmark(benchmark)).toEqual(measureBenchmark(benchmark));
  });

  it("is exposed through the Measurer seam the controller consumes", async () => {
    const measurer = new BenchmarkMeasurer(loadImprovementBenchmark());

    expect(await measurer.measure()).toEqual(
      measureBenchmark(loadImprovementBenchmark()),
    );
  });
});

describe("loadImprovementBenchmark (#146 AC2)", () => {
  it("loads the committed fixture with its version and case set", () => {
    const benchmark = loadImprovementBenchmark();

    expect(benchmark.version).toBe("1");
    expect(benchmark.cases).toHaveLength(4);
    expect(benchmark.gate.requiredSections).toContain("intent");
  });

  it("refuses a fixture with no version, so a comparison can be traced", () => {
    const dir = mkdtempSync(join(tmpdir(), "df-bench-"));
    const file = join(dir, "no-version.json");
    writeFileSync(
      file,
      JSON.stringify({
        gate: { minChars: 1, requiredSections: [], refusalMarkers: [] },
        cases: [],
      }),
    );
    try {
      expect(() => loadImprovementBenchmark(file)).toThrow(
        SelfImprovementConfigError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- #146 AC3/AC4: DECIDE, fail-closed, with exact boundaries -------------

describe("decide (#146 AC3/AC4)", () => {
  const before: Measurement = {
    fixtureVersion: "1",
    objective: 0.5,
    guardrails: { meanIterations: 4.5, meanFixCycles: 2.5 },
  };
  const after = (
    objective: number,
    guardrails: Record<string, number> = before.guardrails,
  ): Measurement => ({ fixtureVersion: "1", objective, guardrails });

  it("accepts a change that improves the objective with no guardrail regression", () => {
    const decision = decide(before, after(0.6));

    expect(decision.verdict).toBe("accept");
    expect(decision.reason).toContain("0.5");
    expect(decision.reason).toContain("0.6");
  });

  it("rejects when the objective is unchanged (exact boundary)", () => {
    expect(decide(before, after(0.5)).verdict).toBe("reject");
  });

  it("rejects when the objective regresses", () => {
    expect(decide(before, after(0.4)).verdict).toBe("reject");
  });

  it("rejects when the objective improves by less than the tolerance", () => {
    const decision = decide(before, after(0.55), { objectiveTolerance: 0.1 });

    expect(decision.verdict).toBe("reject");
  });

  it("accepts when the objective improves by exactly the tolerance", () => {
    const decision = decide(before, after(0.6), { objectiveTolerance: 0.1 });

    expect(decision.verdict).toBe("accept");
  });

  it("rejects a guardrail regression beyond the tolerance", () => {
    const decision = decide(before, after(0.6, { meanIterations: 5.5 }));

    expect(decision.verdict).toBe("reject");
    expect(decision.reason).toContain("meanIterations");
  });

  it("accepts a guardrail exactly at the tolerance", () => {
    const decision = decide(before, after(0.6, { meanIterations: 5.5 }), {
      guardrailTolerance: 1,
    });

    expect(decision.verdict).toBe("accept");
  });

  it("rejects a non-finite objective — verification cannot be skipped", () => {
    expect(decide(before, after(Number.NaN)).verdict).toBe("reject");
    expect(decide(before, after(Number.POSITIVE_INFINITY)).verdict).toBe(
      "reject",
    );
  });

  it("does not treat a newly-appearing guardrail as a regression", () => {
    const decision = decide(
      before,
      after(0.6, {
        meanIterations: 4.5,
        meanFixCycles: 2.5,
        meanLatencyMs: 900,
      }),
    );

    expect(decision.verdict).toBe("accept");
  });

  it("records the before and after numbers for the ledger", () => {
    const decision = decide(before, after(0.6, { meanIterations: 5 }));

    expect(decision.objective).toEqual({ before: 0.5, after: 0.6 });
    expect(decision.guardrails.before.meanIterations).toBe(4.5);
    expect(decision.guardrails.after.meanIterations).toBe(5);
  });
});

// --- #146 AC5: the improvement ledger is append-only and immutable --------

describe("InMemoryImprovementLedger (#146 AC5)", () => {
  const entry = (verdict: "accept" | "reject"): LedgerEntry => ({
    at: "2026-09-17T00:00:00.000Z",
    cycleId: "cycle-1",
    surfaceId: "iteration-bound",
    hypothesis: "raising the bound should help",
    fromVersion: "iteration-bound@v1",
    toVersion: "iteration-bound@v2",
    fixtureVersion: "1",
    verdict,
    reason: "objective improved",
    objective: { before: 0.5, after: 0.6 },
    guardrails: {
      before: { meanIterations: 4.5 },
      after: { meanIterations: 5 },
    },
  });

  it("appends entries and reads them back in order", async () => {
    const ledger = new InMemoryImprovementLedger();

    await ledger.append(entry("reject"));
    await ledger.append(entry("accept"));

    expect(ledger.entries().map((e) => e.verdict)).toEqual([
      "reject",
      "accept",
    ]);
  });

  it("hands out copies, so a reader cannot mutate recorded history", async () => {
    const ledger = new InMemoryImprovementLedger();
    await ledger.append(entry("reject"));

    const read = ledger.entries();
    read[0].verdict = "accept";
    read.push(entry("accept"));

    expect(ledger.entries()).toHaveLength(1);
    expect(ledger.entries()[0].verdict).toBe("reject");
  });
});

// --- #146 AC2 guard + the whole cycle (AC1, AC3, AC4, AC5, AC7, AC8) ------

describe("measureBenchmark guard (#146 AC2)", () => {
  it("refuses to measure an empty benchmark rather than dividing by zero", () => {
    const benchmark = loadImprovementBenchmark();

    expect(() => measureBenchmark({ ...benchmark, cases: [] })).toThrow(
      SelfImprovementConfigError,
    );
  });
});

const benchmark = loadImprovementBenchmark();
const baseline = measureBenchmark(benchmark);
const better: Measurement = { ...baseline, objective: 0.75 };

/** 30 samples at a 60% success rate — below the 0.9 target, so a proposal happens. */
async function lowSuccessStore(): Promise<InMemoryMetricsStore> {
  const entries: Array<[string, number, number, "success" | "failure"]> = [];
  for (let i = 0; i < 30; i++) {
    entries.push(["coding", 5, 3, i < 18 ? "success" : "failure"]);
  }
  return seededStore(entries);
}

/** A second surface, to prove the controller is surface-agnostic (AC8). */
function fakeSurface(id: string, initial: number): TunableSurface<number> {
  let value = initial;
  let version = 1;
  return {
    id,
    read: () => value,
    stage: async (next: number) => {
      const previous = value;
      const previousVersion = `${id}@v${version}`;
      version += 1;
      let applied = false;
      return {
        id: `${id}@v${version}`,
        surfaceId: id,
        previous,
        previousVersion,
        next,
        isApplied: () => applied,
        apply: async () => {
          value = next;
          applied = true;
        },
        revert: async () => {
          value = previous;
          applied = false;
        },
      };
    },
  };
}

async function makeConfig(overrides: Partial<SelfImprovementConfig> = {}) {
  const store = await lowSuccessStore();
  const surface = new IterationBoundSurface(10);
  const ledger = new InMemoryImprovementLedger();
  const queue: Measurement[] = [baseline, better];
  let calls = 0;
  const measurer = {
    measure: async () => queue[Math.min(calls++, queue.length - 1)],
  };
  const config: SelfImprovementConfig = {
    observer: (taskType) => observeTaskType(store, taskType, 30),
    proposer: (observation: Observation) =>
      proposeFromObservation(observation, surface),
    surface,
    measurer,
    ledger,
    taskType: "coding",
    cycleId: "cycle-1",
    pbiId: "self-improve-cycle-1",
    now: () => "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
  return { config, surface, ledger };
}

// Helpers above are module-scoped so the cost-guard and operator-gate suites
// below reuse exactly the same harness.
const makeConfigForGuard = (
  costGuard: CostGuard | undefined,
  overrides: Partial<SelfImprovementConfig> = {},
) => makeConfig({ ...overrides, costGuard });

describe("runImprovementCycle (#146 AC1/AC3/AC4/AC5/AC7)", () => {
  it("accepts a measured improvement, keeps it applied and records it", async () => {
    const { config, surface, ledger } = await makeConfig();

    const result = await runImprovementCycle(config);

    expect(result.status).toBe("accepted");
    expect(surface.read()).toBe(12);
    const [recorded] = ledger.entries();
    expect(recorded.verdict).toBe("accept");
    expect(recorded.fromVersion).toBe("iteration-bound@v1");
    expect(recorded.toVersion).toBe("iteration-bound@v2");
    expect(recorded.objective).toEqual({ before: 0.5, after: 0.75 });
    expect(recorded.fixtureVersion).toBe("1");
    expect(recorded.cycleId).toBe("cycle-1");
    expect(recorded.surfaceId).toBe("iteration-bound");
    expect(recorded.at).toBe("2026-09-17T00:00:00.000Z");
    expect(recorded.hypothesis).toContain("iteration-bound");
  });

  it("reverts a change that does not improve the objective", async () => {
    const { config, surface, ledger } = await makeConfig({
      measurer: { measure: async () => baseline },
    });

    const result = await runImprovementCycle(config);

    expect(result.status).toBe("rejected");
    expect(surface.read()).toBe(10);
    expect(ledger.entries()[0].verdict).toBe("reject");
  });

  it("reverts and rejects when the measurement itself fails (fail-closed)", async () => {
    let calls = 0;
    const { config, surface, ledger } = await makeConfig({
      measurer: {
        measure: async () => {
          calls += 1;
          if (calls === 1) return baseline;
          throw new Error("benchmark unavailable");
        },
      },
    });

    const result = await runImprovementCycle(config);

    expect(result.status).toBe("rejected");
    expect(surface.read()).toBe(10);
    expect(ledger.entries()[0].reason).toContain("cannot verify");
  });

  it("reports insufficient data and touches nothing", async () => {
    const { config, surface, ledger } = await makeConfig({
      observer: () => null,
    });

    const result = await runImprovementCycle(config);

    expect(result).toEqual({ status: "no-op", reason: "insufficient data" });
    expect(surface.read()).toBe(10);
    expect(ledger.entries()).toHaveLength(0);
  });

  it("reports no proposal when there is nothing worth changing", async () => {
    const { config, ledger } = await makeConfig({ proposer: () => null });

    const result = await runImprovementCycle(config);

    expect(result).toEqual({ status: "no-op", reason: "no proposal" });
    expect(ledger.entries()).toHaveLength(0);
  });

  it("runs an entire cycle through a second, non-iteration surface (AC8)", async () => {
    const surface = fakeSurface("skill-set", 1);
    const ledger = new InMemoryImprovementLedger();
    const queue: Measurement[] = [baseline, better];
    let calls = 0;
    const { config } = await makeConfig({
      surface,
      ledger,
      measurer: { measure: async () => queue[Math.min(calls++, 1)] },
      proposer: () => ({
        surfaceId: "skill-set",
        next: 2,
        hypothesis: "adding a lint skill should lift the objective",
        kind: "bounded-tuning",
      }),
    });

    const result = await runImprovementCycle(config);

    expect(result.status).toBe("accepted");
    expect(surface.read()).toBe(2);
    expect(ledger.entries()[0].surfaceId).toBe("skill-set");
  });
});

// --- #146 MUST: respect the #144 cost guard -------------------------------

describe("cost guard integration (#146 / #144)", () => {
  it("blocks before doing any work when the cycle's PBI is already tripped", async () => {
    const activity: Array<{ pbiId: string; status: string }> = [];
    const { config, surface, ledger } = await makeConfigForGuard({
      isTripped: () => true,
      recordActivity: (a) => activity.push(a),
    });

    const result = await runImprovementCycle(config);

    expect(result).toEqual({ status: "blocked", reason: "cost guard tripped" });
    expect(surface.read()).toBe(10);
    expect(ledger.entries()).toHaveLength(0);
    expect(activity).toHaveLength(0);
  });

  it("records the cycle as worker activity so it counts against the budget", async () => {
    const activity: Array<{
      pbiId: string;
      durationMs: number;
      status: string;
    }> = [];
    const { config } = await makeConfigForGuard({
      isTripped: () => false,
      recordActivity: (a) => activity.push(a),
    });

    await runImprovementCycle(config);

    expect(activity).toHaveLength(1);
    expect(activity[0].pbiId).toBe("self-improve-cycle-1");
    expect(activity[0].status).toBe("success");
    expect(Number.isFinite(activity[0].durationMs)).toBe(true);
    expect(activity[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});

// --- #146 NFR security: the human gate -----------------------------------

describe("operator gate (#146 security NFR)", () => {
  const widening: Proposal = {
    surfaceId: "iteration-bound",
    next: 12,
    hypothesis: "widen access for the worker",
    kind: "access-widening",
  };

  it("blocks an access-widening change when no gate is configured", async () => {
    const { config, surface, ledger } = await makeConfigForGuard(undefined, {
      proposer: () => widening,
    });

    const result = await runImprovementCycle(config);

    expect(result).toEqual({
      status: "blocked",
      reason: "operator gate missing",
    });
    expect(surface.read()).toBe(10);
    expect(ledger.entries()).toHaveLength(0);
  });

  it("blocks when the operator declines", async () => {
    const { config, surface, ledger } = await makeConfigForGuard(undefined, {
      proposer: () => widening,
      operatorGate: { approve: async () => false },
    });

    const result = await runImprovementCycle(config);

    expect(result).toEqual({
      status: "blocked",
      reason: "operator gate declined",
    });
    expect(surface.read()).toBe(10);
    expect(ledger.entries()).toHaveLength(0);
  });

  it("lets an approved access-widening change flow through the cycle", async () => {
    const { config, surface } = await makeConfigForGuard(undefined, {
      proposer: () => widening,
      operatorGate: { approve: async () => true },
    });

    const result = await runImprovementCycle(config);

    expect(result.status).toBe("accepted");
    expect(surface.read()).toBe(12);
  });
});

// --- #146: fail-closed environment wiring --------------------------------

describe("resolveSelfImprovementEnvConfig (#146)", () => {
  it("is disabled by default, with no tolerance implied", () => {
    expect(resolveSelfImprovementEnvConfig({})).toEqual({
      enabled: false,
      objectiveTolerance: 0,
      guardrailTolerance: 0,
      intervalMinutes: 1440,
    });
  });

  it("enables only on an explicit truthy value", () => {
    expect(
      resolveSelfImprovementEnvConfig({ DF_SELFIMPROVE_ENABLED: "1" }).enabled,
    ).toBe(true);
    expect(
      resolveSelfImprovementEnvConfig({ DF_SELFIMPROVE_ENABLED: "true" })
        .enabled,
    ).toBe(true);
    expect(
      resolveSelfImprovementEnvConfig({ DF_SELFIMPROVE_ENABLED: "false" })
        .enabled,
    ).toBe(false);
    expect(
      resolveSelfImprovementEnvConfig({ DF_SELFIMPROVE_ENABLED: "0" }).enabled,
    ).toBe(false);
  });

  it("rejects a garbage enable value instead of guessing", () => {
    expect(() =>
      resolveSelfImprovementEnvConfig({ DF_SELFIMPROVE_ENABLED: "yes-please" }),
    ).toThrow(SelfImprovementConfigError);
  });

  it("reads a decimal tolerance", () => {
    expect(
      resolveSelfImprovementEnvConfig({
        DF_SELFIMPROVE_OBJECTIVE_TOLERANCE: "0.05",
      }).objectiveTolerance,
    ).toBe(0.05);
  });

  it("rejects exponent, negative and non-numeric tolerance shapes", () => {
    for (const bad of ["1e3", "-1", "0.5x", "abc"]) {
      expect(() =>
        resolveSelfImprovementEnvConfig({
          DF_SELFIMPROVE_OBJECTIVE_TOLERANCE: bad,
        }),
      ).toThrow(SelfImprovementConfigError);
      expect(() =>
        resolveSelfImprovementEnvConfig({
          DF_SELFIMPROVE_GUARDRAIL_TOLERANCE: bad,
        }),
      ).toThrow(SelfImprovementConfigError);
    }
  });
});

// --- #146: the wired controller (factory) --------------------------------

describe("createSelfImprovementController (#146)", () => {
  async function deps() {
    const store = await lowSuccessStore();
    const surface = new IterationBoundSurface(10);
    const ledger = new InMemoryImprovementLedger();
    const queue: Measurement[] = [baseline, better];
    let calls = 0;
    return {
      store,
      surface,
      ledger,
      calls: () => calls,
      deps: {
        store,
        benchmark,
        surface,
        ledger,
        taskType: "coding",
        pbiId: "self-improve-cycle-1",
        minSamples: 30,
      },
      measurer: { measure: async () => queue[Math.min(calls++, 1)] },
    };
  }

  it("is disabled by default and NO-OPs without measuring anything", async () => {
    const harness = await deps();
    const controller = createSelfImprovementController(
      { ...harness.deps, measurer: harness.measurer },
      {},
    );

    expect(controller.enabled).toBe(false);
    expect(await controller.run("cycle-1")).toEqual({
      status: "no-op",
      reason: "disabled",
    });
    expect(harness.calls()).toBe(0);
    expect(harness.surface.read()).toBe(10);
    expect(harness.ledger.entries()).toHaveLength(0);
  });

  it("runs a cycle when the operator has enabled it", async () => {
    const harness = await deps();
    const controller = createSelfImprovementController(
      { ...harness.deps, measurer: harness.measurer },
      { DF_SELFIMPROVE_ENABLED: "true" },
    );

    expect(controller.enabled).toBe(true);
    const result = await controller.run("cycle-1");

    expect(result.status).toBe("accepted");
    expect(harness.surface.read()).toBe(12);
    expect(harness.ledger.entries()).toHaveLength(1);
  });
});

// --- #146: a human-readable trace of one real cycle ----------------------

describe("self-improvement cycle DEMO (#146)", () => {
  it("DEMO: runs one cycle and prints the ledger entry it recorded", async () => {
    const { config, surface, ledger } = await makeConfig();

    const result = await runImprovementCycle(config);
    const [entry] = ledger.entries();
    console.log(
      [
        "",
        `[DEMO] cycle ${entry.cycleId} → ${result.status.toUpperCase()}`,
        `[DEMO] surface  ${entry.surfaceId}: ${entry.fromVersion} → ${entry.toVersion}`,
        `[DEMO] hypothesis ${entry.hypothesis}`,
        `[DEMO] objective  ${entry.objective.before} → ${entry.objective.after}`,
        `[DEMO] guardrails before=${JSON.stringify(entry.guardrails.before)} after=${JSON.stringify(entry.guardrails.after)}`,
        `[DEMO] verdict ${entry.verdict} (${entry.reason})`,
        `[DEMO] live surface value is now ${surface.read()}`,
        "",
      ].join("\n"),
    );

    expect(entry.verdict).toBe("accept");
    expect(surface.read()).toBe(12);
  });
});

// --- #154 review round 2: benchmark CONTENT validation -------------------
//
// The fixture's top level was validated (version/cases/gate) but individual
// case fields were not, so a malformed case reached the grader and threw a raw
// TypeError instead of a configuration error naming the offending case.

describe("benchmark case validation (#154 review)", () => {
  const gate = {
    minChars: 1,
    requiredSections: [],
    refusalMarkers: [],
  };

  function withFixture(benchmark: unknown, fn: (path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "df-bench-"));
    const file = join(dir, "fixture.json");
    writeFileSync(file, JSON.stringify(benchmark));
    try {
      fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("still accepts a well-formed fixture (the guard must not be over-strict)", () => {
    withFixture(
      {
        version: "9",
        gate,
        cases: [
          {
            id: "ok",
            taskType: "coding",
            output: "x",
            iterations: 1,
            fixCycles: 0,
          },
        ],
      },
      (file) => {
        const benchmark = loadImprovementBenchmark(file);
        expect(benchmark.version).toBe("9");
        expect(benchmark.cases).toHaveLength(1);
        // One case, which passes the one-character gate → objective 1.
        expect(measureBenchmark(benchmark).objective).toBe(1);
      },
    );
  });

  it("rejects a case whose output is not a string", () => {
    withFixture(
      {
        version: "1",
        gate,
        cases: [
          {
            id: "bad",
            taskType: "coding",
            output: 42,
            iterations: 1,
            fixCycles: 0,
          },
        ],
      },
      (file) => {
        expect(() => loadImprovementBenchmark(file)).toThrow(
          SelfImprovementConfigError,
        );
      },
    );
  });

  it("rejects a case with a negative or non-integer effort count", () => {
    for (const bad of [
      {
        id: "neg",
        taskType: "coding",
        output: "x",
        iterations: -1,
        fixCycles: 0,
      },
      {
        id: "frac",
        taskType: "coding",
        output: "x",
        iterations: 1.5,
        fixCycles: 0,
      },
      {
        id: "nan",
        taskType: "coding",
        output: "x",
        iterations: Number.NaN,
        fixCycles: 0,
      },
    ]) {
      withFixture({ version: "1", gate, cases: [bad] }, (file) => {
        expect(() => loadImprovementBenchmark(file)).toThrow(
          SelfImprovementConfigError,
        );
      });
    }
  });

  it("names the offending case so a malformed fixture is diagnosable", () => {
    withFixture(
      {
        version: "1",
        gate,
        cases: [
          {
            id: "ok",
            taskType: "coding",
            output: "x",
            iterations: 1,
            fixCycles: 0,
          },
          {
            id: "broken-case",
            taskType: "",
            output: "x",
            iterations: 1,
            fixCycles: 0,
          },
        ],
      },
      (file) => {
        expect(() => loadImprovementBenchmark(file)).toThrow(/broken-case/);
      },
    );
  });

  it("refuses to measure a malformed case handed in directly", () => {
    const benchmark = loadImprovementBenchmark();

    expect(() =>
      measureBenchmark({
        ...benchmark,
        cases: [
          {
            id: "hand-built",
            taskType: "coding",
            output: 123 as unknown as string,
            iterations: 1,
            fixCycles: 0,
          },
        ],
      }),
    ).toThrow(SelfImprovementConfigError);
  });

  it("rejects duplicate case ids, so a failure maps to exactly one case", () => {
    const duplicate = {
      taskType: "coding",
      output: "x",
      iterations: 1,
      fixCycles: 0,
    };
    withFixture(
      {
        version: "1",
        gate,
        cases: [
          { id: "same", ...duplicate },
          { id: "same", ...duplicate },
        ],
      },
      (file) => {
        expect(() => loadImprovementBenchmark(file)).toThrow(
          SelfImprovementConfigError,
        );
        expect(() => loadImprovementBenchmark(file)).toThrow(/same/);
      },
    );
  });

  it("rejects an absurd effort count, keeping aggregation far from overflow", () => {
    for (const huge of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
      withFixture(
        {
          version: "1",
          gate,
          cases: [
            {
              id: "huge",
              taskType: "coding",
              output: "x",
              iterations: huge,
              fixCycles: 0,
            },
          ],
        },
        (file) => {
          expect(() => loadImprovementBenchmark(file)).toThrow(
            SelfImprovementConfigError,
          );
        },
      );
    }
  });

  it("rejects a gate whose section list is not an array of strings", () => {
    for (const badGate of [
      { minChars: 1, requiredSections: "intent", refusalMarkers: [] },
      { minChars: 1, requiredSections: ["intent"], refusalMarkers: "nope" },
      { minChars: 1, requiredSections: [7], refusalMarkers: [] },
    ]) {
      withFixture(
        {
          version: "1",
          gate: badGate,
          cases: [
            {
              id: "ok",
              taskType: "coding",
              output: "x",
              iterations: 1,
              fixCycles: 0,
            },
          ],
        },
        (file) => {
          expect(() => loadImprovementBenchmark(file)).toThrow(
            SelfImprovementConfigError,
          );
        },
      );
    }
  });

  it("rejects a gate with a negative or non-integer minChars", () => {
    for (const minChars of [-1, 1.5, Number.NaN, "200"]) {
      withFixture(
        {
          version: "1",
          gate: { minChars, requiredSections: [], refusalMarkers: [] },
          cases: [
            {
              id: "ok",
              taskType: "coding",
              output: "x",
              iterations: 1,
              fixCycles: 0,
            },
          ],
        },
        (file) => {
          expect(() => loadImprovementBenchmark(file)).toThrow(
            SelfImprovementConfigError,
          );
        },
      );
    }
  });

  it("accepts a well-formed gate", () => {
    withFixture(
      {
        version: "1",
        gate: { minChars: 0, requiredSections: ["intent"], refusalMarkers: [] },
        cases: [
          {
            id: "ok",
            taskType: "coding",
            output: "Intent: fine.",
            iterations: 1,
            fixCycles: 0,
          },
        ],
      },
      (file) => {
        expect(loadImprovementBenchmark(file).version).toBe("1");
      },
    );
  });
});

// --- #154 review round 5: sandboxed benchmark reads -----------------------
//
// Mirrors `resolveStateDbPath`'s optional sandbox root in index.ts, so a caller
// that DOES make the benchmark path configurable can bound where it may read.

describe("benchmark path sandbox (#154 review)", () => {
  const gate = { minChars: 1, requiredSections: [], refusalMarkers: [] };
  const cases = [
    { id: "ok", taskType: "coding", output: "x", iterations: 1, fixCycles: 0 },
  ];

  it("refuses a benchmark path outside the configured sandbox root", () => {
    const inside = mkdtempSync(join(tmpdir(), "df-bench-in-"));
    const outside = mkdtempSync(join(tmpdir(), "df-bench-out-"));
    const outsideFile = join(outside, "fixture.json");
    writeFileSync(outsideFile, JSON.stringify({ version: "1", gate, cases }));
    try {
      expect(() => loadImprovementBenchmark(outsideFile, inside)).toThrow(
        SelfImprovementConfigError,
      );
    } finally {
      rmSync(inside, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("still reads a benchmark inside the sandbox root", () => {
    const dir = mkdtempSync(join(tmpdir(), "df-bench-in-"));
    const file = join(dir, "fixture.json");
    writeFileSync(file, JSON.stringify({ version: "7", gate, cases }));
    try {
      expect(loadImprovementBenchmark(file, dir).version).toBe("7");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves path handling unconstrained when no sandbox root is configured", () => {
    const dir = mkdtempSync(join(tmpdir(), "df-bench-free-"));
    const file = join(dir, "fixture.json");
    writeFileSync(file, JSON.stringify({ version: "3", gate, cases }));
    try {
      expect(loadImprovementBenchmark(file).version).toBe("3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- #154 review round 4: config validation, atomicity, seam guard --------

describe("tolerance validation on the direct config path (#154 review)", () => {
  it("refuses a negative or non-finite tolerance instead of deciding with it", async () => {
    for (const bad of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { config, surface, ledger } = await makeConfig({
        objectiveTolerance: bad,
      });

      await expect(runImprovementCycle(config)).rejects.toThrow(
        SelfImprovementConfigError,
      );
      // Fail-closed: nothing was staged, applied, measured or recorded.
      expect(surface.read()).toBe(10);
      expect(ledger.entries()).toHaveLength(0);
    }
  });

  it("refuses a negative guardrail tolerance too", async () => {
    const { config } = await makeConfig({ guardrailTolerance: -1 });

    await expect(runImprovementCycle(config)).rejects.toThrow(
      SelfImprovementConfigError,
    );
  });
});

describe("version-handle atomicity (#154 review)", () => {
  it("never loses a version when stages are issued concurrently", async () => {
    const surface = new IterationBoundSurface(10);

    const handles = await Promise.all([surface.stage(12), surface.stage(14)]);

    expect(handles.map((handle) => handle.id)).toEqual([
      "iteration-bound@v2",
      "iteration-bound@v3",
    ]);
    expect(new Set(handles.map((h) => h.id)).size).toBe(2);
  });

  it("settles concurrent applies deterministically — only the current handle wins", async () => {
    const surface = new IterationBoundSurface(10);
    const v2 = await surface.stage(12);
    const v3 = await surface.stage(14);

    const settled = await Promise.allSettled([v2.apply(), v3.apply()]);

    expect(settled[0].status).toBe("rejected");
    expect(settled[1].status).toBe("fulfilled");
    expect(surface.read()).toBe(14);
  });
});

describe("proposal seam guard (#154 review)", () => {
  it("refuses a proposal whose next value is not a usable bound", async () => {
    const surface = new IterationBoundSurface(10);

    await expect(surface.stage("twelve" as unknown as number)).rejects.toThrow(
      InvalidProposalError,
    );
    await expect(surface.stage(undefined as unknown as number)).rejects.toThrow(
      InvalidProposalError,
    );
    await expect(surface.stage(Number.NaN)).rejects.toThrow(
      InvalidProposalError,
    );
  });
});

// --- #154 review round 2: a stale version handle must not clobber ---------
//
// Not a thread-safety issue (JavaScript is single-threaded, and stage/apply
// contain no awaits that could interleave). The real hazard is a SUPERSEDED
// handle acting after a newer version was staged, which would silently undo it.

describe("superseded version handles (#154 review)", () => {
  it("refuses to apply a handle that a newer stage superseded", async () => {
    const surface = new IterationBoundSurface(10);
    const v2 = await surface.stage(12);
    const v3 = await surface.stage(14);

    await expect(v2.apply()).rejects.toThrow(SupersededVersionError);
    expect(surface.read()).toBe(10);

    await v3.apply();
    expect(surface.read()).toBe(14);
  });

  it("refuses to revert a superseded handle", async () => {
    const surface = new IterationBoundSurface(10);
    const v2 = await surface.stage(12);
    await v2.apply();
    const v3 = await surface.stage(14);

    await expect(v2.revert()).rejects.toThrow(SupersededVersionError);
    expect(surface.read()).toBe(12);
  });
});
