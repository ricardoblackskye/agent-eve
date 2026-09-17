/**
 * Dark Factory — Measurable Recursive Self-Improvement (#146, R4a).
 *
 * One bounded, FAIL-CLOSED cycle:
 *   OBSERVE  → read the aggregate metrics from #140 (never a parallel store)
 *   PROPOSE  → a candidate change to a tunable surface + a written hypothesis
 *   APPLY    → staged behind a versioned, reversible handle (never in place)
 *   MEASURE  → re-run a fixed, deterministic benchmark set
 *   DECIDE   → accept iff the objective improves and no guardrail regresses
 *   RECORD   → append an immutable ledger entry {what, why, before → after, verdict}
 *
 * Every step is an injected interface, so no model, vendor or tool is named here.
 * Reversibility and fail-closed verification are the whole point: an unverified
 * self-improvement loop will happily improve itself into a regression.
 *
 * R4b adds the recurrence (cadence + trend report + operator CLI).
 *
 * SCAFFOLD: signatures are declared with real types so the test file collects;
 * behaviour is implemented RED → GREEN per the plan's cycle table.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { round2, type MetricsStore, type TaskMetric } from "./metrics";
import { gradeStoryQuality, type QualityGate } from "../quality-gate";

// --- Errors ---------------------------------------------------------------

/** A configuration problem (env var), as opposed to a caller or runtime error. */
export class SelfImprovementConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfImprovementConfigError";
  }
}

/** A proposal that violates the proposer contract (e.g. no written hypothesis). */
export class InvalidProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProposalError";
  }
}

// --- Step 1: OBSERVE (derived from #140, never a parallel store) ----------

/** Aggregate view of one task type, derived ONLY from the #140 store. */
export interface Observation {
  taskType: string;
  samples: number;
  /** The objective metric: K/N successes, rounded to two decimals. */
  successRate: number;
  /** Guardrail: mean iterations per completed task. */
  meanIterations: number;
  /** Guardrail: mean fail→fix cycles per completed task. */
  meanFixCycles: number;
}

/** Returns null when there is not enough data to observe honestly. */
export type Observer = (taskType: string) => Observation | null;

export function observeTaskType(
  store: MetricsStore,
  taskType: string,
  minSamples: number,
): Observation | null {
  const matching = store
    .getRecords()
    .filter((record) => record.taskType === taskType);
  if (matching.length < minSamples) return null;
  return { taskType, ...summarizeRecords(matching) };
}

export function summarizeRecords(records: TaskMetric[]): {
  samples: number;
  successRate: number;
  meanIterations: number;
  meanFixCycles: number;
} {
  const samples = records.length;
  // An empty set is reported as zeroed aggregates, never NaN — a NaN objective
  // would make every comparison false and silently look like "no improvement".
  if (samples === 0) {
    return { samples: 0, successRate: 0, meanIterations: 0, meanFixCycles: 0 };
  }
  const successes = records.filter((r) => r.status === "success").length;
  const sum = (pick: (r: TaskMetric) => number): number =>
    records.reduce((total, r) => total + pick(r), 0);
  return {
    samples,
    successRate: round2(successes / samples),
    meanIterations: round2(sum((r) => r.iterations) / samples),
    meanFixCycles: round2(sum((r) => r.fixCycles) / samples),
  };
}

// --- Step 2/3: tunable surface + versioned reversible handle -------------

/** A knob the controller may change. Never mutated in place. */
export interface TunableSurface<T = unknown> {
  id: string;
  read(): T;
  stage(next: T): Promise<VersionHandle<T>>;
}

export interface VersionHandle<T = unknown> {
  id: string;
  surfaceId: string;
  /** The id of the version this handle replaces — the ledger's `fromVersion`. */
  previousVersion: string;
  previous: T;
  next: T;
  /** Make the staged value live. */
  apply(): Promise<void>;
  /** Restore `previous`. Idempotent — safe to retry. */
  revert(): Promise<void>;
  /** False once reverted; lets the controller assert the end state. */
  isApplied(): boolean;
}

/**
 * The first real surface: the iteration/retry bound, wrapping the existing
 * `DF_MAX_ITERATIONS` seam (#133). Held in process, so revert is trivially sound.
 */
export class IterationBoundSurface implements TunableSurface<number> {
  readonly id = "iteration-bound";

  private bound: number;
  /** Version 1 is the starting bound; each stage mints the next version. */
  private version = 1;

  constructor(initial: number) {
    this.bound = initial;
  }

  read(): number {
    return this.bound;
  }

