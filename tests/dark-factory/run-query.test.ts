import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  decodeEventCursor,
  decodeListCursor,
  encodeEventCursor,
  encodeListCursor,
  queryRunDetail,
  queryRunDetailFromParams,
  queryRunList,
  queryRunListFromParams,
  queryRunMetrics,
  queryRunMetricsFromParams,
  validateRunEventParams,
  validateRunListParams,
  validateRunMetricsParams,
} from "../../agent/lib/dark-factory/run-query";
import type {
  PersistedRunEvent,
  RunHistoryReadResult,
  RunHistoryStore,
} from "../../agent/lib/dark-factory/run-history-store";
import type {
  RunEvent,
  RunSummary,
} from "../../agent/lib/dark-factory/run-history";

function liveRead<T>(value: T): RunHistoryReadResult<T> {
  return { ok: true, mode: "live", providerId: "fake", value };
}
function blockedRead<T>(): RunHistoryReadResult<T> {
  return {
    ok: false,
    mode: "blocked",
    providerId: "fake",
    value: null,
    error: "unavailable",
  };
}

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

function sampleEvent(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    eventId: "evt-1",
    runId: "run-1",
    type: "run.terminal",
    stage: "terminal",
    occurredAt: "2026-09-24T12:05:00.000Z",
    status: "succeeded",
    ...overrides,
  };
}

interface FakeBehavior {
  listRuns?: (
    options: unknown,
  ) => RunHistoryReadResult<{
    items: RunSummary[];
    nextCursor: { createdAt: string; runId: string } | null;
  }>;
  getRun?: (runId: string) => RunHistoryReadResult<RunSummary | null>;
  listRunEvents?: (
    runId: string,
    options: unknown,
  ) => RunHistoryReadResult<{
    items: PersistedRunEvent[];
    nextCursor?: { sequence: number };
  }>;
  getRunMetrics?: (options: unknown) => RunHistoryReadResult<unknown>;
}

function fakeStore(behavior: FakeBehavior): RunHistoryStore {
  const notImpl = (): never => {
    throw new Error("not implemented in fake store");
  };
  return {
    id: "fake",
    acceptDelivery: notImpl,
    claimControlDelivery: notImpl,
    advanceControlDelivery: notImpl,
    appendEvent: notImpl,
    releaseControlDelivery: notImpl,
    getRun: behavior.getRun ?? (() => liveRead(null)),
    listRuns:
      behavior.listRuns ?? (() => liveRead({ items: [], nextCursor: null })),
    listRunEvents:
      behavior.listRunEvents ??
      (() => liveRead({ items: [], nextCursor: undefined })),
    getRunMetrics: behavior.getRunMetrics ?? (() => liveRead(undefined)),
    close: () => undefined,
  } as unknown as RunHistoryStore;
}

describe("run-query cursor codec", () => {
  it("round-trips a list cursor into an opaque token", () => {
    const token = encodeListCursor({
      createdAt: "2026-09-24T12:00:00.000Z",
      runId: "run-9",
    });
    expect(typeof token).toBe("string");
    expect(token).not.toContain("run-9");
    expect(decodeListCursor(token)).toEqual({
      createdAt: "2026-09-24T12:00:00.000Z",
      runId: "run-9",
    });
  });

  it("rejects tampered or malformed list cursors", () => {
    expect(decodeListCursor("@@@not-base64@@@")).toBeNull();
    expect(
      decodeListCursor(encodeListCursor({ createdAt: "", runId: "x" })),
    ).not.toBeNull();
    const tampered = Buffer.from(JSON.stringify({ foo: 1 }), "utf8").toString(
      "base64url",
    );
    expect(decodeListCursor(tampered)).toBeNull();
  });

  it("round-trips an event cursor", () => {
    const token = encodeEventCursor({ sequence: 7 });
    expect(decodeEventCursor(token)).toEqual({ sequence: 7 });
    expect(decodeEventCursor("bad")).toBeNull();
  });
});

describe("validateRunListParams", () => {
  it("accepts a valid request and applies defaults", () => {
    const result = validateRunListParams({
      repo: "owner/repo",
      issue: "12",
      statuses: ["succeeded", "failed"],
      limit: "50",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        repo: "owner/repo",
        issue: 12,
        statuses: ["succeeded", "failed"],
        limit: 50,
      });
    }
  });

  it("rejects unknown statuses, bad issue, and out-of-range limits", () => {
    expect(validateRunListParams({ statuses: ["bogus"] }).ok).toBe(false);
    expect(validateRunListParams({ issue: "-1" }).ok).toBe(false);
    expect(validateRunListParams({ issue: "abc" }).ok).toBe(false);
    expect(validateRunListParams({ limit: "0" }).ok).toBe(false);
    expect(validateRunListParams({ limit: String(MAX_PAGE_SIZE + 1) }).ok).toBe(
      false,
    );
    expect(validateRunListParams({ limit: "abc" }).ok).toBe(false);
  });

  it("rejects an invalid pagination cursor and a reversed date range", () => {
    expect(validateRunListParams({ cursor: "nope" }).ok).toBe(false);
    expect(
      validateRunListParams({
        from: "2026-09-30T00:00:00.000Z",
        to: "2026-09-01T00:00:00.000Z",
      }).ok,
    ).toBe(false);
  });

  it("accepts an empty parameter set at the default page size", () => {
    const result = validateRunListParams({});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.limit).toBe(DEFAULT_PAGE_SIZE);
  });
});

