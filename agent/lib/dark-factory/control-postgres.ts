import { Pool } from "pg";
import type {
  ControlChange,
  ControlEvent,
  ControlReadResult,
  ControlStore,
  ControlWriteResult,
  FactoryControlState,
  RunControlState,
} from "./control";
import { toControlEvent } from "./control";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS df_factory_control (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    paused BOOLEAN NOT NULL,
    updated_at TEXT NOT NULL,
    actor TEXT,
    reason TEXT
  );
  CREATE TABLE IF NOT EXISTS df_run_control (
    run_id TEXT PRIMARY KEY,
    paused BOOLEAN NOT NULL,
    stopped BOOLEAN NOT NULL,
    updated_at TEXT NOT NULL,
    actor TEXT,
    reason TEXT
  );
  CREATE TABLE IF NOT EXISTS df_control_events (
    sequence BIGSERIAL PRIMARY KEY,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('pause', 'resume', 'stop')),
    scope TEXT NOT NULL CHECK (scope IN ('factory', 'run')),
    run_id TEXT,
    reason TEXT
  );
`;

interface FactoryRow {
  paused: boolean;
  updated_at: string;
  actor: string | null;
  reason: string | null;
}

interface RunRow extends FactoryRow {
  stopped: boolean;
}

interface EventRow {
  at: string;
  actor: string;
  action: string;
  scope: string;
  run_id: string | null;
  reason: string | null;
}

export class PostgresControlAdapter implements ControlStore {
  readonly id = "postgres";
  private readonly pool: Pool;
  private schemaPromise: Promise<void> | null = null;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 5 });
  }

  private ensureSchema(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = this.pool.query(SCHEMA).then(() => undefined).catch((error) => {
        this.schemaPromise = null;
        throw error;
      });
    }
    return this.schemaPromise;
  }

  private failedRead<T>(error: unknown): ControlReadResult<T> {
    return {
      ok: false,
      mode: "blocked",
      providerId: this.id,
      value: null,
      error: `Control store read failed: ${this.detail(error)}`,
    };
  }

  private failedWrite(error: unknown): ControlWriteResult {
    return {
      ok: false,
      mode: "blocked",
      providerId: this.id,
      error: `Control store write failed: ${this.detail(error)}`,
    };
  }

  private detail(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async readFactory(): Promise<ControlReadResult<FactoryControlState>> {
    try {
      await this.ensureSchema();
      const { rows } = await this.pool.query<FactoryRow>(
        "SELECT paused, updated_at, actor, reason FROM df_factory_control WHERE id = 1",
      );
      const row = rows[0];
      return {
        ok: true,
        mode: "live",
        providerId: this.id,
        value: row
          ? {
              paused: row.paused,
              updatedAt: row.updated_at,
              ...(row.actor ? { actor: row.actor } : {}),
              ...(row.reason ? { reason: row.reason } : {}),
            }
          : null,
      };
    } catch (error) {
      return this.failedRead(error);
    }
  }

  async writeFactory(state: FactoryControlState): Promise<ControlWriteResult> {
    try {
      await this.ensureSchema();
      await this.pool.query(
        `INSERT INTO df_factory_control (id, paused, updated_at, actor, reason)
         VALUES (1, $1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET paused = EXCLUDED.paused,
           updated_at = EXCLUDED.updated_at, actor = EXCLUDED.actor,
           reason = EXCLUDED.reason`,
        [state.paused, state.updatedAt, state.actor ?? null, state.reason ?? null],
      );
      return { ok: true, mode: "live", providerId: this.id };
    } catch (error) {
      return this.failedWrite(error);
    }
  }

  async readRun(runId: string): Promise<ControlReadResult<RunControlState>> {
    try {
      await this.ensureSchema();
      const { rows } = await this.pool.query<RunRow>(
        "SELECT paused, stopped, updated_at, actor, reason FROM df_run_control WHERE run_id = $1",
        [runId],
      );
      const row = rows[0];
      return {
        ok: true,
        mode: "live",
        providerId: this.id,
        value: row
          ? {
              paused: row.paused,
              stopped: row.stopped,
              updatedAt: row.updated_at,
              ...(row.actor ? { actor: row.actor } : {}),
              ...(row.reason ? { reason: row.reason } : {}),
            }
          : null,
      };
    } catch (error) {
      return this.failedRead(error);
    }
  }

  async writeRun(runId: string, state: RunControlState): Promise<ControlWriteResult> {
    try {
      await this.ensureSchema();
      await this.pool.query(
        `INSERT INTO df_run_control (run_id, paused, stopped, updated_at, actor, reason)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (run_id) DO UPDATE SET paused = EXCLUDED.paused,
           stopped = EXCLUDED.stopped, updated_at = EXCLUDED.updated_at,
           actor = EXCLUDED.actor, reason = EXCLUDED.reason`,
        [runId, state.paused, state.stopped, state.updatedAt, state.actor ?? null, state.reason ?? null],
      );
      return { ok: true, mode: "live", providerId: this.id };
    } catch (error) {
      return this.failedWrite(error);
    }
  }

  async appendEvent(input: ControlEvent): Promise<ControlWriteResult> {
    try {
      const event = toControlEvent(input);
      await this.ensureSchema();
      await this.pool.query(
        "INSERT INTO df_control_events (at, actor, action, scope, run_id, reason) VALUES ($1, $2, $3, $4, $5, $6)",
        [event.at, event.actor, event.action, event.scope, event.runId ?? null, event.reason ?? null],
      );
      return { ok: true, mode: "live", providerId: this.id };
    } catch (error) {
      return this.failedWrite(error);
    }
  }

  async applyChange(change: ControlChange): Promise<ControlWriteResult> {
    let client;
    try {
      const event = toControlEvent(change.event);
      await this.ensureSchema();
      client = await this.pool.connect();
      await client.query("BEGIN");
      if (change.factoryState) {
        const state = change.factoryState;
        await client.query(
          `INSERT INTO df_factory_control (id, paused, updated_at, actor, reason)
           VALUES (1, $1, $2, $3, $4)
           ON CONFLICT (id) DO UPDATE SET paused = EXCLUDED.paused,
             updated_at = EXCLUDED.updated_at, actor = EXCLUDED.actor,
             reason = EXCLUDED.reason`,
          [state.paused, state.updatedAt, state.actor ?? null, state.reason ?? null],
        );
      }
      if (change.runId && change.runState) {
        const state = change.runState;
        await client.query(
          `INSERT INTO df_run_control (run_id, paused, stopped, updated_at, actor, reason)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (run_id) DO UPDATE SET paused = EXCLUDED.paused,
             stopped = EXCLUDED.stopped, updated_at = EXCLUDED.updated_at,
             actor = EXCLUDED.actor, reason = EXCLUDED.reason`,
          [change.runId, state.paused, state.stopped, state.updatedAt, state.actor ?? null, state.reason ?? null],
        );
      }
      await client.query(
        "INSERT INTO df_control_events (at, actor, action, scope, run_id, reason) VALUES ($1, $2, $3, $4, $5, $6)",
        [event.at, event.actor, event.action, event.scope, event.runId ?? null, event.reason ?? null],
      );
      await client.query("COMMIT");
      return { ok: true, mode: "live", providerId: this.id };
    } catch (error) {
      if (client) {
        try { await client.query("ROLLBACK"); } catch { /* transaction already rolled back */ }
      }
      return this.failedWrite(error);
    } finally {
      client?.release();
    }
  }

  async listEvents(limit = 100): Promise<ControlReadResult<ControlEvent[]>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return this.failedRead("limit must be an integer in [1, 500]");
    }
    try {
      await this.ensureSchema();
      const { rows } = await this.pool.query<EventRow>(
        "SELECT at, actor, action, scope, run_id, reason FROM df_control_events ORDER BY sequence DESC LIMIT $1",
        [limit],
      );
      const value = rows.map((row) =>
        toControlEvent({
          at: row.at,
          actor: row.actor,
          action: row.action,
          scope: row.scope,
          ...(row.run_id ? { runId: row.run_id } : {}),
          ...(row.reason ? { reason: row.reason } : {}),
        }),
      );
      return { ok: true, mode: "live", providerId: this.id, value };
    } catch (error) {
      return this.failedRead(error);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
