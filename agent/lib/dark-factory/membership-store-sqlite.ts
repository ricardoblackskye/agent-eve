/**
 * Dark Factory — SQLite membership store (local/test only).
 *
 * Uses `node:sqlite`. The factory refuses this driver in production, so it can
 * never become the deployed source of scope.
 */

import { DatabaseSync } from "node:sqlite";
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

export class SqliteMembershipStore implements MembershipStore {
  readonly mode = "sqlite" as const;
  readonly id = "sqlite";
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  async getMembership(email: string): Promise<MembershipStoreReadResult> {
    try {
      const row = this.db
        .prepare("SELECT * FROM df_tenant_members WHERE email = ?")
        .get(normalizeEmail(email)) as MemberRow | undefined;
      return { ok: true, value: row ? rowToMembership(row) : null };
    } catch (error) {
      return { ok: false, mode: this.mode, providerId: this.id, error: messageOf(error) };
    }
  }

  async listMemberships(): Promise<MembershipStoreListResult> {
    try {
      const rows = this.db
        .prepare("SELECT * FROM df_tenant_members ORDER BY email")
        .all() as unknown as MemberRow[];
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
      this.db
        .prepare(
          `INSERT INTO df_tenant_members (email, role, tenant_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (email) DO UPDATE SET
             role = excluded.role,
             tenant_id = excluded.tenant_id,
             status = excluded.status,
             updated_at = excluded.updated_at`,
        )
        .run(
          next.email,
          next.role,
          next.tenantId ?? null,
          next.status,
          next.createdAt,
          next.updatedAt,
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
      const updated = this.db
        .prepare(
          "UPDATE df_tenant_members SET status = ?, updated_at = ? WHERE email = ?",
        )
        .run(status, new Date().toISOString(), key);
      if (updated.changes === 0) {
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

  close(): void {
    this.db.close();
  }
}