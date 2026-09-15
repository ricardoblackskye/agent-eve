import { DatabaseSync } from "node:sqlite";

/**
 * Dark Factory — Stateful Execution Memory (issue #134).
 *
 * A `dark factory` must remember what issue it is working on, which worker it
 * assigned, the outcome of the last test run, and where it is in the multi-step
 * delivery loop. Eve is stateless between requests, so that memory lives in an
 * external store reached through this seam.
 *
 * Mirrors the established provider seam in `agent/lib/backlog-provider.ts`: a
 * canonical, provider-agnostic payload (`ExecutionContext`) plus a provider
 * interface (`StateStore`) with concrete adapters. The default is a
 * fail-closed `console` provider that refuses to pretend it persisted anything.
 */

/**
 * Canonical execution memory for one delivery loop. Provider-agnostic: no
 * vendor fields, just the four facts the ACs require the factory to remember.
 */
export interface ExecutionContext {
  /** The issue/backlog item the loop is currently working on. */
  issue: number;
  /** The worker agent the issue was assigned to. */
  worker: string;
  /** Outcome of the last test run, or null when no test has run yet. */
  lastTest: string | null;
  /** Position in the multi-step delivery loop (e.g. "plan", "implement"). */
  step: string;
}

/**
 * Thrown when an input cannot be normalised into a valid `ExecutionContext`.
 * Named so callers can distinguish a validation failure from a store outage.
 */
export class InvalidExecutionContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidExecutionContextError";
  }
}

/**
 * Normalise an input object into the canonical `ExecutionContext`, keeping only
 * the four canonical fields. Anything else on the input is dropped so
 * provider-specific noise can never leak into persisted state.
 */
export function toExecutionContext(input: Partial<ExecutionContext>): ExecutionContext {
  const { issue, worker, lastTest, step } = input;

  if (typeof issue !== "number" || !Number.isInteger(issue) || issue <= 0) {
    throw new InvalidExecutionContextError(
      `Execution context requires a positive integer "issue" (received ${JSON.stringify(issue)}).`,
    );
  }
  if (typeof worker !== "string" || worker.trim() === "") {
    throw new InvalidExecutionContextError(
      `Execution context requires a non-empty "worker" (received ${JSON.stringify(worker)}).`,
    );
  }
  if (typeof step !== "string" || step.trim() === "") {
    throw new InvalidExecutionContextError(
      `Execution context requires a non-empty "step" (received ${JSON.stringify(step)}).`,
    );
  }
  if (lastTest !== null && lastTest !== undefined && typeof lastTest !== "string") {
    throw new InvalidExecutionContextError(
      `Execution context "lastTest" must be a string or null (received ${JSON.stringify(lastTest)}).`,
    );
  }

  return { issue, worker, lastTest: lastTest ?? null, step };
}

// ---------------------------------------------------------------------------
// StateStore seam
// ---------------------------------------------------------------------------

/**
 * How a state write/read was handled:
 *  - `live`    = a real external store performed the operation.
 *  - `dry-run` = deliberately simulated (no external store involved).
 *  - `blocked` = an active refusal (no store configured, or the store is
 *                unreachable) — distinct from a successful dry run, exactly
 *                like `PublishResult.mode` in `backlog-provider.ts`.
 */
export type StateStoreMode = "live" | "dry-run" | "blocked";

export interface StateWriteResult {
  ok: boolean;
  mode: StateStoreMode;
  providerId: string;
  error?: string;
}

export interface StateReadResult<T = unknown> {
  ok: boolean;
  mode: StateStoreMode;
  providerId: string;
  /** The persisted value, or null when absent/unreadable. */
  value: T | null;
  error?: string;
}

/**
 * Pluggable external state store. Values are provider-agnostic and
 * JSON-serialisable so the same seam serves execution memory (#134) and
 * dispatch state (#138), and so Redis/pgvector can be added as adapters later
 * without touching callers.
 */
export interface StateStore {
  id: string;
  save(key: string, value: unknown): Promise<StateWriteResult>;
  get<T = unknown>(key: string): Promise<StateReadResult<T>>;
  /**
   * Release any held resources (file handle / connection). Optional because a
   * remote store needs nothing, but a file-backed adapter MUST expose it: on
   * Windows an open SQLite handle locks the file against deletion, so callers
   * (and test teardown) need a way to close it.
   */
  close?(): void;
}

/** Canonical key for a delivery loop's execution memory. */
export function deliveryKey(issue: number): string {
  return `delivery:${issue}`;
}

