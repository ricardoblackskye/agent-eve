import { describe, expect, it } from "vitest";
import {
  InMemoryTenantStore,
  withTenantStoreResult,
} from "../../agent/lib/dark-factory/tenant-store";
import { InvalidTenantError } from "../../agent/lib/dark-factory/tenant";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function newStore() {
  return new InMemoryTenantStore();
}

async function seeded() {
  const store = await newStore();
  const created = await store.upsertTenant({ slug: "acme", name: "Acme Ltd" });
  if (!created.ok) throw new Error(created.error);
  return { store, tenant: created.value };
}

describe("withTenantStoreResult", () => {
  it("wraps a resolved value as ok:true", async () => {
    await expect(withTenantStoreResult(async () => 42)).resolves.toEqual({
      ok: true,
      value: 42,
    });
  });

  it("converts a driver REJECTION into ok:false rather than throwing", async () => {
    const result = await withTenantStoreResult(async () => {
      throw new Error("connection refused");
    });
    expect(result).toEqual({ ok: false, error: "connection refused" });
  });

  it("stringifies a non-Error rejection", async () => {
    const result = await withTenantStoreResult(async () => {
      throw "boom";
    });
    expect(result).toEqual({ ok: false, error: "boom" });
  });
});

describe("upsertTenant", () => {
  it("creates a tenant with an opaque UUID id and active status", async () => {
    const { tenant } = await seeded();
    expect(tenant.id).toMatch(UUID_RE);
    expect(tenant.slug).toBe("acme");
    expect(tenant.status).toBe("active");
    expect(tenant.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("is idempotent by slug: the SAME id survives a rename", async () => {
    const { store, tenant } = await seeded();
    const again = await store.upsertTenant({ slug: "acme", name: "Acme Ltd (renamed)" });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.id).toBe(tenant.id);
    expect(again.value.name).toBe("Acme Ltd (renamed)");
  });

  it("rejects an empty name rather than storing a blank tenant", async () => {
    const store = await newStore();
    await expect(store.upsertTenant({ slug: "acme", name: "   " })).rejects.toThrow(
      InvalidTenantError,
    );
  });

  it("does not create a second row for the same slug", async () => {
    const { store } = await seeded();
    await store.upsertTenant({ slug: "acme", name: "Acme again" });
    const all = await store.listTenants();
    expect(all.ok && all.value.length).toBe(1);
  });

  it("rejects an invalid slug rather than repairing it", async () => {
    const store = await newStore();
    await expect(
      store.upsertTenant({ slug: "Acme Corp", name: "x" }),
    ).rejects.toThrow(InvalidTenantError);
  });

  it("honours an explicit inactive status on creation", async () => {
    const store = await newStore();
    const created = await store.upsertTenant({
      slug: "old",
      name: "Old Co",
      status: "inactive",
    });
    expect(created.ok && created.value.status).toBe("inactive");
  });
});

describe("getTenant", () => {
  it("returns null (not an error) for an unknown but valid id", async () => {
    const store = await newStore();
    const missing = await store.getTenant("00000000-0000-4000-8000-000000000000");
    expect(missing).toEqual({ ok: true, value: null });
  });

  it("rejects a malformed id loudly", async () => {
    const store = await newStore();
    await expect(store.getTenant("not-a-uuid")).rejects.toThrow(InvalidTenantError);
  });

  it("returns the tenant for a known id", async () => {
    const { store, tenant } = await seeded();
    const found = await store.getTenant(tenant.id);
    expect(found.ok && found.value?.slug).toBe("acme");
  });
});

describe("setTenantStatus", () => {
  it("deactivates a tenant", async () => {
    const { store, tenant } = await seeded();
    const updated = await store.setTenantStatus(tenant.id, "inactive");
    expect(updated.ok && updated.value.status).toBe("inactive");
  });

  it("refuses an unknown tenant with ok:false", async () => {
    const store = await newStore();
    const result = await store.setTenantStatus(
      "00000000-0000-4000-8000-000000000000",
      "inactive",
    );
    expect(result.ok).toBe(false);
  });
});

describe("assignRepo", () => {
  it("stores the canonical lowercase slug", async () => {
    const { store, tenant } = await seeded();
    const assigned = await store.assignRepo("Acme/Widgets", tenant.id);
    expect(assigned.ok && assigned.value.repoSlug).toBe("acme/widgets");
  });

  it("is idempotent: re-assigning the same pair preserves assignedAt", async () => {
    const { store, tenant } = await seeded();
    const first = await store.assignRepo("acme/widgets", tenant.id);
    const second = await store.assignRepo("ACME/Widgets", tenant.id);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.assignedAt).toBe(first.value.assignedAt);
  });

  it("moves a repo to a different tenant (mapping only)", async () => {
    const { store, tenant } = await seeded();
    const other = await store.upsertTenant({ slug: "beta", name: "Beta" });
    if (!other.ok) throw new Error(other.error);
    await store.assignRepo("acme/widgets", tenant.id);
    const moved = await store.assignRepo("acme/widgets", other.value.id);
    expect(moved.ok && moved.value.tenantId).toBe(other.value.id);

    const all = await store.listRepoAssignments();
    expect(all.ok && all.value.length).toBe(1);
  });

  it("refuses an unknown tenant", async () => {
    const { store } = await seeded();
    const result = await store.assignRepo(
      "acme/widgets",
      "00000000-0000-4000-8000-000000000000",
    );
    expect(result.ok).toBe(false);
  });

  it("refuses an inactive tenant", async () => {
    const { store, tenant } = await seeded();
    await store.setTenantStatus(tenant.id, "inactive");
    const result = await store.assignRepo("acme/widgets", tenant.id);
    expect(result.ok).toBe(false);
  });

  it("rejects a hostile repo slug loudly", async () => {
    const { store, tenant } = await seeded();
    await expect(store.assignRepo("owner/$(whoami)", tenant.id)).rejects.toThrow(
      InvalidTenantError,
    );
  });
});

describe("resolveTenantForRepo", () => {
  it("reports an unassigned repo as assigned:false, not an error", async () => {
    const store = await newStore();
    const resolved = await store.resolveTenantForRepo("nobody/nothing");
    expect(resolved).toEqual({
      ok: true,
      value: {
        repoSlug: "nobody/nothing",
        assigned: false,
        tenant: null,
        acceptsWork: false,
      },
    });
  });

  it("accepts work for an assigned, active tenant", async () => {
    const { store, tenant } = await seeded();
    await store.assignRepo("acme/widgets", tenant.id);
    const resolved = await store.resolveTenantForRepo("acme/widgets");
    expect(resolved.ok && resolved.value.acceptsWork).toBe(true);
    expect(resolved.ok && resolved.value.tenant?.slug).toBe("acme");
  });

  it("still resolves an INACTIVE tenant for history, but refuses work", async () => {
    const { store, tenant } = await seeded();
    await store.assignRepo("acme/widgets", tenant.id);
    await store.setTenantStatus(tenant.id, "inactive");
    const resolved = await store.resolveTenantForRepo("acme/widgets");
    expect(resolved.ok && resolved.value.assigned).toBe(true);
    expect(resolved.ok && resolved.value.tenant?.id).toBe(tenant.id);
    expect(resolved.ok && resolved.value.acceptsWork).toBe(false);
  });

  it("matches case-insensitively", async () => {
    const { store, tenant } = await seeded();
    await store.assignRepo("acme/widgets", tenant.id);
    const resolved = await store.resolveTenantForRepo("Acme/Widgets");
    expect(resolved.ok && resolved.value.assigned).toBe(true);
  });

  it("rejects a hostile repo slug loudly", async () => {
    const store = await newStore();
    await expect(store.resolveTenantForRepo("a/b/c")).rejects.toThrow(
      InvalidTenantError,
    );
  });
});