  async stage(next: number): Promise<VersionHandle<number>> {
    if (!Number.isInteger(next) || next < 1) {
      throw new InvalidProposalError(
        `Cannot stage an iteration bound of ${JSON.stringify(next)}; a bound must be a positive integer.`,
      );
    }
    const previous = this.bound;
    const previousVersion = `${this.id}@v${this.version}`;
    this.version += 1;
    const id = `${this.id}@v${this.version}`;
    let applied = false;
    return {
      id,
      surfaceId: this.id,
      previousVersion,
      previous,
      next,
      isApplied: () => applied,
      apply: async () => {
        this.bound = next;
        applied = true;
      },
      // Idempotent on purpose: a retried revert after a failure must not error,
      // and restoring `previous` twice is harmless.
      revert: async () => {
        this.bound = previous;
        applied = false;
      },
    };
  }
}

// --- Step 2: PROPOSE ------------------------------------------------------

export interface Proposal {
  surfaceId: string;
  next: unknown;
  /** AC1: the hypothesis must be explicit and written, never implied. */
  hypothesis: string;
  /**
   * `access-widening` changes may not be accepted without the operator gate
   * (NFR security); `bounded-tuning` is a value change within an existing bound.
   */
  kind: "bounded-tuning" | "access-widening";
}

export function makeProposal(proposal: Proposal): Proposal {
  // AC1: a change without a written hypothesis is not a proposal — refuse it
  // rather than letting an unstated intent ride into the ledger.
  if (typeof proposal.hypothesis !== "string" || !proposal.hypothesis.trim()) {
    throw new InvalidProposalError(
      `Proposal for surface '${proposal.surfaceId}' requires an explicit non-empty hypothesis.`,
    );
  }
  return proposal;
}

export type Proposer = (observation: Observation) => Proposal | null;

export interface ProposeOptions {
  /** Success rate at or above which there is nothing worth changing. */
  targetSuccessRate?: number;
  /** How much to raise the bound by. */
  step?: number;
}

export function proposeFromObservation(
  observation: Observation,
  surface: TunableSurface<number>,
  options?: ProposeOptions,
): Proposal | null {
  const targetSuccessRate = options?.targetSuccessRate ?? 0.9;
  const step = options?.step ?? 2;
  // Nothing worth changing: proposing a change with no rationale would push an
  // unverified edit through the loop for no reason.
  if (observation.successRate >= targetSuccessRate) return null;

  const current = surface.read();
  const next = current + step;
  return makeProposal({
    surfaceId: surface.id,
    next,
    kind: "bounded-tuning",
    hypothesis:
      `Raising ${surface.id} from ${current} to ${next} for task type ` +
      `'${observation.taskType}' (observed success rate ${observation.successRate} ` +
      `over ${observation.samples} samples) should lift the objective above ${targetSuccessRate}.`,
  });
}

// --- Step 4: MEASURE (reuses the #121 pure graders) -----------------------

export interface Measurement {
  /** Identifies the benchmark that produced these numbers. */
  fixtureVersion: string;
  objective: number;
  guardrails: Record<string, number>;
}

export interface Measurer {
  measure(): Promise<Measurement>;
}

/** One fixed benchmark case: an output plus the effort it took to produce. */
export interface BenchmarkCase {
  id: string;
  taskType: string;
  output: string;
  iterations: number;
  fixCycles: number;
}

export interface ImprovementBenchmark {
  version: string;
  gate: QualityGate;
  cases: BenchmarkCase[];
}

export function loadImprovementBenchmark(path?: string): ImprovementBenchmark {
  const file =
    path ??
    join(process.cwd(), "tests", "fixtures", "self-improve-benchmark.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new SelfImprovementConfigError(
      `Improvement benchmark '${file}' could not be read as JSON: ${(error as Error).message}`,
    );
  }
  const benchmark = parsed as Partial<ImprovementBenchmark>;
  // The version is load-bearing: without it, a later edit to the case set would
  // silently invalidate the comparison recorded in every historic ledger entry.
  if (typeof benchmark.version !== "string" || !benchmark.version.trim()) {
    throw new SelfImprovementConfigError(
      `Improvement benchmark '${file}' requires a non-empty "version".`,
    );
  }
  if (!Array.isArray(benchmark.cases)) {
    throw new SelfImprovementConfigError(
      `Improvement benchmark '${file}' requires a "cases" array.`,
    );
  }
  if (!benchmark.gate) {
    throw new SelfImprovementConfigError(
      `Improvement benchmark '${file}' requires a "gate".`,
    );
  }
  return {
    version: benchmark.version,
    gate: benchmark.gate,
    cases: benchmark.cases,
  };
}

