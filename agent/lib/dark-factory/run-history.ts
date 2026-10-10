import { MAX_METRIC_COST_USD, MAX_METRIC_LATENCY_MS } from "./metrics";
import type { CostGovernorRefusal } from "./cost-governor";

export function normalizeRunDateRange(
  from: string | undefined,
  to: string | undefined,
): { from?: string; to?: string } {
  const normalize = (value: string | undefined, field: string) => {
    if (value === undefined) return undefined;
    const parsed = typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isFinite(parsed)) {
      throw new InvalidRunRecordError(
        `Run history filter "${field}" must be an ISO timestamp.`,
      );
    }
    return new Date(parsed).toISOString();
  };
  const normalizedFrom = normalize(from, "from");
  const normalizedTo = normalize(to, "to");
  if (
    normalizedFrom !== undefined &&
    normalizedTo !== undefined &&
    Date.parse(normalizedFrom) >= Date.parse(normalizedTo)
  ) {
    throw new InvalidRunRecordError(
      'Run history filter "from" must be before "to".',
    );
  }
  return {
    ...(normalizedFrom !== undefined ? { from: normalizedFrom } : {}),
    ...(normalizedTo !== undefined ? { to: normalizedTo } : {}),
  };
}

export type RunStatus =
  "queued" | "running" | "blocked" | "aborted" | "succeeded" | "failed";

export type RunStage =
  "trigger" | "dispatch" | "worker" | "review" | "pull-request" | "terminal";

export type RunEventType =
  | "run.accepted"
  | "run.resumed"
  | "dispatch.started"
  | "dispatch.attempt"
  | "worker.progress"
  | "worker.question"
  | "worker.completed"
  | "review.round"
  | "pr.opened"
  | "run.terminal";

/** One current, provider-neutral projection for a single execution. */
export interface RunSummary {
  runId: string;
  repo: string;
  issue: number;
  status: RunStatus;
  stage: RunStage;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  /** Absent while queued, running, or blocked awaiting a human. */
  completedAt?: string;
  attemptCount: number;
  reviewCount: number;
  iterationCount: number;
  fixCycleCount: number;
  /** Absent unless actually measured; explicit zero remains a measurement. */
  latencyMs?: number;
  costUsd?: number;
  prUrl?: string;
  /** Sanitized unified git diff produced by the developer-agent. Absent until captured. */
  gitDiff?: string;
  /**
   * Customer tenant this run is attributed to. Absent means UNASSIGNED — a
   * legitimate state for historical runs recorded before attribution existed.
   * Resolved ONCE at acceptance and never re-derived from the repository
   * mapping, so reassigning a repository cannot rewrite history.
   */
  tenantId?: string;
}

/** Immutable, compact event record; no raw prompts or free-form issue content. */
export interface RunEvent {
  /** Stable caller-generated idempotency identity for this lifecycle transition. */
  eventId: string;
  runId: string;
  type: RunEventType;
  stage: RunStage;
  occurredAt: string;
  status?: RunStatus;
  attempt?: number;
  reviewRound?: number;
  iterationCount?: number;
  fixCycleCount?: number;
  /** Aggregate review findings only; no raw finding text is stored. */
  findingCount?: number;
  resolvedCount?: number;
  acceptedCount?: number;
  /** Structured per-test pass/fail detail from the tester-agent (developer loop). No raw output text. */
  testResults?: TestOutcome[];
  latencyMs?: number;
  costUsd?: number;
  prUrl?: string;
  /**
   * Reference to the external comment (e.g. a GitHub issue comment) that is
   * the system of record for this event's question/blocker. Carried only on
   * `worker.question` events; the ledger stores the reference, never the text.
   */
  commentReference?: CommentReference;
  /**
   * The machine-readable reason a cost-governed LLM call was refused (#270):
   * one of the CostGovernorRefusal codes, or absent. Never free text.
   */
  costRefusal?: CostGovernorRefusal;
}

/** One captured test result from the tester-agent; structured so no raw output is stored. */
export interface TestOutcome {
  testFile: string;
  testCaseName: string;
  passed: boolean;
}

export class InvalidRunRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRunRecordError";
  }
}

