import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
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
import type {
  AcceptRunDelivery,
  AdvanceRunControlDelivery,
  ClaimRunControlDelivery,
  RunControlDeliveryReceipt,
  RunControlTransition,
  EventCursor,
  Page,
  PersistedRunEvent,
  RunCursor,
  RunEventListOptions,
  RunHistoryReadResult,
  RunHistoryStore,
  RunHistoryWriteResult,
  RunListOptions,
} from "./run-history-store";

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
  attempt_count: string | number;
  review_count: string | number;
  iteration_count: string | number;
  fix_cycle_count: string | number;
  latency_ms: number | null;
  cost_usd: number | null;
  pr_url: string | null;
}

interface RunEventRow {
  sequence: string | number;
  run_id: string;
  event_id: string;
  type: RunEvent["type"];
  stage: RunEvent["stage"];
  occurred_at: string;
  status: RunStatus | null;
  attempt: string | number | null;
  review_round: string | number | null;
  iteration_count: string | number | null;
  fix_cycle_count: string | number | null;
  finding_count: string | number | null;
  resolved_count: string | number | null;
  accepted_count: string | number | null;
  latency_ms: number | null;
  cost_usd: number | null;
  pr_url: string | null;
}

const POSTGRES_SCHEMA = `
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
    attempt_count BIGINT NOT NULL,
    review_count BIGINT NOT NULL,
    iteration_count BIGINT NOT NULL,
    fix_cycle_count BIGINT NOT NULL,
    latency_ms DOUBLE PRECISION,
    cost_usd DOUBLE PRECISION,
    pr_url TEXT
  );
  CREATE INDEX IF NOT EXISTS df_run_summaries_page_idx
    ON df_run_summaries (created_at DESC, run_id DESC);
  CREATE INDEX IF NOT EXISTS df_run_summaries_repo_idx
    ON df_run_summaries (repo, created_at DESC, run_id DESC);
  DROP INDEX IF EXISTS df_run_active_issue_uidx;

  CREATE TABLE IF NOT EXISTS df_run_events (
    sequence BIGSERIAL PRIMARY KEY,
    run_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    type TEXT NOT NULL,
    stage TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    status TEXT,
    attempt BIGINT,
    review_round BIGINT,
    iteration_count BIGINT,
    fix_cycle_count BIGINT,
    finding_count BIGINT,
    resolved_count BIGINT,
    accepted_count BIGINT,
    latency_ms DOUBLE PRECISION,
    cost_usd DOUBLE PRECISION,
    pr_url TEXT,
    UNIQUE (run_id, event_id),
    FOREIGN KEY (run_id) REFERENCES df_run_summaries(run_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
  );
  ALTER TABLE df_run_events ADD COLUMN IF NOT EXISTS finding_count BIGINT;
  ALTER TABLE df_run_events ADD COLUMN IF NOT EXISTS resolved_count BIGINT;
  ALTER TABLE df_run_events ADD COLUMN IF NOT EXISTS accepted_count BIGINT;
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
    handoff_sent BOOLEAN NOT NULL DEFAULT FALSE,
    completed BOOLEAN NOT NULL DEFAULT FALSE
  );
  ALTER TABLE df_run_control_receipts ADD COLUMN IF NOT EXISTS handoff_sent BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE df_run_control_receipts ADD COLUMN IF NOT EXISTS completed BOOLEAN NOT NULL DEFAULT FALSE;
`;

function failedWrite<T>(error: unknown): RunHistoryWriteResult<T> {
  return {
    ok: false,
    mode: "blocked",
    providerId: "postgres",
    error: `Run history store write failed: ${error instanceof Error ? error.message : String(error)}`,
  };
}

function failedRead<T>(error: unknown): RunHistoryReadResult<T> {
  return {
    ok: false,
    mode: "blocked",
    providerId: "postgres",
    value: null,
    error: `Run history store read failed: ${error instanceof Error ? error.message : String(error)}`,
  };
}

