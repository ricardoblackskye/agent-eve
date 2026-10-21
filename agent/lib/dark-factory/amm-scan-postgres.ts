/**
 * #424 — the Postgres driver for AMM scans. Same interface as the SQLite store, so the pages cannot tell them apart.
 */
import { Pool } from "pg";

import type { AmmScan } from "./amm-readiness";
import {
  ammScanRowId,
  assertTriad,
  type AmmScanStore,
  type ReadResult,
  type StoredAmmScan,
  type WriteResult,
} from "./amm-scan-store";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS df_amm_scans (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    tenant_id TEXT,
    scanned_at TEXT NOT NULL,
    catalogue_version TEXT NOT NULL,
    points INTEGER NOT NULL,
    level INTEGER NOT NULL,
    label TEXT NOT NULL,
    scan_json JSONB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS df_amm_scans_repo_idx ON df_amm_scans (repo, scanned_at DESC);
  CREATE INDEX IF NOT EXISTS df_amm_scans_tenant_idx ON df_amm_scans (tenant_id, scanned_at DESC);
`;

export interface PostgresAmmScanStoreOptions {
  connectionString: string;
}

export class PostgresAmmScanStore implements AmmScanStore {
  readonly id = "postgres";
  private readonly pool: Pool;
  private schemaReady: Promise<void> | undefined;

  constructor(options: PostgresAmmScanStoreOptions) {
    this.pool = new Pool({ connectionString: options.connectionString });
  }

  private async ensureSchema(): Promise<void> {
    this.schemaReady ??= this.pool.query(SCHEMA).then(() => undefined);
    await this.schemaReady;
  }

  async recordScan(scan: StoredAmmScan): Promise<WriteResult<StoredAmmScan>> {
    try {
      // Same guard as the SQLite driver: the triad is the invariant, not a per-driver courtesy.
      assertTriad(scan);
      await this.ensureSchema();
      await this.pool.query(
        `INSERT INTO df_amm_scans
           (id, repo, tenant_id, scanned_at, catalogue_version, points, level, label, scan_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          ammScanRowId(scan),
          scan.repo,
          scan.tenantId ?? null,
          scan.scannedAt,
          scan.catalogueVersion,
          scan.overall.points,
          scan.overall.level,
          scan.overall.label,
          JSON.stringify(scan),
        ],
      );
      return { ok: true, value: scan };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async latestScans(
    options: { tenantId?: string; repo?: string; limit?: number } = {},
  ): Promise<ReadResult<StoredAmmScan[]>> {
    try {
      await this.ensureSchema();
      const where: string[] = [];
      const values: (string | number)[] = [];
      if (options.tenantId) {
        values.push(options.tenantId);
        where.push(`tenant_id = $${values.length}`);
      }
      if (options.repo) {
        values.push(options.repo);
        where.push(`repo = $${values.length}`);
      }
      values.push(options.limit ?? 200);
      const { rows } = await this.pool.query(
        `SELECT scan_json FROM (
           SELECT scan_json, repo, scanned_at,
                  ROW_NUMBER() OVER (PARTITION BY tenant_id, repo ORDER BY scanned_at DESC, id DESC) AS rank
           FROM df_amm_scans
           ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ) AS ranked WHERE rank = 1
         ORDER BY scanned_at DESC, repo ASC
         LIMIT $${values.length}`,
        values,
      );
      return { ok: true, value: rows.map((row) => row.scan_json as StoredAmmScan) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async history(
    repo: string,
    options: { tenantId?: string; limit?: number } = {},
  ): Promise<ReadResult<StoredAmmScan[]>> {
    try {
      await this.ensureSchema();
      const values: (string | number)[] = [repo];
      let where = "repo = $1";
      if (options.tenantId) {
        values.push(options.tenantId);
        where += ` AND tenant_id = $${values.length}`;
      }
      values.push(options.limit ?? 200);
      const { rows } = await this.pool.query(
        `SELECT scan_json FROM df_amm_scans WHERE ${where} ORDER BY scanned_at DESC, id DESC LIMIT $${values.length}`,
        values,
      );
      return { ok: true, value: rows.map((row) => row.scan_json as StoredAmmScan) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Exported for the driver test's teardown. */
export type { AmmScan };
