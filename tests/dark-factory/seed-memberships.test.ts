import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCostBudgetProvider } from "../../agent/lib/dark-factory/cost-budget-store";
import { createControlStore } from "../../agent/lib/dark-factory/control";
import { InMemoryMembershipProvider } from "../../agent/lib/dark-factory/membership-store";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import { InMemoryTenantStore } from "../../agent/lib/dark-factory/tenant-store";
import { InMemoryUsageStore } from "../../agent/lib/dark-factory/usage-store";
import { runSeed, type SeedStores } from "../../scripts/seed-test-data";

let dir: string;
let stores: SeedStores;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "df-seed-members-"));
  stores = {
    tenant: new InMemoryTenantStore(),
    usage: new InMemoryUsageStore(),
    cost: new InMemoryCostBudgetProvider(),
    runHistory: new SqliteRunHistoryStore(join(dir, "runs.sqlite")),
    control: createControlStore({
      DF_CONTROL_DRIVER: "sqlite",
      DF_CONTROL_DB_PATH: join(dir, "control.sqlite"),
    }),
    membership: new InMemoryMembershipProvider(),
  };
});

afterEach(() => {
  stores.tenant.close?.();
  stores.usage.close();
  stores.cost.close?.();
  stores.runHistory.close();
  stores.control.close?.();
  stores.membership.close?.();
  rmSync(dir, { recursive: true, force: true });
});

describe("seed memberships (#215)", () => {
  it("grants one operator and one customer per tenant, keyed by the slug", async () => {
    const res = await runSeed(stores, { scenarios: ["multi-tenant"] });
    expect(res.ok).toBe(true);

    const listed = await stores.membership.listMemberships();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const byEmail = new Map(
      listed.value.map((member) => [member.email, member]),
    );

    // The email IS the slug — a `seed-` prefix added to a `seed-*` slug
    // produced `seed-seed-alpha@example.com`, which nobody would type.
    expect([...byEmail.keys()].sort()).toEqual([
      "seed-alpha@example.com",
      "seed-beta@example.com",
      "seed-gamma@example.com",
      "seed-operator@example.com",
    ]);

    expect(byEmail.get("seed-operator@example.com")?.role).toBe("operator");
    expect(byEmail.get("seed-operator@example.com")?.tenantId).toBeUndefined();

    // Every customer is bound to a tenant that actually exists in the registry.
    const tenants = await stores.tenant.listTenants();
    expect(tenants.ok).toBe(true);
    if (!tenants.ok) return;
    const ids = new Set(tenants.value.map((tenant) => tenant.id));

    for (const slug of ["seed-alpha", "seed-beta", "seed-gamma"]) {
      const member = byEmail.get(`${slug}@example.com`);
      expect(member?.role).toBe("customer");
      expect(ids.has(member?.tenantId as string)).toBe(true);
    }
  });
});
