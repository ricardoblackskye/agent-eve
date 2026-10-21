/**
 * #424 — choose the AMM scan store, and expose it through the seam the pages already use.
 *
 * FAIL-CLOSED. An unconfigured driver throws rather than falling back to the fixture or to an empty table, because an
 * empty table renders as "no repositories are ready", which looks like a measurement and is not one. This mirrors
 * `run-history-provider.ts`: unset keeps nothing running, an unknown value throws.
 */
import type { AmmReadinessProvider } from "./amm-readiness";
import { SqliteAmmScanStore, type AmmScanStore } from "./amm-scan-store";
import { PostgresAmmScanStore } from "./amm-scan-postgres";

export interface AmmScanStoreEnv {
  DF_AMM_SCAN_DRIVER?: string;
  DF_AMM_SCAN_DB_PATH?: string;
  DF_AMM_SCAN_DATABASE_URL?: string;
}

export function createAmmScanStore(env: AmmScanStoreEnv = process.env as AmmScanStoreEnv): AmmScanStore {
  const driver = env.DF_AMM_SCAN_DRIVER;
  if (!driver) {
    throw new Error(
      "DF_AMM_SCAN_DRIVER is not set: refusing to run without a configured scan store, because an unconfigured " +
        "store would render an empty readiness figure that looks like a measurement",
    );
  }

  switch (driver) {
    case "sqlite": {
      if (!env.DF_AMM_SCAN_DB_PATH) {
        throw new Error("DF_AMM_SCAN_DRIVER=sqlite requires DF_AMM_SCAN_DB_PATH");
      }
      return new SqliteAmmScanStore(env.DF_AMM_SCAN_DB_PATH);
    }
    case "postgres": {
      if (!env.DF_AMM_SCAN_DATABASE_URL) {
        throw new Error("DF_AMM_SCAN_DRIVER=postgres requires DF_AMM_SCAN_DATABASE_URL");
      }
      return new PostgresAmmScanStore({ connectionString: env.DF_AMM_SCAN_DATABASE_URL });
    }
    default:
      throw new Error(`unknown DF_AMM_SCAN_DRIVER: ${driver}`);
  }
}

/**
 * The seam the web already reads. A repository nobody has scanned has no scan - the caller decides what to show, and
 * "not measured yet" is a real answer that a fabricated Level 1 would destroy.
 *
 * A read that FAILS throws rather than returning undefined: a broken database must not be indistinguishable from a
 * repository with no scan, or every readiness figure becomes quietly wrong instead of loudly broken.
 */
export function databaseAmmProvider(store: AmmScanStore): AmmReadinessProvider {
  return {
    async scan(repo: string) {
      const result = await store.latestScans({ repo, limit: 1 });
      if (!result.ok) {
        throw new Error(`reading the AMM scan for ${repo} failed: ${result.error ?? "unknown error"}`);
      }
      return result.value?.[0];
    },
  };
}
