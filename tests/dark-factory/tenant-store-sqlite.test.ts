import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteTenantStore } from "../../agent/lib/dark-factory/tenant-store-sqlite";
import { InvalidTenantError } from "../../agent/lib/dark-factory/tenant";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "df-tenant-sqlite-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function newStore(path = join(dir, "tenants.sqlite")) {
  return new SqliteTenantStore({ path });
}

describe("SqliteTenantStore", () => {
  it("creates a tenant with an opaque UUID id", async () => {
    const store = newStore();
    const created = await store.upsertTenant({ slug: "acme", name: "Acme Ltd" });
    expect(created.ok && created.value.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    store.close();
  });

  it("persists across reopen, keeping the same opaque id after a rename", async () => {
    const path = join(dir, "tenants.sqlite");
    const first = newStore(path);
    const created = await first.upsertTenant({ slug: "acme", name: "Acme Ltd" });
    if (!created.ok) throw new Error(created.error);
    first.close();

    const second = newStore(path);
    const renamed = await second.upsertTenant({ slug: "acme", name: "Acme (renamed)" });
    expect(renamed.ok && renamed.value.id).toBe(created.value.id);
    expect(renamed.ok && renamed.value.name).toBe("Acme (renamed)");
    const all = await second.listTenants();
    expect(all.ok && all.value.length).toBe(1);
    second.close();
  });

  it("returns null, not an error, for an unknown tenant", async () => {
    const store = newStore();
    const missing = await store.getTenant("00000000-0000-4000-8000-000000000000");
    expect(missing).toEqual({ ok: true, value: null });
    store.close();
  });

  it("assigns a repo and resolves it, refusing work for an inactive tenant", async () => {
    const store = newStore();
    const created = await store.upsertTenant({ slug: "acme", name: "Acme Ltd" });
    if (!created.ok) throw new Error(created.error);

    const assigned = await store.assignRepo("Acme/Widgets", created.value.id);
    expect(assigned.ok && assigned.value.repoSlug).toBe("acme/widgets");

    const active = await store.resolveTenantForRepo("acme/widgets");
    expect(active.ok && active.value.acceptsWork).toBe(true);

    await store.setTenantStatus(created.value.id, "inactive");
    const inactive = await store.resolveTenantForRepo("acme/widgets");
    expect(inactive.ok && inactive.value.assigned).toBe(true);
    expect(inactive.ok && inactive.value.acceptsWork).toBe(false);
    store.close();
  });

  it("reports an unassigned repo as assigned:false", async () => {
    const store = newStore();
    const resolved = await store.resolveTenantForRepo("nobody/nothing");
    expect(resolved.ok && resolved.value.assigned).toBe(false);
    expect(resolved.ok && resolved.value.tenant).toBeNull();
    store.close();
  });

  it("refuses to assign a repo to an inactive tenant", async () => {
    const store = newStore();
    const created = await store.upsertTenant({ slug: "acme", name: "Acme Ltd" });
    if (!created.ok) throw new Error(created.error);
    await store.setTenantStatus(created.value.id, "inactive");
    const assigned = await store.assignRepo("acme/widgets", created.value.id);
    expect(assigned.ok).toBe(false);
    store.close();
  });

  it("still rejects a hostile repo slug loudly", async () => {
    const store = newStore();
    const created = await store.upsertTenant({ slug: "acme", name: "Acme Ltd" });
    if (!created.ok) throw new Error(created.error);
    await expect(store.assignRepo("owner/$(whoami)", created.value.id)).rejects.toThrow(
      InvalidTenantError,
    );
    store.close();
  });

  it("reports an unreachable store as ok:false, not a throw", async () => {
    const store = new SqliteTenantStore({
      path: join(dir, "absent", "nested", "tenants.sqlite"),
    });
    const result = await store.listTenants();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeTruthy();
    store.close();
  });

  it("close() releases the file so teardown does not fail on Windows", async () => {
    const store = newStore();
    await store.upsertTenant({ slug: "acme", name: "Acme Ltd" });
    store.close();
    expect(() => rmSync(dir, { recursive: true, force: true })).not.toThrow();
  });
});