/**
 * Dark Factory — wiring hub (R1: #134, #138, #140 · R2: #135, #142).
 *
 * Single place where the seam adapters are chosen from the environment, so the
 * orchestrator never imports a concrete adapter directly. Every factory is
 * fail-closed: an unset driver yields the refusing default rather than a
 * silently non-persistent in-process store — and, for R2, an unset token yields
 * a broker that refuses to issue a lease, and an unset provider yields an
 * honest dry-run that never claims isolation.
 */

import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "./dispatch";
import type { DispatchObserver } from "./dispatch";
import type { MetricsStore } from "./metrics";

export { createMetricsStore } from "./metrics";
export { createStateStore, resolveStateDbPath } from "./state-provider";
export {
  createPlatformAdapter,
  PlatformConfigurationError,
  type DeploymentStage,
  type PlatformAdapter,
  type PlatformContext,
  type PlatformProviderId,
} from "./platform";

// R2 seams re-exported so index.ts stays the single import surface (mirrors the
// createMetricsStore re-export above). Factories live next to their seam so the
// canonical shapes and their env wiring stay in one module.
export { createCredentialBroker } from "./credentials";
export { createWorkerProvider, createWorkerHandler } from "./worker-env";
export {
  createCircuitBreaker,
  createWorkerActivityObserver,
  CircuitBreaker,
  validateWorkerActivity,
  type WorkerActivity,
  type WorkerActivitySink,
  type TripEvent,
  type TripReason,
  type CircuitBreakerConfig,
} from "./circuit-breaker";

// R3 Tester Agent seam (#136)
export {
  createTesterAgent,
  TesterAgent,
  ValidationError,
  ValidationFailedError,
  createValidationReport,
  ALLOWED_ENV_KEYS,
  type ValidationRequest,
  type ValidationReport,
  type PassFail,
  type SecurityAlert,
  type CommandRunner,
  defaultCommandRunner,
} from "./tester-agent";

// R3 Developer Agent seam (#133)
export {
  createDeveloperAgent,
  DeveloperAgent,
  InvalidTaskError,
  toTaskAssignment,
  type TaskAssignment,
  type SkeletonMap,
  type IterationRecord,
  type DeveloperAgentConfig,
  ALLOWED_TOOLS,
  ALLOWED_SKELETON_EXTENSIONS,
  toTaskStatus,
  assertToolAllowed,
  ToolNotAllowedError,
  type LoopContext,
  type WorkerResult,
  type LoopResult,
  type CodingLoopOptions,
  runCodingLoop,
  applySkeletalMap,
  SkeletonMapError,
} from "./developer-agent";

// R4a — measurable recursive self-improvement controller (#146)
export {
  createSelfImprovementController,
  resolveSelfImprovementEnvConfig,
  observeTaskType,
  summarizeRecords,
  proposeFromObservation,
  makeProposal,
  decide,
  measureBenchmark,
  loadImprovementBenchmark,
  BenchmarkMeasurer,
  IterationBoundSurface,
  InMemoryImprovementLedger,
  MAX_BENCHMARK_EFFORT,
  DEFAULT_TARGET_SUCCESS_RATE,
  DEFAULT_ITERATION_STEP,
  SelfImprovementConfigError,
  InvalidProposalError,
  SupersededVersionError,
  type CycleResult,
  type Decision,
  type DecisionConfig,
  type ImprovementBenchmark,
  type ImprovementLedger,
  type LedgerEntry,
  type Measurement,
  type Measurer,
  type Observation,
  type Observer,
  type OperatorGate,
  type Proposal,
  type Proposer,
  type CostGuard,
  type SelfImprovementConfig,
  type SelfImprovementController,
  type SelfImprovementDeps,
  type SelfImprovementEnvConfig,
  type TunableSurface,
  type VersionHandle,
} from "./self-improve";

// R4b — recurrence, trend and operator override (#146)
export {
  isCycleDue,
  nextRunAt,
  objectiveTrend,
  runScheduledCycle,
  DEFAULT_INTERVAL_MINUTES,
  type CadenceInput,
  type CadenceWatermark,
  type ObjectiveTrend,
  type ScheduledRunOptions,
  type ScheduledRunResult,
  type TrendPoint,
} from "./self-improve";

export {
  createOperatorDecisionStore,
  createCadenceWatermark,
  operatorGateFromStore,
  SelfImprovementStateError,
  OPERATOR_DECISIONS_KEY,
  CADENCE_WATERMARK_KEY,
  type OperatorDecision,
  type OperatorDecisionStore,
  type OperatorDecisionValue,
} from "./self-improve-state";

// R5 — worker reporting on the ticket (#162). The reporter is TRUSTED-SIDE: the
// worker emits, Eve posts, and the token never enters a WorkerTask.
export {
  createWorkerReporter,
  toWorkerMessage,
  renderMessage,
  reporterKey,
  ConsoleReporter,
  GitHubCommentReporter,
  InvalidWorkerMessageError,
  MAX_ATTEMPT,
  MAX_QUESTION_CHARS,
  MAX_TEST_EVIDENCE_LINES,
  MAX_TEST_EVIDENCE_CHARS,
  type ReportResult,
  type WorkerMessage,
  type WorkerMessageKind,
  type WorkerReporter,
} from "./worker-reporter";
export {
  GitHubIssueWriter,
  resolveIssueToken,
  type IssueWriterFetch,
  type WriteResult,
} from "./issue-writer";
// The handler-side signal that a run is parked on a human (#162, decision A).
export { ParkedRunError } from "./dispatch";

