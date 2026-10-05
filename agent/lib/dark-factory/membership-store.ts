/**
 * Dark Factory — membership store seam (#215, epic #212 R3).
 *
 * Provider-neutral: `console` is fail-closed, `sqlite` is local-only, `postgres`
 * is required in deployed environments, plus an in-memory provider for tests.
 * Selected by `DF_MEMBERSHIP_DRIVER`, exactly like the other Dark Factory stores.
 *
 * Membership is resolved on EVERY request from the session email, so a status or
 * scope change takes effect immediately — nothing about scope is cached in the
 * session cookie.
 */

import {
  normalizeEmail,
  validateMembership,
  type Membership,
  type MembershipInput,
  type MembershipStatus,
} from "./membership";
import { PostgresMembershipStore } from "./membership-store-postgres";
import { SqliteMembershipStore } from "./membership-store-sqlite";

export type MembershipStoreMode = "console" | "sqlite" | "postgres" | "memory";

export type MembershipStoreReadResult =
  | { ok: true; value: Membership | null }
  | { ok: false; mode: MembershipStoreMode; providerId: string; error: string };

export type MembershipStoreListResult =
  | { ok: true; value: Membership[] }
  | { ok: false; mode: MembershipStoreMode; providerId: string; error: string };

export type MembershipStoreWriteResult =
  | { ok: true; value: Membership }
  | { ok: false; mode: MembershipStoreMode; providerId: string; error: string };

export interface MembershipStore {
  readonly mode: MembershipStoreMode;
  readonly id: string;
  /** Resolve one membership by email. `value: null` means "no membership". */
  getMembership(email: string): Promise<MembershipStoreReadResult>;
  listMemberships(): Promise<MembershipStoreListResult>;
  upsertMembership(input: MembershipInput): Promise<MembershipStoreWriteResult>;
  setMembershipStatus(
    email: string,
    status: MembershipStatus,
  ): Promise<MembershipStoreWriteResult>;
  close?(): Promise<void> | void;
}

/** A configuration error, distinct from a runtime failure. */
export class MembershipStoreConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MembershipStoreConfigurationError";
  }
}

function blocked(
  mode: MembershipStoreMode,
  providerId: string,
  error: string,
): { ok: false; mode: MembershipStoreMode; providerId: string; error: string } {
  return { ok: false, mode, providerId, error };
}

/**
 * Fail-closed default: refuses every read and write, so a deployment that has
 * not chosen a membership driver denies access rather than granting it.
 */
export class ConsoleMembershipProvider implements MembershipStore {
  readonly mode = "console" as const;
  readonly id = "console";
  private readonly error =
    "Membership store is not configured (console mode refuses all reads and writes).";

  async getMembership(_email: string): Promise<MembershipStoreReadResult> {
    return blocked(this.mode, this.id, this.error);
  }
  async listMemberships(): Promise<MembershipStoreListResult> {
    return blocked(this.mode, this.id, this.error);
  }
  async upsertMembership(
    _input: MembershipInput,
  ): Promise<MembershipStoreWriteResult> {
    return blocked(this.mode, this.id, this.error);
  }
  async setMembershipStatus(
    _email: string,
    _status: MembershipStatus,
  ): Promise<MembershipStoreWriteResult> {
    return blocked(this.mode, this.id, this.error);
  }
}

/** In-memory provider, for tests and local wiring. */
export class InMemoryMembershipProvider implements MembershipStore {
  readonly mode = "memory" as const;
  readonly id = "memory";
  private readonly rows = new Map<string, Membership>();

  async getMembership(email: string): Promise<MembershipStoreReadResult> {
    try {
      return { ok: true, value: this.rows.get(normalizeEmail(email)) ?? null };
    } catch (error) {
      return blocked(this.mode, this.id, messageOf(error));
    }
  }

  async listMemberships(): Promise<MembershipStoreListResult> {
    const value = [...this.rows.values()].sort((a, b) =>
      a.email.localeCompare(b.email),
    );
    return { ok: true, value };
  }

  async upsertMembership(
    input: MembershipInput,
  ): Promise<MembershipStoreWriteResult> {
    try {
      const next = validateMembership(input);
      const existing = this.rows.get(next.email);
      const value: Membership = {
        ...next,
        // The creation time is write-once; only the update time moves.
        createdAt: existing?.createdAt ?? next.createdAt,
      };
      this.rows.set(value.email, value);
      return { ok: true, value };
    } catch (error) {
      return blocked(this.mode, this.id, messageOf(error));
    }
  }

  async setMembershipStatus(
    email: string,
    status: MembershipStatus,
  ): Promise<MembershipStoreWriteResult> {
    try {
      const key = normalizeEmail(email);
      const existing = this.rows.get(key);
      if (!existing) {
        return blocked(this.mode, this.id, `No membership for ${key}.`);
      }
      const value: Membership = {
        ...existing,
        status,
        updatedAt: new Date().toISOString(),
      };
      this.rows.set(key, value);
      return { ok: true, value };
    } catch (error) {
      return blocked(this.mode, this.id, messageOf(error));
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Build the membership store from the environment. Fails closed. */
export function createMembershipStore(
  env: Record<string, string | undefined> = process.env,
): MembershipStore {
  const driver = (env.DF_MEMBERSHIP_DRIVER ?? "console").trim().toLowerCase();

  switch (driver) {
    case "console":
      return new ConsoleMembershipProvider();
    case "memory":
      return new InMemoryMembershipProvider();
    case "sqlite": {
      if ((env.NODE_ENV ?? "").trim().toLowerCase() === "production") {
        throw new MembershipStoreConfigurationError(
          "DF_MEMBERSHIP_DRIVER=sqlite is local-only and is refused in production",
        );
      }
      const path = env.DF_MEMBERSHIP_DATABASE_PATH;
      if (!path) {
        throw new MembershipStoreConfigurationError(
          "DF_MEMBERSHIP_DRIVER=sqlite requires DF_MEMBERSHIP_DATABASE_PATH",
        );
      }
      return new SqliteMembershipStore(path);
    }
    case "postgres": {
      const url = env.DF_MEMBERSHIP_DATABASE_URL ?? env.DF_TENANT_DATABASE_URL;
      if (!url) {
        throw new MembershipStoreConfigurationError(
          "DF_MEMBERSHIP_DRIVER=postgres requires DF_MEMBERSHIP_DATABASE_URL",
        );
      }
      return new PostgresMembershipStore(url);
    }
    default:
      throw new MembershipStoreConfigurationError(
        `Unknown DF_MEMBERSHIP_DRIVER ${JSON.stringify(driver)}; expected console, sqlite, postgres or memory.`,
      );
  }
}