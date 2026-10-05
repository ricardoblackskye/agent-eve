import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../app/auth-session";
import { InMemoryTenantStore } from "../../agent/lib/dark-factory/tenant-store";

const storeHolder = vi.hoisted(() => ({ store: null as unknown }));

vi.mock(
  "../../agent/lib/dark-factory/tenant-store-provider",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../agent/lib/dark-factory/tenant-store-provider")
      >();
    return { ...actual, createTenantStore: () => storeHolder.store };
  },
);

// These routes resolve role and tenant per request (#215). The guard is mocked
// so the test keeps its real session check but needs no membership store.
vi.mock("../../app/api/dark-factory/guard", async () => {
  const auth = await import("../../app/api/dark-factory/viewer-auth");
  const { unauthorized } = await import("../../app/api/dark-factory/responses");
  const viewer = { email: "operator@example.test", role: "operator" as const };
  const resolve = async (request: Request) => {
    const session = await auth.getViewerSession(request);
    return session ? { ok: true, viewer } : { ok: false, response: unauthorized() };
  };
  return { guardViewer: resolve, guardOperator: resolve };
});

import * as route from "../../app/api/dark-factory/tenants/route";

const secret = "test-tenants-session";
let cookie = "";

const DEFAULT_PATH = "https://eve.local/api/dark-factory/tenants";

beforeEach(async () => {
  process.env.AUTH_SESSION_SECRET = secret;
  cookie = `${SESSION_COOKIE_NAME}=${await createSessionToken({
    email: "operator@example.test",
    secret,
  })}`;
  storeHolder.store = new InMemoryTenantStore();
});

afterEach(() => {
  delete process.env.AUTH_SESSION_SECRET;
});

function req(path = DEFAULT_PATH, authenticated = true): Request {
  return new Request(path, {
    method: "GET",
    headers: authenticated ? { cookie } : {},
  });
}

describe("Dark Factory tenants API", () => {
  it("requires a signed viewer session", async () => {
    const response = await route.GET(req(DEFAULT_PATH, false) as never);
    expect(response.status).toBe(401);
  });

  it("lists tenants and their repository assignments", async () => {
    const store = storeHolder.store as InMemoryTenantStore;
    const created = await store.upsertTenant({ slug: "acme", name: "Acme" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await store.assignRepo("owner/repo", created.value.id);

    const response = await route.GET(req() as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tenants: { slug: string }[];
      assignments: { repoSlug: string }[];
    };
    expect(body.tenants.map((tenant) => tenant.slug)).toEqual(["acme"]);
    expect(body.assignments.map((item) => item.repoSlug)).toEqual(["owner/repo"]);
  });

  it("returns empty collections rather than failing when nothing is assigned", async () => {
    const response = await route.GET(req() as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tenants: unknown[];
      assignments: unknown[];
    };
    // An unassigned deployment is a legitimate state, not an error: reporting
    // 503 here would send an operator hunting for an outage.
    expect(body.tenants).toEqual([]);
    expect(body.assignments).toEqual([]);
  });

  it("reports an unavailable registry as 503", async () => {
    storeHolder.store = {
      listTenants: async () => ({ ok: false, error: "registry down" }),
      listRepoAssignments: async () => ({ ok: false, error: "registry down" }),
      close: () => {},
    };

    const response = await route.GET(req() as never);
    expect(response.status).toBe(503);
  });

  it("exposes identifiers and counts only, never issue or prompt content", async () => {
    const store = storeHolder.store as InMemoryTenantStore;
    await store.upsertTenant({ slug: "acme", name: "Acme" });

    const response = await route.GET(req() as never);
    const text = JSON.stringify(await response.json());

    expect(text).not.toMatch(/prompt/i);
    expect(text).not.toMatch(/completion/i);
    expect(text).toMatch(/tenants/);
  });
});