function rowToSummary(row: RunSummaryRow): RunSummary {
  return toRunSummary({
    runId: row.run_id,
    repo: row.repo,
    issue: Number(row.issue),
    status: row.status,
    stage: row.stage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    attemptCount: Number(row.attempt_count),
    reviewCount: Number(row.review_count),
    iterationCount: Number(row.iteration_count),
    fixCycleCount: Number(row.fix_cycle_count),
    ...(row.latency_ms !== null ? { latencyMs: Number(row.latency_ms) } : {}),
    ...(row.cost_usd !== null ? { costUsd: Number(row.cost_usd) } : {}),
    ...(row.pr_url !== null ? { prUrl: row.pr_url } : {}),
  });
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
      ...(row.attempt !== null ? { attempt: Number(row.attempt) } : {}),
      ...(row.review_round !== null
        ? { reviewRound: Number(row.review_round) }
        : {}),
      ...(row.iteration_count !== null
        ? { iterationCount: Number(row.iteration_count) }
        : {}),
      ...(row.fix_cycle_count !== null
        ? { fixCycleCount: Number(row.fix_cycle_count) }
        : {}),
      ...(row.finding_count !== null
        ? { findingCount: Number(row.finding_count) }
        : {}),
      ...(row.resolved_count !== null
        ? { resolvedCount: Number(row.resolved_count) }
        : {}),
      ...(row.accepted_count !== null
        ? { acceptedCount: Number(row.accepted_count) }
        : {}),
      ...(row.latency_ms !== null ? { latencyMs: Number(row.latency_ms) } : {}),
      ...(row.cost_usd !== null ? { costUsd: Number(row.cost_usd) } : {}),
      ...(row.pr_url !== null ? { prUrl: row.pr_url } : {}),
    }),
  };
}

