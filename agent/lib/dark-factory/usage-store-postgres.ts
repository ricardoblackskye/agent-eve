/**
 * Dark Factory — PostgreSQL usage ledger adapter (#209, epic #206 R7.3).
 *
 * Standard `pg` only; no vendor SDK. The ledger is append-only: events are
 * inserted and never updated or deleted.
 *
 * `summarizeUsage` remains the semantic authority for the window and sum rules;
 * the SQL `WHERE` is only an optimisation, and the same query is re-applied in
 * memory so a row that slipped through the SQL filter still cannot change the
 * answer. That keeps the deployed adapter agreeing with the in-memory one.
 */

import type { Pool } from "pg";
import { normalizeRunDateRange } from "./run-history";
import { randomUUID } from "node:crypto";
import { toUsageEvent, type UsageEvent } from "./usage-ledger";
import {
  summarizeUsage,
  type UsageAggregate,
  type UsageQuery,
  type UsageReadResult,
  type UsageStore,
  type UsageWriteResult,
} from "./usage-store";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS df_usage_events (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    pbi_id INTEGER,
    task_type TEXT NOT NULL,
    model TEXT NOT NULL,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost_usd DOUBLE PRECISION,
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

export class PostgresUsageStore implements UsageStore {
  readonly id = "postgres";
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
        ({ Pool }) => new Pool({ connectionString: this.connectionString, max: 2 }),
      );
    }
    return this.poolPromise;
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = this.pool()
        .then((pool) => pool.query(SCHEMA))
        .then(() => undefined)
        .catch((error) => {
          this.schemaPromise = null;
          throw error;
        });
    }
    await this.schemaPromise;
  }

  private failed(error: unknown, verb: string): string {
    return `Usage ledger ${verb} failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  async record(event: UsageEvent): Promise<UsageWriteResult> {
    // Validated OUTSIDE the try: a malformed event is a caller bug and throws.
    const normalized = toUsageEvent(event);
    try {
      await this.ensureSchema();
      const pool = await this.pool();
      await pool.query(
        `INSERT INTO df_usage_events
           (event_id, run_id, pbi_id, task_type, model,
            tokens_in, tokens_out, cost_usd, duration_ms, tenant_id, ts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
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
        ],
      );
      return { ok: true, mode: "live", providerId: this.id, event: normalized };
    } catch (error) {
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        error: this.failed(error, "write"),
      };
    }
  }

  async aggregate(
    query: UsageQuery = {},
  ): Promise<UsageReadResult<UsageAggregate>> {
    // The window is a caller contract: an invalid range throws.
    const { from, to } = normalizeRunDateRange(query.from, query.to);
    try {
      await this.ensureSchema();
      const pool = await this.pool();

      const clauses: string[] = [];
      const values: (string | number)[] = [];
      const bind = (value: string | number): string => {
        values.push(value);
        return `$${values.length}`;
      };
      if (from !== undefined) clauses.push(`ts >= ${bind(from)}`);
      if (to !== undefined) clauses.push(`ts < ${bind(to)}`);
      if (query.runId !== undefined) clauses.push(`run_id = ${bind(query.runId)}`);
      if (query.model !== undefined) clauses.push(`model = ${bind(query.model)}`);
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";

      const { rows } = await pool.query<UsageRow>(
        `SELECT run_id, pbi_id, task_type, model,
                tokens_in, tokens_out, cost_usd, duration_ms, tenant_id, ts
           FROM df_usage_events${where}`,
        values,
      );
      return {
        ok: true,
        mode: "live",
        providerId: this.id,
        value: summarizeUsage(rows.map(rowToEvent), query),
      };
    } catch (error) {
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        value: null,
        error: this.failed(error, "read"),
      };
    }
  }

  async close(): Promise<void> {
    if (this.poolPromise) {
      const pool = await this.poolPromise;
      await pool.end();
      this.poolPromise = null;
    }
  }
}