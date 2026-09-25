import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
} from "../../app/auth-session";
import {
  getViewerSession,
  readCookieValue,
} from "../../app/api/dark-factory/viewer-auth";
import * as listRoute from "../../app/api/dark-factory/runs/route";
import * as detailRoute from "../../app/api/dark-factory/runs/[runId]/route";
import * as metricsRoute from "../../app/api/dark-factory/metrics/route";
import type { PersistedRunEvent } from "../../agent/lib/dark-factory/run-history-store";
import type {
  RunMetrics,
  RunSummary,
} from "../../agent/lib/dark-factory/run-history";

const storeHolder = vi.hoisted(() => ({ store: null as any }));

vi.mock("../../agent/lib/dark-factory/run-history-provider", () => ({
  createRunHistoryStore: () => storeHolder.store,
}));

const SESSION_SECRET = "test-session-secret";

function sampleSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    repo: "owner/repo",
    issue: 1,
    status: "succeeded",
    stage: "terminal",
    createdAt: "2026-09-24T12:00:00.000Z",
    updatedAt: "2026-09-24T12:05:00.000Z",
    startedAt: "2026-09-24T12:00:01.000Z",
    completedAt: "2026-09-24T12:05:00.000Z",
    attemptCount: 1,
    reviewCount: 0,
    iterationCount: 1,
    fixCycleCount: 0,
    latencyMs: 1000,
    costUsd: 0.5,
    ...overrides,
  };
}

function makeStore(overrides: Record<string, unknown> = {}): any {
  return {
    id: "fake",
    acceptDelivery: () => {
      throw new Error("not used");
    },
    claimControlDelivery: () => {
      throw new Error("not used");
    },
    advanceControlDelivery: () => {
      throw new Error("not used");
    },
    appendEvent: () => {
      throw new Error("not used");
    },
    releaseControlDelivery: () => {
      throw new Error("not used");
    },
    close: async () => undefined,
    ...overrides,
  };
}

