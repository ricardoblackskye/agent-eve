import { DatabaseSync } from "node:sqlite";
import { PostgresControlAdapter } from "./control-postgres";

export type ControlScope = "factory" | "run";
export type ControlAction = "pause" | "resume" | "stop";
export type ControlStoreMode = "live" | "blocked";

export interface FactoryControlState {
  paused: boolean;
  updatedAt: string;
  actor?: string;
  reason?: string;
}

export interface RunControlState {
  paused: boolean;
  stopped: boolean;
  updatedAt: string;
  actor?: string;
  reason?: string;
}

export interface ControlEvent {
  at: string;
  actor: string;
  action: ControlAction;
  scope: ControlScope;
  runId?: string;
  reason?: string;
}

export interface ControlChange {
  event: ControlEvent;
  factoryState?: FactoryControlState;
  runId?: string;
  runState?: RunControlState;
}

export interface ControlReadResult<T> {
  ok: boolean;
  mode: ControlStoreMode;
  providerId: string;
  value: T | null;
  error?: string;
}

export interface ControlWriteResult {
  ok: boolean;
  mode: ControlStoreMode;
  providerId: string;
  error?: string;
}

export interface ControlStore {
  id: string;
  readFactory(): Promise<ControlReadResult<FactoryControlState>>;
  writeFactory(state: FactoryControlState): Promise<ControlWriteResult>;
  readRun(runId: string): Promise<ControlReadResult<RunControlState>>;
  writeRun(runId: string, state: RunControlState): Promise<ControlWriteResult>;
  appendEvent(event: ControlEvent): Promise<ControlWriteResult>;
  applyChange(change: ControlChange): Promise<ControlWriteResult>;
  listEvents(limit?: number): Promise<ControlReadResult<ControlEvent[]>>;
  close?(): void | Promise<void>;
}

export class InvalidControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidControlError";
  }
}

export class ControlConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlConfigurationError";
  }
}

export function validateControlActor(value: string): string {
  const actor = value.trim();
  if (!actor || actor.length > 256) throw new InvalidControlError("Control actor must be 1..256 characters.");
  return actor;
}

export function validateControlRunId(value: string): string {
  const runId = value.trim();
  if (!runId || runId.length > 256 || [...runId].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new InvalidControlError("runId must be a non-empty identifier of at most 256 characters.");
  }
  return runId;
}

export function validateControlReason(value: string | undefined): string | undefined {
  const reason = value?.trim();
  if (reason && reason.length > 1000) throw new InvalidControlError("Control reason must be <= 1000 characters.");
  return reason || undefined;
}

export function toControlEvent(input: unknown): ControlEvent {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidControlError("Control event must be an object.");
  }
  const raw = input as Record<string, unknown>;
  const actor = typeof raw.actor === "string" ? raw.actor.trim() : "";
  if (!actor || actor.length > 256) {
    throw new InvalidControlError("Control event requires an actor of 1..256 characters.");
  }
  const action = raw.action;
  if (action !== "pause" && action !== "resume" && action !== "stop") {
    throw new InvalidControlError("Control event action must be pause, resume, or stop.");
  }
  const scope = raw.scope;
  if (scope !== "factory" && scope !== "run") {
    throw new InvalidControlError("Control event scope must be factory or run.");
  }
  const runId = typeof raw.runId === "string" ? raw.runId.trim() : "";
  if (scope === "run" && !runId) {
    throw new InvalidControlError("Run-scoped control events require a runId.");
  }
  if (scope === "factory" && runId) {
    throw new InvalidControlError("Factory-scoped control events cannot include a runId.");
  }
  const at = typeof raw.at === "string" ? raw.at.trim() : "";
  if (!at || !Number.isFinite(Date.parse(at))) {
    throw new InvalidControlError("Control event requires a valid timestamp.");
  }
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  if (reason.length > 1000) {
    throw new InvalidControlError("Control event reason must be <= 1000 characters.");
  }
  return {
    at: new Date(at).toISOString(),
    actor,
    action,
    scope,
    ...(runId ? { runId } : {}),
    ...(reason ? { reason } : {}),
  };
}

const NOT_CONFIGURED =
  "Control store is not configured; refusing to change control state.";

export class ConsoleControlProvider implements ControlStore {
  readonly id = "console";
  async readFactory(): Promise<ControlReadResult<FactoryControlState>> {
    return { ok: false, mode: "blocked", providerId: this.id, value: null, error: NOT_CONFIGURED };
  }
  async writeFactory(_state: FactoryControlState): Promise<ControlWriteResult> {
    return { ok: false, mode: "blocked", providerId: this.id, error: NOT_CONFIGURED };
  }
  async readRun(_runId: string): Promise<ControlReadResult<RunControlState>> {
    return { ok: false, mode: "blocked", providerId: this.id, value: null, error: NOT_CONFIGURED };
  }
  async writeRun(_runId: string, _state: RunControlState): Promise<ControlWriteResult> {
    return { ok: false, mode: "blocked", providerId: this.id, error: NOT_CONFIGURED };
  }
  async appendEvent(_event: ControlEvent): Promise<ControlWriteResult> {
    return { ok: false, mode: "blocked", providerId: this.id, error: NOT_CONFIGURED };
  }
  async applyChange(_change: ControlChange): Promise<ControlWriteResult> {
    return { ok: false, mode: "blocked", providerId: this.id, error: NOT_CONFIGURED };
  }
  async listEvents(_limit?: number): Promise<ControlReadResult<ControlEvent[]>> {
    return { ok: false, mode: "blocked", providerId: this.id, value: null, error: NOT_CONFIGURED };
  }
  close(): void {}
}