export interface RunMetricsQuery {
  repo?: string;
  /** Inclusive lower bound for createdAt. */
  from?: string;
  /** Exclusive upper bound for createdAt. */
  to?: string;
}

export interface RunStatusCount {
  status: RunStatus;
  count: number;
}

export interface RunTrendPoint {
  /** UTC calendar date, YYYY-MM-DD. */
  date: string;
  outcome: RunStatus;
  count: number;
}

export interface RunMeasuredSummary {
  sum: number;
  count: number;
}

export interface RunMetrics {
  /** One entry per canonical status, including aborted; count may be 0. */
  statusCounts: RunStatusCount[];
  /** Terminal outcomes grouped by completedAt calendar day (UTC). */
  trend: RunTrendPoint[];
  /** Measured aggregates; a field is absent when no run reported it. */
  measured: {
    latencyMs?: RunMeasuredSummary;
    costUsd?: RunMeasuredSummary;
  };
}

export const ALL_RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "blocked",
  "aborted",
  "succeeded",
  "failed",
];
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "aborted",
  "succeeded",
  "failed",
];

const RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "blocked",
  "aborted",
  "succeeded",
  "failed",
];
const RUN_STAGES: readonly RunStage[] = [
  "trigger",
  "dispatch",
  "worker",
  "review",
  "pull-request",
  "terminal",
];
const RUN_EVENT_TYPES: readonly RunEventType[] = [
  "run.accepted",
  "run.resumed",
  "dispatch.started",
  "dispatch.attempt",
  "worker.progress",
  "worker.question",
  "worker.completed",
  "review.round",
  "pr.opened",
  "run.terminal",
];
const TERMINAL_STATUSES: readonly RunStatus[] = [
  "aborted",
  "succeeded",
  "failed",
];
const REPO_PAIR = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_RUN_COUNTER = Number.MAX_SAFE_INTEGER;
/** Hard cap on the stored git diff so a huge patch cannot bloat the ledger. */
const MAX_GIT_DIFF_CHARS = 65536;
/**
 * Detects `DF_*=value` / `DF_*: value` assignments that should have been
 * redacted by the capture layer before storage. Defense-in-depth guard so
 * unsanitized secrets can never reach the run history.
 */
const RAW_SECRET_RE = /DF_[A-Z0-9_]+\s*[=:]\s*["']?[A-Za-z0-9/+._-]{6,}/;

function invalid(field: string, value: unknown, expected: string): never {
  throw new InvalidRunRecordError(
    `Run record requires "${field}" ${expected} (received ${JSON.stringify(value)}).`,
  );
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.trim().length > MAX_IDENTIFIER_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return invalid(
      field,
      value,
      `to be a non-empty string of at most ${MAX_IDENTIFIER_LENGTH} characters`,
    );
  }
  return value.trim();
}

function repoPair(value: unknown): string {
  if (typeof value !== "string" || !REPO_PAIR.test(value.trim())) {
    return invalid("repo", value, "to be an owner/repo pair");
  }
  return value.trim().toLowerCase();
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return invalid(field, value, "to be a positive safe integer");
  }
  return value as number;
}

function count(value: unknown, field: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_RUN_COUNTER
  ) {
    return invalid(
      field,
      value,
      `to be a safe integer in [0, ${MAX_RUN_COUNTER}]`,
    );
  }
  return value as number;
}

function enumValue<T extends string>(
  value: unknown,
  field: string,
  choices: readonly T[],
): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    return invalid(field, value, `to be one of ${choices.join(", ")}`);
  }
  return value as T;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    return invalid(field, value, "to be a valid ISO timestamp");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return invalid(field, value, "to be a valid ISO timestamp");
  }
  return new Date(parsed).toISOString();
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : timestamp(value, field);
}

function optionalCount(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : count(value, field);
}

function optionalPositiveInteger(
  value: unknown,
  field: string,
): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, field);
}

function optionalMeasurement(
  value: unknown,
  field: "latencyMs" | "costUsd",
): number | undefined {
  if (value === undefined) return undefined;
  const max =
    field === "latencyMs" ? MAX_METRIC_LATENCY_MS : MAX_METRIC_COST_USD;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max
  ) {
    return invalid(
      field,
      value,
      `to be a finite measured value in [0, ${max}]`,
    );
  }
  return value;
}

