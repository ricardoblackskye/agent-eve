import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  ALL_RUN_STATUSES,
  applyRunEvent,
  InvalidRunRecordError,
  normalizeRunDateRange,
  TERMINAL_RUN_STATUSES,
  toRunEvent,
  toRunSummary,
  type RunEvent,
  type RunMetrics,
  type RunMetricsQuery,
  type RunStatus,
  type RunStatusCount,
  type RunSummary,
  type RunTrendPoint,
} from "./run-history";
import { formatTerminatedRuns } from "./run-history";
import {
  InvalidPlanRecordError,
  toPlanEstimateRecord,
  toPlanRecord,
  type PersistedPlan,
  type PersistedPlanEstimate,
  type PlanCommentRef,
  type PlanEstimateAccuracyRow,
  type PlanEstimateRecordInput,
  type PlanLedger,
  type PlanRecordInput,
  type PlanSource,
} from "./plan-ledger";
import type { CostClass, CostConfidence } from "./plan-cost-estimate";

export interface AcceptRunDelivery {
  deliveryId: string;
  repo: string;
  issue: number;
  receivedAt: string;
  /**
   * Customer tenant this run is attributed to. Absent means UNASSIGNED — a
   * legitimate state for historical runs recorded before attribution
   * existed. Resolved ONCE at acceptance; never re-derived, so reassigning
   * the repository cannot rewrite a run's stored attribution.
   */
  tenantId?: string;
}

export type RunControlTransition = "abort" | "resume";

export interface ClaimRunControlDelivery {
  deliveryId: string;
  repo: string;
  issue: number;
  transition: RunControlTransition;
  receivedAt: string;
  runId?: string;
}

export interface RunControlDeliveryReceipt {
  deliveryId: string;
  repo: string;
  issue: number;
  transition: RunControlTransition;
  runId?: string;
  runStatus?: RunStatus;
  handoffSent: boolean;
  completed: boolean;
}

export interface AdvanceRunControlDelivery extends ClaimRunControlDelivery {
  handoffSent?: boolean;
  completed?: boolean;
}

/** The ACTIVE run holding the claim for a repo+issue (#328). */
export interface ActiveRunConflict {
  runId: string;
  status: RunStatus;
}

/**
 * #404 R2 — retire the claim a STOPPED run holds, so a clean re-run becomes possible.
 *
 * The ledger deliberately stores no free-form operator text (see operator-actions.ts), so the human's reason is
 * not carried here: the retirement is identified by the self-describing terminal event id `retire-claim:<runId>`,
 * exactly as the #328 repair names its own terminations.
 */
export interface RetireRunClaim {
  repo: string;
  issue: number;
  /** Who asked, for the caller's own record. */
  actor?: string;
}

/**
 * #404 R2 — the outcome of a retirement attempt.
 *
 * Deliberately NOT an error shape: refusing to retire a LIVE holder is a legitimate, expected result, and so is
 * finding no claim to retire. Only a genuine fault produces `ok: false`.
 */
export type RunClaimRetirement =
  | { outcome: "retired"; runId: string; previousStatus: RunStatus }
  | { outcome: "holder-is-live"; runId: string; status: RunStatus }
  | { outcome: "no-claim" };

export interface RunHistoryWriteResult<T> {
  ok: boolean;
  mode: "live" | "blocked";
  providerId: string;
  value?: T;
  duplicate?: boolean;
  error?: string;
  /**
   * Set when an ACTIVE run for the same repo+issue already holds the claim (#328).
   * `ok` stays true: the delivery was handled, it simply started NO new run.
   */
  activeConflict?: ActiveRunConflict;
}

export interface RunHistoryReadResult<T> {
  ok: boolean;
  mode: "live" | "blocked";
  providerId: string;
  value: T | null;
  error?: string;
}

/**
 * #421 - the cursor CARRIES the ordering it was issued under.
 *
 * Without `sort` and `direction` a cursor cannot be checked against the request that presents it, so a cursor
 * issued under one ordering was honoured under another and returned page 2 of a different list. `key` is the
 * sort column's value for the row the cursor points past: an ISO timestamp for `createdAt`, the status or the
 * repository for the other two.
 */
export interface RunCursor {
  sort: RunSortField;
  direction: "asc" | "desc";
  key: string;
  runId: string;
}

/**
 * The columns the list may be ordered by.
 *
 * #421 widened this from `createdAt` alone, once the cursor carried its own sort key and could therefore resume an
 * ordering by another column. `issue` is deliberately still absent: its key is numeric, so a text `key` would need
 * typed parsing per sort, and the acceptance criteria ask for one non-time column rather than for every column.
 */
export const RUN_SORT_FIELDS = ["createdAt", "status", "repo"] as const;
export type RunSortField = (typeof RUN_SORT_FIELDS)[number];

/**
 * Sort field to column, by WHITELIST. A caller's string never reaches the SQL: it selects one of these names or the
 * sort is refused, which is what keeps this a bound parameter rather than an interpolation.
 */
const SORT_COLUMNS: Record<RunSortField, string> = {
  createdAt: "created_at",
  status: "status",
  repo: "repo",
};

export interface EventCursor {
  sequence: number;
}

export interface Page<T, TCursor> {
  items: T[];
  nextCursor?: TCursor;
}

export interface RunListOptions {
  repo?: string;
  issue?: number;
  status?: RunStatus;
  statuses?: RunStatus[];
  /** Inclusive lower bound for createdAt. */
  from?: string;
  /** Exclusive upper bound for createdAt. */
  to?: string;
  limit?: number;
  cursor?: RunCursor;
  /** Ordering column. Defaults to `createdAt`; see RUN_SORT_FIELDS for why only that one is allowed today. */
  sort?: RunSortField;
  /** Ordering direction. Defaults to `desc`, i.e. newest first, which is what this list has always returned. */
  direction?: "asc" | "desc";
}

export interface RunEventListOptions {
  limit?: number;
  after?: EventCursor;
}

export interface PersistedRunEvent {
  sequence: number;
  event: RunEvent;
}

export interface RunHistoryStore extends PlanLedger {
  id: string;
  acceptDelivery(
    input: AcceptRunDelivery,
  ): Promise<RunHistoryWriteResult<RunSummary>>;
  claimControlDelivery(
    input: ClaimRunControlDelivery,
  ): Promise<RunHistoryWriteResult<RunControlDeliveryReceipt>>;
  advanceControlDelivery(
    input: AdvanceRunControlDelivery,
  ): Promise<RunHistoryWriteResult<RunControlDeliveryReceipt>>;

  appendEvent(event: RunEvent): Promise<RunHistoryWriteResult<RunSummary>>;
  /**
   * #404 R2 — retire the claim a stopped run holds: a terminal transition (which releases the claim, #328) for a
   * run that is no longer working.
   *
   * REFUSES a LIVE (`running`) holder — cutting the claim from under work in flight would put two agents on one
   * issue, the very thing the claim exists to prevent. A `blocked` (parked) holder IS retired, because a park is a
   * WAIT and retirement is what makes it unable to resume. Reports `no-claim` when nothing holds the claim.
   */
  retireRunClaim(
    input: RetireRunClaim,
  ): Promise<RunHistoryWriteResult<RunClaimRetirement>>;
  updateCommentReference(
    runId: string,
    eventId: string,
    reference: RunEvent["commentReference"],
  ): Promise<void>;
  getRun(runId: string): Promise<RunHistoryReadResult<RunSummary>>;
  recordRunSummary(
    summary: RunSummary,
  ): Promise<RunHistoryWriteResult<RunSummary>>;
  listRuns(
    options?: RunListOptions,
  ): Promise<RunHistoryReadResult<Page<RunSummary, RunCursor>>>;
  listRunEvents(
    runId: string,
    options?: RunEventListOptions,
  ): Promise<RunHistoryReadResult<Page<PersistedRunEvent, EventCursor>>>;
  getRunMetrics(
    options?: RunMetricsQuery,
  ): Promise<RunHistoryReadResult<RunMetrics>>;
  close(): void | Promise<void>;
}