/**
 * Deterministic measurer: fractions of the fixed case set that pass the #121
 * quality gate (objective) plus mean iterations/fixCycles (guardrails).
 * No network, no API key — the same numbers every run.
 */
export class BenchmarkMeasurer implements Measurer {
  private readonly benchmark: ImprovementBenchmark;

  constructor(benchmark: ImprovementBenchmark) {
    this.benchmark = benchmark;
  }

  async measure(): Promise<Measurement> {
    return measureBenchmark(this.benchmark);
  }
}

export function measureBenchmark(benchmark: ImprovementBenchmark): Measurement {
  const { cases, gate, version } = benchmark;
  if (cases.length === 0) {
    throw new SelfImprovementConfigError(
      `Improvement benchmark '${version}' has no cases; nothing can be measured.`,
    );
  }
  // Objective: the fraction of the FIXED case set that still passes the #121
  // quality gate. A change that degrades output quality cannot raise this.
  const passed = cases.filter(
    (testCase) => gradeStoryQuality(testCase.output, gate).passed,
  ).length;
  const mean = (pick: (testCase: BenchmarkCase) => number): number =>
    round2(cases.reduce((total, c) => total + pick(c), 0) / cases.length);
  return {
    fixtureVersion: version,
    objective: round2(passed / cases.length),
    guardrails: {
      meanIterations: mean((c) => c.iterations),
      meanFixCycles: mean((c) => c.fixCycles),
    },
  };
}

// --- Step 5: DECIDE (fail-closed) ----------------------------------------

export interface Decision {
  verdict: "accept" | "reject";
  reason: string;
  objective: { before: number; after: number };
  guardrails: { before: Record<string, number>; after: Record<string, number> };
}

export interface DecisionConfig {
  /** Required objective gain. 0 = strictly better. */
  objectiveTolerance?: number;
  /** Allowed guardrail regression. 0 = no regression. */
  guardrailTolerance?: number;
}

export function decide(
  before: Measurement,
  after: Measurement,
  config?: DecisionConfig,
): Decision {
  const objectiveTolerance = config?.objectiveTolerance ?? 0;
  const guardrailTolerance = config?.guardrailTolerance ?? 0;
  const numbers = {
    objective: { before: before.objective, after: after.objective },
    guardrails: { before: before.guardrails, after: after.guardrails },
  };

  // Fail-closed: a number we cannot verify can never justify a change. This is
  // what makes "no change without a measured before/after" real rather than
  // aspirational — a NaN objective would otherwise compare false and look like
  // "no improvement", i.e. a silent reject in the wrong place.
  const measured = [
    before.objective,
    after.objective,
    ...Object.values(before.guardrails),
    ...Object.values(after.guardrails),
  ];
  if (measured.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    return {
      verdict: "reject",
      reason:
        "cannot verify: the objective or a guardrail was not a finite number, so no measurement backs this change",
      ...numbers,
    };
  }

  // Strictly better AND at least the configured tolerance of improvement.
  // With the default tolerance of 0 that means ANY improvement is enough, while
  // an unchanged objective is still rejected.
  const improved =
    after.objective > before.objective &&
    after.objective >= before.objective + objectiveTolerance;
  if (!improved) {
    return {
      verdict: "reject",
      reason:
        `objective did not improve: ${before.objective} → ${after.objective} ` +
        `(required gain ${objectiveTolerance})`,
      ...numbers,
    };
  }

  const regressed = Object.keys(after.guardrails).filter((key) => {
    const prior = before.guardrails[key];
    // A guardrail that did not exist before cannot have regressed.
    if (typeof prior !== "number") return false;
    return after.guardrails[key] > prior + guardrailTolerance;
  });
  if (regressed.length > 0) {
    return {
      verdict: "reject",
      reason:
        `guardrail regression beyond tolerance ${guardrailTolerance}: ` +
        regressed.join(", "),
      ...numbers,
    };
  }

  return {
    verdict: "accept",
    reason: `objective improved ${before.objective} → ${after.objective} with no guardrail regression`,
    ...numbers,
  };
}

// --- Step 6: RECORD (immutable ledger) -----------------------------------

export interface LedgerEntry {
  at: string;
  cycleId: string;
  surfaceId: string;
  hypothesis: string;
  fromVersion: string;
  toVersion: string;
  fixtureVersion: string;
  verdict: "accept" | "reject";
  reason: string;
  objective: { before: number; after: number };
  guardrails: { before: Record<string, number>; after: Record<string, number> };
}