type CommentReference = { provider: "github"; id: number; url: string };

function httpUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    return invalid(field, value, "to be an HTTP(S) URL without credentials");
  }
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return invalid(field, value, "to be an HTTP(S) URL without credentials");
    }
    return parsed.toString();
  } catch {
    return invalid(field, value, "to be an HTTP(S) URL without credentials");
  }
}

function optionalPrUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return httpUrl(value, "prUrl");
}

function optionalGitDiff(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return invalid("gitDiff", value, "to be a string when present");
  }
  if (value.length > MAX_GIT_DIFF_CHARS) {
    return invalid(
      "gitDiff",
      value.length,
      `to be at most ${MAX_GIT_DIFF_CHARS} characters`,
    );
  }
  if (RAW_SECRET_RE.test(value)) {
    return invalid(
      "gitDiff",
      "<redacted>",
      "to contain no unsanitized DF_* secret assignments",
    );
  }
  return value;
}

function commentReference(value: unknown): CommentReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(
      "commentReference",
      value,
      "to be a github comment reference",
    );
  }
  const obj = value as { provider?: unknown; id?: unknown; url?: unknown };
  if (obj.provider !== "github") {
    return invalid("commentReference.provider", obj.provider, 'to be "github"');
  }
  const id = positiveInteger(obj.id, "commentReference.id");
  const url = httpUrl(obj.url, "commentReference.url");
  return { provider: "github", id, url };
}

function optionalCommentReference(
  value: unknown,
): CommentReference | undefined {
  return value === undefined ? undefined : commentReference(value);
}

/** The canonical cost-refusal codes (#270); kept in sync with CostGovernorRefusal. */
const COST_REFUSALS: readonly CostGovernorRefusal[] = [
  "not_configured",
  "unpriced_model",
  "budget_exceeded",
  "budget_unavailable",
  "tenant_unconfigured",
];

function optionalCostRefusal(value: unknown): CostGovernorRefusal | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !COST_REFUSALS.includes(value as CostGovernorRefusal)
  ) {
    return invalid(
      "costRefusal",
      value,
      `to be one of ${COST_REFUSALS.join(", ")}`,
    );
  }
  return value as CostGovernorRefusal;
}

function optionalTestResults(value: unknown): TestOutcome[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    return invalid("testResults", value, "to be an array of test outcomes");
  }
  const results: TestOutcome[] = [];
  for (const item of value) {
    if (
      item === null ||
      typeof item !== "object" ||
      typeof (item as { testFile?: unknown }).testFile !== "string" ||
      typeof (item as { testCaseName?: unknown }).testCaseName !== "string" ||
      typeof (item as { passed?: unknown }).passed !== "boolean"
    ) {
      return invalid("testResults", item, "to be a valid test outcome");
    }
    results.push({
      testFile: (item as { testFile: string }).testFile,
      testCaseName: (item as { testCaseName: string }).testCaseName,
      passed: (item as { passed: boolean }).passed,
    });
  }
  return results;
}

function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function optionalIdentifier(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  return identifier(value, field);
}