function sameEvent(left: RunEvent, right: RunEvent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

function insertSummary(
  client: PoolClient,
  summary: RunSummary,
): Promise<unknown> {
  return client.query(
    `INSERT INTO df_run_summaries (
       run_id, repo, issue, status, stage, created_at, updated_at,
       started_at, completed_at, attempt_count, review_count,
       iteration_count, fix_cycle_count, latency_ms, cost_usd, pr_url
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
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
    ],
  );
}

function updateSummary(
  client: PoolClient,
  summary: RunSummary,
): Promise<unknown> {
  return client.query(
    `UPDATE df_run_summaries SET
       repo = $2, issue = $3, status = $4, stage = $5,
       created_at = $6, updated_at = $7, started_at = $8, completed_at = $9,
       attempt_count = $10, review_count = $11, iteration_count = $12,
       fix_cycle_count = $13, latency_ms = $14, cost_usd = $15, pr_url = $16
     WHERE run_id = $1`,
    [
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
    ],
  );
}

function insertEvent(client: PoolClient, event: RunEvent): Promise<unknown> {
  return client.query(
    `INSERT INTO df_run_events (
       run_id, event_id, type, stage, occurred_at, status, attempt,
       review_round, iteration_count, fix_cycle_count, finding_count,
       resolved_count, accepted_count, latency_ms, cost_usd, pr_url
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
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
    ],
  );
}

export class PostgresRunHistoryStore implements RunHistoryStore {
  id = "postgres";
  private readonly connectionString: string;
  private readonly idFactory: () => string;
  private poolPromise: Promise<Pool> | null = null;
  private schemaPromise: Promise<void> | null = null;

  constructor(connectionString: string, idFactory: () => string = randomUUID) {
    this.connectionString = connectionString;
    this.idFactory = idFactory;
  }

  private async pool(): Promise<Pool> {
    if (!this.poolPromise) {
      this.poolPromise = import("pg").then(
        ({ Pool }) =>
          new Pool({ connectionString: this.connectionString, max: 1 }),
      );
    }
    return this.poolPromise;
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = this.pool()
        .then((pool) => pool.query(POSTGRES_SCHEMA))
        .then(() => undefined)
        .catch((error) => {
          this.schemaPromise = null;
          throw error;
        });
    }
    await this.schemaPromise;
  }

  private async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    await this.ensureSchema();
    const client = await (await this.pool()).connect();
    let began = false;
    try {
      await client.query("BEGIN");
      began = true;
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      if (began) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original operation failure.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async acceptDelivery(
    input: AcceptRunDelivery,
  ): Promise<RunHistoryWriteResult<RunSummary>> {
    const deliveryId = validateIdentifier(input.deliveryId, "deliveryId");
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
      const accepted = await this.transaction(async (client) => {
        const runId = this.idFactory();
        const reservation = await client.query<{ run_id: string }>(
          `INSERT INTO df_run_deliveries (delivery_id, run_id)
           VALUES ($1, $2)
           ON CONFLICT (delivery_id) DO NOTHING
           RETURNING run_id`,
          [eventId, runId],
        );
        if (reservation.rowCount === 0) {
          const existing = await client.query<{ run_id: string }>(
            "SELECT run_id FROM df_run_deliveries WHERE delivery_id = $1",
            [eventId],
          );
          const existingRunId = existing.rows[0]?.run_id;
          if (!existingRunId)
            throw new Error(`Delivery '${eventId}' has no run binding.`);
          const summaryResult = await client.query<RunSummaryRow>(
            "SELECT * FROM df_run_summaries WHERE run_id = $1",
            [existingRunId],
          );
          const row = summaryResult.rows[0];
          if (!row)
            throw new Error(
              `Delivery '${eventId}' points to a missing summary.`,
            );
          const summary = rowToSummary(row);
          if (
            summary.repo !== normalizedInput.repo ||
            summary.issue !== normalizedInput.issue
          ) {
            throw new Error(
              `Delivery '${eventId}' was replayed with a different repo/issue identity.`,
            );
          }
          return { summary, duplicate: true };
        }

        const acceptedEvent = toRunEvent({
          eventId,
          runId,
          type: "run.accepted",
          stage: "trigger",
          occurredAt: input.receivedAt,
          status: "queued",
        });
        const summary = toRunSummary({
          runId,
          repo: input.repo,
          issue: input.issue,
          status: "queued",
          stage: "trigger",
          createdAt: acceptedEvent.occurredAt,
          updatedAt: acceptedEvent.occurredAt,
          attemptCount: 0,
          reviewCount: 0,
          iterationCount: 0,
          fixCycleCount: 0,
        });
        await insertSummary(client, summary);
        await insertEvent(client, acceptedEvent);
        return { summary, duplicate: false };
      });
      return {
        ok: true,
        mode: "live",
        providerId: this.id,
        value: accepted.summary,
        duplicate: accepted.duplicate,
      };
    } catch (error) {
      return failedWrite(error);
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
      const claimed = await this.transaction(async (client) => {
        const target = runId
          ? await client.query<RunSummaryRow>(
              "SELECT * FROM df_run_summaries WHERE run_id = $1 FOR UPDATE",
              [runId],
            )
          : null;
        const targetRow = target?.rows[0];
        const targetSummary = targetRow ? rowToSummary(targetRow) : null;
        if (
          runId &&
          (!targetSummary ||
            targetSummary.repo !== repo ||
            targetSummary.issue !== issue)
        ) {
          throw new InvalidRunRecordError(
            "Control delivery runId does not identify the supplied repo and issue.",
          );
        }

        const inserted = await client.query(
          `INSERT INTO df_run_control_receipts
           (delivery_id, repo, issue, transition, run_id, received_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (delivery_id) DO NOTHING
           RETURNING delivery_id`,
          [
            deliveryId,
            repo,
            issue,
            input.transition,
            runId ?? null,
            normalizedAt,
          ],
        );
        if (inserted.rowCount === 0) {
          const existingResult = await client.query<{
            repo: string;
            issue: number;
            transition: RunControlTransition;
            run_id: string | null;
            handoff_sent: boolean;
            completed: boolean;
          }>(
            `SELECT repo, issue, transition, run_id, handoff_sent, completed
             FROM df_run_control_receipts WHERE delivery_id = $1 FOR UPDATE`,
            [deliveryId],
          );
          const existing = existingResult.rows[0];
          if (!existing)
            throw new Error(
              "Control delivery receipt disappeared during claim.",
            );
          if (
            existing.repo !== repo ||
            existing.issue !== issue ||
            existing.transition !== input.transition
          ) {
            throw new InvalidRunRecordError(
              "Control delivery identity was reused with different repo, issue, or transition data.",
            );
          }
          let previousStatus: RunStatus | undefined;
          if (existing.run_id) {
            const previousResult = await client.query<RunSummaryRow>(
              "SELECT * FROM df_run_summaries WHERE run_id = $1",
              [existing.run_id],
            );
            const previousRow = previousResult.rows[0];
            if (previousRow) previousStatus = rowToSummary(previousRow).status;
          }
          return {
            duplicate: true,
            value: {
              deliveryId,
              repo,
              issue,
              transition: input.transition,
              ...(existing.run_id ? { runId: existing.run_id } : {}),
              ...(previousStatus ? { runStatus: previousStatus } : {}),
              handoffSent: existing.handoff_sent,
              completed: existing.completed,
            } satisfies RunControlDeliveryReceipt,
          };
        }

        return {
          duplicate: false,
          value: {
            deliveryId,
            repo,
            issue,
            transition: input.transition,
            ...(runId ? { runId } : {}),
            ...(targetSummary ? { runStatus: targetSummary.status } : {}),
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
      return failedWrite(error);
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
      const advanced = await this.transaction(async (client) => {
        const existingResult = await client.query<{
          repo: string;
          issue: number;
          transition: RunControlTransition;
          run_id: string | null;
          handoff_sent: boolean;
          completed: boolean;
        }>(
          `SELECT repo, issue, transition, run_id, handoff_sent, completed
           FROM df_run_control_receipts WHERE delivery_id = $1 FOR UPDATE`,
          [deliveryId],
        );
        const existing = existingResult.rows[0];
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
        const handoffSent = existing.handoff_sent || input.handoffSent === true;
        const completed = existing.completed || input.completed === true;
        const duplicate =
          (!input.handoffSent || existing.handoff_sent) &&
          (!input.completed || existing.completed);
        await client.query(
          `UPDATE df_run_control_receipts
           SET handoff_sent = handoff_sent OR $2,
               completed = completed OR $3
           WHERE delivery_id = $1`,
          [deliveryId, input.handoffSent === true, input.completed === true],
        );
        const summaryResult = runId
          ? await client.query<RunSummaryRow>(
              "SELECT * FROM df_run_summaries WHERE run_id = $1",
              [runId],
            )
          : null;
        const summaryRow = summaryResult?.rows[0];
        return {
          duplicate,
          value: {
            deliveryId,
            repo,
            issue,
            transition: input.transition,
            ...(runId ? { runId } : {}),
            ...(summaryRow
              ? { runStatus: rowToSummary(summaryRow).status }
              : {}),
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
      return failedWrite(error);
    }
  }

  async appendEvent(
    eventInput: RunEvent,
  ): Promise<RunHistoryWriteResult<RunSummary>> {
    const event = toRunEvent(eventInput);
    try {
      const appended = await this.transaction(async (client) => {
        const summaryResult = await client.query<RunSummaryRow>(
          "SELECT * FROM df_run_summaries WHERE run_id = $1 FOR UPDATE",
          [event.runId],
        );
        const summaryRow = summaryResult.rows[0];
        if (!summaryRow)
          throw new Error(`Run '${event.runId}' does not exist.`);
        const summary = rowToSummary(summaryRow);
        const existingResult = await client.query<RunEventRow>(
          "SELECT * FROM df_run_events WHERE run_id = $1 AND event_id = $2",
          [event.runId, event.eventId],
        );
        const existingRow = existingResult.rows[0];
        if (existingRow) {
          if (!sameEvent(rowToEvent(existingRow).event, event)) {
            throw new Error(
              `Event ID '${event.eventId}' was reused with different event data.`,
            );
          }
          return { summary, duplicate: true };
        }
        const updated = applyRunEvent(summary, event);
        await insertEvent(client, event);
        await updateSummary(client, updated);
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
      return failedWrite(error);
    }
  }

  async getRun(runId: string): Promise<RunHistoryReadResult<RunSummary>> {
    const normalizedId = validateIdentifier(runId, "runId");
    try {
      await this.ensureSchema();
      const result = await (
        await this.pool()
      ).query<RunSummaryRow>(
        "SELECT * FROM df_run_summaries WHERE run_id = $1",
        [normalizedId],
      );
      return {
        ok: true,
        mode: "live",
        providerId: this.id,
        value: result.rows[0] ? rowToSummary(result.rows[0]) : null,
      };
    } catch (error) {
      return failedRead(error);
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
      await this.ensureSchema();
      const values: unknown[] = [];
      const clauses: string[] = [];
      const bind = (value: unknown) => {
        values.push(value);
        return `$${values.length}`;
      };
      if (repo !== undefined) clauses.push(`repo = ${bind(repo)}`);
      if (issue !== undefined) clauses.push(`issue = ${bind(issue)}`);
      if (statuses) {
        clauses.push(
          `status IN (${statuses.map((value) => bind(value)).join(", ")})`,
        );
      } else if (status !== undefined) {
        clauses.push(`status = ${bind(status)}`);
      }
      if (from !== undefined) clauses.push(`created_at >= ${bind(from)}`);
      if (to !== undefined) clauses.push(`created_at < ${bind(to)}`);
      if (cursor) {
        const created = bind(cursor.createdAt);
        const equalCreated = bind(cursor.createdAt);
        const runId = bind(cursor.runId);
        clauses.push(
          `(created_at < ${created} OR (created_at = ${equalCreated} AND run_id < ${runId}))`,
        );
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const result = await (
        await this.pool()
      ).query<RunSummaryRow>(
        `SELECT * FROM df_run_summaries ${where} ORDER BY created_at DESC, run_id DESC LIMIT ${bind(limit + 1)}`,
        values,
      );
      const hasMore = result.rows.length > limit;
      const items = result.rows.slice(0, limit).map(rowToSummary);
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
      return failedRead(error);
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
      await this.ensureSchema();
      const result = await (
        await this.pool()
      ).query<RunEventRow>(
        "SELECT * FROM df_run_events WHERE run_id = $1 AND sequence > $2 ORDER BY sequence ASC LIMIT $3",
        [normalizedId, after, limit + 1],
      );
      const hasMore = result.rows.length > limit;
      const items = result.rows.slice(0, limit).map(rowToEvent);
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
      return failedRead(error);
    }
  }

  async close(): Promise<void> {
    if (!this.poolPromise) return;
    const pool = await this.poolPromise;
    await pool.end();
    this.poolPromise = null;
    this.schemaPromise = null;
  }
}