export class SqliteControlAdapter implements ControlStore {
  readonly id = "sqlite";
  private db: DatabaseSync | null = null;
  private openError: string | null = null;

  constructor(private readonly path: string) {}

  private handle(): DatabaseSync | null {
    if (this.db) return this.db;
    if (this.openError) return null;
    try {
      const db = new DatabaseSync(this.path);
      db.exec(`
        CREATE TABLE IF NOT EXISTS df_factory_control (
          id INTEGER PRIMARY KEY CHECK (id = 1), paused INTEGER NOT NULL,
          updated_at TEXT NOT NULL, actor TEXT, reason TEXT
        );
        CREATE TABLE IF NOT EXISTS df_run_control (
          run_id TEXT PRIMARY KEY, paused INTEGER NOT NULL, stopped INTEGER NOT NULL,
          updated_at TEXT NOT NULL, actor TEXT, reason TEXT
        );
        CREATE TABLE IF NOT EXISTS df_control_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
          actor TEXT NOT NULL, action TEXT NOT NULL, scope TEXT NOT NULL,
          run_id TEXT, reason TEXT
        );
      `);
      this.db = db;
      return db;
    } catch (error) {
      this.openError = this.detail(error);
      return null;
    }
  }

  async readFactory(): Promise<ControlReadResult<FactoryControlState>> {
    const db = this.handle();
    if (!db) return this.failedRead("factory", this.openError ?? "unavailable");
    try {
      const row = db.prepare("SELECT paused, updated_at, actor, reason FROM df_factory_control WHERE id = 1").get() as { paused: number; updated_at: string; actor: string | null; reason: string | null } | undefined;
      return { ok: true, mode: "live", providerId: this.id, value: row ? { paused: row.paused === 1, updatedAt: row.updated_at, ...(row.actor ? { actor: row.actor } : {}), ...(row.reason ? { reason: row.reason } : {}) } : null };
    } catch (error) { return this.failedRead("factory", error); }
  }

  async writeFactory(state: FactoryControlState): Promise<ControlWriteResult> {
    const db = this.handle();
    if (!db) return this.failedWrite("factory", this.openError ?? "unavailable");
    try {
      db.prepare(`INSERT INTO df_factory_control (id, paused, updated_at, actor, reason) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET paused=excluded.paused, updated_at=excluded.updated_at, actor=excluded.actor, reason=excluded.reason`).run(state.paused ? 1 : 0, state.updatedAt, state.actor ?? null, state.reason ?? null);
      return { ok: true, mode: "live", providerId: this.id };
    } catch (error) { return this.failedWrite("factory", error); }
  }

  async readRun(runId: string): Promise<ControlReadResult<RunControlState>> {
    const db = this.handle();
    if (!db) return this.failedRead(runId, this.openError ?? "unavailable");
    try {
      const row = db.prepare("SELECT paused, stopped, updated_at, actor, reason FROM df_run_control WHERE run_id = ?").get(runId) as { paused: number; stopped: number; updated_at: string; actor: string | null; reason: string | null } | undefined;
      return { ok: true, mode: "live", providerId: this.id, value: row ? { paused: row.paused === 1, stopped: row.stopped === 1, updatedAt: row.updated_at, ...(row.actor ? { actor: row.actor } : {}), ...(row.reason ? { reason: row.reason } : {}) } : null };
    } catch (error) { return this.failedRead(runId, error); }
  }

  async writeRun(runId: string, state: RunControlState): Promise<ControlWriteResult> {
    const db = this.handle();
    if (!db) return this.failedWrite(runId, this.openError ?? "unavailable");
    try {
      db.prepare(`INSERT INTO df_run_control (run_id, paused, stopped, updated_at, actor, reason) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET paused=excluded.paused, stopped=excluded.stopped, updated_at=excluded.updated_at, actor=excluded.actor, reason=excluded.reason`).run(runId, state.paused ? 1 : 0, state.stopped ? 1 : 0, state.updatedAt, state.actor ?? null, state.reason ?? null);
      return { ok: true, mode: "live", providerId: this.id };
    } catch (error) { return this.failedWrite(runId, error); }
  }

  async appendEvent(input: ControlEvent): Promise<ControlWriteResult> {
    const event = toControlEvent(input);
    const db = this.handle();
    if (!db) return this.failedWrite("audit", this.openError ?? "unavailable");
    try {
      db.prepare("INSERT INTO df_control_events (at, actor, action, scope, run_id, reason) VALUES (?, ?, ?, ?, ?, ?)").run(event.at, event.actor, event.action, event.scope, event.runId ?? null, event.reason ?? null);
      return { ok: true, mode: "live", providerId: this.id };
    } catch (error) { return this.failedWrite("audit", error); }
  }

