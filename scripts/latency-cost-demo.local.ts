/**
 * #158 — local evidence run (NOT part of the test suite).
 *
 * Runs a REAL `runImprovementCycle` twice against measured metrics:
 *   A. a change that improves the objective but regresses latency beyond
 *      `guardrailTolerance` → rejected AND reverted (the surface goes back);
 *   B. the same change within tolerance → accepted, so the guardrail is provably
 *      not a hair-trigger.
 *
 * Run: npx tsx scripts/latency-cost-demo.local.ts
 */
import { InMemoryMetricsStore } from "../agent/lib/dark-factory/metrics";
import {
  InMemoryImprovementLedger,
  IterationBoundSurface,
  observeTaskType,
  proposeFromObservation,
  runImprovementCycle,
  type Measurement,
  type SelfImprovementConfig,
} from "../agent/lib/dark-factory/self-improve";

const line = (label: string, value: unknown) => console.log(`  ${label.padEnd(34)} ${JSON.stringify(value)}`);

async function seedMetrics(): Promise<ReturnType<typeof observeTaskType>> {
  const store = new InMemoryMetricsStore();
  // 2 of 4 succeed → success rate 0.5, below the 0.9 target, so a proposal is made.
  await store.record("coding", {
    iterations: 4, fixCycles: 2, status: "success", latencyMs: 100, costUsd: 0.5,
  });
  await store.record("coding", {
    iterations: 4, fixCycles: 2, status: "failure", latencyMs: 200, costUsd: 0.5,
  });
  await store.record("coding", { iterations: 4, fixCycles: 3, status: "success", latencyMs: 150, costUsd: 0.25 });
  await store.record("coding", { iterations: 5, fixCycles: 3, status: "failure" }); // <- latency NOT measured

  console.log("[1] SENSOR — metrics carry latency/cost, an unmeasured one stays absent");
  for (const record of store.getRecords()) {
    line(`record (${record.status})`, {
      iterations: record.iterations,
      latencyMs: record.latencyMs,
      costUsd: record.costUsd,
    });
  }
  line("has latencyMs key? (row 4)", "latencyMs" in store.getRecords()[3]);
  const observation = observeTaskType(store, "coding", 2);
  line("observation", observation);
  console.log(
    "  → mean latency 150 = (100+200+150)/3, over the MEASURED samples only;\n" +
      "    the unmeasured row is skipped, not counted as 0.\n",
  );
  return observation;
}

function measurer(before: Measurement, after: Measurement) {
  let calls = 0;
  return { measure: async () => (calls++ === 0 ? before : after) };
}

async function runCase(
  label: string,
  after: Measurement,
  guardrailTolerance: number,
): Promise<void> {
  const surface = new IterationBoundSurface(10);
  const ledger = new InMemoryImprovementLedger();
  const before: Measurement = {
    fixtureVersion: "demo-1",
    objective: 0.5,
    guardrails: { meanIterations: 4, meanFixCycles: 2, meanLatencyMs: 100, meanCostUsd: 0.5 },
  };
  const config: SelfImprovementConfig = {
    observer: () => seeded,
    proposer: (o) => proposeFromObservation(o, surface),
    surface,
    measurer: measurer(before, after),
    ledger,
    taskType: "coding",
    cycleId: "demo-cycle",
    pbiId: "PBI-158-DEMO",
    objectiveTolerance: 0,
    guardrailTolerance,
    operatorGate: { approve: async () => true },
  };

  console.log(`[${label}] guardrailTolerance=${guardrailTolerance}`);
  line("surface before", surface.read());
  const result = await runImprovementCycle(config);
  line("cycle status", result.status);
  const entry = ledger.entries().at(-1);
  if (entry) {
    line("ledger verdict", entry.verdict);
    line("ledger reason", entry.reason);
    line("guardrails before", entry.guardrails.before);
    line("guardrails after", entry.guardrails.after);
    line("versions", `${entry.fromVersion} -> ${entry.toVersion}`);
  } else {
    line("ledger entry", "(none - no decision was recorded)");
  }
  line("surface after", surface.read());
  console.log(
    `  → ${surface.read() === 10 ? "surface RESTORED to 10 (reverted)" : "surface moved to " + surface.read()}\n`,
  );
}

/** The seeded observation both runs share — the observer must return the same one. */
let seeded: ReturnType<typeof observeTaskType> = null;

async function main(): Promise<void> {
  seeded = await seedMetrics();

  await runCase(
    "A: objective up, latency regression BEYOND tolerance",
    {
      fixtureVersion: "demo-1",
      objective: 0.9,
      guardrails: { meanIterations: 4, meanFixCycles: 2, meanLatencyMs: 400, meanCostUsd: 0.5 },
    },
    50,
  );

  await runCase(
    "B: objective up, latency regression WITHIN tolerance",
    {
      fixtureVersion: "demo-1",
      objective: 0.9,
      guardrails: { meanIterations: 4, meanFixCycles: 2, meanLatencyMs: 140, meanCostUsd: 0.5 },
    },
    50,
  );
}

void main();