interface RunSummaryRow {
  run_id: string;
  repo: string;
  issue: number;
  status: RunStatus;
  stage: RunSummary["stage"];
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  attempt_count: number;
  review_count: number;
  iteration_count: number;
  fix_cycle_count: number;
  latency_ms: number | null;
  cost_usd: number | null;
  pr_url: string | null;
  git_diff: string | null;
  tenant_id: string | null;
}

interface RunEventRow {
  sequence: number;
  run_id: string;
  event_id: string;
  type: RunEvent["type"];
  stage: RunEvent["stage"];
  occurred_at: string;
  status: RunStatus | null;
  attempt: number | null;
  review_round: number | null;
  iteration_count: number | null;
  fix_cycle_count: number | null;
  finding_count: number | null;
  resolved_count: number | null;
  accepted_count: number | null;
  latency_ms: number | null;
  cost_usd: number | null;
  pr_url: string | null;
  comment_reference: string | null;
  cost_refusal: string | null;
  test_results: string | null;
  trace: string | null;
  breaker_trip: string | null;
}

function readSummary(db: DatabaseSync, runId: string): RunSummary | null {
  const row = db
    .prepare("SELECT * FROM df_run_summaries WHERE run_id = ?")
    .get(runId) as RunSummaryRow | undefined;
  return row ? rowToSummary(row) : null;
}

function readCommentRef(
  value: string,
): { provider: "github"; id: number; url: string } | undefined {
  try {
    const parsed = JSON.parse(value) as {
      provider?: unknown;
      id?: unknown;
      url?: unknown;
    };
    if (
      parsed &&
      parsed.provider === "github" &&
      typeof parsed.id === "number" &&
      typeof parsed.url === "string"
    ) {
      return { provider: "github", id: parsed.id, url: parsed.url };
    }
  } catch {
    // Malformed persisted reference: treat as absent rather than failing the read.
  }
  return undefined;
}

function readTestResults(value: string): RunEvent["testResults"] | undefined {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    return parsed as RunEvent["testResults"];
  } catch {
    // Malformed persisted test results: treat as absent rather than failing the read.
  }
  return undefined;
}

function readTrace(value: string): RunEvent["trace"] | undefined {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    return parsed as RunEvent["trace"];
  } catch {
    // Malformed persisted trace: treat as absent rather than failing the read.
  }
  return undefined;
}

/** A persisted trip is JSON; a malformed value is treated as absent, never fatal. */
function readBreakerTrip(value: string): RunEvent["breakerTrip"] | undefined {
  try {
    const parsed = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    return parsed as RunEvent["breakerTrip"];
  } catch {
    // Malformed persisted trip: treat as absent rather than failing the read.
  }
  return undefined;
}

function rowToEvent(row: RunEventRow): PersistedRunEvent {
  return {
    sequence: Number(row.sequence),
    event: toRunEvent({
      eventId: row.event_id,
      runId: row.run_id,
      type: row.type,
      stage: row.stage,
      occurredAt: row.occurred_at,
      ...(row.status !== null ? { status: row.status } : {}),
      ...(row.attempt !== null ? { attempt: row.attempt } : {}),
      ...(row.review_round !== null ? { reviewRound: row.review_round } : {}),
      ...(row.iteration_count !== null
        ? { iterationCount: row.iteration_count }
        : {}),
      ...(row.fix_cycle_count !== null
        ? { fixCycleCount: row.fix_cycle_count }
        : {}),
      ...(row.finding_count !== null
        ? { findingCount: row.finding_count }
        : {}),
      ...(row.resolved_count !== null
        ? { resolvedCount: row.resolved_count }
        : {}),
      ...(row.accepted_count !== null
        ? { acceptedCount: row.accepted_count }
        : {}),
      ...(row.latency_ms !== null ? { latencyMs: row.latency_ms } : {}),
      ...(row.cost_usd !== null ? { costUsd: row.cost_usd } : {}),
      ...(row.pr_url !== null ? { prUrl: row.pr_url } : {}),
      ...(row.comment_reference !== null && row.comment_reference !== undefined
        ? { commentReference: readCommentRef(row.comment_reference) }
        : {}),
      ...(row.cost_refusal !== null && row.cost_refusal !== undefined
        ? { costRefusal: row.cost_refusal as RunEvent["costRefusal"] }
        : {}),
      ...(row.test_results !== null && row.test_results !== undefined
        ? { testResults: readTestResults(row.test_results) }
        : {}),
      ...(row.trace !== null && row.trace !== undefined
        ? { trace: readTrace(row.trace) }
        : {}),
      ...(row.breaker_trip !== null && row.breaker_trip !== undefined
        ? { breakerTrip: readBreakerTrip(row.breaker_trip) }
        : {}),
    }),
  };
}

function sameEvent(left: RunEvent, right: RunEvent): boolean {
  // Ignore the external comment reference: it is derived from GitHub after the
  // event is recorded, so it must not block an idempotent re-append on retry.
  const strip = (e: RunEvent): RunEvent => ({
    ...e,
    commentReference: undefined,
  });
  return JSON.stringify(strip(left)) === JSON.stringify(strip(right));
}

