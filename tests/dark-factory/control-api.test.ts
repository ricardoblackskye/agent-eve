import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../app/auth-session";

const storeHolder = vi.hoisted(() => ({ store: null as any }));
vi.mock("../../agent/lib/dark-factory/control", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agent/lib/dark-factory/control")>();
  return { ...actual, createControlStore: () => storeHolder.store };
});

import * as route from "../../app/api/dark-factory/control/route";

const secret = "test-control-session";
let cookie = "";

function makeStore() {
  const events: unknown[] = [];
  let factory: any = null;
  const runs = new Map<string, any>();
  return {
    id: "fake",
    events,
    readFactory: async () => ({ ok: true, mode: "live", providerId: "fake", value: factory }),
    writeFactory: async (value: unknown) => { factory = value; return { ok: true, mode: "live", providerId: "fake" }; },
    readRun: async (runId: string) => ({ ok: true, mode: "live", providerId: "fake", value: runs.get(runId) ?? null }),
    writeRun: async (runId: string, value: unknown) => { runs.set(runId, value); return { ok: true, mode: "live", providerId: "fake" }; },
    appendEvent: async (value: unknown) => { events.push(value); return { ok: true, mode: "live", providerId: "fake" }; },
    applyChange: async (change: any) => {
      if (change.factoryState) factory = change.factoryState;
      if (change.runId && change.runState) runs.set(change.runId, change.runState);
      events.push(change.event);
      return { ok: true, mode: "live", providerId: "fake" };
    },
    listEvents: async () => ({ ok: true, mode: "live", providerId: "fake", value: events }),
    close: () => {},
  };
}

beforeEach(async () => {
  process.env.AUTH_SESSION_SECRET = secret;
  cookie = `${SESSION_COOKIE_NAME}=${await createSessionToken({ email: "operator@example.test", secret })}`;
  storeHolder.store = makeStore();
});
afterEach(() => { delete process.env.AUTH_SESSION_SECRET; });

function req(method: string, body?: unknown, path = "https://eve.local/api/dark-factory/control", authenticated = true): Request {
  return new Request(path, {
    method,
    headers: {
      ...(authenticated ? { cookie } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("Dark Factory control API", () => {
  it("requires a signed viewer session", async () => {
    const response = await route.GET(req("GET", undefined, undefined, false) as never);
    expect(response.status).toBe(401);
  });

  it("returns the persisted control state and recent audit events without caching", async () => {
    const response = await route.GET(req("GET") as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ available: true, factory: null, events: [] });
  });

  it("authenticates, applies and audits an operator pause", async () => {
    const response = await route.POST(req("POST", { action: "pause", scope: "factory", reason: "incident" }) as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ state: { paused: true, actor: "operator@example.test" } });
    expect(storeHolder.store.events).toHaveLength(1);
  });

  it("rejects a Stop action at factory scope", async () => {
    const response = await route.POST(req("POST", { action: "stop", scope: "factory" }) as never);
    expect(response.status).toBe(400);
  });
});
