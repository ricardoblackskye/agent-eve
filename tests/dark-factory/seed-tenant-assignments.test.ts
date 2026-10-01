/**
 * Seeding the tenant registry (#213, epic #212 R1).
 *
 * The properties that matter: the seed is EXPLICIT (no implicit default),
 * IDEMPOTENT (a re-run reuses the tenant and assigns nothing new), and it
 * REFUSES to move a repository that already belongs to another customer.
 */
import { describe, expect, it } from "vitest";
import { InMemoryTenantStore } from "../../agent/lib/dark-factory/tenant-store";
import {
  parseSeedArgs,
  seedTenantAssignments,
} from "../../scripts/seed-tenant-assignments";

describe("parseSeedArgs", () => {
  it("requires slug, name and at least one repository", () => {
    expect(parseSeedArgs([])).toEqual({
      error: expect.stringContaining("--slug"),
    });
    expect(parseSeedArgs(["--slug=internal"])).toEqual({
      error: expect.stringContaining("--name"),
    });
    expect(parseSeedArgs(["--slug=internal", "--name=Ops"])).toEqual({
      error: expect.stringContaining("--repo"),
    });
  });

  it("collects repeated repositories and the dry-run flag", () => {
    expect(
      parseSeedArgs([
        "--slug=internal",
        "--name=Ops",
        "--repo=owner/a",
        "--repo=owner/b",
        "--dry-run",
      ]),
    ).toEqual({
      slug: "internal",
      name: "Ops",
      repos: ["owner/a", "owner/b"],
      dryRun: true,
    });
  });

  it("rejects unknown options and malformed arguments", () => {
    expect(parseSeedArgs(["--nope=1"])).toEqual({
      error: expect.stringContaining("--nope"),
    });
    expect(parseSeedArgs(["slug=internal"])).toEqual({
      error: expect.stringContaining("Unrecognised"),
    });
  });
});

describe("seedTenantAssignments", () => {
  it("creates the tenant and assigns the repositories", async () => {
    const store = new InMemoryTenantStore();
    const result = await seedTenantAssignments(store, {
      slug: "internal",
      name: "Internal Operations",
      repos: ["Owner/Repo"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.created).toBe(true);
    expect(result.report.assigned).toEqual(["owner/repo"]);

    const tenants = await store.listTenants();
    expect(tenants.ok && tenants.value.map((tenant) => tenant.slug)).toEqual([
      "internal",
    ]);
    const assignments = await store.listRepoAssignments();
    expect(
      assignments.ok && assignments.value.map((item) => item.repoSlug),
    ).toEqual(["owner/repo"]);
  });

  it("is idempotent: a re-run reuses the tenant id and assigns nothing new", async () => {
    const store = new InMemoryTenantStore();
    const input = {
      slug: "internal",
      name: "Internal Operations",
      repos: ["owner/repo"],
    };
    const first = await seedTenantAssignments(store, input);
    const second = await seedTenantAssignments(store, input);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.report.tenantId).toBe(first.report.tenantId);
    expect(second.report.created).toBe(false);
    expect(second.report.assigned).toEqual([]);
    expect(second.report.alreadyAssigned).toEqual(["owner/repo"]);

    const tenants = await store.listTenants();
    expect(tenants.ok && tenants.value.length).toBe(1);
  });

  it("refuses to move a repository that already belongs to another tenant", async () => {
    const store = new InMemoryTenantStore();
    const other = await store.upsertTenant({ slug: "acme", name: "Acme" });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    await store.assignRepo("owner/repo", other.value.id);

    const result = await seedTenantAssignments(store, {
      slug: "internal",
      name: "Ops",
      repos: ["owner/repo"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("owner/repo");
    expect(result.error).toMatch(/another tenant/i);
  });

  it("writes nothing on a dry run", async () => {
    const store = new InMemoryTenantStore();
    const result = await seedTenantAssignments(store, {
      slug: "internal",
      name: "Ops",
      repos: ["owner/repo"],
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.dryRun).toBe(true);
    expect(result.report.assigned).toEqual(["owner/repo"]);

    const tenants = await store.listTenants();
    expect(tenants.ok && tenants.value).toEqual([]);
    const assignments = await store.listRepoAssignments();
    expect(assignments.ok && assignments.value).toEqual([]);
  });

  it("reports a bad slug or repository as an error rather than throwing", async () => {
    const store = new InMemoryTenantStore();

    const badSlug = await seedTenantAssignments(store, {
      slug: "Not A Slug",
      name: "Ops",
      repos: ["owner/repo"],
    });
    expect(badSlug.ok).toBe(false);

    const badRepo = await seedTenantAssignments(store, {
      slug: "internal",
      name: "Ops",
      repos: ["not-a-repo"],
    });
    expect(badRepo.ok).toBe(false);
  });
});