describe("validateRunEventParams and validateRunMetricsParams", () => {
  it("validates event pagination", () => {
    const result = validateRunEventParams({
      limit: "40",
      cursor: encodeEventCursor({ sequence: 5 }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.limit).toBe(40);
      expect(result.value.cursor).toEqual({ sequence: 5 });
    }
    expect(validateRunEventParams({ cursor: "bad" }).ok).toBe(false);
  });

  it("validates metric filters", () => {
    const result = validateRunMetricsParams({
      repo: "owner/repo",
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-30T00:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.repo).toBe("owner/repo");
    expect(validateRunMetricsParams({ to: "not-a-date" }).ok).toBe(false);
  });
});

describe("queryRunList", () => {
  it("maps a successful read and keeps the cursor opaque", async () => {
    const store = fakeStore({
      listRuns: () =>
        liveRead({
          items: [sampleSummary()],
          nextCursor: {
            createdAt: "2026-09-24T12:00:00.000Z",
            runId: "run-1",
          },
        }),
    });
    const outcome = await queryRunList(store, { limit: DEFAULT_PAGE_SIZE });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.runs).toHaveLength(1);
      expect(typeof outcome.nextCursor).toBe("string");
      expect(outcome.nextCursor).not.toBeNull();
    }
  });

  it("maps a blocked store read to 503", async () => {
    const store = fakeStore({ listRuns: () => blockedRead() });
    const outcome = await queryRunList(store, { limit: DEFAULT_PAGE_SIZE });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(503);
  });

  it("returns 400 for invalid params without touching the store", async () => {
    const store = fakeStore({});
    const outcome = await queryRunListFromParams(store, { issue: "bad" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(400);
  });
});

describe("queryRunDetail", () => {
  it("returns 404 when the summary is missing", async () => {
    const store = fakeStore({ getRun: () => liveRead(null) });
    const outcome = await queryRunDetail(store, "missing", {
      limit: DEFAULT_PAGE_SIZE,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(404);
  });

  it("returns 503 when the store is blocked", async () => {
    const store = fakeStore({ getRun: () => blockedRead() });
    const outcome = await queryRunDetail(store, "x", {
      limit: DEFAULT_PAGE_SIZE,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(503);
  });

  it("returns the summary, ordered events, and an opaque event cursor", async () => {
    const store = fakeStore({
      getRun: () => liveRead(sampleSummary()),
      listRunEvents: () =>
        liveRead({
          items: [{ sequence: 1, event: sampleEvent() }],
          nextCursor: { sequence: 2 },
        }),
    });
    const outcome = await queryRunDetail(store, "run-1", {
      limit: DEFAULT_PAGE_SIZE,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.summary.runId).toBe("run-1");
      expect(outcome.events).toHaveLength(1);
      expect(outcome.events[0].sequence).toBe(1);
      expect(typeof outcome.nextCursor).toBe("string");
    }
  });

  it("maps invalid event params to 400", async () => {
    const outcome = await queryRunDetailFromParams(
      store_passthrough(),
      "run-1",
      {
        cursor: "bad",
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(400);
  });
});

describe("queryRunMetrics", () => {
  it("maps a successful aggregate read", async () => {
    const store = fakeStore({
      getRunMetrics: () =>
        liveRead({
          statusCounts: [{ status: "succeeded", count: 3 }],
          trend: [],
          measured: {},
        }),
    });
    const outcome = await queryRunMetrics(store, {});
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.metrics.statusCounts).toHaveLength(1);
  });

  it("maps a blocked store read to 503", async () => {
    const store = fakeStore({ getRunMetrics: () => blockedRead() });
    const outcome = await queryRunMetrics(store, {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(503);
  });

  it("returns 400 for invalid metric params", async () => {
    const store = fakeStore({});
    const outcome = await queryRunMetricsFromParams(store, { from: "bad" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(400);
  });
});

function store_passthrough(): RunHistoryStore {
  return fakeStore({
    getRun: () => liveRead(sampleSummary()),
    listRunEvents: () => liveRead({ items: [], nextCursor: undefined }),
  });
}
