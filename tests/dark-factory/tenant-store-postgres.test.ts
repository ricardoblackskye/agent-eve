/**
 * PostgreSQL tenant registry integration tests (#213).
 *
 * Gated on DF_TENANT_TEST_DATABASE_URL. Without a disposable database these are
 * SKIPPED, never faked — an unexercised adapter must not be reported as passing.
 *
 * Run against a scratch database only: the suite writes and then removes rows.
 */

import { afterAll, describe, expect, it } from "vitest";
import { PostgresTenantStore } from "../../agent/lib/dark-factory/tenant-store-postgres";
import { InvalidTenantError } from "../../agent/lib/dark-factory/tenant";

const DSN = process.env.DF_TENANT_TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

// Unique per run so concurrent runs cannot collide, and cleanup is precise.
const STAMP = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const SLUG_A = `tenant-a-${STAMP}`;
const SLUG_B = `tenant-b-${STAMP}`;
const REPO = `tenant-org-${STAMP}/widgets`;

suite("PostgresTenantStore (integration)", () => {
  const store = new PostgresTenantStore(DSN ?? "");

  afterAll(async () => {
    if (!DSN) return;
    const pool = await import("pg").then(
      ({ Pool }) => new Pool({ connectionString: DSN, max: 1 }),
    );
    await pool.query("DELETE FROM df_tenant_repos WHERE repo_slug = $1", [REPO]);
    await pool.query("DELETE FROM df_tenants WHERE slug = ANY($1)", [[SLUG_A, SLUG_B]]);
    await pool.end();
    store.close();
  });

  it("creates a tenant with an opaque id and persists it", async () => {
    const created = await store.upsertTenant({ slug: SLUG_A, name: "Integration A" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const found = await store.getTenant(created.value.id);
    expect(found.ok && found.value?.slug).toBe(SLUG_A);
  });

  it("keeps the same id when the slug is upserted again", async () => {
    const first = await store.upsertTenant({ slug: SLUG_A, name: "Integration A" });
    const second = await store.upsertTenant({ slug: SLUG_A, name: "Integration A v2" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.id).toBe(first.value.id);
    expect(second.value.name).toBe("Integration A v2");
  });

  it("assigns a repo and resolves it for an active tenant", async () => {
    const created = await store.upsertTenant({ slug: SLUG_A, name: "Integration A" });
    if (!created.ok) throw new Error(created.error);

    const assigned = await store.assignRepo(REPO, created.value.id);
    expect(assigned.ok).toBe(true);

    const resolved = await store.resolveTenantForRepo(REPO);
    expect(resolved.ok && resolved.value.assigned).toBe(true);
    expect(resolved.ok && resolved.value.acceptsWork).toBe(true);
  });

  it("is idempotent for the same repo and tenant pair", async () => {
    const created = await store.upsertTenant({ slug: SLUG_A, name: "Integration A" });
    if (!created.ok) throw new Error(created.error);

    const first = await store.assignRepo(REPO, created.value.id);
    const second = await store.assignRepo(REPO, created.value.id);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.assignedAt).toBe(first.value.assignedAt);
  });

  it("resolves but refuses work for an inactive tenant", async () => {
    const created = await store.upsertTenant({ slug: SLUG_B, name: "Integration B" });
    if (!created.ok) throw new Error(created.error);

    await store.setTenantStatus(created.value.id, "inactive");
    const resolved = await store.resolveTenantForRepo(REPO);
    // REPO still points at tenant A, so it should remain accepted here.
    expect(resolved.ok && resolved.value.acceptsWork).toBe(true);

    const refused = await store.assignRepo(`tenant-org-${STAMP}/other`, created.value.id);
    expect(refused.ok).toBe(false);
  });

  it("reports an unassigned repo as assigned:false", async () => {
    const resolved = await store.resolveTenantForRepo(`tenant-org-${STAMP}/never`);
    expect(resolved.ok && resolved.value.assigned).toBe(false);
  });

  it("still rejects a hostile repo slug loudly", async () => {
    await expect(store.resolveTenantForRepo("owner/$(whoami)")).rejects.toThrow(
      InvalidTenantError,
    );
  });
});