const SQLITE_SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS df_run_summaries (
    run_id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    issue INTEGER NOT NULL,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    attempt_count INTEGER NOT NULL,
    review_count INTEGER NOT NULL,
    iteration_count INTEGER NOT NULL,
    fix_cycle_count INTEGER NOT NULL,
    latency_ms REAL,
    cost_usd REAL,
    pr_url TEXT,
    git_diff TEXT,
    tenant_id TEXT
  );
  CREATE INDEX IF NOT EXISTS df_run_summaries_page_idx
    ON df_run_summaries (created_at DESC, run_id DESC);
  CREATE INDEX IF NOT EXISTS df_run_summaries_repo_idx
    ON df_run_summaries (repo, created_at DESC, run_id DESC);
  -- df_run_active_issue_uidx is created in ensureSchema AFTER the duplicate repair (#328).

  -- #486: plans are versioned by revision, because amendPlan re-plans after review (#378).
  CREATE TABLE IF NOT EXISTS df_plans (
    plan_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    tenant_id TEXT,
    plan_revision INTEGER NOT NULL,
    story_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    plan TEXT NOT NULL,
    comment_ref TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, plan_revision)
  );
  CREATE TABLE IF NOT EXISTS df_plan_estimates (
    estimate_id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES df_plans(plan_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    tenant_id TEXT,
    period TEXT NOT NULL,
    estimator_version TEXT NOT NULL,
    model TEXT NOT NULL,
    low_usd REAL NOT NULL,
    expected_usd REAL NOT NULL,
    high_usd REAL NOT NULL,
    cost_class TEXT NOT NULL,
    confidence TEXT NOT NULL,
    revision_factor REAL NOT NULL,
    history_samples INTEGER NOT NULL,
    target_file_count INTEGER NOT NULL,
    task_count INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    price_source TEXT NOT NULL,
    stage TEXT,
    features TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS df_plan_estimates_rollup_idx
    ON df_plan_estimates (period, cost_class);
  CREATE INDEX IF NOT EXISTS df_plan_estimates_run_idx
    ON df_plan_estimates (run_id);
  CREATE INDEX IF NOT EXISTS df_plan_estimates_tenant_idx
    ON df_plan_estimates (tenant_id, period);
  CREATE VIEW IF NOT EXISTS df_plan_estimate_accuracy AS
    SELECT e.period AS period, e.cost_class AS cost_class,
           e.confidence AS confidence, e.estimator_version AS estimator_version,
           e.expected_usd AS expected_usd, s.cost_usd AS actual_usd,
           (e.expected_usd - s.cost_usd) AS signed_error_usd
    FROM df_plan_estimates e
    JOIN df_run_summaries s ON s.run_id = e.run_id
    WHERE s.cost_usd IS NOT NULL;

  CREATE TABLE IF NOT EXISTS df_run_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    type TEXT NOT NULL,
    stage TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    status TEXT,
    attempt INTEGER,
    review_round INTEGER,
    iteration_count INTEGER,
    fix_cycle_count INTEGER,
    finding_count INTEGER,
    resolved_count INTEGER,
    accepted_count INTEGER,
    latency_ms REAL,
    cost_usd REAL,
    pr_url TEXT,
    comment_reference TEXT,
    cost_refusal TEXT,
    test_results TEXT,
    trace TEXT,
    breaker_trip TEXT,
    UNIQUE (run_id, event_id),
    FOREIGN KEY (run_id) REFERENCES df_run_summaries(run_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
  );
  CREATE INDEX IF NOT EXISTS df_run_events_page_idx
    ON df_run_events (run_id, sequence);

  CREATE TABLE IF NOT EXISTS df_run_deliveries (
    delivery_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES df_run_summaries(run_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
  );

  CREATE TABLE IF NOT EXISTS df_run_control_receipts (
    delivery_id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    issue INTEGER NOT NULL,
    transition TEXT NOT NULL CHECK(transition IN ('abort', 'resume')),
    run_id TEXT REFERENCES df_run_summaries(run_id) ON DELETE SET NULL,
    received_at TEXT NOT NULL,
    handoff_sent INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0
  );
`;

function blocked<T>(
  providerId: string,
  error: unknown,
): RunHistoryWriteResult<T> {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    mode: "blocked",
    providerId,
    error: `Run history store write failed: ${detail}`,
  };
}

function rowToSummary(row: RunSummaryRow): RunSummary {
  return toRunSummary({
    runId: row.run_id,
    repo: row.repo,
    issue: row.issue,
    status: row.status,
    stage: row.stage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    attemptCount: row.attempt_count,
    reviewCount: row.review_count,
    iterationCount: row.iteration_count,
    fixCycleCount: row.fix_cycle_count,
    ...(row.latency_ms !== null ? { latencyMs: row.latency_ms } : {}),
    ...(row.cost_usd !== null ? { costUsd: row.cost_usd } : {}),
    ...(row.pr_url !== null ? { prUrl: row.pr_url } : {}),
    ...(row.git_diff !== null ? { gitDiff: row.git_diff } : {}),
    ...(row.tenant_id !== null ? { tenantId: row.tenant_id } : {}),
  });
}

/**
 * #328 — the ACTIVE run for a repo+issue, if any. `ok`-shaped refusal data, never a throw.
 * The ACTIVE set is exactly the partial index predicate.
 */
function activeRunHolder(
  db: DatabaseSync,
  repo: string,
  issue: number,
): ActiveRunConflict | undefined {
  const row = db
    .prepare(
      `SELECT run_id, status FROM df_run_summaries
        WHERE repo = ? AND issue = ? AND status IN ('queued','running','blocked')
        LIMIT 1`,
    )
    .get(repo, issue) as { run_id: string; status: RunStatus } | undefined;
  return row ? { runId: row.run_id, status: row.status } : undefined;
}

/** A UNIQUE violation from the active-run claim index (as opposed to any other write failure). */
function isClaimConflict(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? "";
  return code.startsWith("SQLITE_CONSTRAINT");
}

/**
 * #328 — terminate older ACTIVE duplicates for the same (repo, issue).
 *
 * The claim is a partial UNIQUE index, which CANNOT be created while the table still holds two
 * active runs for one issue — the state the previous code allowed. This bounded, idempotent
 * repair runs BEFORE the index: newest wins (created_at, then run_id), older ones are marked
 * aborted/terminal. It is a no-op on a consistent database.
 */
type TerminatedRun = { repo: string; issue: number; runId: string };

function repairActiveRunDuplicates(
  db: DatabaseSync,
  nowIso: string,
): TerminatedRun[] {
  const rows = db
    .prepare(
      `SELECT run_id, repo, issue FROM df_run_summaries
        WHERE status IN ('queued','running','blocked')
        ORDER BY repo, issue, created_at DESC, run_id DESC`,
    )
    .all() as { run_id: string; repo: string; issue: number }[];
  const seen = new Set<string>();
  const losers: TerminatedRun[] = [];
  for (const row of rows) {
    const key = `${row.repo}\u0000${row.issue}`;
    if (seen.has(key)) {
      losers.push({ repo: row.repo, issue: row.issue, runId: row.run_id });
    } else {
      seen.add(key);
    }
  }
  const update = db.prepare(
    "UPDATE df_run_summaries SET status = 'aborted', stage = 'terminal', completed_at = ?, updated_at = ? WHERE run_id = ?",
  );
  for (const loser of losers) {
    update.run(nowIso, nowIso, loser.runId);
    // A terminal transition must be READABLE and RECORDED: without completed_at the record layer
    // rejects the row ("completedAt to be present for a terminal status"), and without the event
    // the ledger's timeline would show a run that never ended.
    writeEvent(db, {
      runId: loser.runId,
      eventId: `repair-active-claim:${loser.runId}`,
      type: "run.terminal",
      stage: "terminal",
      occurredAt: nowIso,
      status: "aborted",
    });
  }
  return losers;
}

function writeSummary(db: DatabaseSync, summary: RunSummary): void {
  db.prepare(
    `INSERT INTO df_run_summaries (
       run_id, repo, issue, status, stage, created_at, updated_at,
       started_at, completed_at, attempt_count, review_count,
       iteration_count, fix_cycle_count, latency_ms, cost_usd, pr_url, git_diff,
       tenant_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       repo = excluded.repo,
       issue = excluded.issue,
       status = excluded.status,
       stage = excluded.stage,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       started_at = excluded.started_at,
       completed_at = excluded.completed_at,
       attempt_count = excluded.attempt_count,
       review_count = excluded.review_count,
       iteration_count = excluded.iteration_count,
       fix_cycle_count = excluded.fix_cycle_count,
       latency_ms = excluded.latency_ms,
       cost_usd = excluded.cost_usd,
       pr_url = excluded.pr_url,
       git_diff = excluded.git_diff`,
  ).run(
    summary.runId,
    summary.repo,
    summary.issue,
    summary.status,
    summary.stage,
    summary.createdAt,
    summary.updatedAt,
    summary.startedAt ?? null,
    summary.completedAt ?? null,
    summary.attemptCount,
    summary.reviewCount,
    summary.iterationCount,
    summary.fixCycleCount,
    summary.latencyMs ?? null,
    summary.costUsd ?? null,
    summary.prUrl ?? null,
    summary.gitDiff ?? null,
    summary.tenantId ?? null,
  );
}

function updateCommentReference(
  db: DatabaseSync,
  runId: string,
  eventId: string,
  reference: RunEvent["commentReference"],
): void {
  db.prepare(
    `UPDATE df_run_events SET comment_reference = ? WHERE run_id = ? AND event_id = ?`,
  ).run(reference ? JSON.stringify(reference) : null, runId, eventId);
}

function writeEvent(db: DatabaseSync, event: RunEvent): void {
  db.prepare(
    `INSERT INTO df_run_events (
       run_id, event_id, type, stage, occurred_at, status, attempt,
       review_round, iteration_count, fix_cycle_count, finding_count,
       resolved_count, accepted_count, latency_ms, cost_usd, pr_url,
       comment_reference, cost_refusal, test_results, trace, breaker_trip
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.runId,
    event.eventId,
    event.type,
    event.stage,
    event.occurredAt,
    event.status ?? null,
    event.attempt ?? null,
    event.reviewRound ?? null,
    event.iterationCount ?? null,
    event.fixCycleCount ?? null,
    event.findingCount ?? null,
    event.resolvedCount ?? null,
    event.acceptedCount ?? null,
    event.latencyMs ?? null,
    event.costUsd ?? null,
    event.prUrl ?? null,
    event.commentReference ? JSON.stringify(event.commentReference) : null,
    event.costRefusal ?? null,
    event.testResults ? JSON.stringify(event.testResults) : null,
    event.trace ? JSON.stringify(event.trace) : null,
    event.breakerTrip ? JSON.stringify(event.breakerTrip) : null,
  );
}

function validateIdentifier(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.trim().length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new InvalidRunRecordError(
      `Run history requires "${field}" to be a non-empty string of at most 256 characters.`,
    );
  }
  return value.trim();
}

function validateRepo(value: string): string {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new InvalidRunRecordError(
      'Run history filter "repo" must be an owner/repo pair.',
    );
  }
  return normalized;
}

function validateStatus(value: RunStatus): RunStatus {
  const allowed: readonly RunStatus[] = [
    "queued",
    "running",
    "blocked",
    "aborted",
    "succeeded",
    "failed",
  ];
  if (!allowed.includes(value)) {
    throw new InvalidRunRecordError(`Unknown run status '${String(value)}'.`);
  }
  return value;
}

function validateIssue(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidRunRecordError(
      "Run history issue filter must be a positive safe integer.",
    );
  }
  return value;
}