function buildRequest(url: string, opts: { cookie?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request(url, { headers });
}

function liveMetrics(): RunMetrics {
  return {
    statusCounts: [{ status: "succeeded", count: 1 }],
    trend: [],
    measured: {},
  };
}

describe("viewer-auth", () => {
  let token: string;
  beforeEach(async () => {
    process.env.AUTH_SESSION_SECRET = SESSION_SECRET;
    token = await createSessionToken({
      email: "viewer@example.com",
      secret: SESSION_SECRET,
      now: Date.now(),
      ttlMs: 8 * 60 * 60 * 1000,
    });
  });
  afterEach(() => {
    delete process.env.AUTH_SESSION_SECRET;
  });

  it("parses a named cookie from a Cookie header", () => {
    expect(readCookieValue("a=1; eve_session=xyz; b=2", "eve_session")).toBe(
      "xyz",
    );
    expect(readCookieValue("", "eve_session")).toBeNull();
  });

  it("returns the session for a valid signed cookie", async () => {
    const session = await getViewerSession(
      buildRequest("https://eve.local/api/dark-factory/runs", {
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
      }),
    );
    expect(session?.email).toBe("viewer@example.com");
  });

  it("returns null when no session cookie is present", async () => {
    expect(
      await getViewerSession(buildRequest("https://eve.local/x")),
    ).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const expired = await createSessionToken({
      email: "viewer@example.com",
      secret: SESSION_SECRET,
      now: Date.now(),
      ttlMs: -1000,
    });
    const session = await getViewerSession(
      buildRequest("https://eve.local/x", {
        cookie: `${SESSION_COOKIE_NAME}=${expired}`,
      }),
    );
    expect(session).toBeNull();
  });

  it("returns null when no session secret is configured in production", async () => {
    const prev = process.env.AUTH_SESSION_SECRET;
    delete (process.env as Record<string, string | undefined>)
      .AUTH_SESSION_SECRET;
    try {
      const session = await getViewerSession(
        buildRequest("https://eve.local/x", {
          cookie: `${SESSION_COOKIE_NAME}=${token}`,
        }),
      );
      expect(session).toBeNull();
    } finally {
      (process.env as Record<string, string | undefined>).AUTH_SESSION_SECRET =
        prev;
    }
  });
});

describe("Dark Factory run query API", () => {
  let token: string;

  const envSet = (key: string, value: string | undefined) => {
    (process.env as Record<string, string | undefined>)[key] = value;
  };
  const envDel = (key: string) => {
    delete (process.env as Record<string, string | undefined>)[key];
  };

  beforeEach(async () => {
    envSet("AUTH_SESSION_SECRET", SESSION_SECRET);
    envSet("NODE_ENV", "development");
    token = await createSessionToken({
      email: "viewer@example.com",
      secret: SESSION_SECRET,
      now: Date.now(),
      ttlMs: 8 * 60 * 60 * 1000,
    });
    storeHolder.store = makeStore();
  });

  afterEach(() => {
    envDel("AUTH_SESSION_SECRET");
    envDel("NODE_ENV");
    storeHolder.store = null;
  });

  const authCookie = () => `${SESSION_COOKIE_NAME}=${token}`;

  it("GET /runs returns 200 with runs and a no-store cache header", async () => {
    storeHolder.store = makeStore({
      listRuns: async () => ({
        ok: true,
        mode: "live",
        providerId: "fake",
        value: { items: [sampleSummary()], nextCursor: null },
      }),
    });
    const response = await listRoute.GET(
      buildRequest(
        "https://eve.local/api/dark-factory/runs?repo=owner%2Frepo",
        {
          cookie: authCookie(),
        },
      ) as any,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.runs).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
  });

  it("GET /runs returns 400 for invalid filters", async () => {
    const response = await listRoute.GET(
      buildRequest("https://eve.local/api/dark-factory/runs?issue=abc", {
        cookie: authCookie(),
      }) as any,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/issue/i);
  });

  it("GET /runs returns 503 when the store is blocked", async () => {
    storeHolder.store = makeStore({
      listRuns: async () => ({
        ok: false,
        mode: "blocked",
        providerId: "fake",
        value: null,
        error: "unavailable",
      }),
    });
    const response = await listRoute.GET(
      buildRequest("https://eve.local/api/dark-factory/runs", {
        cookie: authCookie(),
      }) as any,
    );
    expect(response.status).toBe(503);
  });

  it("GET /runs returns 401 without a viewer session", async () => {
    const response = await listRoute.GET(
      buildRequest("https://eve.local/api/dark-factory/runs") as any,
    );
    expect(response.status).toBe(401);
  });

  it("GET /runs/[runId] returns 200 with summary and events", async () => {
    storeHolder.store = makeStore({
      getRun: async () => ({
        ok: true,
        mode: "live",
        providerId: "fake",
        value: sampleSummary(),
      }),
      listRunEvents: async () => ({
        ok: true,
        mode: "live",
        providerId: "fake",
        value: {
          items: [
            {
              sequence: 1,
              event: {
                eventId: "evt-1",
                runId: "run-1",
                type: "run.terminal",
                stage: "terminal",
                occurredAt: "2026-09-24T12:05:00.000Z",
                status: "succeeded",
              },
            } as PersistedRunEvent,
          ],
          nextCursor: undefined,
        },
      }),
    });
    const response = await detailRoute.GET(
      buildRequest("https://eve.local/api/dark-factory/runs/run-1", {
        cookie: authCookie(),
      }) as any,
      { params: Promise.resolve({ runId: "run-1" }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.summary.runId).toBe("run-1");
    expect(body.events).toHaveLength(1);
  });

  it("GET /runs/[runId] returns 404 when the run is missing", async () => {
    storeHolder.store = makeStore({
      getRun: async () => ({
        ok: true,
        mode: "live",
        providerId: "fake",
        value: null,
      }),
    });
    const response = await detailRoute.GET(
      buildRequest("https://eve.local/api/dark-factory/runs/nope", {
        cookie: authCookie(),
      }) as any,
      { params: Promise.resolve({ runId: "nope" }) },
    );
    expect(response.status).toBe(404);
  });

  it("GET /runs/[runId] returns 400 for an invalid cursor", async () => {
    storeHolder.store = makeStore({
      getRun: async () => ({
        ok: true,
        mode: "live",
        providerId: "fake",
        value: sampleSummary(),
      }),
      listRunEvents: async () => ({
        ok: true,
        mode: "live",
        providerId: "fake",
        value: { items: [], nextCursor: undefined },
      }),
    });
    const response = await detailRoute.GET(
      buildRequest("https://eve.local/api/dark-factory/runs/run-1?cursor=bad", {
        cookie: authCookie(),
      }) as any,
      { params: Promise.resolve({ runId: "run-1" }) },
    );
    expect(response.status).toBe(400);
  });

  it("GET /runs/[runId] returns 401 without a viewer session", async () => {
    const response = await detailRoute.GET(
      buildRequest("https://eve.local/api/dark-factory/runs/run-1") as any,
      { params: Promise.resolve({ runId: "run-1" }) },
    );
    expect(response.status).toBe(401);
  });

  it("GET /metrics returns 200 with metrics", async () => {
    storeHolder.store = makeStore({
      getRunMetrics: async () => ({
        ok: true,
        mode: "live",
        providerId: "fake",
        value: liveMetrics(),
      }),
    });
    const response = await metricsRoute.GET(
      buildRequest(
        "https://eve.local/api/dark-factory/metrics?repo=owner%2Frepo",
        {
          cookie: authCookie(),
        },
      ) as any,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.metrics.statusCounts).toHaveLength(1);
  });

  it("GET /metrics returns 503 when the store is blocked", async () => {
    storeHolder.store = makeStore({
      getRunMetrics: async () => ({
        ok: false,
        mode: "blocked",
        providerId: "fake",
        value: null,
        error: "unavailable",
      }),
    });
    const response = await metricsRoute.GET(
      buildRequest("https://eve.local/api/dark-factory/metrics", {
        cookie: authCookie(),
      }) as any,
    );
    expect(response.status).toBe(503);
  });

  it("GET /metrics returns 401 without a viewer session", async () => {
    const response = await metricsRoute.GET(
      buildRequest("https://eve.local/api/dark-factory/metrics") as any,
    );
    expect(response.status).toBe(401);
  });
});
