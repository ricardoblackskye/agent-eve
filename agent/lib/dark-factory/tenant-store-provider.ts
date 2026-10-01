/**
 * Dark Factory — tenant registry driver factory (#213, epic #212 R1).
 *
 * The registry is OPT-IN: with no driver set the in-memory adapter is used,
 * which writes nowhere external. An explicit `postgres` or `sqlite` driver is
 * required before anything leaves the process, so enabling tenant attribution
 * cannot break an existing deployment.
 *
 * The `isDeployedRuntime` rule is repeated here rather than shared: the same
 * three-line predicate is private in `run-history-provider.ts` and inlined in
 * `control.ts` / `cost-budget-store.ts` / `usage-store-provider.ts`.
 * Consolidating all of them is a cross-module refactor, deliberately out of
 * scope for this issue.
 */

import { InMemoryTenantStore, type TenantStore } from "./tenant-store";
import { PostgresTenantStore } from "./tenant-store-postgres";
import { SqliteTenantStore } from "./tenant-store-sqlite";

export class TenantConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantConfigurationError";
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
 * Select the tenant registry driver.
 *
 * Unset => in-memory (nothing external is written). An unknown driver THROWS
 * rather than degrading silently, so a typo surfaces as a clear configuration
 * error instead of quietly losing attribution.
 */
export function createTenantStore(
  env: Record<string, string | undefined> = process.env,
): TenantStore {
  const driver = (env.DF_TENANT_DRIVER ?? "").trim().toLowerCase();
  if (driver === "" || driver === "memory") return new InMemoryTenantStore();

  if (driver === "sqlite") {
    if (isDeployedRuntime(env)) {
      throw new TenantConfigurationError(
        "SQLite tenant registry is local-only; use PostgreSQL for deployed environments.",
      );
    }
    const path = (env.DF_TENANT_DB_PATH ?? "").trim();
    if (!path) {
      throw new TenantConfigurationError(
        "DF_TENANT_DRIVER=sqlite requires DF_TENANT_DB_PATH.",
      );
    }
    return new SqliteTenantStore({ path });
  }

  if (driver === "postgres") {
    const connectionString = (env.DF_TENANT_DATABASE_URL ?? "").trim();
    if (!connectionString) {
      throw new TenantConfigurationError(
        "DF_TENANT_DRIVER=postgres requires DF_TENANT_DATABASE_URL.",
      );
    }
    if (!/^postgres(?:ql)?:\/\//i.test(connectionString)) {
      throw new TenantConfigurationError(
        "DF_TENANT_DATABASE_URL must use a postgres:// or postgresql:// URL.",
      );
    }
    return new PostgresTenantStore(connectionString);
  }

  throw new TenantConfigurationError(
    `Unknown DF_TENANT_DRIVER '${driver}'. Supported drivers: ${SUPPORTED_DRIVERS}.`,
  );
}

/**
 * Whether tenant attribution is actually enabled.
 *
 * Callers use this to decide whether to resolve and persist a tenant at all, so
 * an unconfigured deployment pays no cost and writes no attribution.
 */
export function isTenantRegistryConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const driver = (env.DF_TENANT_DRIVER ?? "").trim().toLowerCase();
  return driver === "postgres" || driver === "sqlite";
}