function validateStatuses(
  value: RunStatus[] | undefined,
): RunStatus[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidRunRecordError(
      "Run history statuses filter must be a non-empty array.",
    );
  }
  return [...new Set(value.map(validateStatus))];
}

function validateLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new InvalidRunRecordError(
      "Run history page limit must be an integer in [1, 100].",
    );
  }
  return value;
}

/** The sort column's value for a row - what a cursor must carry to resume that ordering. */
function sortKeyOf(summary: RunSummary, sort: RunSortField): string {
  if (sort === "createdAt") return summary.createdAt;
  if (sort === "status") return summary.status;
  return summary.repo;
}

/** The cursor that resumes this ordering after `summary` - shared so both drivers hand back the same shape. */
export function runCursorAfter(
  summary: RunSummary,
  sort: RunSortField,
  direction: "asc" | "desc",
): RunCursor {
  return {
    sort,
    direction,
    key: sortKeyOf(summary, sort),
    runId: summary.runId,
  };
}

/** The sort field, refused unless it is one the store can actually order by. */
export function validateRunSortField(
  sort: RunListOptions["sort"],
): RunSortField {
  const value = sort ?? "createdAt";
  if (!(RUN_SORT_FIELDS as readonly string[]).includes(value as string)) {
    throw new InvalidRunRecordError(
      `Run history sort must be one of: ${RUN_SORT_FIELDS.join(", ")}.`,
    );
  }
  return value as RunSortField;
}

/** The direction, refused unless it is one the store can actually order by. */
function validateRunDirection(
  direction: RunListOptions["direction"],
): "asc" | "desc" {
  const value = direction ?? "desc";
  if (value !== "asc" && value !== "desc") {
    throw new InvalidRunRecordError(
      "Run history sort direction must be asc or desc.",
    );
  }
  return value;
}

/**
 * #421 - validate a cursor AGAINST THE REQUEST that presents it.
 *
 * A cursor naming a different ordering than the one requested is REFUSED rather than honoured: honouring it hands
 * back page 2 of a different list, which looks like data and is not. Shared by both drivers so the two cannot
 * disagree about what a cursor means.
 */
export function validateRunCursor(
  cursor: RunCursor,
  options: RunListOptions = {},
): RunCursor {
  const sort = validateRunSortField(cursor.sort);
  const direction = validateRunDirection(cursor.direction);
  const requestedSort = validateRunSortField(options.sort);
  const requestedDirection = validateRunDirection(options.direction);
  if (sort !== requestedSort || direction !== requestedDirection) {
    throw new InvalidRunRecordError(
      `Run history cursor was issued for ${sort} ${direction} and cannot resume ${requestedSort} ${requestedDirection}.`,
    );
  }
  const runId = validateIdentifier(cursor.runId, "cursor.runId");
  if (typeof cursor.key !== "string" || cursor.key.length === 0) {
    throw new InvalidRunRecordError(
      "Run history cursor key must be a non-empty string.",
    );
  }
  if (sort === "createdAt") {
    const parsed = Date.parse(cursor.key);
    if (!Number.isFinite(parsed)) {
      throw new InvalidRunRecordError(
        "Run history cursor key must be an ISO timestamp for the createdAt sort.",
      );
    }
    return { sort, direction, key: new Date(parsed).toISOString(), runId };
  }
  if (sort === "status") {
    return {
      sort,
      direction,
      key: validateStatus(cursor.key as RunStatus),
      runId,
    };
  }
  return { sort, direction, key: validateRepo(cursor.key), runId };
}

/** Refuse an ordering the cursor cannot serve, rather than returning rows in an order nobody asked for. */
export function validateRunSort(options: RunListOptions): {
  sort: RunSortField;
  direction: "asc" | "desc";
  order: "ASC" | "DESC";
  comparison: "<" | ">";
  column: string;
} {
  const sort = validateRunSortField(options.sort);
  const direction = validateRunDirection(options.direction);
  const column = SORT_COLUMNS[sort];
  return direction === "asc"
    ? { sort, direction, order: "ASC", comparison: ">", column }
    : { sort, direction, order: "DESC", comparison: "<", column };
}

function validateEventCursor(cursor: EventCursor): number {
  if (!Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0) {
    throw new InvalidRunRecordError(
      "Run history event cursor must be a safe sequence number >= 0.",
    );
  }
  return cursor.sequence;
}

