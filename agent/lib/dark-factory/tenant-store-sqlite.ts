/**
 * Dark Factory — local SQLite tenant registry (#213, epic #212 R1).
 *
 * File-backed adapter for local development and contract testing. Local-only:
 * the driver factory refuses it in a deployed runtime.
 *
 * Validation happens OUTSIDE the wrapped driver call, so a malformed id or slug
 * still throws while a genuine database failure becomes `{ ok: false }`.
 */

import { DatabaseSync } from "node:sqlite";
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

const SQLITE_SCHEMA = `
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

export interface SqliteTenantStoreOptions {
  path: string;
  /** Diagnostic id for error messages. */
  id?: string;
  /** Test hook: force the "cannot open" path. */
  openError?: string;
}

export class SqliteTenantStore implements TenantStore {
  private readonly path: string;
  private readonly id: string;
  private openError: string | undefined;
  private db: DatabaseSync | null = null;

  constructor(options: SqliteTenantStoreOptions) {
    this.path = options.path;
    this.id = options.id ?? "sqlite";
    this.openError = options.openError;
    // Deliberately not opened eagerly: an unreachable path must surface as
    // `ok: false` on the call, not as a constructor throw.
  }

  private handle(): DatabaseSync | null {
    if (this.db) return this.db;
    if (this.openError) return null;
    try {
      const db = new DatabaseSync(this.path);
      db.exec(SQLITE_SCHEMA);
      this.db = db;
      return db;
    } catch (error) {
      this.openError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  private unavailable(): Error {
    return new Error(
      `SQLite tenant registry is unavailable at '${this.path}': ${this.openError ?? "unknown error"}`,
    );
  }

  async upsertTenant(input: UpsertTenantInput): Promise<TenantStoreResult<Tenant>> {
    const slug = validateTenantSlug(input.slug);
    const name = validateTenantName(input.name);
    if (input.status !== undefined) validateTenantStatus(input.status);

    return withTenantStoreResult(async () => {
      const db = this.handle();
      if (!db) throw this.unavailable();

      const existing = db
        .prepare("SELECT * FROM df_tenants WHERE slug = ?")
        .get(slug) as unknown as TenantRow | undefined;

      if (existing) {
        const status = input.status ?? (existing.status as TenantStatus);
        db.prepare("UPDATE df_tenants SET name = ?, status = ? WHERE id = ?").run(
          name,
          status,
          existing.id,
        );
        return { ...rowToTenant(existing), name, status };
      }

      const created: Tenant = {
        id: newTenantId(),
        slug,
        name,
        status: input.status ?? "active",
        createdAt: new Date().toISOString(),
      };
      db.prepare(
        "INSERT INTO df_tenants (id, slug, name, status, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(created.id, created.slug, created.name, created.status, created.createdAt);
      return created;
    });
  }

  async getTenant(id: string): Promise<TenantStoreResult<Tenant | null>> {
    const valid = validateTenantId(id);
    return withTenantStoreResult(async () => {
      const db = this.handle();
      if (!db) throw this.unavailable();
      const row = db
        .prepare("SELECT * FROM df_tenants WHERE id = ?")
        .get(valid) as unknown as TenantRow | undefined;
      return row ? rowToTenant(row) : null;
    });
  }

  async listTenants(): Promise<TenantStoreResult<Tenant[]>> {
    return withTenantStoreResult(async () => {
      const db = this.handle();
      if (!db) throw this.unavailable();
      const rows = db
        .prepare("SELECT * FROM df_tenants ORDER BY slug")
        .all() as unknown as TenantRow[];
      return rows.map(rowToTenant);
    });
  }

  async setTenantStatus(
    id: string,
    status: TenantStatus,
  ): Promise<TenantStoreResult<Tenant>> {
    const valid = validateTenantId(id);
    const nextStatus = validateTenantStatus(status);

    return withTenantStoreResult(async () => {
      const db = this.handle();
      if (!db) throw this.unavailable();
      const row = db
        .prepare("SELECT * FROM df_tenants WHERE id = ?")
        .get(valid) as unknown as TenantRow | undefined;
      if (!row) throw new Error(`unknown tenant ${valid}`);
      db.prepare("UPDATE df_tenants SET status = ? WHERE id = ?").run(nextStatus, valid);
      return { ...rowToTenant(row), status: nextStatus };
    });
  }

  async assignRepo(
    repoSlug: string,
    tenantId: string,
  ): Promise<TenantStoreResult<RepoAssignment>> {
    const slug = normalizeRepoSlug(repoSlug);
    const id = validateTenantId(tenantId);

    return withTenantStoreResult(async () => {
      const db = this.handle();
      if (!db) throw this.unavailable();

      const tenantRow = db
        .prepare("SELECT * FROM df_tenants WHERE id = ?")
        .get(id) as unknown as TenantRow | undefined;
      if (!tenantRow) throw new Error(`unknown tenant ${id}`);

      const tenant = rowToTenant(tenantRow);
      if (!isTenantActive(tenant)) {
        throw new Error(
          `tenant ${tenant.slug} is inactive and cannot accept new work`,
        );
      }

      const existing = db
        .prepare("SELECT * FROM df_tenant_repos WHERE repo_slug = ?")
        .get(slug) as unknown as AssignmentRow | undefined;
      if (existing && existing.tenant_id === id) {
        // Idempotent: preserve the original assignment timestamp.
        return rowToAssignment(existing);
      }

      const assignedAt = new Date().toISOString();
      db.prepare(
        `INSERT INTO df_tenant_repos (repo_slug, tenant_id, assigned_at)
         VALUES (?, ?, ?)
         ON CONFLICT(repo_slug) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           assigned_at = excluded.assigned_at`,
      ).run(slug, id, assignedAt);
      return { repoSlug: slug, tenantId: id, assignedAt };
    });
  }

  async resolveTenantForRepo(
    repoSlug: string,
  ): Promise<TenantStoreResult<RepoResolution>> {
    const slug = normalizeRepoSlug(repoSlug);

    return withTenantStoreResult(async () => {
      const db = this.handle();
      if (!db) throw this.unavailable();

      const assignment = db
        .prepare("SELECT * FROM df_tenant_repos WHERE repo_slug = ?")
        .get(slug) as unknown as AssignmentRow | undefined;
      if (!assignment) {
        return {
          repoSlug: slug,
          assigned: false,
          tenant: null,
          acceptsWork: false,
        };
      }

      const tenantRow = db
        .prepare("SELECT * FROM df_tenants WHERE id = ?")
        .get(assignment.tenant_id) as unknown as TenantRow | undefined;
      if (!tenantRow) {
        // Mapping points at a tenant that no longer exists: fail closed.
        return {
          repoSlug: slug,
          assigned: false,
          tenant: null,
          acceptsWork: false,
        };
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
      const db = this.handle();
      if (!db) throw this.unavailable();
      const rows = db
        .prepare("SELECT * FROM df_tenant_repos ORDER BY repo_slug")
        .all() as unknown as AssignmentRow[];
      return rows.map(rowToAssignment);
    });
  }

  /** Idempotent: an open node:sqlite handle locks its file on Windows. */
  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }
}