/**
 * Shared refusal message for the fail-closed default. The gate is CLOSED by
 * default: with no store configured we refuse rather than fall back to an
 * in-process store that would silently lose state on the next request (the
 * same stance as `STORY_ALLOWED_REPOS` in `backlog-provider.ts`).
 */
const STATE_NOT_CONFIGURED =
  "External state store is not configured (set DF_STATE_DRIVER, e.g. 'sqlite').";

/** Persist a delivery loop's execution memory under its canonical key. */
export async function saveContext(
  store: StateStore,
  context: ExecutionContext,
): Promise<StateWriteResult> {
  return store.save(deliveryKey(context.issue), context);
}

/** Load a delivery loop's execution memory by issue number. */
export async function loadContext(
  store: StateStore,
  issue: number,
): Promise<StateReadResult<ExecutionContext>> {
  return store.get<ExecutionContext>(deliveryKey(issue));
}

export class ConsoleStateProvider implements StateStore {
  id = "console";

  async save(key: string, value: unknown): Promise<StateWriteResult> {
    return {
      ok: false,
      mode: "blocked",
      providerId: this.id,
      error: `${STATE_NOT_CONFIGURED} Refusing to write '${key}'.`,
    };
  }

  async get<T = unknown>(key: string): Promise<StateReadResult<T>> {
    return {
      ok: false,
      mode: "blocked",
      providerId: this.id,
      value: null,
      error: `${STATE_NOT_CONFIGURED} Refusing to read '${key}'.`,
    };
  }
}

/**
 * File-backed `node:sqlite` adapter — the R1 real external store.
 *
 * Opening is lazy so constructing an adapter can never crash the process: a bad
 * path surfaces as a `blocked` result with an "unreachable" error on the first
 * operation instead (AC3). The connection is cached, which is also what makes
 * the `:memory:` path usable (each new connection would otherwise be a brand
 * new database).
 */
export class SqliteStateAdapter implements StateStore {
  id = "sqlite";
  private readonly path: string;
  private db: DatabaseSync | null = null;
  private openError: string | null = null;

  constructor(path: string) {
    this.path = path;
  }

  /**
   * Lazily open (and cache) the database. A failure is remembered so every
   * later operation reports the same explicit outage instead of retrying a
   * doomed path on each call.
   */
  private handle(): DatabaseSync | null {
    if (this.db) return this.db;
    if (this.openError) return null;
    try {
      const db = new DatabaseSync(this.path);
      db.exec(
        `CREATE TABLE IF NOT EXISTS dark_factory_state (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL,
           updated_at TEXT NOT NULL
         )`,
      );
      this.db = db;
      return db;
    } catch (err) {
      this.openError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /** Build the explicit outage result required by AC3. */
  private unavailable(detail: string): string {
    return `State store unreachable at '${this.path}' (${detail}): ${this.openError ?? "unknown error"}`;
  }

  async save(key: string, value: unknown): Promise<StateWriteResult> {
    const json = JSON.stringify(value);
    if (json === undefined) {
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        error: `State value for '${key}' is not JSON-serialisable.`,
      };
    }

    const db = this.handle();
    if (!db) {
      return { ok: false, mode: "blocked", providerId: this.id, error: this.unavailable("save") };
    }

    try {
      db.prepare(
        `INSERT INTO dark_factory_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(key, json, new Date().toISOString());
      return { ok: true, mode: "live", providerId: this.id };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        error: this.unavailable(`save failed: ${detail}`),
      };
    }
  }

  async get<T = unknown>(key: string): Promise<StateReadResult<T>> {
    const db = this.handle();
    if (!db) {
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        value: null,
        error: this.unavailable("get"),
      };
    }

    try {
      const row = db
        .prepare(`SELECT value FROM dark_factory_state WHERE key = ?`)
        .get(key) as { value?: string } | undefined;
      if (!row || typeof row.value !== "string") {
        return { ok: true, mode: "live", providerId: this.id, value: null };
      }
      try {
        return { ok: true, mode: "live", providerId: this.id, value: JSON.parse(row.value) as T };
      } catch {
        return {
          ok: false,
          mode: "blocked",
          providerId: this.id,
          value: null,
          error: `State store returned corrupt JSON for '${key}'.`,
        };
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        value: null,
        error: this.unavailable(`get failed: ${detail}`),
      };
    }
  }

  /** Release the file handle (Windows will not delete an open SQLite file). */
  close(): void {
    if (!this.db) return;
    try {
      this.db.close();
    } catch {
      // Already closed — nothing to release.
    }
    this.db = null;
  }
}