/** Append-only. Entries are never mutated or removed. */
export interface ImprovementLedger {
  append(entry: LedgerEntry): Promise<void>;
  entries(): LedgerEntry[];
}

export class InMemoryImprovementLedger implements ImprovementLedger {
  private readonly history: LedgerEntry[] = [];

  async append(entry: LedgerEntry): Promise<void> {
    // Store a clone so a caller that keeps mutating its own object cannot
    // rewrite history after the fact.
    this.history.push(structuredClone(entry));
  }

  entries(): LedgerEntry[] {
    // Hand out clones for the same reason: recorded history is append-only.
    return this.history.map((entry) => structuredClone(entry));
  }
}

// --- The controller ------------------------------------------------------

/** Adapter over the #144 circuit breaker / cost guard. */
export interface CostGuard {
  isTripped(pbiId: string): boolean;
  recordActivity(activity: {
    pbiId: string;
    durationMs: number;
    status: "success" | "failure";
  }): void;
}

/**
 * Human gate. An `access-widening` proposal with NO gate is blocked, not
 * applied — a missing gate must never mean "allowed".
 */
export interface OperatorGate {
  approve(proposal: Proposal): Promise<boolean>;
}

export type CycleResult =
  | {
      status: "no-op";
      reason: "insufficient data" | "no proposal" | "disabled";
    }
  | {
      status: "blocked";
      reason:
        | "cost guard tripped"
        | "operator gate missing"
        | "operator gate declined";
    }
  | { status: "accepted" | "rejected"; decision: Decision; entry: LedgerEntry };

export interface SelfImprovementConfig {
  observer: Observer;
  proposer: Proposer;
  surface: TunableSurface<number>;
  measurer: Measurer;
  ledger: ImprovementLedger;
  taskType: string;
  cycleId: string;
  /** Must satisfy the #144 circuit breaker's PBI id pattern. */
  pbiId: string;
  objectiveTolerance?: number;
  guardrailTolerance?: number;
  costGuard?: CostGuard;
  operatorGate?: OperatorGate;
  /** Injectable clock, so ledger timestamps are testable. */
  now?: () => string;
}

export async function runImprovementCycle(
  config: SelfImprovementConfig,
): Promise<CycleResult> {
  const startedAt = Date.now();

  // The cost guard is consulted FIRST: a tripped PBI must not spend anything,
  // so no observation, proposal, apply or measurement happens at all.
  if (config.costGuard?.isTripped(config.pbiId)) {
    return { status: "blocked", reason: "cost guard tripped" };
  }

  const observation = config.observer(config.taskType);
  if (!observation) return { status: "no-op", reason: "insufficient data" };

  const proposal = config.proposer(observation);
  if (!proposal) return { status: "no-op", reason: "no proposal" };

  // NFR security: a change that widens access may not be accepted without the
  // human gate — and a MISSING gate is a refusal, never permission.
  if (proposal.kind === "access-widening") {
    if (!config.operatorGate) {
      return { status: "blocked", reason: "operator gate missing" };
    }
    if (!(await config.operatorGate.approve(proposal))) {
      return { status: "blocked", reason: "operator gate declined" };
    }
  }

  const before = await config.measurer.measure();
  const handle = await config.surface.stage(proposal.next as number);
  await handle.apply();

  // Fail-closed MEASURE: a benchmark that cannot produce numbers can never
  // justify KEEPING the change, so the failure path reverts exactly like a
  // measured regression does.
  let decision: Decision;
  try {
    const after = await config.measurer.measure();
    decision = decide(before, after, {
      objectiveTolerance: config.objectiveTolerance,
      guardrailTolerance: config.guardrailTolerance,
    });
  } catch (error) {
    decision = {
      verdict: "reject",
      reason: `cannot verify: the post-change measurement failed (${(error as Error).message})`,
      objective: { before: before.objective, after: Number.NaN },
      guardrails: { before: before.guardrails, after: {} },
    };
  }

  if (decision.verdict === "reject") {
    await handle.revert();
  }

  const entry: LedgerEntry = {
    at: (config.now ?? (() => new Date().toISOString()))(),
    cycleId: config.cycleId,
    surfaceId: handle.surfaceId,
    hypothesis: proposal.hypothesis,
    fromVersion: handle.previousVersion,
    toVersion: handle.id,
    fixtureVersion: before.fixtureVersion,
    verdict: decision.verdict,
    reason: decision.reason,
    objective: decision.objective,
    guardrails: decision.guardrails,
  };
  await config.ledger.append(entry);

  // A cycle is a budgeted unit of work, so it counts against the cost guard
  // whether or not the change was accepted.
  config.costGuard?.recordActivity({
    pbiId: config.pbiId,
    durationMs: Math.max(0, Date.now() - startedAt),
    status: decision.verdict === "accept" ? "success" : "failure",
  });

  return {
    status: decision.verdict === "accept" ? "accepted" : "rejected",
    decision,
    entry,
  };
}