function readError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Run history store read failed: ${detail}`;
}

/** File-backed run history for local development and contract testing. */
interface PlanRow {
  plan_id: number;
  run_id: string;
  tenant_id: string | null;
  plan_revision: number;
  story_id: number;
  source: PlanSource;
  plan: string;
  comment_ref: string | null;
  created_at: string;
}

interface PlanEstimateRow {
  estimate_id: number;
  plan_id: number;
  run_id: string;
  tenant_id: string | null;
  period: string;
  estimator_version: string;
  model: string;
  low_usd: number;
  expected_usd: number;
  high_usd: number;
  cost_class: CostClass;
  confidence: CostConfidence;
  revision_factor: number;
  history_samples: number;
  target_file_count: number;
  task_count: number;
  input_tokens: number;
  output_tokens: number;
  price_source: string;
  stage: string | null;
  features: string;
  created_at: string;
}

/** Parse a persisted JSON column, treating anything unparseable as absent (#486). */
function readJsonColumn(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    // Malformed persisted JSON: treat as absent rather than failing the read.
  }
  return undefined;
}

function rowToPlan(row: PlanRow): PersistedPlan | null {
  const plan = readJsonColumn(row.plan);
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return null;
  const comment = readJsonColumn(row.comment_ref);
  return {
    planId: row.plan_id,
    runId: row.run_id,
    ...(row.tenant_id !== null ? { tenantId: row.tenant_id } : {}),
    planRevision: row.plan_revision,
    storyId: row.story_id,
    source: row.source,
    plan: plan as PersistedPlan["plan"],
    ...(typeof comment === "object" && comment !== null
      ? { commentRef: comment as PlanCommentRef }
      : {}),
    createdAt: row.created_at,
  };
}

function rowToPlanEstimate(row: PlanEstimateRow): PersistedPlanEstimate | null {
  const features = readJsonColumn(row.features);
  if (typeof features !== "object" || features === null || Array.isArray(features)) {
    return null;
  }
  return {
    estimateId: row.estimate_id,
    planId: row.plan_id,
    runId: row.run_id,
    ...(row.tenant_id !== null ? { tenantId: row.tenant_id } : {}),
    period: row.period,
    estimatorVersion: row.estimator_version,
    model: row.model,
    lowUsd: row.low_usd,
    expectedUsd: row.expected_usd,
    highUsd: row.high_usd,
    costClass: row.cost_class,
    confidence: row.confidence,
    revisionFactor: row.revision_factor,
    historySamples: row.history_samples,
    targetFileCount: row.target_file_count,
    taskCount: row.task_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    priceSource: row.price_source,
    ...(row.stage !== null ? { stage: row.stage } : {}),
    features: features as Record<string, number | string>,
    createdAt: row.created_at,
  };
}

export class SqliteRunHistoryStore implements RunHistoryStore {
  id = "sqlite";
  private readonly path: string;
  private readonly idFactory: () => string;
  private db: DatabaseSync | null = null;
  private openError: string | null = null;

  constructor(path: string, idFactory: () => string = randomUUID) {
    this.path = path;
    this.idFactory = idFactory;
  }

  private handle(): DatabaseSync | null {
    if (this.db) return this.db;
    if (this.openError) return null;
    try {
      const db = new DatabaseSync(this.path);
      db.exec(SQLITE_SCHEMA);
      const repaired = repairActiveRunDuplicates(db, new Date().toISOString());
      if (repaired.length > 0) {
        console.warn(
          `[run-history] terminated ${repaired.length} older duplicate ACTIVE run(s) so the active-run claim could be created (#328): ${formatTerminatedRuns(repaired)}`,
        );
      }
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS df_run_active_issue_uidx ON df_run_summaries (repo, issue) WHERE status IN ('queued','running','blocked')",
      );
      const receiptColumns = db
        .prepare("PRAGMA table_info(df_run_control_receipts)")
        .all() as { name: string }[];
      if (!receiptColumns.some((column) => column.name === "handoff_sent")) {
        db.exec(
          "ALTER TABLE df_run_control_receipts ADD COLUMN handoff_sent INTEGER NOT NULL DEFAULT 0",
        );
      }
      if (!receiptColumns.some((column) => column.name === "completed")) {
        db.exec(
          "ALTER TABLE df_run_control_receipts ADD COLUMN completed INTEGER NOT NULL DEFAULT 0",
        );
      }
      const summaryColumns = db
        .prepare("PRAGMA table_info(df_run_summaries)")
        .all() as { name: string }[];
      if (!summaryColumns.some((column) => column.name === "tenant_id")) {
        db.exec("ALTER TABLE df_run_summaries ADD COLUMN tenant_id TEXT");
        db.exec("ALTER TABLE df_run_summaries ADD COLUMN git_diff TEXT");
      }
      const eventColumns = db
        .prepare("PRAGMA table_info(df_run_events)")
        .all() as { name: string }[];
      if (!eventColumns.some((column) => column.name === "comment_reference")) {
        db.exec("ALTER TABLE df_run_events ADD COLUMN comment_reference TEXT");
      }
      if (!eventColumns.some((column) => column.name === "cost_refusal")) {
        db.exec("ALTER TABLE df_run_events ADD COLUMN cost_refusal TEXT");
      }
      if (!eventColumns.some((column) => column.name === "test_results")) {
        db.exec("ALTER TABLE df_run_events ADD COLUMN test_results TEXT");
      }
      if (!eventColumns.some((column) => column.name === "breaker_trip")) {
        db.exec("ALTER TABLE df_run_events ADD COLUMN breaker_trip TEXT");
      }
      if (!eventColumns.some((column) => column.name === "trace")) {
        db.exec("ALTER TABLE df_run_events ADD COLUMN trace TEXT");
      }
      this.db = db;
      return db;
    } catch (error) {
      this.openError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  private transaction<T>(operation: (db: DatabaseSync) => T): T {
    const db = this.handle();
    if (!db) {
      throw new Error(
        `SQLite run history is not available at '${this.path}': ${this.openError ?? "unknown error"}`,
      );
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation(db);
      db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the operation error; a failed rollback does not turn it into success.
      }
      throw error;
    }
  }

  async acceptDelivery(
    input: AcceptRunDelivery,
  ): Promise<RunHistoryWriteResult<RunSummary>> {
    const deliveryId =
      typeof input.deliveryId === "string" ? input.deliveryId.trim() : "";
    if (!deliveryId) {
      throw new InvalidRunRecordError(
        "Webhook delivery requires a non-empty deliveryId.",
      );
    }
    const eventId = toRunEvent({
      eventId: deliveryId,
      runId: "validation-only",
      type: "run.accepted",
      stage: "trigger",
      occurredAt: input.receivedAt,
      status: "queued",
    }).eventId;
    const normalizedInput = toRunSummary({
      runId: "validation-only",
      repo: input.repo,
      issue: input.issue,
      status: "queued",
      stage: "trigger",
      createdAt: input.receivedAt,
      updatedAt: input.receivedAt,
      attemptCount: 0,
      reviewCount: 0,
      iterationCount: 0,
      fixCycleCount: 0,
    });

    try {
      const accepted = this.transaction(
        (
          db,
        ): {
          summary: RunSummary | null;
          duplicate: boolean;
          activeConflict?: ActiveRunConflict;
        } => {
          const existingDelivery = db
            .prepare(
              "SELECT run_id FROM df_run_deliveries WHERE delivery_id = ?",
            )
            .get(eventId) as { run_id?: string } | undefined;
          if (existingDelivery?.run_id) {
            const row = db
              .prepare("SELECT * FROM df_run_summaries WHERE run_id = ?")
              .get(existingDelivery.run_id) as RunSummaryRow | undefined;
            if (!row) {
              throw new Error(
                `Delivery '${eventId}' points to a missing run summary.`,
              );
            }
            const existing = rowToSummary(row);
            if (
              existing.repo !== normalizedInput.repo ||
              existing.issue !== normalizedInput.issue
            ) {
              throw new Error(
                `Delivery '${eventId}' was replayed with a different repo/issue identity.`,
              );
            }
            return { summary: existing, duplicate: true };
          }

          // #328 — the ATOMIC active-run claim. This is the single place a run is
          // created, so enforcing it here means no caller can defeat it. The partial
          // UNIQUE index on df_run_summaries is the backstop for a true race (see the
          // isClaimConflict catch below); this read makes the common path clean.
          const holder = activeRunHolder(
            db,
            normalizedInput.repo,
            normalizedInput.issue,
          );
          if (holder) {
            return { summary: null, duplicate: false, activeConflict: holder };
          }

          const runId = this.idFactory();
          const createdAt = toRunEvent({
            eventId,
            runId,
            type: "run.accepted",
            stage: "trigger",
            occurredAt: input.receivedAt,
            status: "queued",
          });
          const initial: RunSummary = toRunSummary({
            runId,
            repo: input.repo,
            issue: input.issue,
            tenantId: input.tenantId,
            status: "queued",
            stage: "trigger",
            createdAt: createdAt.occurredAt,
            updatedAt: createdAt.occurredAt,
            attemptCount: 0,
            reviewCount: 0,
            iterationCount: 0,
            fixCycleCount: 0,
          });

          try {
            writeSummary(db, initial);
          } catch (error) {
            const racer = isClaimConflict(error)
              ? activeRunHolder(db, normalizedInput.repo, normalizedInput.issue)
              : undefined;
            if (racer) {
              return { summary: null, duplicate: false, activeConflict: racer };
            }
            throw error;
          }
          writeEvent(db, createdAt);
          db.prepare(
            "INSERT INTO df_run_deliveries (delivery_id, run_id) VALUES (?, ?)",
          ).run(eventId, runId);
          return { summary: initial, duplicate: false };
        },
      );
      if (accepted.activeConflict) {
        return {
          ok: true,
          mode: "live",
          providerId: this.id,
          duplicate: false,
          activeConflict: accepted.activeConflict,
        };
      }
      return {
        ok: true,
        mode: "live",
        providerId: this.id,
        ...(accepted.summary ? { value: accepted.summary } : {}),
        duplicate: accepted.duplicate,
      };
    } catch (error) {
      return blocked(this.id, error);
    }
  }

  async claimControlDelivery(
    input: ClaimRunControlDelivery,
  ): Promise<RunHistoryWriteResult<RunControlDeliveryReceipt>> {
    const deliveryId = validateIdentifier(input.deliveryId, "deliveryId");
    const repo = validateRepo(input.repo);
    const issue = validateIssue(input.issue);
    if (issue === undefined) {
      throw new InvalidRunRecordError(
        "Control delivery requires a positive issue number.",
      );
    }
    if (input.transition !== "abort" && input.transition !== "resume") {
      throw new InvalidRunRecordError(
        "Control delivery transition must be abort or resume.",
      );
    }
    const normalizedAt = toRunSummary({
      runId: "control-receipt-validation",
      repo,
      issue,
      status: "queued",
      stage: "trigger",
      createdAt: input.receivedAt,
      updatedAt: input.receivedAt,
      attemptCount: 0,
      reviewCount: 0,
      iterationCount: 0,
      fixCycleCount: 0,
    }).createdAt;
    const runId =
      input.runId === undefined
        ? undefined
        : validateIdentifier(input.runId, "runId");

    try {
      const claimed = this.transaction((db) => {
        const existing = db
          .prepare(
            `SELECT delivery_id, repo, issue, transition, run_id, handoff_sent, completed
             FROM df_run_control_receipts WHERE delivery_id = ?`,
          )
          .get(deliveryId) as
          | {
              delivery_id: string;
              repo: string;
              issue: number;
              transition: RunControlTransition;
              run_id: string | null;
              handoff_sent: number;
              completed: number;
            }
          | undefined;
        if (existing) {
          if (
            existing.repo !== repo ||
            existing.issue !== issue ||
            existing.transition !== input.transition
          ) {
            throw new InvalidRunRecordError(
              "Control delivery identity was reused with different repo, issue, or transition data.",
            );
          }
          const previous = existing.run_id
            ? readSummary(db, existing.run_id)
            : null;
          return {
            duplicate: true,
            value: {
              deliveryId,
              repo,
              issue,
              transition: input.transition,
              ...(existing.run_id ? { runId: existing.run_id } : {}),
              ...(previous ? { runStatus: previous.status } : {}),
              handoffSent: Boolean(existing.handoff_sent),
              completed: Boolean(existing.completed),
            } satisfies RunControlDeliveryReceipt,
          };
        }

        const target = runId ? readSummary(db, runId) : null;
        if (
          runId &&
          (!target || target.repo !== repo || target.issue !== issue)
        ) {
          throw new InvalidRunRecordError(
            "Control delivery runId does not identify the supplied repo and issue.",
          );
        }
        db.prepare(
          `INSERT INTO df_run_control_receipts
           (delivery_id, repo, issue, transition, run_id, received_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          deliveryId,
          repo,
          issue,
          input.transition,
          runId ?? null,
          normalizedAt,
        );
        return {
          duplicate: false,
          value: {
            deliveryId,
            repo,
            issue,
            transition: input.transition,
            ...(runId ? { runId } : {}),
            ...(target ? { runStatus: target.status } : {}),
            handoffSent: false,
            completed: false,
          } satisfies RunControlDeliveryReceipt,
        };
      });
      return {
        ok: true,
        mode: "live",
        providerId: this.id,
        value: claimed.value,
        duplicate: claimed.duplicate,
      };
    } catch (error) {
      return blocked(this.id, error);
    }
  }

  async advanceControlDelivery(
    input: AdvanceRunControlDelivery,
  ): Promise<RunHistoryWriteResult<RunControlDeliveryReceipt>> {
    const deliveryId = validateIdentifier(input.deliveryId, "deliveryId");
    const repo = validateRepo(input.repo);
    const issue = validateIssue(input.issue);
    if (issue === undefined) {
      throw new InvalidRunRecordError(
        "Control delivery requires a positive issue number.",
      );
    }
    if (input.transition !== "abort" && input.transition !== "resume") {
      throw new InvalidRunRecordError(
        "Control delivery transition must be abort or resume.",
      );
    }
    if (input.handoffSent && input.transition !== "resume") {
      throw new InvalidRunRecordError(
        "Only resume deliveries can record a successful handoff.",
      );
    }
    if (!input.handoffSent && !input.completed) {
      throw new InvalidRunRecordError(
        "Control delivery progress must advance at least one phase.",
      );
    }
    toRunSummary({
      runId: "control-progress-validation",
      repo,
      issue,
      status: "queued",
      stage: "trigger",
      createdAt: input.receivedAt,
      updatedAt: input.receivedAt,
      attemptCount: 0,
      reviewCount: 0,
      iterationCount: 0,
      fixCycleCount: 0,
    });
    const runId =
      input.runId === undefined
        ? null
        : validateIdentifier(input.runId, "runId");

    try {
      const advanced = this.transaction((db) => {
        const existing = db
          .prepare(
            `SELECT repo, issue, transition, run_id, handoff_sent, completed
             FROM df_run_control_receipts WHERE delivery_id = ?`,
          )
          .get(deliveryId) as
          | {
              repo: string;
              issue: number;
              transition: RunControlTransition;
              run_id: string | null;
              handoff_sent: number;
              completed: number;
            }
          | undefined;
        if (!existing)
          throw new Error(
            "Control delivery must be claimed before it advances.",
          );
        if (
          existing.repo !== repo ||
          existing.issue !== issue ||
          existing.transition !== input.transition ||
          existing.run_id !== runId
        ) {
          throw new InvalidRunRecordError(
            "Control progress does not match its claimed delivery identity.",
          );
        }
        const handoffSent =
          Boolean(existing.handoff_sent) || input.handoffSent === true;
        const completed =
          Boolean(existing.completed) || input.completed === true;
        const duplicate =
          (!input.handoffSent || Boolean(existing.handoff_sent)) &&
          (!input.completed || Boolean(existing.completed));
        db.prepare(
          `UPDATE df_run_control_receipts
           SET handoff_sent = ?, completed = ?
           WHERE delivery_id = ?`,
        ).run(Number(handoffSent), Number(completed), deliveryId);
        const summary = runId ? readSummary(db, runId) : null;
        return {
          duplicate,
          value: {
            deliveryId,
            repo,
            issue,
            transition: input.transition,
            ...(runId ? { runId } : {}),
            ...(summary ? { runStatus: summary.status } : {}),
            handoffSent,
            completed,
          } satisfies RunControlDeliveryReceipt,
        };
      });
      return {
        ok: true,
        mode: "live",
        providerId: this.id,
        value: advanced.value,
        duplicate: advanced.duplicate,
      };
    } catch (error) {
      return blocked(this.id, error);
    }
  }

  async appendEvent(
    eventInput: RunEvent,
  ): Promise<RunHistoryWriteResult<RunSummary>> {
    const event = toRunEvent(eventInput);
    try {
      const appended = this.transaction((db) => {
        const summary = readSummary(db, event.runId);
        if (!summary) throw new Error(`Run '${event.runId}' does not exist.`);
        const row = db
          .prepare(
            "SELECT * FROM df_run_events WHERE run_id = ? AND event_id = ?",
          )
          .get(event.runId, event.eventId) as RunEventRow | undefined;
        if (row) {
          if (!sameEvent(rowToEvent(row).event, event)) {
            throw new Error(
              `Event ID '${event.eventId}' was reused with different event data.`,
            );
          }
          return { summary, duplicate: true };
        }

        const updated = applyRunEvent(summary, event);
        writeEvent(db, event);
        writeSummary(db, updated);
        return { summary: updated, duplicate: false };
      });
      return {
        ok: true,
        mode: "live",
        providerId: this.id,
        value: appended.summary,
        duplicate: appended.duplicate,
      };
    } catch (error) {
      return blocked(this.id, error);
    }
  }

  /**
   * #404 R2 — retire the claim a STOPPED run holds.
   *
   * The holder is located and re-read INSIDE one transaction, so a run that resumed to `running` since the holder
   * query is refused (a live process is never cut out from under itself). The terminal transition then reuses the
   * record layer's own rules — `applyRunEvent` + `writeSummary` — so a retired run satisfies exactly the same
   * invariants as any other terminal one (it is written with `completed_at`, and the event makes it readable).
   */
  async retireRunClaim(
    input: RetireRunClaim,
  ): Promise<RunHistoryWriteResult<RunClaimRetirement>> {
    try {
      const retirement = this.transaction((db): RunClaimRetirement => {
        // Normalise EXACTLY as a write does. The ledger stores `repo` lowercased (acceptDelivery), so comparing the
        // caller's raw casing matches no row and reports no-claim while a claim is plainly held — found live.
        const repo = validateRepo(input.repo);
        const holder = db
          .prepare(
            `SELECT run_id, status FROM df_run_summaries
              WHERE repo = ? AND issue = ? AND status IN ('queued','running','blocked')
              LIMIT 1`,
          )
          .get(repo, input.issue) as
          | { run_id: string; status: RunStatus }
          | undefined;
        if (!holder) return { outcome: "no-claim" };

        const summary = readSummary(db, holder.run_id);
        if (!summary) return { outcome: "no-claim" };

        // The GUARD, re-read inside the transaction: a run that resumed since the query above is LIVE.
        if (summary.status === "running") {
          return { outcome: "holder-is-live", runId: summary.runId, status: summary.status };
        }

        const event: RunEvent = {
          runId: summary.runId,
          eventId: `retire-claim:${summary.runId}`,
          type: "run.terminal",
          stage: "terminal",
          occurredAt: new Date().toISOString(),
          status: "aborted",
        };
        const updated = applyRunEvent(summary, event);
        writeEvent(db, event);
        writeSummary(db, updated);
        return {
          outcome: "retired",
          runId: summary.runId,
          previousStatus: summary.status,
        };
      });
      return {
        ok: true,
        mode: "live",
        providerId: this.id,
        value: retirement,
        duplicate: false,
      };
    } catch (error) {
      return blocked(this.id, error);
    }
  }

  async recordRunSummary(
    summary: RunSummary,
  ): Promise<RunHistoryWriteResult<RunSummary>> {
    try {
      const written = this.transaction((db) => {
        writeSummary(db, summary);
        return summary;
      });
      return {
        ok: true,
        mode: "live",
        providerId: this.id,
        value: written,
        duplicate: false,
      };
    } catch (error) {
      return blocked(this.id, error);
    }
  }

  async updateCommentReference(
    runId: string,
    eventId: string,
    reference: RunEvent["commentReference"],
  ): Promise<void> {
    const db = this.handle();
    if (!db)
      throw new Error(`SQLite run history is unavailable at '${this.path}'.`);
    updateCommentReference(db, runId, eventId, reference);
  }

  async getRun(runId: string): Promise<RunHistoryReadResult<RunSummary>> {
    const normalizedId = validateIdentifier(runId, "runId");
    try {
      const db = this.handle();
      if (!db)
        throw new Error(`SQLite run history is unavailable at '${this.path}'.`);
      return {
        ok: true,
        mode: "live",
        providerId: this.id,
        value: readSummary(db, normalizedId),
      };
    } catch (error) {
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        value: null,
        error: readError(error),
      };
    }
  }

  async listRuns(
    options: RunListOptions = {},
  ): Promise<RunHistoryReadResult<Page<RunSummary, RunCursor>>> {
    const limit = validateLimit(options.limit);
    const repo =
      options.repo === undefined ? undefined : validateRepo(options.repo);
    const issue = validateIssue(options.issue);
    const status =
      options.status === undefined ? undefined : validateStatus(options.status);
    const statuses = validateStatuses(options.statuses);
    if (status !== undefined && statuses !== undefined) {
      throw new InvalidRunRecordError(
        "Use either status or statuses, not both.",
      );
    }
    const { from, to } = normalizeRunDateRange(options.from, options.to);
    const { sort, direction, order, comparison, column } =
      validateRunSort(options);
    const cursor = options.cursor
      ? validateRunCursor(options.cursor, options)
      : undefined;
    try {
      const db = this.handle();
      if (!db)
        throw new Error(`SQLite run history is unavailable at '${this.path}'.`);
      const clauses: string[] = [];
      const values: (string | number)[] = [];
      if (repo !== undefined) {
        clauses.push("repo = ?");
        values.push(repo);
      }
      if (issue !== undefined) {
        clauses.push("issue = ?");
        values.push(issue);
      }
      if (statuses) {
        clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
        values.push(...statuses);
      } else if (status !== undefined) {
        clauses.push("status = ?");
        values.push(status);
      }
      if (from !== undefined) {
        clauses.push("created_at >= ?");
        values.push(from);
      }
      if (to !== undefined) {
        clauses.push("created_at < ?");
        values.push(to);
      }
      if (cursor) {
        clauses.push(
          `(${column} ${comparison} ? OR (${column} = ? AND run_id ${comparison} ?))`,
        );
        values.push(cursor.key, cursor.key, cursor.runId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `SELECT * FROM df_run_summaries ${where} ` +
            `ORDER BY ${column} ${order}, run_id ${order} LIMIT ?`,
        )
        .all(...values, limit + 1) as unknown as RunSummaryRow[];
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(rowToSummary);
      const last = items.at(-1);
      return {
        ok: true,
        mode: "live",
        providerId: this.id,
        value: {
          items,
          ...(hasMore && last
            ? { nextCursor: runCursorAfter(last, sort, direction) }
            : {}),
        },
      };
    } catch (error) {
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        value: null,
        error: readError(error),
      };
    }
  }

  async listRunEvents(
    runId: string,
    options: RunEventListOptions = {},
  ): Promise<RunHistoryReadResult<Page<PersistedRunEvent, EventCursor>>> {
    const normalizedId = validateIdentifier(runId, "runId");
    const limit = validateLimit(options.limit);
    const after = options.after ? validateEventCursor(options.after) : 0;
    try {
      const db = this.handle();
      if (!db)
        throw new Error(`SQLite run history is unavailable at '${this.path}'.`);
      const rows = db
        .prepare(
          `SELECT * FROM df_run_events WHERE run_id = ? AND sequence > ? ` +
            "ORDER BY sequence ASC LIMIT ?",
        )
        .all(normalizedId, after, limit + 1) as unknown as RunEventRow[];
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(rowToEvent);
      const last = items.at(-1);
      return {
        ok: true,
        mode: "live",
        providerId: this.id,
        value: {
          items,
          ...(hasMore && last
            ? { nextCursor: { sequence: last.sequence } }
            : {}),
        },
      };
    } catch (error) {
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        value: null,
        error: readError(error),
      };
    }
  }

  async getRunMetrics(
    options: RunMetricsQuery = {},
  ): Promise<RunHistoryReadResult<RunMetrics>> {
    const repo =
      options.repo === undefined ? undefined : validateRepo(options.repo);
    const { from, to } = normalizeRunDateRange(options.from, options.to);
    try {
      const db = this.handle();
      if (!db)
        throw new Error(`SQLite run history is unavailable at '${this.path}'.`);
      const clauses: string[] = [];
      const values: (string | number)[] = [];
      if (repo !== undefined) {
        clauses.push("repo = ?");
        values.push(repo);
      }
      if (from !== undefined) {
        clauses.push("created_at >= ?");
        values.push(from);
      }
      if (to !== undefined) {
        clauses.push("created_at < ?");
        values.push(to);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

      const statusRows = db
        .prepare(
          `SELECT status, COUNT(*) AS count FROM df_run_summaries ${where} GROUP BY status`,
        )
        .all(...values) as unknown as Array<{ status: string; count: number }>;
      const statusMap = new Map<string, number>();
      for (const row of statusRows)
        statusMap.set(row.status, Number(row.count));
      const statusCounts: RunStatusCount[] = ALL_RUN_STATUSES.map((status) => ({
        status,
        count: statusMap.get(status) ?? 0,
      }));

      const trendClauses = [
        ...clauses,
        "completed_at IS NOT NULL",
        `status IN (${TERMINAL_RUN_STATUSES.map(() => "?").join(", ")})`,
      ];
      const trendWhere = `WHERE ${trendClauses.join(" AND ")}`;
      const trendRows = db
        .prepare(
          `SELECT substr(completed_at, 1, 10) AS date, status, COUNT(*) AS count ` +
            `FROM df_run_summaries ${trendWhere} GROUP BY date, status`,
        )
        .all(...values, ...TERMINAL_RUN_STATUSES) as unknown as Array<{
        date: string;
        status: RunStatus;
        count: number;
      }>;
      const trend: RunTrendPoint[] = trendRows.map((row) => ({
        date: row.date,
        outcome: row.status,
        count: Number(row.count),
      }));

      const measuredRow = db
        .prepare(
          `SELECT SUM(latency_ms) AS latency_sum, COUNT(latency_ms) AS latency_count, ` +
            `SUM(cost_usd) AS cost_sum, COUNT(cost_usd) AS cost_count ` +
            `FROM df_run_summaries ${where}`,
        )
        .get(...values) as unknown as {
        latency_sum: number | null;
        latency_count: number;
        cost_sum: number | null;
        cost_count: number;
      };
      const measured: RunMetrics["measured"] = {};
      if (Number(measuredRow.latency_count) > 0) {
        measured.latencyMs = {
          sum: Number(measuredRow.latency_sum ?? 0),
          count: Number(measuredRow.latency_count),
        };
      }
      if (Number(measuredRow.cost_count) > 0) {
        measured.costUsd = {
          sum: Number(measuredRow.cost_sum ?? 0),
          count: Number(measuredRow.cost_count),
        };
      }

      return {
        ok: true,
        mode: "live",
        providerId: this.id,
        value: { statusCounts, trend, measured },
      };
    } catch (error) {
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        value: null,
        error: readError(error),
      };
    }
  }

  /**
   * Persist one plan revision (#486). Write-once per revision, enforced by the UNIQUE constraint
   * rather than an upsert, so a re-plan cannot silently overwrite an earlier estimate.
   */
  async recordPlan(input: PlanRecordInput): Promise<PersistedPlan> {
    return this.transaction((db) => {
      const plan = toPlanRecord(input);
      const inserted = db
        .prepare(
          `INSERT INTO df_plans (
             run_id, tenant_id, plan_revision, story_id, source, plan, comment_ref, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          plan.runId,
          plan.tenantId ?? null,
          plan.planRevision,
          plan.storyId,
          plan.source,
          JSON.stringify(plan.plan),
          plan.commentRef ? JSON.stringify(plan.commentRef) : null,
          plan.createdAt,
        );
      return { ...plan, planId: Number(inserted.lastInsertRowid) };
    });
  }

  async listPlans(runId: string): Promise<PersistedPlan[]> {
    const db = this.handle();
    if (!db) throw new Error(`SQLite run history is unavailable at '${this.path}'.`);
    const rows = db
      .prepare("SELECT * FROM df_plans WHERE run_id = ? ORDER BY plan_revision ASC")
      .all(runId) as unknown as PlanRow[];
    return rows
      .map(rowToPlan)
      .filter((plan): plan is PersistedPlan => plan !== null);
  }

  async recordPlanEstimate(input: PlanEstimateRecordInput): Promise<PersistedPlanEstimate> {
    return this.transaction((db) => {
      const estimate = toPlanEstimateRecord(input);
      const inserted = db
        .prepare(
          `INSERT INTO df_plan_estimates (
             plan_id, run_id, tenant_id, period, estimator_version, model,
             low_usd, expected_usd, high_usd, cost_class, confidence,
             revision_factor, history_samples, target_file_count, task_count,
             input_tokens, output_tokens, price_source, stage, features, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          estimate.planId,
          estimate.runId,
          estimate.tenantId ?? null,
          estimate.period,
          estimate.estimatorVersion,
          estimate.model,
          estimate.lowUsd,
          estimate.expectedUsd,
          estimate.highUsd,
          estimate.costClass,
          estimate.confidence,
          estimate.revisionFactor,
          estimate.historySamples,
          estimate.targetFileCount,
          estimate.taskCount,
          estimate.inputTokens,
          estimate.outputTokens,
          estimate.priceSource,
          estimate.stage ?? null,
          JSON.stringify(estimate.features),
          estimate.createdAt,
        );
      return { ...estimate, estimateId: Number(inserted.lastInsertRowid) };
    });
  }

  async listPlanEstimates(runId: string): Promise<PersistedPlanEstimate[]> {
    const db = this.handle();
    if (!db) throw new Error(`SQLite run history is unavailable at '${this.path}'.`);
    const rows = db
      .prepare("SELECT * FROM df_plan_estimates WHERE run_id = ? ORDER BY estimate_id ASC")
      .all(runId) as unknown as PlanEstimateRow[];
    return rows
      .map(rowToPlanEstimate)
      .filter((estimate): estimate is PersistedPlanEstimate => estimate !== null);
  }

  /** The calibration rollup #490 consumes: what was forecast against what it actually cost. */
  async listEstimateAccuracy(period?: string): Promise<PlanEstimateAccuracyRow[]> {
    const db = this.handle();
    if (!db) throw new Error(`SQLite run history is unavailable at '${this.path}'.`);
    const rows = (
      period === undefined
        ? db.prepare("SELECT * FROM df_plan_estimate_accuracy").all()
        : db.prepare("SELECT * FROM df_plan_estimate_accuracy WHERE period = ?").all(period)
    ) as Array<{
      period: string;
      cost_class: CostClass;
      confidence: CostConfidence;
      estimator_version: string;
      expected_usd: number;
      actual_usd: number;
      signed_error_usd: number;
    }>;
    return rows.map((row) => ({
      period: row.period,
      costClass: row.cost_class,
      confidence: row.confidence,
      estimatorVersion: row.estimator_version,
      expectedUsd: row.expected_usd,
      actualUsd: row.actual_usd,
      signedErrorUsd: row.signed_error_usd,
    }));
  }

  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }
}
