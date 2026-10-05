/**
 * Dark Factory — PostgreSQL membership store (deployed).
 *
 * Standard `pg` only; no vendor SDK. The schema is also shipped as a
 * source-controlled migration (`db/migrations/008_df_tenant_members.sql` with
 * RLS enabled); `ensureSchema` keeps local and integration runs working without
 * a separate migrate step. The connection stays server-side — there is no
 * browser-to-Postgres path and no public RLS policy.
 */

import { Pool, type PoolClient } from "pg";
import {
  normalizeEmail,
  validateMembership,
  type Membership,
  type MembershipInput,
  type MembershipStatus,
} from "./membership";
import type {
  MembershipStore,
  MembershipStoreListResult,
  MembershipStoreReadResult,
  MembershipStoreWriteResult,
} from "./membership-store";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS df_tenant_members (
    email TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    tenant_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS df_tenant_members_tenant_idx
    ON df_tenant_members (tenant_id);
`;

interface MemberRow {
  email: string;
  role: string;
  tenant_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToMembership(row: MemberRow): Membership {
  return {
    email: row.email,
    role: row.role === "operator" ? "operator" : "customer",
    ...(row.tenant_id === null ? {} : { tenantId: row.tenant_id }),
    status: row.status === "suspended" ? "suspended" : "active",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PostgresMembershipStore implements MembershipStore {
  readonly mode = "postgres" as const;
  readonly id = "postgres";
  private readonly pool: Pool;
  private schemaPromise: Promise<void> | null = null;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 4 });
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = this.pool.query(SCHEMA).then(() => undefined);
    }
    return this.schemaPromise;
  }

  private async query<T extends MemberRow>(
    sql: string,
    params: unknown[],
  ): Promise<T[]> {
    await this.ensureSchema();
    const client: PoolClient = await this.pool.connect();
    try {
      const result = await client.query<T>(sql, params);
      return result.rows;
    } finally {
      client.release();
    }
  }

  async getMembership(email: string): Promise<MembershipStoreReadResult> {
    try {
      const rows = await this.query<MemberRow>(
        "SELECT * FROM df_tenant_members WHERE email = $1",
        [normalizeEmail(email)],
      );
      return { ok: true, value: rows[0] ? rowToMembership(rows[0]) : null };
    } catch (error) {
      return { ok: false, mode: this.mode, providerId: this.id, error: messageOf(error) };
    }
  }

  async listMemberships(): Promise<MembershipStoreListResult> {
    try {
      const rows = await this.query<MemberRow>(
        "SELECT * FROM df_tenant_members ORDER BY email",
        [],
      );
      return { ok: true, value: rows.map(rowToMembership) };
    } catch (error) {
      return { ok: false, mode: this.mode, providerId: this.id, error: messageOf(error) };
    }
  }

  async upsertMembership(
    input: MembershipInput,
  ): Promise<MembershipStoreWriteResult> {
    try {
      const next = validateMembership(input);
      await this.ensureSchema();
      await this.pool.query(
        `INSERT INTO df_tenant_members (email, role, tenant_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (email) DO UPDATE SET
           role = EXCLUDED.role,
           tenant_id = EXCLUDED.tenant_id,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at`,
        [
          next.email,
          next.role,
          next.tenantId ?? null,
          next.status,
          next.createdAt,
          next.updatedAt,
        ],
      );
      const read = await this.getMembership(next.email);
      if (!read.ok || !read.value) {
        return { ok: false, mode: this.mode, providerId: this.id, error: "write did not persist" };
      }
      return { ok: true, value: read.value };
    } catch (error) {
      return { ok: false, mode: this.mode, providerId: this.id, error: messageOf(error) };
    }
  }

  async setMembershipStatus(
    email: string,
    status: MembershipStatus,
  ): Promise<MembershipStoreWriteResult> {
    try {
      const key = normalizeEmail(email);
      await this.ensureSchema();
      const result = await this.pool.query(
        "UPDATE df_tenant_members SET status = $1, updated_at = $2 WHERE email = $3",
        [status, new Date().toISOString(), key],
      );
      if (result.rowCount === 0) {
        return { ok: false, mode: this.mode, providerId: this.id, error: `No membership for ${key}.` };
      }
      const read = await this.getMembership(key);
      if (!read.ok || !read.value) {
        return { ok: false, mode: this.mode, providerId: this.id, error: "write did not persist" };
      }
      return { ok: true, value: read.value };
    } catch (error) {
      return { ok: false, mode: this.mode, providerId: this.id, error: messageOf(error) };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}