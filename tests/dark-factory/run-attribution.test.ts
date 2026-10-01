/**
 * Run attribution at acceptance (#213, epic #212 R1).
 *
 * Resolution is TOTAL: an unconfigured registry, an unassigned repository, a
 * registry outage, or a store that throws all degrade to UNASSIGNED. R1 only
 * RECORDS attribution — refusing to accept a run because it cannot be
 * attributed would break existing operator flows before the repository seed has
 * been applied everywhere. That refusal is R2's job, enforced there.
 */
import { describe, expect, it } from "vitest";
import { resolveRunTenant } from "../../agent/lib/dark-factory/run-attribution";
import type {
  RepoResolution,
  TenantStore,
  TenantStoreResult,
} from "../../agent/lib/dark-factory/tenant-store";
import type { Tenant } from "../../agent/lib/dark-factory/tenant";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

function tenant(status: Tenant["status"] = "active"): Tenant {
  return {
    id: TENANT_ID,
    slug: "acme",
    name: "Acme",
    status,
    createdAt: "2026-09-24T12:00:00.000Z",
  };
}

/** Minimal fake: only the method under test matters. */
function fakeStore(
  impl: (repo: string) => Promise<TenantStoreResult<RepoResolution>>,
): TenantStore {
  return { resolveTenantForRepo: impl } as unknown as TenantStore;
}

function resolution(overrides: Partial<RepoResolution>): RepoResolution {
  return {
    repoSlug: "owner/repo",
    assigned: false,
    tenant: null,
    acceptsWork: false,
    ...overrides,
  };
}

describe("resolveRunTenant", () => {
  it("returns the tenant id for an assigned, active repository", async () => {
    const store = fakeStore(async () => ({
      ok: true,
      value: resolution({ assigned: true, tenant: tenant("active"), acceptsWork: true }),
    }));
    expect(await resolveRunTenant(store, "owner/repo")).toBe(TENANT_ID);
  });

  it("still attributes an INACTIVE tenant (history must not be rewritten)", async () => {
    const store = fakeStore(async () => ({
      ok: true,
      value: resolution({ assigned: true, tenant: tenant("inactive"), acceptsWork: false }),
    }));
    expect(await resolveRunTenant(store, "owner/repo")).toBe(TENANT_ID);
  });

  it("returns undefined for an unassigned repository (not an error)", async () => {
    const store = fakeStore(async () => ({ ok: true, value: resolution({}) }));
    expect(await resolveRunTenant(store, "owner/repo")).toBeUndefined();
  });

  it("degrades to unassigned on a registry OUTAGE rather than refusing the run", async () => {
    const store = fakeStore(async () => ({ ok: false, error: "registry unavailable" }));
    expect(await resolveRunTenant(store, "owner/repo")).toBeUndefined();
  });

  it("degrades to unassigned when the store THROWS", async () => {
    const store = fakeStore(async () => {
      throw new Error("connection reset");
    });
    expect(await resolveRunTenant(store, "owner/repo")).toBeUndefined();
  });

  it("writes no attribution when no registry is configured", async () => {
    expect(await resolveRunTenant(undefined, "owner/repo")).toBeUndefined();
  });
});