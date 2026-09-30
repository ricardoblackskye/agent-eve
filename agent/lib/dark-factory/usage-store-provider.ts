/**
 * Dark Factory — usage store driver factory (#209, epic #206 R7.3).
 *
 * Recording is OPT-IN: with no driver set the in-memory adapter is used, which
 * writes nowhere external. An explicit `postgres` or `sqlite` driver is required
 * before anything leaves the process, so enabling this feature cannot break an
 * existing deployment.
 *
 * The `isDeployedRuntime` rule is repeated here rather than shared: the same
 * three-line predicate is currently private in `run-history-provider.ts` and
 * inlined in `control.ts` / `cost-budget-store.ts`. Consolidating all four is a
 * cross-module refactor, deliberately out of scope for this issue.
 */

import { InMemoryUsageStore, type UsageStore } from "./usage-store";
import { PostgresUsageStore } from "./usage-store-postgres";
import { SqliteUsageStore } from "./usage-store-sqlite";

export class UsageConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageConfigurationError";
  }
}

const SUPPORTED_DRIVERS =
  "postgres, sqlite (leave unset for the in-memory default)";

function isDeployedRuntime(env: Record<string, string | undefined>): boolean {
  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
  if (nodeEnv === "production") return true;
  const provider = (env.DF_PLATFORM_PROVIDER ?? "").trim().toLowerCase();
  const stage = (provider === "vercel" ? env.VERCEL_ENV : env.DF_DEPLOYMENT_ENV)
    ?.trim()
    .toLowerCase();
  return stage === "preview" || stage === "production";
}

/**
 * Select the usage ledger driver.
 *
 * Unset => in-memory (nothing external is written, recording is inert). An
 * unknown driver THROWS rather than degrading silently, so a typo surfaces as a
 * clear configuration error instead of quietly losing usage data.
 */
export function createUsageStore(
  env: Record<string, string | undefined> = process.env,
): UsageStore {
  const driver = (env.DF_USAGE_DRIVER ?? "").trim().toLowerCase();
  if (driver === "" || driver === "memory") return new InMemoryUsageStore();

  if (driver === "sqlite") {
    if (isDeployedRuntime(env)) {
      throw new UsageConfigurationError(
        "SQLite usage ledger is local-only; use PostgreSQL for deployed environments.",
      );
    }
    const path = (env.DF_USAGE_DB_PATH ?? "").trim();
    if (!path) {
      throw new UsageConfigurationError(
        "DF_USAGE_DRIVER=sqlite requires DF_USAGE_DB_PATH.",
      );
    }
    return new SqliteUsageStore(path);
  }

  if (driver === "postgres") {
    const connectionString = (env.DF_USAGE_DATABASE_URL ?? "").trim();
    if (!connectionString) {
      throw new UsageConfigurationError(
        "DF_USAGE_DRIVER=postgres requires DF_USAGE_DATABASE_URL.",
      );
    }
    if (!/^postgres(?:ql)?:\/\//i.test(connectionString)) {
      throw new UsageConfigurationError(
        "DF_USAGE_DATABASE_URL must use a postgres:// or postgresql:// URL.",
      );
    }
    return new PostgresUsageStore(connectionString);
  }

  throw new UsageConfigurationError(
    `Unknown DF_USAGE_DRIVER '${driver}'. Supported drivers: ${SUPPORTED_DRIVERS}.`,
  );
}

/**
 * Whether usage recording is actually enabled.
 *
 * Callers use this to decide whether to build a recorder at all, so an
 * unconfigured deployment pays no cost and writes no events.
 */
export function isUsageRecordingConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const driver = (env.DF_USAGE_DRIVER ?? "").trim().toLowerCase();
  return driver === "postgres" || driver === "sqlite";
}