/** Validate and copy only canonical summary fields; unknown fields are discarded. */
export function toRunSummary(input: Partial<RunSummary>): RunSummary {
  const runId = identifier(input.runId, "runId");
  const repo = repoPair(input.repo);
  const issue = positiveInteger(input.issue, "issue");
  const status = enumValue(input.status, "status", RUN_STATUSES);
  const stage = enumValue(input.stage, "stage", RUN_STAGES);
  const createdAt = timestamp(input.createdAt, "createdAt");
  const updatedAt = timestamp(input.updatedAt, "updatedAt");
  const startedAt = optionalTimestamp(input.startedAt, "startedAt");
  const completedAt = optionalTimestamp(input.completedAt, "completedAt");
  const attemptCount = count(input.attemptCount, "attemptCount");
  const reviewCount = count(input.reviewCount, "reviewCount");
  const iterationCount = count(input.iterationCount, "iterationCount");
  const fixCycleCount = count(input.fixCycleCount, "fixCycleCount");
  const latencyMs = optionalMeasurement(input.latencyMs, "latencyMs");
  const costUsd = optionalMeasurement(input.costUsd, "costUsd");
  const prUrl = optionalPrUrl(input.prUrl);
  const gitDiff = optionalGitDiff(input.gitDiff);
  const tenantId = optionalIdentifier(input.tenantId, "tenantId");

  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    return invalid("updatedAt", updatedAt, "to be at or after createdAt");
  }
  if (startedAt && Date.parse(startedAt) < Date.parse(createdAt)) {
    return invalid("startedAt", startedAt, "to be at or after createdAt");
  }
  if (isTerminal(status) !== (completedAt !== undefined)) {
    return invalid(
      "completedAt",
      completedAt,
      isTerminal(status)
        ? "to be present for a terminal status"
        : "to be absent until a terminal status",
    );
  }
  if (completedAt && Date.parse(completedAt) > Date.parse(updatedAt)) {
    return invalid("completedAt", completedAt, "to be at or before updatedAt");
  }

  return {
    runId,
    repo,
    issue,
    status,
    stage,
    createdAt,
    updatedAt,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(tenantId !== undefined ? { tenantId } : {}),
    attemptCount,
    reviewCount,
    iterationCount,
    fixCycleCount,
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(prUrl !== undefined ? { prUrl } : {}),
    ...(gitDiff !== undefined ? { gitDiff } : {}),
  };
}

