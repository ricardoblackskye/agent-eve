import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../app/auth-session";
import { InMemoryUsageStore } from "../../agent/lib/dark-factory/usage-store";

const storeHolder = vi.hoisted(() => ({ store: null as unknown }));

vi.mock(
  "../../agent/lib/dark-factory/usage-store-provider",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../agent/lib/dark-factory/usage-store-provider")
      >();
    return { ...actual, createUsageStore: () => storeHolder.store };
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

import * as route from "../../app/api/dark-factory/usage/route";

const secret = "test-usage-session";
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
let cookie = "";

const DEFAULT_PATH = "https://eve.local/api/dark-factory/usage";

beforeEach(async () => {
  process.env.AUTH_SESSION_SECRET = secret;
  cookie = `${SESSION_COOKIE_NAME}=${await createSessionToken({
    email: "operator@example.test",
    secret,
  })}`;
  storeHolder.store = new InMemoryUsageStore();
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

async function seed(store: InMemoryUsageStore): Promise<void> {
  await store.record({
    runId: "run-1",
    taskType: "pr-review",
    model: "deepseek/deepseek-chat",
    ts: "2026-09-30T10:00:00.000Z",
    costUsd: 0.5,
  });
}

describe("Dark Factory usage API", () => {
  it("requires a signed viewer session", async () => {
    const response = await route.GET(req(DEFAULT_PATH, false) as never);
    expect(response.status).toBe(401);
  });

  it("returns the usage report for an authenticated operator", async () => {
    await seed(storeHolder.store as InMemoryUsageStore);

    const response = await route.GET(req() as never);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      report: { totals: { calls: number; costUsd?: number } };
    };
    expect(body.report.totals.calls).toBe(1);
    expect(body.report.totals.costUsd).toBe(0.5);
  });

  it("rejects a malformed window with 400", async () => {
    const response = await route.GET(
      req(`${DEFAULT_PATH}?from=yesterday`) as never,
    );
    expect(response.status).toBe(400);
  });

  it("reports an unavailable ledger as 503", async () => {
    storeHolder.store = {
      id: "down",
      record: async () => ({
        ok: false,
        mode: "blocked",
        providerId: "down",
        error: "down",
      }),
      aggregate: async () => ({
        ok: false,
        mode: "blocked",
        providerId: "down",
        value: null,
        error: "ledger unavailable",
      }),
      close: () => {},
    };

    const response = await route.GET(req() as never);
    expect(response.status).toBe(503);
  });

  it("exposes counts only, never prompt or completion content", async () => {
    await seed(storeHolder.store as InMemoryUsageStore);

    const response = await route.GET(req() as never);
    const text = JSON.stringify(await response.json());

    expect(text).not.toMatch(/prompt/i);
    expect(text).not.toMatch(/completion/i);
    expect(text).not.toMatch(/content/i);
    expect(text).toMatch(/totals/);
  });

  it("filters usage to a single tenant via ?tenant=", async () => {
    const store = storeHolder.store as InMemoryUsageStore;
    await store.record({
      runId: "run-1",
      taskType: "pr-review",
      model: "deepseek/deepseek-chat",
      ts: "2026-09-30T10:00:00.000Z",
      costUsd: 0.1,
      tenantId: T1,
    });
    await store.record({
      runId: "run-1",
      taskType: "pr-review",
      model: "deepseek/deepseek-chat",
      ts: "2026-09-30T10:00:00.000Z",
      costUsd: 0.2,
      tenantId: T2,
    });

    const response = await route.GET(
      req(`${DEFAULT_PATH}?tenant=${T1}`) as never,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      report: { totals: { calls: number; costUsd?: number } };
    };
    // Only the requested tenant's spend, not the other tenant's.
    expect(body.report.totals.calls).toBe(1);
    expect(body.report.totals.costUsd).toBeCloseTo(0.1, 6);
  });
});