  async applyChange(change: ControlChange): Promise<ControlWriteResult> {
    const event = toControlEvent(change.event);
    const db = this.handle();
    if (!db) return this.failedWrite("control change", this.openError ?? "unavailable");
    try {
      db.exec("BEGIN IMMEDIATE");
      if (change.factoryState) {
        const state = change.factoryState;
        db.prepare(`INSERT INTO df_factory_control (id, paused, updated_at, actor, reason)
          VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET paused=excluded.paused,
          updated_at=excluded.updated_at, actor=excluded.actor, reason=excluded.reason`)
          .run(state.paused ? 1 : 0, state.updatedAt, state.actor ?? null, state.reason ?? null);
      }
      if (change.runId && change.runState) {
        const state = change.runState;
        db.prepare(`INSERT INTO df_run_control (run_id, paused, stopped, updated_at, actor, reason)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET paused=excluded.paused,
          stopped=excluded.stopped, updated_at=excluded.updated_at, actor=excluded.actor, reason=excluded.reason`)
          .run(change.runId, state.paused ? 1 : 0, state.stopped ? 1 : 0, state.updatedAt, state.actor ?? null, state.reason ?? null);
      }
      db.prepare("INSERT INTO df_control_events (at, actor, action, scope, run_id, reason) VALUES (?, ?, ?, ?, ?, ?)")
        .run(event.at, event.actor, event.action, event.scope, event.runId ?? null, event.reason ?? null);
      db.exec("COMMIT");
      return { ok: true, mode: "live", providerId: this.id };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* transaction already rolled back */ }
      return this.failedWrite("control change", error);
    }
  }

  async listEvents(limit = 100): Promise<ControlReadResult<ControlEvent[]>> {
    const db = this.handle();
    if (!db) return this.failedRead("audit", this.openError ?? "unavailable");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return this.failedRead("audit", "limit must be an integer in [1, 500]");
    }
    try {
      const rows = db.prepare("SELECT at, actor, action, scope, run_id, reason FROM df_control_events ORDER BY sequence DESC LIMIT ?").all(limit) as Array<{ at: string; actor: string; action: ControlAction; scope: ControlScope; run_id: string | null; reason: string | null }>;
      const value = rows.map((row) => toControlEvent({ at: row.at, actor: row.actor, action: row.action, scope: row.scope, ...(row.run_id ? { runId: row.run_id } : {}), ...(row.reason ? { reason: row.reason } : {}) }));
      return { ok: true, mode: "live", providerId: this.id, value };
    } catch (error) { return this.failedRead("audit", error); }
  }

  private failedRead<T>(where: string, error: unknown): ControlReadResult<T> {
    return { ok: false, mode: "blocked", providerId: this.id, value: null, error: `Control store unreachable; read failed for '${where}': ${this.detail(error)}` };
  }
  private failedWrite(where: string, error: unknown): ControlWriteResult {
    return { ok: false, mode: "blocked", providerId: this.id, error: `Control store write failed for '${where}': ${this.detail(error)}` };
  }
  private detail(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  close(): void { this.db?.close(); this.db = null; }
}

export function createControlStore(env: Record<string, string | undefined> = process.env): ControlStore {
  const driver = (env.DF_CONTROL_DRIVER ?? "").trim().toLowerCase();
  if (!driver || driver === "console") return new ConsoleControlProvider();
  if (driver === "sqlite") {
    const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
    const platform = (env.DF_PLATFORM_PROVIDER ?? "").trim().toLowerCase();
    const stage = (platform === "vercel" ? env.VERCEL_ENV : env.DF_DEPLOYMENT_ENV)?.trim().toLowerCase();
    if (nodeEnv === "production" || stage === "preview" || stage === "production") {
      throw new ControlConfigurationError("SQLite control state is local-only; use PostgreSQL in deployed environments.");
    }
    const path = (env.DF_CONTROL_DB_PATH ?? "").trim();
    if (!path) throw new ControlConfigurationError("DF_CONTROL_DRIVER=sqlite requires DF_CONTROL_DB_PATH.");
    return new SqliteControlAdapter(path);
  }
  if (driver === "postgres") {
    const connectionString = (env.DF_CONTROL_DATABASE_URL ?? env.DF_RUN_HISTORY_DATABASE_URL ?? "").trim();
    if (!connectionString) throw new ControlConfigurationError("DF_CONTROL_DRIVER=postgres requires DF_CONTROL_DATABASE_URL or DF_RUN_HISTORY_DATABASE_URL.");
    if (!/^postgres(?:ql)?:\/\//i.test(connectionString)) {
      throw new ControlConfigurationError("Control database URL must use postgres:// or postgresql://.");
    }
    return new PostgresControlAdapter(connectionString);
  }
  throw new ControlConfigurationError(`Unknown DF_CONTROL_DRIVER '${driver}'. Supported: console, sqlite, postgres.`);
}
