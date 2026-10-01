/**
 * Dark Factory — local SQLite usage ledger (#209, epic #206 R7.3).
 *
 * File-backed adapter for local development and contract testing. Local-only:
 * the driver factory refuses it in a deployed runtime.
 *
 * The read path reuses `summarizeUsage` rather than re-implementing the window
 * and sum semantics in SQL, so a local run and an in-memory run can never
 * disagree about what "measured" means.
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { normalizeRunDateRange } from "./run-history";
import { toUsageEvent, type UsageEvent } from "./usage-ledger";
import {
  summarizeUsage,
  type UsageAggregate,
  type UsageQuery,
  type UsageReadResult,
  type UsageStore,
  type UsageWriteResult,
} from "./usage-store";

const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS df_usage_events (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    pbi_id INTEGER,
    task_type TEXT NOT NULL,
    model TEXT NOT NULL,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost_usd REAL,
    duration_ms INTEGER,
    tenant_id TEXT,
    ts TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS df_usage_events_ts_idx
    ON df_usage_events (ts);
  CREATE INDEX IF NOT EXISTS df_usage_events_model_idx
    ON df_usage_events (model, ts);
  CREATE INDEX IF NOT EXISTS df_usage_events_run_idx
    ON df_usage_events (run_id, ts);
`;

interface UsageRow {
  run_id: string;
  pbi_id: number | null;
  task_type: string;
  model: string;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  tenant_id: string | null;
  ts: string;
}

/** Nullable columns ARE the schema-level expression of "unmeasured is absent". */
function rowToEvent(row: UsageRow): UsageEvent {
  return toUsageEvent({
    runId: row.run_id,
    taskType: row.task_type,
    model: row.model,
    ts: row.ts,
    ...(row.pbi_id !== null ? { pbiId: Number(row.pbi_id) } : {}),
    ...(row.tokens_in !== null ? { tokensIn: Number(row.tokens_in) } : {}),
    ...(row.tokens_out !== null ? { tokensOut: Number(row.tokens_out) } : {}),
    ...(row.cost_usd !== null ? { costUsd: Number(row.cost_usd) } : {}),
    ...(row.duration_ms !== null ? { durationMs: Number(row.duration_ms) } : {}),
    ...(row.tenant_id !== null ? { tenantId: row.tenant_id } : {}),
  });
}

export class SqliteUsageStore implements UsageStore {
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
      this.db = db;
      return db;
    } catch (error) {
      this.openError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  private unavailable(): Error {
    return new Error(
      `SQLite usage ledger is unavailable at '${this.path}': ${this.openError ?? "unknown error"}`,
    );
  }

  async record(event: UsageEvent): Promise<UsageWriteResult> {
    // Validated OUTSIDE the try: a malformed event is a caller bug and throws.
    const normalized = toUsageEvent(event);
    try {
      const db = this.handle();
      if (!db) throw this.unavailable();
      db.prepare(
        `INSERT INTO df_usage_events
           (event_id, run_id, pbi_id, task_type, model,
            tokens_in, tokens_out, cost_usd, duration_ms, tenant_id, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        this.idFactory(),
        normalized.runId,
        normalized.pbiId ?? null,
        normalized.taskType,
        normalized.model,
        normalized.tokensIn ?? null,
        normalized.tokensOut ?? null,
        normalized.costUsd ?? null,
        normalized.durationMs ?? null,
        normalized.tenantId ?? null,
        normalized.ts,
      );
      return { ok: true, mode: "live", providerId: this.id, event: normalized };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        error: `Usage ledger write failed: ${detail}`,
      };
    }
  }

  async aggregate(
    query: UsageQuery = {},
  ): Promise<UsageReadResult<UsageAggregate>> {
    // The window is a caller contract: an invalid range throws rather than
    // being reported as an outage.
    normalizeRunDateRange(query.from, query.to);
    try {
      const db = this.handle();
      if (!db) throw this.unavailable();
      const rows = db
        .prepare("SELECT * FROM df_usage_events")
        .all() as unknown as UsageRow[];
      return {
        ok: true,
        mode: "live",
        providerId: this.id,
        value: summarizeUsage(rows.map(rowToEvent), query),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        value: null,
        error: `Usage ledger read failed: ${detail}`,
      };
    }
  }

  /** Idempotent: an open node:sqlite handle locks its file on Windows. */
  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }
}