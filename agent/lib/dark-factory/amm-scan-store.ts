/**
 * #424 — the storage seam for AMM scans.
 *
 * The model (#382) turns measurements into an `AmmScan`; this seam keeps those scans, attributes them to a tenant, and
 * reads back the newest per repository. The web pages keep reading `AmmReadinessProvider`, so nothing above this
 * changes.
 *
 * THE CONSTRAINT FROM #426: the runner is what decides that a check which could NOT RUN is `unmeasured` rather than
 * absent. So the signal triad is never reduced to a boolean on the way to disk - `state` is carried verbatim, and the
 * write path refuses anything outside the triad rather than storing it and discovering it later. #426 then changes what
 * is MEASURED, not what is STORED.
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { AmmScan } from "./amm-readiness";
import { catalogueVersion } from "./amm-signals";

/** The three things a check can find. A boolean cannot express the third, which is why the schema does not use one. */
export const AMM_SCAN_STATES = ["present", "absent", "unmeasured"] as const;
export type AmmScanState = (typeof AMM_SCAN_STATES)[number];

/** A scan as persisted: the model's own output, plus who it belongs to and which catalogue produced it. */
export interface StoredAmmScan extends AmmScan {
  /** Absent means UNASSIGNED, a legitimate state for scans taken before attribution existed. */
  tenantId?: string;
  /** The catalogue that produced this score. Scores from different versions are not comparable. */
  catalogueVersion: string;
}

export interface WriteResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

export interface ReadResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

export interface AmmScanStore {
  readonly id: string;
  /** Append-only: a repeat scan is a NEW row, because the series is the value. */
  recordScan(scan: StoredAmmScan): Promise<WriteResult<StoredAmmScan>>;
  /** The newest scan per repository - what the list and the detail page display. */
  latestScans(options?: {
    tenantId?: string;
    repo?: string;
    limit?: number;
  }): Promise<ReadResult<StoredAmmScan[]>>;
  /** The full series for one repository, newest first. */
  history(
    repo: string,
    options?: { tenantId?: string; limit?: number },
  ): Promise<ReadResult<StoredAmmScan[]>>;
  close(): void;
}

/**
 * Attach attribution and the catalogue version to a scored scan. The version is read HERE rather than passed in, so a
 * caller cannot stamp a scan with a version that did not produce it.
 */
export function toStoredScan(scan: AmmScan, tenantId?: string): StoredAmmScan {
  return { ...scan, ...(tenantId ? { tenantId } : {}), catalogueVersion: catalogueVersion() };
}

/** The version digest of the scan's own stamp, exposed so a driver can refuse a mixed set at write time too. */
export function scanCatalogueVersion(scan: StoredAmmScan): string {
  return scan.catalogueVersion ?? catalogueVersion();
}

/**
 * Refuse a set of scans that spans catalogue versions. A trend drawn across a weight change is an artifact wearing a
 * trend's clothes, so this is a deliberate act rather than something a caller does by accident.
 */
export function comparable(rows: readonly StoredAmmScan[]): true {
  const versions = new Set(rows.map(scanCatalogueVersion));
  if (versions.size > 1) {
    throw new Error(
      `refusing to compare scans from ${versions.size} catalogue versions (${[...versions].join(", ")}): ` +
        "a score only means something under the weights that produced it",
    );
  }
  return true;
}

/**
 * Fails closed: a signal the model produced outside the triad is a bug, not a row to store.
 *
 * Exported so EVERY driver runs it. Enforcing the #426 constraint in one write path only would mean the other driver
 * accepts a row this one refuses, and the schema would end up carrying a shape #426 has to migrate.
 */
export function assertTriad(scan: StoredAmmScan): void {
  for (const pillar of scan.pillars ?? []) {
    for (const signal of pillar.signals ?? []) {
      const state = signal.state;
      if (state === undefined || !AMM_SCAN_STATES.includes(state)) {
        throw new Error(
          `signal ${signal.id} carries state ${String(state)}, which is not one of ${AMM_SCAN_STATES.join("/")}`,
        );
      }
      if (signal.present !== (state === "present")) {
        throw new Error(`signal ${signal.id} is present=${signal.present} but state=${state}`);
      }
    }
  }
}

export function ammScanRowId(scan: StoredAmmScan): string {
  const tenant = scan.tenantId ?? "-";
  return createHash("sha256").update(`${tenant}\u0000${scan.repo}\u0000${scan.scannedAt}`).digest("hex").slice(0, 32);
}

const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS df_amm_scans (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    tenant_id TEXT,
    scanned_at TEXT NOT NULL,
    catalogue_version TEXT NOT NULL,
    points INTEGER NOT NULL,
    level INTEGER NOT NULL,
    label TEXT NOT NULL,
    scan_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS df_amm_scans_repo_idx ON df_amm_scans (repo, scanned_at DESC);
  CREATE INDEX IF NOT EXISTS df_amm_scans_tenant_idx ON df_amm_scans (tenant_id, scanned_at DESC);
`;

interface Row {
  scan_json: string;
}

function parseRows(rows: readonly Row[]): StoredAmmScan[] {
  return rows.map((row) => JSON.parse(row.scan_json) as StoredAmmScan);
}

/**
 * The local driver. It creates its own schema, as the run-history SQLite store does, so a checkout works without a
 * migration step.
 */
export class SqliteAmmScanStore implements AmmScanStore {
  readonly id = "sqlite";
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(SQLITE_SCHEMA);
  }

  async recordScan(scan: StoredAmmScan): Promise<WriteResult<StoredAmmScan>> {
    try {
      assertTriad(scan);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    const statement = this.database.prepare(
      `INSERT INTO df_amm_scans
         (id, repo, tenant_id, scanned_at, catalogue_version, points, level, label, scan_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    );
    statement.run(
      ammScanRowId(scan),
      scan.repo,
      scan.tenantId ?? null,
      scan.scannedAt,
      scan.catalogueVersion,
      scan.overall.points,
      scan.overall.level,
      scan.overall.label,
      JSON.stringify(scan),
    );
    return { ok: true, value: scan };
  }

  async latestScans(options: { tenantId?: string; repo?: string; limit?: number } = {}) {
    const where: string[] = [];
    const values: (string | number)[] = [];
    if (options.tenantId) {
      where.push("tenant_id = ?");
      values.push(options.tenantId);
    }
    if (options.repo) {
      where.push("repo = ?");
      values.push(options.repo);
    }

    const statement = this.database.prepare(
      `SELECT scan_json FROM (
         SELECT scan_json, repo, scanned_at,
                ROW_NUMBER() OVER (PARTITION BY tenant_id, repo ORDER BY scanned_at DESC, id DESC) AS rank
         FROM df_amm_scans
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ) WHERE rank = 1
       ORDER BY scanned_at DESC, repo ASC
       LIMIT ?`,
    );
    const rows = statement.all(...values, options.limit ?? 200) as unknown as Row[];
    return { ok: true, value: parseRows(rows) };
  }

  async history(repo: string, options: { tenantId?: string; limit?: number } = {}) {
    const values: (string | number)[] = [repo];
    let where = "repo = ?";
    if (options.tenantId) {
      where += " AND tenant_id = ?";
      values.push(options.tenantId);
    }
    const statement = this.database.prepare(
      `SELECT scan_json FROM df_amm_scans WHERE ${where} ORDER BY scanned_at DESC, id DESC LIMIT ?`,
    );
    const rows = statement.all(...values, options.limit ?? 200) as unknown as Row[];
    return { ok: true, value: parseRows(rows) };
  }

  close(): void {
    this.database.close();
  }
}
