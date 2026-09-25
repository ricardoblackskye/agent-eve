import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  applyRunEvent,
  InvalidRunRecordError,
  normalizeRunDateRange,
  toRunEvent,
  toRunSummary,
  type RunEvent,
  type RunStatus,
  type RunSummary,
} from "./run-history";

export interface AcceptRunDelivery {
  deliveryId: string;
  repo: string;
  issue: number;
  receivedAt: string;
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

export interface RunHistoryWriteResult<T> {
  ok: boolean;
  mode: "live" | "blocked";
  providerId: string;
  value?: T;
  duplicate?: boolean;
  error?: string;
}

export interface RunHistoryReadResult<T> {
  ok: boolean;
  mode: "live" | "blocked";
  providerId: string;
  value: T | null;
  error?: string;
}

export interface RunCursor {
  createdAt: string;
  runId: string;
}

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
}

export interface RunEventListOptions {
  limit?: number;
  after?: EventCursor;
}

export interface PersistedRunEvent {
  sequence: number;
  event: RunEvent;
}

export interface RunHistoryStore {
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
  getRun(runId: string): Promise<RunHistoryReadResult<RunSummary>>;
  listRuns(
    options?: RunListOptions,
  ): Promise<RunHistoryReadResult<Page<RunSummary, RunCursor>>>;
  listRunEvents(
    runId: string,
    options?: RunEventListOptions,
  ): Promise<RunHistoryReadResult<Page<PersistedRunEvent, EventCursor>>>;
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
}

function readSummary(db: DatabaseSync, runId: string): RunSummary | null {
  const row = db
    .prepare("SELECT * FROM df_run_summaries WHERE run_id = ?")
    .get(runId) as RunSummaryRow | undefined;
  return row ? rowToSummary(row) : null;
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
    }),
  };
}

function sameEvent(left: RunEvent, right: RunEvent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
    pr_url TEXT
  );
  CREATE INDEX IF NOT EXISTS df_run_summaries_page_idx
    ON df_run_summaries (created_at DESC, run_id DESC);
  CREATE INDEX IF NOT EXISTS df_run_summaries_repo_idx
    ON df_run_summaries (repo, created_at DESC, run_id DESC);
  DROP INDEX IF EXISTS df_run_active_issue_uidx;

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
  });
}

function writeSummary(db: DatabaseSync, summary: RunSummary): void {
  db.prepare(
    `INSERT INTO df_run_summaries (
       run_id, repo, issue, status, stage, created_at, updated_at,
       started_at, completed_at, attempt_count, review_count,
       iteration_count, fix_cycle_count, latency_ms, cost_usd, pr_url
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       pr_url = excluded.pr_url`,
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
  );
}

function writeEvent(db: DatabaseSync, event: RunEvent): void {
  db.prepare(
    `INSERT INTO df_run_events (
       run_id, event_id, type, stage, occurred_at, status, attempt,
       review_round, iteration_count, fix_cycle_count, finding_count,
       resolved_count, accepted_count, latency_ms, cost_usd, pr_url
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

function validateRunCursor(cursor: RunCursor): RunCursor {
  const runId = validateIdentifier(cursor.runId, "cursor.runId");
  const parsed = Date.parse(cursor.createdAt);
  if (!Number.isFinite(parsed)) {
    throw new InvalidRunRecordError(
      "Run history cursor createdAt must be an ISO timestamp.",
    );
  }
  return { runId, createdAt: new Date(parsed).toISOString() };
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
      const accepted = this.transaction((db) => {
        const existingDelivery = db
          .prepare("SELECT run_id FROM df_run_deliveries WHERE delivery_id = ?")
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
          status: "queued",
          stage: "trigger",
          createdAt: createdAt.occurredAt,
          updatedAt: createdAt.occurredAt,
          attemptCount: 0,
          reviewCount: 0,
          iterationCount: 0,
          fixCycleCount: 0,
        });

        writeSummary(db, initial);
        writeEvent(db, createdAt);
        db.prepare(
          "INSERT INTO df_run_deliveries (delivery_id, run_id) VALUES (?, ?)",
        ).run(eventId, runId);
        return { summary: initial, duplicate: false };
      });
      return {
        ok: true,
        mode: "live",
        providerId: this.id,
        value: accepted.summary,
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
    const cursor = options.cursor
      ? validateRunCursor(options.cursor)
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
        clauses.push("(created_at < ? OR (created_at = ? AND run_id < ?))");
        values.push(cursor.createdAt, cursor.createdAt, cursor.runId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `SELECT * FROM df_run_summaries ${where} ` +
            "ORDER BY created_at DESC, run_id DESC LIMIT ?",
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
            ? { nextCursor: { createdAt: last.createdAt, runId: last.runId } }
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

  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }
}
