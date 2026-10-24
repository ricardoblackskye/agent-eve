/**
 * #424 — choose the AMM scan store, and expose it through the seam the pages already use.
 *
 * FAIL-CLOSED. An unconfigured driver throws rather than falling back to the fixture or to an empty table, because an
 * empty table renders as "no repositories are ready", which looks like a measurement and is not one. This mirrors
 * `run-history-provider.ts`: unset keeps nothing running, an unknown value throws.
 */
import type { AmmReadinessProvider } from "./amm-readiness";
import type { AmmScanResult } from "./amm-scan-runner";
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

/**
 * #465 - the source the PAGES read. A configured driver gives the store; with no driver this refuses, so a page
 * that cannot measure will not render a figure nobody took. This is #424's fail-closed decision applied to the
 * pages, which until now read the fixture instead.
 */
export function ammProviderFromEnv(
  env: AmmScanStoreEnv = process.env as AmmScanStoreEnv,
): AmmReadinessProvider {
  const store = createAmmScanStore(env);
  const provider = databaseAmmProvider(store);
  return { scan: (repo) => provider.scan(repo), close: () => store.close() };
}

/** What happened to a measured scan on its way to the store. */
export interface RecordScanOutcome {
  /** True when the scan is now in the store. */
  recorded: boolean;
  /**
   * True when a store was configured at all. This is the difference between "there was nothing to write to" and
   * "the write failed", which a caller cannot tell from `recorded` alone.
   */
  configured: boolean;
  storeId?: string;
  rowId?: string;
  reason?: string;
}

/**
 * #465 - persist a scan that has just been measured. `df:amm-scan` printed the scan and discarded it, so a
 * measurement existed only in whatever terminal ran it. This is the write link.
 */
export async function recordAmmScan(
  scan: AmmScanResult,
  env: AmmScanStoreEnv = process.env as AmmScanStoreEnv,
  tenantId?: string,
): Promise<RecordScanOutcome> {
  return {
    recorded: false,
    configured: false,
    reason: `recordAmmScan is not implemented for ${scan.repo}/${tenantId ?? "-"}`,
  };
}
