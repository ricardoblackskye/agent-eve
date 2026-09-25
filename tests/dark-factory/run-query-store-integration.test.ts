import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import {
  queryRunDetailFromParams,
  queryRunListFromParams,
  queryRunMetricsFromParams,
  decodeListCursor,
  encodeListCursor,
  type RunEventParams,
} from "../../agent/lib/dark-factory/run-query";
import type { RunStatus } from "../../agent/lib/dark-factory/run-history";

let dbDir: string;
let store: SqliteRunHistoryStore;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "df-query-int-"));
  store = new SqliteRunHistoryStore(join(dbDir, "runs.sqlite"));

  const seed = async (
    key: string,
    repo: string,
    issue: number,
    status: RunStatus,
    completedAt: string,
  ) => {
    const accepted = await store.acceptDelivery({
      deliveryId: `delivery-${key}`,
      repo,
      issue,
      receivedAt: completedAt,
    });
    const runId = accepted.value?.runId;
    if (!runId) throw new Error(`seed delivery failed for ${key}`);
    if (status !== "queued") {
      await store.appendEvent({
        eventId: `${key}-terminal`,
        runId,
        type: "run.terminal",
        stage: "terminal",
        occurredAt: completedAt,
        status,
      });
    }
    return runId;
  };

  await seed("a", "owner/repo", 1, "succeeded", "2026-09-24T12:00:00.000Z");
  await seed("b", "owner/other", 2, "failed", "2026-09-25T08:00:00.000Z");
  await seed("c", "owner/repo", 3, "queued", "2026-09-23T08:00:00.000Z");
});

afterAll(() => {
  store.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("run query service over a real SQLite store", () => {
  it("paginates the full run set via opaque cursors without repeating runs", async () => {
    const collected: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const outcome = await queryRunListFromParams(store, {
        limit: "1",
        cursor,
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) break;
      expect(outcome.runs).toHaveLength(1);
      collected.push(outcome.runs[0].runId);
      if (!outcome.nextCursor) break;
      cursor = outcome.nextCursor;
    }
    expect(collected).toHaveLength(3);
    expect(new Set(collected).size).toBe(3);
  });

  it("filters the list by repo", async () => {
    const outcome = await queryRunListFromParams(store, { repo: "owner/repo" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.runs.map((r) => r.issue).sort()).toEqual([1, 3]);
  });

  it("filters the list by status", async () => {
    const outcome = await queryRunListFromParams(store, {
      statuses: ["succeeded"],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.runs.map((r) => r.issue)).toEqual([1]);
  });

  it("rejects an undecodable cursor as invalid (400) rather than silently", async () => {
    const outcome = await queryRunListFromParams(store, {
      cursor: "not-a-real-cursor",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(400);
  });

  it("returns run detail with events", async () => {
    const listed = await queryRunListFromParams(store, {
      repo: "owner/repo",
      issue: "1",
    });
    if (!listed.ok) throw new Error("list failed");
    const runId = listed.runs[0].runId;
    const params: RunEventParams = { limit: "50" };
    const detail = await queryRunDetailFromParams(store, runId, params);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.summary.runId).toBe(runId);
    expect(detail.events.length).toBeGreaterThanOrEqual(1);
  });

  it("returns 404 for a missing run", async () => {
    const detail = await queryRunDetailFromParams(store, "missing-run", {
      limit: "50",
    });
    expect(detail.ok).toBe(false);
    if (detail.ok) return;
    expect(detail.status).toBe(404);
  });

  it("aggregates metrics with one entry per canonical status", async () => {
    const outcome = await queryRunMetricsFromParams(store, {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const statuses = outcome.metrics.statusCounts.map((c) => c.status);
    expect(statuses).toContain("succeeded");
    expect(statuses).toContain("failed");
    expect(statuses).toContain("queued");
    const succeeded = outcome.metrics.statusCounts.find(
      (c) => c.status === "succeeded",
    );
    expect(succeeded?.count).toBe(1);
  });
});

describe("list cursor codec", () => {
  it("round-trips a list cursor", () => {
    const token = encodeListCursor({
      runId: "run-xyz",
      createdAt: "2026-09-24T12:00:00.000Z",
    });
    expect(typeof token).toBe("string");
    expect(decodeListCursor(token)).toEqual({
      runId: "run-xyz",
      createdAt: "2026-09-24T12:00:00.000Z",
    });
  });
});