// --- Environment wiring (fail-closed) ------------------------------------

export interface SelfImprovementEnvConfig {
  enabled: boolean;
  objectiveTolerance: number;
  guardrailTolerance: number;
}

/** Dependencies the controller needs; the env supplies only its policy knobs. */
export interface SelfImprovementDeps {
  store: MetricsStore;
  benchmark: ImprovementBenchmark;
  surface: TunableSurface<number>;
  ledger: ImprovementLedger;
  taskType: string;
  pbiId: string;
  minSamples?: number;
  /** Override the measurement source (defaults to the benchmark measurer). */
  measurer?: Measurer;
  costGuard?: CostGuard;
  operatorGate?: OperatorGate;
}

export interface SelfImprovementController {
  enabled: boolean;
  /** Run one cycle. A disabled controller NO-OPs without touching anything. */
  run(cycleId: string): Promise<CycleResult>;
}

/**
 * Wire a controller from its dependencies and the environment. The factory lives
 * next to the seam, matching the other Dark Factory factories in `index.ts`.
 */
export function createSelfImprovementController(
  deps: SelfImprovementDeps,
  env: Record<string, string | undefined> = process.env,
): SelfImprovementController {
  const config = resolveSelfImprovementEnvConfig(env);
  const measurer = deps.measurer ?? new BenchmarkMeasurer(deps.benchmark);

  return {
    enabled: config.enabled,
    run: async (cycleId: string): Promise<CycleResult> => {
      // Fail-closed: a disabled controller is inert — it does not observe,
      // propose, stage, measure or record anything.
      if (!config.enabled) return { status: "no-op", reason: "disabled" };
      return runImprovementCycle({
        observer: (taskType) =>
          observeTaskType(deps.store, taskType, deps.minSamples ?? 30),
        proposer: (observation) =>
          proposeFromObservation(observation, deps.surface),
        surface: deps.surface,
        measurer,
        ledger: deps.ledger,
        taskType: deps.taskType,
        cycleId,
        pbiId: deps.pbiId,
        objectiveTolerance: config.objectiveTolerance,
        guardrailTolerance: config.guardrailTolerance,
        costGuard: deps.costGuard,
        operatorGate: deps.operatorGate,
      });
    },
  };
}

export function resolveSelfImprovementEnvConfig(
  env: Record<string, string | undefined> = process.env,
): SelfImprovementEnvConfig {
  const raw = (env.DF_SELFIMPROVE_ENABLED ?? "").trim().toLowerCase();
  let enabled: boolean;
  if (raw === "" || raw === "0" || raw === "false") {
    // Fail-closed: unset means OFF. An operator opts IN explicitly.
    enabled = false;
  } else if (raw === "1" || raw === "true") {
    enabled = true;
  } else {
    throw new SelfImprovementConfigError(
      `DF_SELFIMPROVE_ENABLED must be one of 1/true/0/false (received ${JSON.stringify(env.DF_SELFIMPROVE_ENABLED)}).`,
    );
  }

  return {
    enabled,
    objectiveTolerance: readTolerance(
      "DF_SELFIMPROVE_OBJECTIVE_TOLERANCE",
      env.DF_SELFIMPROVE_OBJECTIVE_TOLERANCE,
    ),
    guardrailTolerance: readTolerance(
      "DF_SELFIMPROVE_GUARDRAIL_TOLERANCE",
      env.DF_SELFIMPROVE_GUARDRAIL_TOLERANCE,
    ),
  };
}

/**
 * Parse a non-negative tolerance. Plain digits with an optional decimal part,
 * so "1e3" and "-1" are configuration errors rather than silently coerced
 * numbers — the same fail-closed stance as #133's DF_MAX_ITERATIONS.
 */
function readTolerance(name: string, raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (value === "") return 0;
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new SelfImprovementConfigError(
      `${name} must be a non-negative number in plain digits (received ${JSON.stringify(raw)}).`,
    );
  }
  return Number(value);
}
