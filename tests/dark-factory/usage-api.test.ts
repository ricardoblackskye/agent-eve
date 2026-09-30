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

import * as route from "../../app/api/dark-factory/usage/route";

const secret = "test-usage-session";
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
});