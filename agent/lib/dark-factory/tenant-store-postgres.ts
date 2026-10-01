/**
 * Dark Factory — PostgreSQL tenant registry adapter (#213, epic #212 R1).
 *
 * Standard `pg` only; no vendor SDK. The same contract as the in-memory and
 * SQLite adapters, so callers never learn which backend is configured.
 *
 * Validation happens OUTSIDE the wrapped driver call, so a malformed id or slug
 * still throws while a genuine database failure becomes `{ ok: false }`.
 */

import type { Pool } from "pg";
import {
  type Tenant,
  type TenantStatus,
  isTenantActive,
  newTenantId,
  normalizeRepoSlug,
  validateTenantId,
  validateTenantSlug,
} from "./tenant";
import {
  type RepoAssignment,
  type RepoResolution,
  type TenantStore,
  type TenantStoreResult,
  type UpsertTenantInput,
  validateTenantName,
  validateTenantStatus,
  withTenantStoreResult,
} from "./tenant-store";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS df_tenants (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS df_tenant_repos (
    repo_slug TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    assigned_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS df_tenant_repos_tenant_idx
    ON df_tenant_repos (tenant_id);
`;

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  created_at: string;
}

interface AssignmentRow {
  repo_slug: string;
  tenant_id: string;
  assigned_at: string;
}

function rowToTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status as TenantStatus,
    createdAt: row.created_at,
  };
}

function rowToAssignment(row: AssignmentRow): RepoAssignment {
  return {
    repoSlug: row.repo_slug,
    tenantId: row.tenant_id,
    assignedAt: row.assigned_at,
  };
}

export class PostgresTenantStore implements TenantStore {
  readonly id = "postgres";
  private readonly connectionString: string;
  private poolPromise: Promise<Pool> | null = null;
  private schemaPromise: Promise<void> | null = null;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
  }

  private async pool(): Promise<Pool> {
    if (!this.poolPromise) {
      this.poolPromise = import("pg").then(
        ({ Pool }) => new Pool({ connectionString: this.connectionString, max: 2 }),
      );
    }
    return this.poolPromise;
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = (async () => {
        const pool = await this.pool();
        await pool.query(SCHEMA);
      })();
    }
    return this.schemaPromise;
  }

  async upsertTenant(input: UpsertTenantInput): Promise<TenantStoreResult<Tenant>> {
    const slug = validateTenantSlug(input.slug);
    const name = validateTenantName(input.name);
    if (input.status !== undefined) validateTenantStatus(input.status);

    return withTenantStoreResult(async () => {
      await this.ensureSchema();
      const pool = await this.pool();

      const existing = await pool.query<TenantRow>(
        "SELECT * FROM df_tenants WHERE slug = $1",
        [slug],
      );
      const row = existing.rows[0];
      if (row) {
        const status = input.status ?? (row.status as TenantStatus);
        await pool.query("UPDATE df_tenants SET name = $1, status = $2 WHERE id = $3", [
          name,
          status,
          row.id,
        ]);
        return { ...rowToTenant(row), name, status };
      }

      const created: Tenant = {
        id: newTenantId(),
        slug,
        name,
        status: input.status ?? "active",
        createdAt: new Date().toISOString(),
      };
      await pool.query(
        "INSERT INTO df_tenants (id, slug, name, status, created_at) VALUES ($1, $2, $3, $4, $5)",
        [created.id, created.slug, created.name, created.status, created.createdAt],
      );
      return created;
    });
  }

  async getTenant(id: string): Promise<TenantStoreResult<Tenant | null>> {
    const valid = validateTenantId(id);
    return withTenantStoreResult(async () => {
      await this.ensureSchema();
      const pool = await this.pool();
      const result = await pool.query<TenantRow>(
        "SELECT * FROM df_tenants WHERE id = $1",
        [valid],
      );
      const row = result.rows[0];
      return row ? rowToTenant(row) : null;
    });
  }

  async listTenants(): Promise<TenantStoreResult<Tenant[]>> {
    return withTenantStoreResult(async () => {
      await this.ensureSchema();
      const pool = await this.pool();
      const result = await pool.query<TenantRow>(
        "SELECT * FROM df_tenants ORDER BY slug",
      );
      return result.rows.map(rowToTenant);
    });
  }

  async setTenantStatus(
    id: string,
    status: TenantStatus,
  ): Promise<TenantStoreResult<Tenant>> {
    const valid = validateTenantId(id);
    const nextStatus = validateTenantStatus(status);

    return withTenantStoreResult(async () => {
      await this.ensureSchema();
      const pool = await this.pool();
      const result = await pool.query<TenantRow>(
        "UPDATE df_tenants SET status = $1 WHERE id = $2 RETURNING *",
        [nextStatus, valid],
      );
      const row = result.rows[0];
      if (!row) throw new Error(`unknown tenant ${valid}`);
      return rowToTenant(row);
    });
  }

  async assignRepo(
    repoSlug: string,
    tenantId: string,
  ): Promise<TenantStoreResult<RepoAssignment>> {
    const slug = normalizeRepoSlug(repoSlug);
    const id = validateTenantId(tenantId);

    return withTenantStoreResult(async () => {
      await this.ensureSchema();
      const pool = await this.pool();

      const tenantResult = await pool.query<TenantRow>(
        "SELECT * FROM df_tenants WHERE id = $1",
        [id],
      );
      const tenantRow = tenantResult.rows[0];
      if (!tenantRow) throw new Error(`unknown tenant ${id}`);

      const tenant = rowToTenant(tenantRow);
      if (!isTenantActive(tenant)) {
        throw new Error(`tenant ${tenant.slug} is inactive and cannot accept new work`);
      }

      const existingResult = await pool.query<AssignmentRow>(
        "SELECT * FROM df_tenant_repos WHERE repo_slug = $1",
        [slug],
      );
      const existing = existingResult.rows[0];
      if (existing && existing.tenant_id === id) {
        // Idempotent: preserve the original assignment timestamp.
        return rowToAssignment(existing);
      }

      const assignedAt = new Date().toISOString();
      await pool.query(
        `INSERT INTO df_tenant_repos (repo_slug, tenant_id, assigned_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (repo_slug) DO UPDATE SET
           tenant_id = EXCLUDED.tenant_id,
           assigned_at = EXCLUDED.assigned_at`,
        [slug, id, assignedAt],
      );
      return { repoSlug: slug, tenantId: id, assignedAt };
    });
  }

  async resolveTenantForRepo(
    repoSlug: string,
  ): Promise<TenantStoreResult<RepoResolution>> {
    const slug = normalizeRepoSlug(repoSlug);

    return withTenantStoreResult(async () => {
      await this.ensureSchema();
      const pool = await this.pool();

      const assignmentResult = await pool.query<AssignmentRow>(
        "SELECT * FROM df_tenant_repos WHERE repo_slug = $1",
        [slug],
      );
      const assignment = assignmentResult.rows[0];
      if (!assignment) {
        return { repoSlug: slug, assigned: false, tenant: null, acceptsWork: false };
      }

      const tenantResult = await pool.query<TenantRow>(
        "SELECT * FROM df_tenants WHERE id = $1",
        [assignment.tenant_id],
      );
      const tenantRow = tenantResult.rows[0];
      if (!tenantRow) {
        // Mapping points at a tenant that no longer exists: fail closed.
        return { repoSlug: slug, assigned: false, tenant: null, acceptsWork: false };
      }

      const tenant = rowToTenant(tenantRow);
      return {
        repoSlug: slug,
        assigned: true,
        tenant,
        acceptsWork: isTenantActive(tenant),
      };
    });
  }

  async listRepoAssignments(): Promise<TenantStoreResult<RepoAssignment[]>> {
    return withTenantStoreResult(async () => {
      await this.ensureSchema();
      const pool = await this.pool();
      const result = await pool.query<AssignmentRow>(
        "SELECT * FROM df_tenant_repos ORDER BY repo_slug",
      );
      return result.rows.map(rowToAssignment);
    });
  }

  /** Idempotent: releases the pool so a test process can exit cleanly. */
  close(): void {
    const pending = this.poolPromise;
    this.poolPromise = null;
    this.schemaPromise = null;
    if (pending) {
      void pending.then((pool) => pool.end()).catch(() => undefined);
    }
  }
}