/** Validate and copy one immutable lifecycle event. */
export function toRunEvent(input: Partial<RunEvent>): RunEvent {
  const eventId = identifier(input.eventId, "eventId");
  const runId = identifier(input.runId, "runId");
  const type = enumValue(input.type, "type", RUN_EVENT_TYPES);
  const stage = enumValue(input.stage, "stage", RUN_STAGES);
  const occurredAt = timestamp(input.occurredAt, "occurredAt");
  const status =
    input.status === undefined
      ? undefined
      : enumValue(input.status, "status", RUN_STATUSES);
  const attempt = optionalPositiveInteger(input.attempt, "attempt");
  const reviewRound = optionalPositiveInteger(input.reviewRound, "reviewRound");
  const iterationCount = optionalCount(input.iterationCount, "iterationCount");
  const fixCycleCount = optionalCount(input.fixCycleCount, "fixCycleCount");
  const findingCount = optionalCount(input.findingCount, "findingCount");
  const resolvedCount = optionalCount(input.resolvedCount, "resolvedCount");
  const acceptedCount = optionalCount(input.acceptedCount, "acceptedCount");
  const latencyMs = optionalMeasurement(input.latencyMs, "latencyMs");
  const costUsd = optionalMeasurement(input.costUsd, "costUsd");
  const prUrl = optionalPrUrl(input.prUrl);
  const commentReference = optionalCommentReference(input.commentReference);
  const costRefusal = optionalCostRefusal(input.costRefusal);
  const testResults = optionalTestResults(input.testResults);

  if (type === "run.accepted" && status !== "queued") {
    return invalid("status", status, 'to be "queued" for run.accepted');
  }
  if (type === "worker.question" && status !== "blocked") {
    return invalid("status", status, 'to be "blocked" for worker.question');
  }
  if (type === "run.resumed" && status !== "running") {
    return invalid("status", status, 'to be "running" for run.resumed');
  }
  if (type === "dispatch.attempt" && attempt === undefined) {
    return invalid("attempt", attempt, "to be present for dispatch.attempt");
  }
  if (type === "review.round" && reviewRound === undefined) {
    return invalid(
      "reviewRound",
      reviewRound,
      "to be present for review.round",
    );
  }
  const hasFindingMetrics =
    findingCount !== undefined ||
    resolvedCount !== undefined ||
    acceptedCount !== undefined;
  if (hasFindingMetrics && type !== "review.round") {
    return invalid(
      "findingCount",
      findingCount,
      "to be used only on review.round events",
    );
  }
  if (testResults !== undefined && type !== "review.round") {
    return invalid(
      "testResults",
      testResults,
      "to be used only on review.round events",
    );
  }
  if (
    findingCount === undefined &&
    (resolvedCount !== undefined || acceptedCount !== undefined)
  ) {
    return invalid(
      "findingCount",
      findingCount,
      "to be present when disposition counts are supplied",
    );
  }
  if (findingCount !== undefined && (acceptedCount ?? 0) > findingCount) {
    return invalid(
      "findingCount",
      findingCount,
      "to be at least acceptedCount",
    );
  }
  if (type === "pr.opened" && prUrl === undefined) {
    return invalid("prUrl", prUrl, "to be present for pr.opened");
  }
  if (
    type === "run.terminal" &&
    (status === undefined || !isTerminal(status))
  ) {
    return invalid("status", status, "to be terminal for run.terminal");
  }

  return {
    eventId,
    runId,
    type,
    stage,
    occurredAt,
    ...(status !== undefined ? { status } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(reviewRound !== undefined ? { reviewRound } : {}),
    ...(iterationCount !== undefined ? { iterationCount } : {}),
    ...(fixCycleCount !== undefined ? { fixCycleCount } : {}),
    ...(findingCount !== undefined ? { findingCount } : {}),
    ...(resolvedCount !== undefined ? { resolvedCount } : {}),
    ...(acceptedCount !== undefined ? { acceptedCount } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(prUrl !== undefined ? { prUrl } : {}),
    ...(commentReference !== undefined ? { commentReference } : {}),
    ...(costRefusal !== undefined ? { costRefusal } : {}),
    ...(testResults !== undefined ? { testResults } : {}),
  };
}

function defaultStatusForEvent(event: RunEvent, current: RunStatus): RunStatus {
  if (event.status) return event.status;
  if (
    event.type === "dispatch.started" ||
    event.type === "dispatch.attempt" ||
    event.type === "run.resumed" ||
    event.type === "worker.progress" ||
    event.type === "worker.completed" ||
    event.type === "review.round" ||
    event.type === "pr.opened"
  ) {
    return "running";
  }
  if (event.type === "worker.question") return "blocked";
  return current;
}

/** Apply one newly accepted event to the current summary projection. */
export function applyRunEvent(
  currentInput: RunSummary,
  eventInput: RunEvent,
): RunSummary {
  const current = toRunSummary(currentInput);
  const event = toRunEvent(eventInput);
  if (current.runId !== event.runId) {
    return invalid(
      "runId",
      event.runId,
      `to match summary runId '${current.runId}'`,
    );
  }
  if (isTerminal(current.status)) {
    return invalid("runId", current.runId, "to reference a non-terminal run");
  }
  if (event.type === "run.accepted") {
    return invalid(
      "type",
      event.type,
      "to be applied only when the run is created",
    );
  }
  if (
    current.status === "blocked" &&
    event.type !== "run.resumed" &&
    event.type !== "run.terminal"
  ) {
    return invalid(
      "type",
      event.type,
      "to resume a blocked run before further work events",
    );
  }
  if (event.type === "run.resumed" && current.status !== "blocked") {
    return invalid(
      "status",
      current.status,
      'to be "blocked" before run.resumed',
    );
  }

  const status = defaultStatusForEvent(event, current.status);
  if (isTerminal(status) && event.type !== "run.terminal") {
    return invalid(
      "type",
      event.type,
      "to be run.terminal for a terminal status",
    );
  }
  if (event.type === "run.terminal" && event.stage !== "terminal") {
    return invalid("stage", event.stage, 'to be "terminal" for run.terminal');
  }

  const updatedAt =
    Date.parse(event.occurredAt) >= Date.parse(current.updatedAt)
      ? event.occurredAt
      : current.updatedAt;
  const startedAt =
    current.startedAt ??
    (["dispatch.started", "run.resumed"].includes(event.type)
      ? event.occurredAt
      : undefined);
  const completedAt = isTerminal(status) ? event.occurredAt : undefined;

  return toRunSummary({
    ...current,
    status,
    stage: event.stage,
    updatedAt,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    attemptCount: Math.max(current.attemptCount, event.attempt ?? 0),
    reviewCount: Math.max(current.reviewCount, event.reviewRound ?? 0),
    iterationCount: Math.max(current.iterationCount, event.iterationCount ?? 0),
    fixCycleCount: Math.max(current.fixCycleCount, event.fixCycleCount ?? 0),
    ...(event.latencyMs !== undefined ? { latencyMs: event.latencyMs } : {}),
    ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
    ...(event.prUrl !== undefined ? { prUrl: event.prUrl } : {}),
  });
}
