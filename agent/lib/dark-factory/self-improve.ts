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
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  MAX_METRIC_COST_USD,
  MAX_METRIC_LATENCY_MS,
  meanOfMeasured,
  round2,
  type MetricsStore,
  type TaskMetric,
} from "./metrics";
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

/**
 * A version handle that a newer `stage()` superseded tried to act.
 *
 * Deliberately its own type rather than an `InvalidProposalError`: the remedy
 * differs. A bad proposal must be regenerated; a superseded handle just needs to
 * be re-staged, and a caller may legitimately want to retry rather than fail.
 */
export class SupersededVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupersededVersionError";
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
  /**
   * Guardrail: mean latency over the tasks that MEASURED it (#158). Absent when
   * no sample carried a latency — an unmeasured metric is absent, never 0.
   */
  meanLatencyMs?: number;
  /** Guardrail: mean cost in USD over the tasks that measured it (#158). */
  meanCostUsd?: number;
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
  meanLatencyMs?: number;
  meanCostUsd?: number;
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
  const summary: {
    samples: number;
    successRate: number;
    meanIterations: number;
    meanFixCycles: number;
    meanLatencyMs?: number;
    meanCostUsd?: number;
  } = {
    samples,
    successRate: round2(successes / samples),
    meanIterations: round2(sum((r) => r.iterations) / samples),
    meanFixCycles: round2(sum((r) => r.fixCycles) / samples),
  };
  // Latency and cost are averaged over the samples that MEASURED them (#158): a
  // sample without a value is skipped rather than counted as 0, and if no sample
  // measured the metric the key stays ABSENT. "Not measured" is not "measured
  // zero", and a fabricated zero would drag the mean toward a number nobody saw.
  const latency = meanOfMeasured(records, (r) => r.latencyMs);
  if (latency !== undefined) summary.meanLatencyMs = latency;
  const cost = meanOfMeasured(records, (r) => r.costUsd);
  if (cost !== undefined) summary.meanCostUsd = cost;
  return summary;
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
 *
 * Deliberately IN-PROCESS state — not a distributed-store abstraction. The
 * `TunableSurface` interface is the seam: a surface backed by shared or remote
 * state (a deployed prompt, a config service) is a different IMPLEMENTATION of
 * the same interface and requires no change to the controller. What such an
 * implementation must preserve is the contract proven here: stage never mutates
 * the live value, apply/revert are the only transitions, and a superseded handle
 * refuses to act (optimistic concurrency on the version id).
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
    const handleVersion = this.version;
    let applied = false;
    // A superseded handle must not act: applying or reverting it after a newer
    // version was staged would silently undo that newer change. (This is not a
    // thread-safety guard — JavaScript is single-threaded and nothing here
    // awaits mid-update; it is an optimistic-concurrency check on the version.)
    const assertCurrent = (): void => {
      if (this.version !== handleVersion) {
        throw new SupersededVersionError(
          `Handle '${id}' was superseded by '${this.id}@v${this.version}'; refusing to act on a stale version.`,
        );
      }
    };
    return {
      id,
      surfaceId: this.id,
      previousVersion,
      previous,
      next,
      isApplied: () => applied,
      apply: async () => {
        assertCurrent();
        this.bound = next;
        applied = true;
      },
      // Idempotent on purpose: a retried revert after a failure must not error,
      // and restoring `previous` twice is harmless.
      revert: async () => {
        assertCurrent();
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
  /**
   * AC1: the hypothesis must be explicit and written, never implied. Expected
   * form: one sentence stating the CAUSAL claim — what is being changed, from
   * which value to which, for which task type, and on what observation — so a
   * reader of the ledger can judge the reasoning without the diff. E.g.
   * "Raising iteration-bound from 10 to 12 for task type 'coding' (observed
   * success rate 0.6 over 30 samples) should lift the objective above 0.9."
   * Recorded verbatim in the ledger entry; an empty/whitespace hypothesis is
   * refused by `makeProposal`.
   */
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

/** Default success rate at or above which nothing is worth changing. */
export const DEFAULT_TARGET_SUCCESS_RATE = 0.9;
/** Default amount by which a proposal raises the iteration bound. */
export const DEFAULT_ITERATION_STEP = 2;

export function proposeFromObservation(
  observation: Observation,
  surface: TunableSurface<number>,
  options?: ProposeOptions,
): Proposal | null {
  const targetSuccessRate =
    options?.targetSuccessRate ?? DEFAULT_TARGET_SUCCESS_RATE;
  const step = options?.step ?? DEFAULT_ITERATION_STEP;
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
  /** Optional measured latency for this case (#158): absent = not measured. */
  latencyMs?: number;
  /** Optional measured cost for this case (#158): absent = not measured. */
  costUsd?: number;
}

export interface ImprovementBenchmark {
  version: string;
  gate: QualityGate;
  cases: BenchmarkCase[];
}

export function loadImprovementBenchmark(
  path?: string,
  sandboxRoot?: string,
): ImprovementBenchmark {
  const file =
    path ??
    join(process.cwd(), "tests", "fixtures", "self-improve-benchmark.json");

  // Optional sandbox: mirrors `resolveStateDbPath` in index.ts. The default
  // trusts the caller (this is code-supplied configuration, not request input),
  // but a deployment that makes the benchmark path settable can bound where it
  // may be read. Containment is decided by `path.relative`, never a
  // `startsWith(root + sep)` compare — see the note on `resolveStateDbPath`.
  const root = (sandboxRoot ?? "").trim();
  if (root !== "") {
    const resolvedRoot = resolve(root);
    const resolvedFile = resolve(file);
    const rel = relative(resolvedRoot, resolvedFile);
    const inside =
      rel === "" ||
      (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
    if (!inside) {
      throw new SelfImprovementConfigError(
        `Improvement benchmark '${resolvedFile}' resolves outside the configured sandbox root '${resolvedRoot}'; refusing to read it.`,
      );
    }
  }

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
  assertValidQualityGate(benchmark.gate, file);
  // Validate each case's CONTENTS too, not just that it is an array: a
  // malformed entry would otherwise reach the grader and die as a bare
  // `TypeError` that names no fixture entry.
  benchmark.cases.forEach((testCase, index) =>
    assertValidBenchmarkCase(testCase, index),
  );
  // Unique ids: a duplicate would make a measurement (and any error message)
  // ambiguous about which case it refers to.
  const seenIds = new Set<string>();
  for (const testCase of benchmark.cases) {
    if (seenIds.has(testCase.id)) {
      throw new SelfImprovementConfigError(
        `Improvement benchmark '${file}' has duplicate case id '${testCase.id}'; ids must be unique.`,
      );
    }
    seenIds.add(testCase.id);
  }
  return {
    version: benchmark.version,
    gate: benchmark.gate,
    cases: benchmark.cases,
  };
}

/**
 * Upper bound for a benchmark case's effort counts. A case needing more than a
 * million iterations is nonsense, and the bound keeps the aggregate sums
 * (cases x this) far below `Number.MAX_SAFE_INTEGER`.
 */
export const MAX_BENCHMARK_EFFORT = 1_000_000;

/**
 * Validate the quality gate's SHAPE, not just its presence.
 *
 * An asserted-but-unchecked gate changes grading semantics silently rather than
 * failing: `requiredSections: "intent"` would be iterated character by
 * character, and `minChars: "200"` would compare as a coerced number. Refuse
 * the shape at load time instead.
 */
function assertValidQualityGate(gate: unknown, file: string): void {
  if (!gate || typeof gate !== "object") {
    throw new SelfImprovementConfigError(
      `Improvement benchmark '${file}' requires "gate" to be an object.`,
    );
  }
  const candidate = gate as Partial<QualityGate>;
  if (
    !Number.isInteger(candidate.minChars) ||
    (candidate.minChars as number) < 0
  ) {
    throw new SelfImprovementConfigError(
      `Improvement benchmark '${file}' requires "gate.minChars" to be an integer >= 0 (received ${JSON.stringify(candidate.minChars)}).`,
    );
  }
  for (const field of ["requiredSections", "refusalMarkers"] as const) {
    const value = candidate[field];
    const wellFormed =
      Array.isArray(value) &&
      value.every(
        (marker) => typeof marker === "string" && marker.trim() !== "",
      );
    if (!wellFormed) {
      throw new SelfImprovementConfigError(
        `Improvement benchmark '${file}' requires "gate.${field}" to be an array of non-empty strings.`,
      );
    }
  }
}

/**
 * Validate one benchmark case.
 *
 * Requirements for a valid case:
 * - `id` — non-empty string, UNIQUE within the fixture (so a measurement maps
 *   to exactly one case).
 * - `taskType` — non-empty string.
 * - `output` — string (the text the quality gate grades).
 * - `iterations` / `fixCycles` — integers in `0..MAX_BENCHMARK_EFFORT`.
 *
 * Fails as a CONFIGURATION error naming the offending case, so a malformed
 * fixture is diagnosable — rather than surviving to `gradeStoryQuality` where a
 * non-string `output` throws `TypeError: text.trim is not a function`, which
 * says nothing about which entry is broken.
 */
function assertValidBenchmarkCase(testCase: unknown, index: number): void {
  const label = (candidate: unknown): string => {
    const id = (candidate as { id?: unknown } | null)?.id;
    return typeof id === "string" && id.trim()
      ? `'${id}'`
      : `at index ${index}`;
  };
  if (!testCase || typeof testCase !== "object") {
    throw new SelfImprovementConfigError(
      `Improvement benchmark case ${label(testCase)} must be an object.`,
    );
  }
  const candidate = testCase as Partial<BenchmarkCase>;
  const where = label(testCase);
  if (typeof candidate.id !== "string" || !candidate.id.trim()) {
    throw new SelfImprovementConfigError(
      `Improvement benchmark case ${where} requires a non-empty "id".`,
    );
  }
  if (typeof candidate.taskType !== "string" || !candidate.taskType.trim()) {
    throw new SelfImprovementConfigError(
      `Improvement benchmark case ${where} requires a non-empty "taskType".`,
    );
  }
  if (typeof candidate.output !== "string") {
    throw new SelfImprovementConfigError(
      `Improvement benchmark case ${where} requires "output" to be a string (received ${JSON.stringify(candidate.output)}).`,
    );
  }
  for (const field of ["iterations", "fixCycles"] as const) {
    const value = candidate[field];
    if (!Number.isInteger(value) || (value as number) < 0) {
      throw new SelfImprovementConfigError(
        `Improvement benchmark case ${where} requires "${field}" to be an integer >= 0 (received ${JSON.stringify(value)}).`,
      );
    }
    if ((value as number) > MAX_BENCHMARK_EFFORT) {
      throw new SelfImprovementConfigError(
        `Improvement benchmark case ${where} requires "${field}" to be <= ${MAX_BENCHMARK_EFFORT} (received ${JSON.stringify(value)}).`,
      );
    }
  }
  // Latency and cost are optional (#158) and bounded like every other number this
  // module accepts: a nonsense value must be refused at the boundary rather than
  // averaged into a guardrail that DECIDE then trusts.
  for (const [field, max] of [
    ["latencyMs", MAX_METRIC_LATENCY_MS],
    ["costUsd", MAX_METRIC_COST_USD],
  ] as const) {
    const value = candidate[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
      throw new SelfImprovementConfigError(
        `Improvement benchmark case ${where} requires "${field}" to be a finite number in [0, ${max}] ` +
          `when present (received ${JSON.stringify(value)}).`,
      );
    }
  }
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
  // Re-validate here as well as at load: a benchmark assembled in code (or by a
  // future non-JSON loader) never passed through `loadImprovementBenchmark`.
  cases.forEach((testCase, index) => assertValidBenchmarkCase(testCase, index));
  // Objective: the fraction of the FIXED case set that still passes the #121
  // quality gate. A change that degrades output quality cannot raise this.
  const passed = cases.filter(
    (testCase) => gradeStoryQuality(testCase.output, gate).passed,
  ).length;
  const mean = (pick: (testCase: BenchmarkCase) => number): number =>
    round2(cases.reduce((total, c) => total + pick(c), 0) / cases.length);
  const guardrails: Record<string, number> = {
    meanIterations: mean((c) => c.iterations),
    meanFixCycles: mean((c) => c.fixCycles),
  };
  // Latency and cost join the guardrails ONLY when the benchmark measured them
  // (#158), for the same reason the store omits an unmeasured mean: a 0 here
  // would be a number nobody observed, and DECIDE compares guardrails directly.
  // Making them present is what lets the existing tolerance logic reject a change
  // that "improves" the objective by spending more.
  const latency = meanOfMeasured(cases, (c) => c.latencyMs);
  if (latency !== undefined) guardrails.meanLatencyMs = latency;
  const cost = meanOfMeasured(cases, (c) => c.costUsd);
  if (cost !== undefined) guardrails.meanCostUsd = cost;
  return {
    fixtureVersion: version,
    objective: round2(passed / cases.length),
    guardrails,
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
  /**
   * Required objective gain, as an absolute difference (not a ratio).
   * Range: >= 0. Default 0, which means any strict improvement is enough while
   * an unchanged objective is still rejected. Values parsed from the
   * environment must be plain digits with an optional decimal part — "1e3" and
   * "-1" are rejected at the boundary (`resolveSelfImprovementEnvConfig`).
   */
  objectiveTolerance?: number;
  /**
   * Allowed guardrail regression, as an absolute difference per guardrail key.
   * Range: >= 0. Default 0, which means no guardrail may get worse at all.
   * Same env-boundary validation as `objectiveTolerance`.
   */
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

  // Config errors fail fast, before the cost guard is consulted and before
  // anything is staged: a bad tolerance must never influence a decision. The
  // environment path already enforces this (`readTolerance` rejects "-1"/"1e3"),
  // but a caller can pass tolerances programmatically.
  assertValidTolerance("objectiveTolerance", config.objectiveTolerance);
  assertValidTolerance("guardrailTolerance", config.guardrailTolerance);

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

// --- R4b (#146): recurrence, trend and the operator override -------------

/** Minutes between cycles when none is configured (once a day). */
export const DEFAULT_INTERVAL_MINUTES = 1440;

export interface CadenceInput {
  /** ISO timestamp of the last completed cycle, or null if none has run. */
  lastRunAt: string | null;
  now: Date | string;
  intervalMinutes: number;
}

/**
 * Is a cycle due? Pure, so the caller's scheduler decides — deliberately NOT a
 * `setInterval`: the factory runs out-of-band precisely because a serverless
 * function cannot host a long-lived loop, so an in-process timer would pass
 * locally and silently never fire in production.
 */
export function isCycleDue(input: CadenceInput): boolean {
  assertValidInterval(input.intervalMinutes);
  const now = toInstant(input.now, "now");
  // No watermark means no cycle has run: the first one is always due.
  if (input.lastRunAt === null) return true;
  const last = toInstant(input.lastRunAt, "lastRunAt");
  // `>=` on purpose: the boundary instant IS due, which is what the test
  // asserting nextRunAt() satisfies isCycleDue() pins down.
  return now.getTime() >= last.getTime() + input.intervalMinutes * 60_000;
}

/** The instant a cycle becomes due again, given the last run. */
export function nextRunAt(lastRunAt: string, intervalMinutes: number): string {
  assertValidInterval(intervalMinutes);
  const last = toInstant(lastRunAt, "lastRunAt");
  return new Date(last.getTime() + intervalMinutes * 60_000).toISOString();
}

function assertValidInterval(intervalMinutes: number): void {
  if (
    typeof intervalMinutes !== "number" ||
    !Number.isFinite(intervalMinutes) ||
    intervalMinutes <= 0
  ) {
    throw new SelfImprovementConfigError(
      `intervalMinutes must be a finite number > 0 (received ${JSON.stringify(intervalMinutes)}).`,
    );
  }
}

/**
 * Parse an instant, refusing to guess. A corrupt watermark must be loud: silently
 * treating it as "never ran" would run a cycle on every invocation (burning the
 * cost budget), and silently treating it as "just ran" would stop the loop
 * forever. Neither failure is visible, so throw instead.
 */
function toInstant(value: Date | string, label: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new SelfImprovementConfigError(
      `${label} is not a valid timestamp (received ${JSON.stringify(value)}); refusing to guess the cadence.`,
    );
  }
  return date;
}

/** One cycle's measured objective, as recorded in the ledger. */
export interface TrendPoint {
  cycleId: string;
  at: string;
  objective: number;
  verdict: "accept" | "reject";
}

/** AC6: the objective over time — evidence of cumulative, not single-step, change. */
export interface ObjectiveTrend {
  series: string;
  points: TrendPoint[];
  first: number | null;
  last: number | null;
  delta: number | null;
  accepted: number;
  rejected: number;
  improving: boolean;
}

export function objectiveTrend(
  entries: LedgerEntry[],
  options?: { surfaceId?: string },
): ObjectiveTrend {
  const surfaceId = options?.surfaceId;
  // The objective AFTER each cycle is the measured state at that point in time,
  // so the series is directly comparable cycle to cycle.
  const points: TrendPoint[] = entries
    .filter((entry) => (surfaceId ? entry.surfaceId === surfaceId : true))
    .map((entry) => ({
      cycleId: entry.cycleId,
      at: entry.at,
      objective: entry.objective.after,
      verdict: entry.verdict,
    }));

  const first = points.length > 0 ? points[0].objective : null;
  const last = points.length > 0 ? points[points.length - 1].objective : null;
  const delta = first === null || last === null ? null : round2(last - first);

  return {
    series: surfaceId ?? "all",
    points,
    first,
    last,
    delta,
    accepted: points.filter((point) => point.verdict === "accept").length,
    rejected: points.filter((point) => point.verdict === "reject").length,
    // Cumulative, not single-step: the LAST measurement must beat the FIRST.
    improving: delta !== null && delta > 0,
  };
}

/** Persistence seam for the cadence watermark. */
export interface CadenceWatermark {
  read(): Promise<string | null>;
  write(at: string): Promise<void>;
}

export interface ScheduledRunOptions {
  controller: SelfImprovementController;
  watermark: CadenceWatermark;
  intervalMinutes: number;
  now?: () => Date;
}

export type ScheduledRunResult =
  | { status: "skipped"; reason: "not due" | "disabled" }
  | { status: "ran"; result: CycleResult };

/**
 * Run one cycle IF the cadence says it is due. The watermark only advances once
 * a cycle actually ran (even one that was rejected or NO-OPed), so a scheduler
 * firing early cannot busy-loop the factory.
 */
export async function runScheduledCycle(
  options: ScheduledRunOptions,
): Promise<ScheduledRunResult> {
  assertValidInterval(options.intervalMinutes);

  // Disabled is checked first so an inert controller never even reads state.
  if (!options.controller.enabled) {
    return { status: "skipped", reason: "disabled" };
  }

  const now = options.now ? options.now() : new Date();
  const lastRunAt = await options.watermark.read();
  if (
    !isCycleDue({ lastRunAt, now, intervalMinutes: options.intervalMinutes })
  ) {
    return { status: "skipped", reason: "not due" };
  }

  const result = await options.controller.run(`cycle-${now.toISOString()}`);
  // Advance only AFTER the cycle completed, and for ANY outcome: a rejected or
  // NO-OPed cycle still consumed its slot, so a scheduler firing early cannot
  // busy-loop the factory.
  await options.watermark.write(now.toISOString());
  return { status: "ran", result };
}

export interface SelfImprovementEnvConfig {
  enabled: boolean;
  objectiveTolerance: number;
  guardrailTolerance: number;
  /** Minimum minutes between cycles (cadence policy). */
  intervalMinutes: number;
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
    intervalMinutes: readPositiveInt(
      "DF_SELFIMPROVE_INTERVAL_MINUTES",
      env.DF_SELFIMPROVE_INTERVAL_MINUTES,
      DEFAULT_INTERVAL_MINUTES,
    ),
  };
}

/** Parse a positive integer env var in plain digits, or fall back when unset. */
function readPositiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  const value = (raw ?? "").trim();
  if (value === "") return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new SelfImprovementConfigError(
      `${name} must be a positive integer in plain digits (received ${JSON.stringify(raw)}).`,
    );
  }
  return Number(value);
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

/**
 * Validate a decision tolerance supplied PROGRAMMATICALLY. A negative tolerance
 * would silently change what "the objective improved" means, so refuse it at the
 * boundary rather than deciding with it.
 */
function assertValidTolerance(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new SelfImprovementConfigError(
      `${name} must be a finite number >= 0 (received ${JSON.stringify(value)}).`,
    );
  }
}