// R5 — the kick-off trigger and entry point (#163). The trigger is a pure decision
// (testable offline); the entry point records the dispatch and hands off, and never
// runs the loop inside a request.
export {
  decideDarkFactoryTrigger,
  resolveTriggerLabel,
  resolveTriggerAllowedUsers,
  TRIGGER_DEFAULTS,
  TRIGGER_LABELS,
  MAX_BRIEF_BODY_CHARS,
  MAX_BRIEF_TITLE_CHARS,
  MAX_REASON_CHARS,
  type DarkFactoryTriggerDecision,
  type DarkFactoryTriggerKind,
  type DarkFactoryTriggerPayload,
} from "./trigger";
export {
  buildIntent,
  renderHandoffMessage,
  resolveRunnerMode,
  runDarkFactoryDispatch,
  sanitizeIdentifier,
  toRunId,
  type DispatchIntent,
  type EntryDeps,
  type EntryResult,
  type EntryStatus,
  type LabelWriter,
  type RunnerDecision,
  type RunnerMode,
} from "./entry";

// R5 — definition of DONE (#164). Opening a PR is the terminal automated action;
// the loop bounds review fixes and halts at blocked; the factory never merges.
export {
  DEFAULT_MAX_REVIEW_ROUNDS,
  InvalidConfigurationError,
  resolveMaxReviewRounds,
  runDefinitionOfDone,
  renderAcceptedFindingComment,
  type FindingDisposition,
  type FindingDispositionStatus,
  type FindingSource,
  type ReviewFinding,
  type DefinitionOfDoneTask,
  type DefinitionOfDoneDeps,
  type DefinitionOfDoneResult,
  type DoneStatus,
} from "./definition-of-done";
export {
  GitHubPrWriter,
  type CreatePullRequestOptions,
  type CreatePullRequestResult,
  type GitHubPrWriterOptions,
  type PullRequestDetails,
} from "./pr-writer";

/**
 * The skill seams (#157). `SKILLS` is the catalogue of capability grants; the
 * surface is what the self-improvement controller tunes, and its grants reach the
 * developer agent's enforcement points through `resolveCapabilities`.
 */
export {
  SKILLS,
  SKILL_NAMES,
  SkillCatalogueError,
  parseSkillName,
  canonicaliseSkills,
  resolveCapabilities,
  validateCatalogue,
  type Capabilities,
  type SkillDefinition,
  type SkillGrant,
  type SkillName,
} from "./skills";

export {
  createSkillSetSurface,
  proposeSkillAddition,
  type SkillSet,
  type SkillSetSurface,
  type SkillEvidence,
} from "./skill-set-surface";

/**
 * Adapt the dispatch attempt stream into the observability store (#140 AC4).
 *
 * Only TERMINAL events are recorded, because a `TaskMetric` describes a
 * completed task: `iterations` is the attempt count and `fixCycles` the number
 * of fail->retry cycles that preceded the outcome, so a dispatch that succeeded
 * on the second attempt is `{iterations: 2, fixCycles: 1, status: "success"}`.
 */
export function createDispatchObserver(
  recorder: MetricsStore,
): DispatchObserver {
  return async (metric) => {
    if (metric.status !== "succeeded" && metric.status !== "failed") return;
    await recorder.record("dispatch", {
      iterations: metric.attempt,
      fixCycles: Math.max(0, metric.attempt - 1),
      status: metric.status === "succeeded" ? "success" : "failure",
    });
  };
}

/**
 * Read the dispatch retry policy from the environment. A malformed numeric
 * value is a configuration error and throws: silently falling back to the
 * default would hide an operator's intent to change retry behaviour.
 */
export function createRetryPolicy(
  env: Record<string, string | undefined> = process.env,
): RetryPolicy {
  return {
    maxRetries: readInt(
      "DF_DISPATCH_MAX_RETRIES",
      env.DF_DISPATCH_MAX_RETRIES,
      DEFAULT_RETRY_POLICY.maxRetries,
      0,
      MAX_DISPATCH_RETRIES,
    ),
    baseDelayMs: readInt(
      "DF_DISPATCH_BASE_DELAY_MS",
      env.DF_DISPATCH_BASE_DELAY_MS,
      DEFAULT_RETRY_POLICY.baseDelayMs,
      0,
      MAX_DISPATCH_BASE_DELAY_MS,
    ),
    backoffMultiplier: DEFAULT_RETRY_POLICY.backoffMultiplier,
  };
}

/**
 * Documented upper bounds for the dispatch integers (see `.env.example`).
 *
 * Without a maximum, `Number.isInteger(Number.MAX_SAFE_INTEGER)` is accepted for
 * a retry count, so a typo becomes an effectively unbounded loop.
 */
const MAX_DISPATCH_RETRIES = 100;
const MAX_DISPATCH_BASE_DELAY_MS = 3_600_000; // one hour

/**
 * Parse a non-negative integer env var, throwing on garbage (naming the var).
 *
 * Digits only: `Number("1e3")` is 1000 and `Number("0x5")` is 5, and
 * `Number.isInteger` accepts both, so a coercion-based check silently admits
 * scientific notation and hex — the same class of bug fixed for
 * `DF_MAX_ITERATIONS` in #133. The value is therefore tested as a plain run of
 * digits BEFORE any numeric coercion, and bounded at both ends.
 */
function readInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${name} must be an integer in range ${min}..${max} (received ` +
        `${JSON.stringify(raw)}); plain digits only — scientific notation, hex ` +
        "and surrounding whitespace are refused.",
    );
  }
  const parsed = Number(raw);
  if (parsed < min || parsed > max) {
    throw new Error(
      `${name} must be an integer in range ${min}..${max} ` +
        `(received ${JSON.stringify(raw)}).`,
    );
  }
  return parsed;
}
