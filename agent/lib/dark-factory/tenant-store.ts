/**
 * Dark Factory — tenant store seam (#213, epic #212 R1).
 *
 * The contract every backend (in-memory, SQLite, Postgres) must satisfy, so the
 * rest of the system never learns which one is configured.
 *
 * Two error shapes, deliberately distinct:
 *
 *  - **Invalid input** (a malformed id, slug, name, or repo) throws
 *    `InvalidTenantError`. That is a programmer or configuration defect, and it
 *    should be loud.
 *  - **A handled-but-unsuccessful call** (unknown tenant, inactive tenant, a
 *    driver outage) returns `{ ok: false, error }`. A real driver can also
 *    REJECT, so every call is wrapped and converted to this same shape —
 *    otherwise a store outage surfaces as a rejected promise that terminates
 *    the caller.
 *
 * "Not found" is NOT an error: `getTenant` returns `{ ok: true, value: null }`,
 * so "no such tenant" stays distinct from "cannot read the store".
 */

import {
  type Tenant,
  type TenantStatus,
  InvalidTenantError,
  isTenantActive,
  newTenantId,
  normalizeRepoSlug,
  validateTenantId,
  validateTenantSlug,
} from "./tenant";

export type TenantStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface RepoAssignment {
  /** Canonical lowercase `owner/repo`. */
  repoSlug: string;
  tenantId: string;
  /** ISO-8601 UTC. */
  assignedAt: string;
}

export interface RepoResolution {
  repoSlug: string;
  /** False when no tenant is assigned. Not an error. */
  assigned: boolean;
  /** The assigned tenant, even when inactive (historical attribution). */
  tenant: Tenant | null;
  /** True only when assigned AND the tenant is active. */
  acceptsWork: boolean;
}

export interface UpsertTenantInput {
  slug: string;
  name: string;
  status?: TenantStatus;
}

export interface TenantStore {
  upsertTenant(input: UpsertTenantInput): Promise<TenantStoreResult<Tenant>>;
  getTenant(id: string): Promise<TenantStoreResult<Tenant | null>>;
  listTenants(): Promise<TenantStoreResult<Tenant[]>>;
  setTenantStatus(
    id: string,
    status: TenantStatus,
  ): Promise<TenantStoreResult<Tenant>>;
  assignRepo(
    repoSlug: string,
    tenantId: string,
  ): Promise<TenantStoreResult<RepoAssignment>>;
  resolveTenantForRepo(repoSlug: string): Promise<TenantStoreResult<RepoResolution>>;
  listRepoAssignments(): Promise<TenantStoreResult<RepoAssignment[]>>;
  /** Present on file-backed adapters; Windows keeps the file locked otherwise. */
  close?(): void;
}

export function validateTenantName(name: string): string {
  if (typeof name !== "string") {
    throw new InvalidTenantError("tenant name must be a string");
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new InvalidTenantError("tenant name must not be empty");
  }
  return trimmed;
}

export function validateTenantStatus(status: TenantStatus): TenantStatus {
  if (status !== "active" && status !== "inactive") {
    throw new InvalidTenantError(
      `tenant status must be active or inactive (received ${JSON.stringify(status)})`,
    );
  }
  return status;
}

/**
 * Convert a driver call into the result shape. Callers must validate their
 * input BEFORE calling this, so that only genuine runtime failures are
 * converted — a validation error should still throw.
 */
export async function withTenantStoreResult<T>(
  call: () => Promise<T>,
): Promise<TenantStoreResult<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** In-memory store: the inert default, and the reference implementation. */
export class InMemoryTenantStore implements TenantStore {
  private readonly tenants = new Map<string, Tenant>();
  private readonly assignments = new Map<string, RepoAssignment>();

  async upsertTenant(input: UpsertTenantInput): Promise<TenantStoreResult<Tenant>> {
    const slug = validateTenantSlug(input.slug);
    const name = validateTenantName(input.name);
    if (input.status !== undefined) validateTenantStatus(input.status);

    const existing = [...this.tenants.values()].find((t) => t.slug === slug);
    if (existing) {
      const updated: Tenant = {
        ...existing,
        name,
        status: input.status ?? existing.status,
      };
      this.tenants.set(updated.id, updated);
      return { ok: true, value: updated };
    }

    const created: Tenant = {
      id: newTenantId(),
      slug,
      name,
      status: input.status ?? "active",
      createdAt: new Date().toISOString(),
    };
    this.tenants.set(created.id, created);
    return { ok: true, value: created };
  }

  async getTenant(id: string): Promise<TenantStoreResult<Tenant | null>> {
    const valid = validateTenantId(id);
    return { ok: true, value: this.tenants.get(valid) ?? null };
  }

  async listTenants(): Promise<TenantStoreResult<Tenant[]>> {
    const all = [...this.tenants.values()].sort((a, b) => a.slug.localeCompare(b.slug));
    return { ok: true, value: all };
  }

  async setTenantStatus(
    id: string,
    status: TenantStatus,
  ): Promise<TenantStoreResult<Tenant>> {
    const valid = validateTenantId(id);
    const nextStatus = validateTenantStatus(status);
    const existing = this.tenants.get(valid);
    if (!existing) {
      return { ok: false, error: `unknown tenant ${valid}` };
    }
    const updated: Tenant = { ...existing, status: nextStatus };
    this.tenants.set(valid, updated);
    return { ok: true, value: updated };
  }

  async assignRepo(
    repoSlug: string,
    tenantId: string,
  ): Promise<TenantStoreResult<RepoAssignment>> {
    const slug = normalizeRepoSlug(repoSlug);
    const id = validateTenantId(tenantId);

    const tenant = this.tenants.get(id);
    if (!tenant) {
      return { ok: false, error: `unknown tenant ${id}` };
    }
    if (!isTenantActive(tenant)) {
      return {
        ok: false,
        error: `tenant ${tenant.slug} is inactive and cannot accept new work`,
      };
    }

    const existing = this.assignments.get(slug);
    if (existing && existing.tenantId === id) {
      // Idempotent: preserve the original assignment timestamp.
      return { ok: true, value: existing };
    }

    const assignment: RepoAssignment = {
      repoSlug: slug,
      tenantId: id,
      assignedAt: new Date().toISOString(),
    };
    this.assignments.set(slug, assignment);
    return { ok: true, value: assignment };
  }

  async resolveTenantForRepo(
    repoSlug: string,
  ): Promise<TenantStoreResult<RepoResolution>> {
    const slug = normalizeRepoSlug(repoSlug);
    const assignment = this.assignments.get(slug);
    if (!assignment) {
      return {
        ok: true,
        value: { repoSlug: slug, assigned: false, tenant: null, acceptsWork: false },
      };
    }

    const tenant = this.tenants.get(assignment.tenantId) ?? null;
    if (!tenant) {
      // A mapping pointing at a tenant that no longer exists is treated as
      // unassigned: fail closed rather than invent an owner.
      return {
        ok: true,
        value: { repoSlug: slug, assigned: false, tenant: null, acceptsWork: false },
      };
    }

    return {
      ok: true,
      value: {
        repoSlug: slug,
        assigned: true,
        tenant,
        acceptsWork: isTenantActive(tenant),
      },
    };
  }

  async listRepoAssignments(): Promise<TenantStoreResult<RepoAssignment[]>> {
    const all = [...this.assignments.values()].sort((a, b) =>
      a.repoSlug.localeCompare(b.repoSlug),
    );
    return { ok: true, value: all };
  }
}