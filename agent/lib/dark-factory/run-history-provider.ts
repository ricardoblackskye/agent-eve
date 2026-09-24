import { PostgresRunHistoryStore } from "./run-history-postgres";
import { SqliteRunHistoryStore } from "./run-history-store";
import type {
  AcceptRunDelivery,
  AdvanceRunControlDelivery,
  ClaimRunControlDelivery,
  RunControlDeliveryReceipt,
  EventCursor,
  Page,
  PersistedRunEvent,
  RunEventListOptions,
  RunHistoryReadResult,
  RunHistoryStore,
  RunHistoryWriteResult,
  RunListOptions,
} from "./run-history-store";
import type { RunEvent, RunSummary } from "./run-history";

export class RunHistoryConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunHistoryConfigurationError";
  }
}

const RUN_HISTORY_NOT_CONFIGURED = "Run history provider is not configured.";

function isDeployedRuntime(env: Record<string, string | undefined>): boolean {
  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
  if (nodeEnv === "production") return true;
  const provider = (env.DF_PLATFORM_PROVIDER ?? "").trim().toLowerCase();
  const stage = (provider === "vercel" ? env.VERCEL_ENV : env.DF_DEPLOYMENT_ENV)
    ?.trim()
    .toLowerCase();
  return stage === "preview" || stage === "production";
}

export class ConsoleRunHistoryStore implements RunHistoryStore {
  id = "console";
  async acceptDelivery(
    _input: AcceptRunDelivery,
  ): Promise<RunHistoryWriteResult<RunSummary>> {
    return {
      ok: false,
      mode: "blocked",
      providerId: this.id,
      error: RUN_HISTORY_NOT_CONFIGURED,
    };
  }

  async claimControlDelivery(
    _input: ClaimRunControlDelivery,
  ): Promise<RunHistoryWriteResult<RunControlDeliveryReceipt>> {
    return {
      ok: false,
      mode: "blocked",
      providerId: this.id,
      error: RUN_HISTORY_NOT_CONFIGURED,
    };
  }

  async advanceControlDelivery(
    _input: AdvanceRunControlDelivery,
  ): Promise<RunHistoryWriteResult<RunControlDeliveryReceipt>> {
    return {
      ok: false,
      mode: "blocked",
      providerId: this.id,
      error: RUN_HISTORY_NOT_CONFIGURED,
    };
  }

  async appendEvent(
    _event: RunEvent,
  ): Promise<RunHistoryWriteResult<RunSummary>> {
    return {
      ok: false,
      mode: "blocked",
      providerId: this.id,
      error: RUN_HISTORY_NOT_CONFIGURED,
    };
  }
  async getRun(_runId: string): Promise<RunHistoryReadResult<RunSummary>> {
    return {
      ok: false,
      mode: "blocked",
      providerId: this.id,
      value: null,
      error: RUN_HISTORY_NOT_CONFIGURED,
    };
  }
  async listRuns(
    _options: RunListOptions = {},
  ): Promise<
    RunHistoryReadResult<Page<RunSummary, { createdAt: string; runId: string }>>
  > {
    return {
      ok: false,
      mode: "blocked",
      providerId: this.id,
      value: null,
      error: RUN_HISTORY_NOT_CONFIGURED,
    };
  }
  async listRunEvents(
    _runId: string,
    _options: RunEventListOptions = {},
  ): Promise<RunHistoryReadResult<Page<PersistedRunEvent, EventCursor>>> {
    return {
      ok: false,
      mode: "blocked",
      providerId: this.id,
      value: null,
      error: RUN_HISTORY_NOT_CONFIGURED,
    };
  }
  close(): void {}
}

export function createRunHistoryStore(
  env: Record<string, string | undefined> = process.env,
): RunHistoryStore {
  const driver = (env.DF_RUN_HISTORY_DRIVER ?? "").trim().toLowerCase();
  if (driver === "") return new ConsoleRunHistoryStore();
  if (driver === "sqlite") {
    if (isDeployedRuntime(env)) {
      throw new RunHistoryConfigurationError(
        "SQLite run history is local-only; use PostgreSQL for deployed environments.",
      );
    }
    const path = (env.DF_RUN_HISTORY_DB_PATH ?? "").trim();
    if (!path) {
      throw new RunHistoryConfigurationError(
        "DF_RUN_HISTORY_DRIVER=sqlite requires DF_RUN_HISTORY_DB_PATH.",
      );
    }
    return new SqliteRunHistoryStore(path);
  }
  if (driver === "postgres") {
    const connectionString = (env.DF_RUN_HISTORY_DATABASE_URL ?? "").trim();
    if (!connectionString) {
      throw new RunHistoryConfigurationError(
        "DF_RUN_HISTORY_DRIVER=postgres requires DF_RUN_HISTORY_DATABASE_URL.",
      );
    }
    if (!/^postgres(?:ql)?:\/\//i.test(connectionString)) {
      throw new RunHistoryConfigurationError(
        "DF_RUN_HISTORY_DATABASE_URL must use a postgres:// or postgresql:// URL.",
      );
    }
    return new PostgresRunHistoryStore(connectionString);
  }
  throw new RunHistoryConfigurationError(
    `Unknown DF_RUN_HISTORY_DRIVER '${driver}'. Supported drivers: postgres, sqlite (leave unset to refuse writes).`,
  );
}
