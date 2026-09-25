import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

const at = "2026-09-24T12:00:00.000Z";
const directories: string[] = [];
const stores: SqliteRunHistoryStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(idFactory = () => "run-1") {
  const directory = mkdtempSync(join(tmpdir(), "df-run-history-"));
  directories.push(directory);
  const store = new SqliteRunHistoryStore(
    join(directory, "runs.sqlite"),
    idFactory,
  );
  stores.push(store);
  return store;
}

describe("SqliteRunHistoryStore delivery acceptance", () => {
  it("binds a webhook delivery to one run without using the delivery ID as run identity", async () => {
    let generated = 0;
    const store = createStore(() => `opaque-run-${++generated}`);

    const input = {
      deliveryId: "github-delivery-1",
      repo: "Owner/Repo",
      issue: 198,
      receivedAt: at,
    };
    const first = await store.acceptDelivery(input);
    const replay = await store.acceptDelivery(input);

    expect(first.ok).toBe(true);
    expect(first.value?.runId).toBe("opaque-run-1");
    expect(first.value?.runId).not.toBe(input.deliveryId);
    expect(first.value?.repo).toBe("owner/repo");
    expect(first.value?.status).toBe("queued");
    expect(first.duplicate).toBe(false);
    expect(replay.ok).toBe(true);
    expect(replay.duplicate).toBe(true);
    expect(replay.value?.runId).toBe(first.value?.runId);
    expect(generated).toBe(1);

    store.close();
  });

  it("creates a distinct run for a new trigger delivery even while another run is active", async () => {
    let generated = 0;
    const store = createStore(() => `active-run-${++generated}`);
    const first = await store.acceptDelivery({
      deliveryId: "active-delivery-1",
      repo: "owner/repo",
      issue: 198,
      receivedAt: at,
    });
    const repeatedIntent = await store.acceptDelivery({
      deliveryId: "active-delivery-2",
      repo: "owner/repo",
      issue: 198,
      receivedAt: "2026-09-24T12:00:01.000Z",
    });
    const runId = first.value?.runId;
    if (!runId) throw new Error("run acceptance did not return a runId");

    expect(repeatedIntent.ok).toBe(true);
    expect(repeatedIntent.duplicate).toBe(false);
    expect(repeatedIntent.value?.runId).toBe("active-run-2");
    expect(repeatedIntent.value?.runId).not.toBe(runId);
    expect(generated).toBe(2);

    const stopped = await store.appendEvent({
      eventId: "active-run-aborted",
      runId,
      type: "run.terminal",
      stage: "terminal",
      occurredAt: "2026-09-24T12:01:00.000Z",
      status: "aborted",
    });
    expect(stopped.ok).toBe(true);

    const deliberateRerun = await store.acceptDelivery({
      deliveryId: "active-delivery-3",
      repo: "owner/repo",
      issue: 198,
      receivedAt: "2026-09-24T12:02:00.000Z",
    });
    expect(deliberateRerun.ok).toBe(true);
    expect(deliberateRerun.duplicate).toBe(false);
    expect(deliberateRerun.value?.runId).toBe("active-run-3");
    expect(generated).toBe(3);
  });

  it("binds a replayed control delivery to its original run", async () => {
    let generated = 0;
    const store = createStore(() => `control-run-${++generated}`);
    const first = await store.acceptDelivery({
      deliveryId: "control-trigger-1",
      repo: "owner/repo",
      issue: 198,
      receivedAt: at,
    });
    const firstRunId = first.value?.runId;
    if (!firstRunId) throw new Error("first run was not created");

    const claimed = await store.claimControlDelivery({
      deliveryId: "control-abort-1",
      repo: "owner/repo",
      issue: 198,
      transition: "abort",
      receivedAt: "2026-09-24T12:00:01.000Z",
      runId: firstRunId,
    });
    expect(claimed.ok).toBe(true);
    expect(claimed.duplicate).toBe(false);

    const aborted = await store.appendEvent({
      eventId: "control-abort-event-1",
      runId: firstRunId,
      type: "run.terminal",
      stage: "terminal",
      occurredAt: "2026-09-24T12:00:02.000Z",
      status: "aborted",
    });
    expect(aborted.ok).toBe(true);

    const later = await store.acceptDelivery({
      deliveryId: "control-trigger-2",
      repo: "owner/repo",
      issue: 198,
      receivedAt: "2026-09-24T12:01:00.000Z",
    });
    const laterRunId = later.value?.runId;
    if (!laterRunId) throw new Error("later run was not created");

    const replay = await store.claimControlDelivery({
      deliveryId: "control-abort-1",
      repo: "owner/repo",
      issue: 198,
      transition: "abort",
      receivedAt: "2026-09-24T12:02:00.000Z",
      runId: laterRunId,
    });

    expect(replay.ok).toBe(true);
    expect(replay.duplicate).toBe(true);
    expect(replay.value?.runId).toBe(firstRunId);
    expect(replay.value?.runStatus).toBe("aborted");
  });

  it("remembers a control delivery that found no eligible run", async () => {
    let generated = 0;
    const store = createStore(() => `no-run-${++generated}`);
    const initial = await store.claimControlDelivery({
      deliveryId: "control-resume-no-run",
      repo: "owner/repo",
      issue: 198,
      transition: "resume",
      receivedAt: at,
    });
    expect(initial.ok).toBe(true);
    expect(initial.duplicate).toBe(false);

    const later = await store.acceptDelivery({
      deliveryId: "control-trigger-after-no-run",
      repo: "owner/repo",
      issue: 198,
      receivedAt: "2026-09-24T12:01:00.000Z",
    });
    const replay = await store.claimControlDelivery({
      deliveryId: "control-resume-no-run",
      repo: "owner/repo",
      issue: 198,
      transition: "resume",
      receivedAt: "2026-09-24T12:02:00.000Z",
      runId: later.value?.runId,
    });

    expect(replay.ok).toBe(true);
    expect(replay.duplicate).toBe(true);
    expect(replay.value?.runId).toBeUndefined();
    expect(generated).toBe(1);
  });

  it("advances control delivery progress monotonically with idempotent updates", async () => {
    const store = createStore();
    const accepted = await store.acceptDelivery({
      deliveryId: "control-progress-trigger",
      repo: "owner/repo",
      issue: 198,
      receivedAt: at,
    });
    const runId = accepted.value?.runId;
    if (!runId) throw new Error("control progress run was not created");
    const claim = {
      deliveryId: "control-progress-resume",
      repo: "owner/repo",
      issue: 198,
      transition: "resume" as const,
      receivedAt: "2026-09-24T12:00:01.000Z",
      runId,
    };
    const claimed = await store.claimControlDelivery(claim);
    const handoff = await store.advanceControlDelivery({
      ...claim,
      receivedAt: "2026-09-24T12:00:02.000Z",
      handoffSent: true,
    });
    const completed = await store.advanceControlDelivery({
      ...claim,
      receivedAt: "2026-09-24T12:00:03.000Z",
      completed: true,
    });
    const replay = await store.claimControlDelivery(claim);

    expect(claimed.ok).toBe(true);
    expect(claimed.value).toMatchObject({
      handoffSent: false,
      completed: false,
    });
    expect(handoff.ok).toBe(true);
    expect(handoff.value).toMatchObject({
      handoffSent: true,
      completed: false,
    });
    expect(completed.ok).toBe(true);
    expect(completed.value).toMatchObject({
      handoffSent: true,
      completed: true,
    });
    expect(replay.ok).toBe(true);
    expect(replay.duplicate).toBe(true);
    expect(replay.value).toMatchObject({ handoffSent: true, completed: true });
  });

  it("atomically appends a new event and updates the current summary", async () => {
    const store = createStore();
    const accepted = await store.acceptDelivery({
      deliveryId: "delivery-append",
      repo: "owner/repo",
      issue: 198,
      receivedAt: at,
    });
    const runId = accepted.value?.runId;
    if (!runId) throw new Error("run acceptance did not return a runId");

    const appended = await store.appendEvent({
      eventId: "dispatch-started-1",
      runId,
      type: "dispatch.started",
      stage: "dispatch",
      occurredAt: "2026-09-24T12:00:01.000Z",
      status: "running",
    });

    expect(appended.ok).toBe(true);
    expect(appended.duplicate).toBe(false);
    expect(appended.value).toMatchObject({
      runId,
      status: "running",
      stage: "dispatch",
      startedAt: "2026-09-24T12:00:01.000Z",
    });
    store.close();
  });

  it("persists disposition counts on review-round events", async () => {
    const store = createStore();
    const accepted = await store.acceptDelivery({
      deliveryId: "delivery-review-counts",
      repo: "owner/repo",
      issue: 198,
      receivedAt: at,
    });
    const runId = accepted.value?.runId;
    if (!runId) throw new Error("run acceptance did not return a runId");

    const recorded = await store.appendEvent({
      eventId: "review-round-1",
      runId,
      type: "review.round",
      stage: "review",
      occurredAt: "2026-09-24T12:00:01.000Z",
      reviewRound: 1,
      findingCount: 4,
      resolvedCount: 2,
      acceptedCount: 1,
    });
    const events = await store.listRunEvents(runId);

    expect(recorded.ok).toBe(true);
    expect(events.value?.items[1]?.event).toMatchObject({
      findingCount: 4,
      resolvedCount: 2,
      acceptedCount: 1,
    });
  });

  it("deduplicates event IDs without double-counting and refuses conflicting replay data", async () => {
    const store = createStore();
    const accepted = await store.acceptDelivery({
      deliveryId: "delivery-event-replay",
      repo: "owner/repo",
      issue: 198,
      receivedAt: at,
    });
    const runId = accepted.value?.runId;
    if (!runId) throw new Error("run acceptance did not return a runId");

    const attempt = {
      eventId: "attempt-2",
      runId,
      type: "dispatch.attempt" as const,
      stage: "dispatch" as const,
      occurredAt: "2026-09-24T12:00:01.000Z",
      attempt: 2,
      status: "running" as const,
      iterationCount: 3,
    };
    const first = await store.appendEvent(attempt);
    const replay = await store.appendEvent(attempt);
    const conflict = await store.appendEvent({ ...attempt, iterationCount: 5 });

    expect(first.ok).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(first.value?.attemptCount).toBe(2);
    expect(first.value?.iterationCount).toBe(3);
    expect(replay.ok).toBe(true);
    expect(replay.duplicate).toBe(true);
    expect(replay.value?.attemptCount).toBe(2);
    expect(replay.value?.iterationCount).toBe(3);
    expect(conflict.ok).toBe(false);
  });

  it("filters run queries by repository, issue, and a set of statuses", async () => {
    let generated = 0;
    const store = createStore(() => `filter-run-${++generated}`);
    const first = await store.acceptDelivery({
      deliveryId: "filter-issue-1",
      repo: "owner/repo",
      issue: 198,
      receivedAt: at,
    });
    const second = await store.acceptDelivery({
      deliveryId: "filter-issue-2",
      repo: "owner/repo",
      issue: 199,
      receivedAt: "2026-09-24T12:00:01.000Z",
    });
    const firstRunId = first.value?.runId;
    const secondRunId = second.value?.runId;
    if (!firstRunId || !secondRunId)
      throw new Error("run acceptance returned no runId");
    await store.appendEvent({
      eventId: "filter-started",
      runId: firstRunId,
      type: "dispatch.started",
      stage: "dispatch",
      occurredAt: "2026-09-24T12:00:02.000Z",
      status: "running",
    });
    await store.appendEvent({
      eventId: "filter-question",
      runId: secondRunId,
      type: "worker.question",
      stage: "worker",
      occurredAt: "2026-09-24T12:00:03.000Z",
      status: "blocked",
    });

    const page = await store.listRuns({
      repo: "owner/repo",
      issue: 198,
      statuses: ["running", "blocked"],
    });
    expect(page.value?.items.map((run) => run.runId)).toEqual([firstRunId]);
  });

  it("filters runs by inclusive from and exclusive to with repo and status filters", async () => {
    let generated = 0;
    const store = createStore(() => `date-filter-run-${++generated}`);
    const runs = [
      ["date-before", "owner/repo", 200, "2026-09-24T12:00:00.999Z"],
      ["date-from", "owner/repo", 201, "2026-09-24T12:00:01.000Z"],
      ["date-running", "owner/repo", 202, "2026-09-24T12:00:02.000Z"],
      ["date-before-to", "owner/repo", 203, "2026-09-24T12:00:02.999Z"],
      ["date-at-to", "owner/repo", 204, "2026-09-24T12:00:03.000Z"],
      ["date-other-repo", "other/repo", 205, "2026-09-24T12:00:02.500Z"],
    ] as const;

    const accepted = new Map<number, string>();
    for (const [deliveryId, repo, issue, receivedAt] of runs) {
      const result = await store.acceptDelivery({
        deliveryId,
        repo,
        issue,
        receivedAt,
      });
      if (!result.value) throw new Error("run acceptance returned no summary");
      accepted.set(issue, result.value.runId);
    }
    const runningRunId = accepted.get(202);
    if (!runningRunId) throw new Error("running run was not accepted");
    await store.appendEvent({
      eventId: "date-filter-started",
      runId: runningRunId,
      type: "dispatch.started",
      stage: "dispatch",
      occurredAt: "2026-09-24T12:00:02.001Z",
      status: "running",
    });

    const page = await store.listRuns({
      repo: "owner/repo",
      statuses: ["queued"],
      from: "2026-09-24T12:00:01.000Z",
      to: "2026-09-24T12:00:03.000Z",
    });

    expect(page.value?.items.map((run) => run.issue)).toEqual([203, 201]);
  });

  it("loads runs and paginates in stable newest-first order", async () => {
    let generated = 0;
    const store = createStore(() => `page-run-${++generated}`);
    const first = await store.acceptDelivery({
      deliveryId: "page-delivery-1",
      repo: "owner/repo",
      issue: 198,
      receivedAt: at,
    });
    const second = await store.acceptDelivery({
      deliveryId: "page-delivery-2",
      repo: "other/repo",
      issue: 199,
      receivedAt: "2026-09-24T12:01:00.000Z",
    });

    const loaded = await store.getRun(first.value!.runId);
    const page1 = await store.listRuns({ limit: 1 });
    const page2 = await store.listRuns({
      limit: 1,
      cursor: page1.value?.nextCursor,
    });
    const filtered = await store.listRuns({ repo: "owner/repo", limit: 10 });

    expect(loaded.ok).toBe(true);
    expect(loaded.value?.runId).toBe(first.value?.runId);
    expect(page1.value?.items.map((run) => run.runId)).toEqual([
      second.value?.runId,
    ]);
    expect(page1.value?.nextCursor).toEqual({
      createdAt: second.value?.createdAt,
      runId: second.value?.runId,
    });
    expect(page2.value?.items.map((run) => run.runId)).toEqual([
      first.value?.runId,
    ]);
    expect(filtered.value?.items.map((run) => run.runId)).toEqual([
      first.value?.runId,
    ]);
  });

  it("persists summaries and immutable events across a store reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "df-run-history-reopen-"));
    directories.push(directory);
    const path = join(directory, "runs.sqlite");
    const firstStore = new SqliteRunHistoryStore(path, () => "durable-run");
    stores.push(firstStore);
    const accepted = await firstStore.acceptDelivery({
      deliveryId: "durable-delivery",
      repo: "owner/repo",
      issue: 198,
      receivedAt: at,
    });
    const runId = accepted.value?.runId;
    if (!runId) throw new Error("run acceptance did not return a runId");
    await firstStore.appendEvent({
      eventId: "durable-dispatch-started",
      runId,
      type: "dispatch.started",
      stage: "dispatch",
      occurredAt: "2026-09-24T12:00:01.000Z",
      status: "running",
    });
    firstStore.close();

    const reopened = new SqliteRunHistoryStore(path);
    stores.push(reopened);
    const loaded = await reopened.getRun(runId);
    const events = await reopened.listRunEvents(runId);

    expect(loaded.value).toMatchObject({ runId, status: "running" });
    expect(events.value?.items.map((item) => item.event.type)).toEqual([
      "run.accepted",
      "dispatch.started",
    ]);
  });

  it("surfaces an unavailable durable path as a blocked write", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "df-run-history-unavailable-"),
    );
    directories.push(directory);
    const store = new SqliteRunHistoryStore(
      join(directory, "missing", "runs.sqlite"),
    );
    stores.push(store);

    const result = await store.acceptDelivery({
      deliveryId: "unavailable-delivery",
      repo: "owner/repo",
      issue: 198,
      receivedAt: at,
    });

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("blocked");
    expect(result.error).toMatch(/unavailable|no such|cannot open|ENOENT/i);
  });

  it("lists append-only lifecycle events in sequence pages", async () => {
    const store = createStore();
    const accepted = await store.acceptDelivery({
      deliveryId: "event-page-delivery",
      repo: "owner/repo",
      issue: 198,
      receivedAt: at,
    });
    const runId = accepted.value?.runId;
    if (!runId) throw new Error("run acceptance did not return a runId");

    await store.appendEvent({
      eventId: "dispatch-started",
      runId,
      type: "dispatch.started",
      stage: "dispatch",
      occurredAt: "2026-09-24T12:00:01.000Z",
      status: "running",
    });
    await store.appendEvent({
      eventId: "attempt-1",
      runId,
      type: "dispatch.attempt",
      stage: "dispatch",
      occurredAt: "2026-09-24T12:00:02.000Z",
      status: "running",
      attempt: 1,
    });

    const firstPage = await store.listRunEvents(runId, { limit: 1 });
    const secondPage = await store.listRunEvents(runId, {
      limit: 1,
      after: firstPage.value?.nextCursor,
    });

    expect(firstPage.ok).toBe(true);
    expect(firstPage.value?.items[0]?.event.type).toBe("run.accepted");
    expect(firstPage.value?.items[0]?.sequence).toBe(1);
    expect(secondPage.value?.items[0]?.event.type).toBe("dispatch.started");
    expect(secondPage.value?.items[0]?.sequence).toBe(2);
  });

  it("aggregates status counts, terminal trend, and measured sums for a repo", async () => {
    let generated = 0;
    const store = createStore(() => `metrics-run-${++generated}`);
    const terminal = async (
      deliveryId: string,
      repo: string,
      issue: number,
      status: "succeeded" | "failed" | "aborted",
      completedAt: string,
      extra: Record<string, unknown> = {},
    ) => {
      const accepted = await store.acceptDelivery({
        deliveryId,
        repo,
        issue,
        receivedAt: completedAt,
      });
      const runId = accepted.value?.runId;
      if (!runId) throw new Error("no runId");
      const result = await store.appendEvent({
        eventId: `${deliveryId}-terminal`,
        runId,
        type: "run.terminal",
        stage: "terminal",
        occurredAt: completedAt,
        status,
        ...extra,
      });
      if (!result.ok) throw new Error("terminal event failed");
    };
    await terminal(
      "m-succeeded",
      "owner/repo",
      300,
      "succeeded",
      "2026-09-24T12:00:00.000Z",
      {
        latencyMs: 1000,
        costUsd: 0.5,
      },
    );
    await terminal(
      "m-failed",
      "owner/repo",
      301,
      "failed",
      "2026-09-24T12:00:00.000Z",
      {
        latencyMs: 2000,
        costUsd: 1.0,
      },
    );
    await terminal(
      "m-aborted",
      "owner/repo",
      302,
      "aborted",
      "2026-09-25T08:00:00.000Z",
      {
        latencyMs: 500,
        costUsd: 0.25,
      },
    );
    const runningAccepted = await store.acceptDelivery({
      deliveryId: "m-running",
      repo: "owner/repo",
      issue: 303,
      receivedAt: "2026-09-26T08:00:00.000Z",
    });
    if (!runningAccepted.value?.runId) throw new Error("no runId");
    await store.appendEvent({
      eventId: "m-running-started",
      runId: runningAccepted.value.runId,
      type: "dispatch.started",
      stage: "dispatch",
      occurredAt: "2026-09-26T08:00:01.000Z",
      status: "running",
    });
    await terminal(
      "m-other",
      "other/repo",
      304,
      "succeeded",
      "2026-09-24T12:00:00.000Z",
      {
        latencyMs: 300,
        costUsd: 0.3,
      },
    );

    const metrics = await store.getRunMetrics({ repo: "owner/repo" });

    const byStatus = Object.fromEntries(
      metrics.value?.statusCounts.map((c) => [c.status, c.count]) ?? [],
    );
    expect(byStatus).toEqual({
      queued: 0,
      running: 1,
      blocked: 0,
      aborted: 1,
      succeeded: 1,
      failed: 1,
    });
    const trend = metrics.value?.trend
      .map((t) => `${t.date}:${t.outcome}:${t.count}`)
      .sort();
    expect(trend).toEqual([
      "2026-09-24:failed:1",
      "2026-09-24:succeeded:1",
      "2026-09-25:aborted:1",
    ]);
    expect(metrics.value?.measured.latencyMs).toEqual({ sum: 3500, count: 3 });
    expect(metrics.value?.measured.costUsd).toEqual({ sum: 1.75, count: 3 });
  });

  it("reports explicit zero measurements as present and absent measurements as missing", async () => {
    let generated = 0;
    const store = createStore(() => `metrics-zero-run-${++generated}`);
    const zero = await store.acceptDelivery({
      deliveryId: "zero",
      repo: "owner/zero",
      issue: 400,
      receivedAt: "2026-09-24T12:00:00.000Z",
    });
    if (!zero.value?.runId) throw new Error("no runId");
    await store.appendEvent({
      eventId: "zero-t",
      runId: zero.value.runId,
      type: "run.terminal",
      stage: "terminal",
      occurredAt: "2026-09-24T12:00:01.000Z",
      status: "succeeded",
      latencyMs: 0,
      costUsd: 0,
    });
    const none = await store.acceptDelivery({
      deliveryId: "none",
      repo: "owner/none",
      issue: 401,
      receivedAt: "2026-09-24T12:00:00.000Z",
    });
    if (!none.value?.runId) throw new Error("no runId");
    await store.appendEvent({
      eventId: "none-t",
      runId: none.value.runId,
      type: "run.terminal",
      stage: "terminal",
      occurredAt: "2026-09-24T12:00:01.000Z",
      status: "succeeded",
    });

    const zeroMetrics = await store.getRunMetrics({ repo: "owner/zero" });
    expect(zeroMetrics.value?.measured.latencyMs).toEqual({ sum: 0, count: 1 });
    expect(zeroMetrics.value?.measured.costUsd).toEqual({ sum: 0, count: 1 });

    const noneMetrics = await store.getRunMetrics({ repo: "owner/none" });
    expect(noneMetrics.value?.measured.latencyMs).toBeUndefined();
    expect(noneMetrics.value?.measured.costUsd).toBeUndefined();
  });

  it("applies inclusive from and exclusive to date filtering to metrics", async () => {
    let generated = 0;
    const store = createStore(() => `metrics-range-run-${++generated}`);
    const terminal = async (
      deliveryId: string,
      issue: number,
      completedAt: string,
      extra: Record<string, unknown> = {},
    ) => {
      const accepted = await store.acceptDelivery({
        deliveryId,
        repo: "owner/repo",
        issue,
        receivedAt: completedAt,
      });
      const runId = accepted.value?.runId;
      if (!runId) throw new Error("no runId");
      const result = await store.appendEvent({
        eventId: `${deliveryId}-t`,
        runId,
        type: "run.terminal",
        stage: "terminal",
        occurredAt: completedAt,
        status: "succeeded",
        ...extra,
      });
      if (!result.ok) throw new Error("terminal failed");
    };
    await terminal("r-before", 410, "2026-09-23T12:00:00.000Z", {
      latencyMs: 100,
    });
    await terminal("r-from", 411, "2026-09-24T00:00:00.000Z", {
      latencyMs: 200,
    });
    await terminal("r-mid", 412, "2026-09-24T12:00:00.000Z", {
      latencyMs: 300,
    });
    await terminal("r-at-to", 413, "2026-09-25T00:00:00.000Z", {
      latencyMs: 400,
    });

    const metrics = await store.getRunMetrics({
      repo: "owner/repo",
      from: "2026-09-24T00:00:00.000Z",
      to: "2026-09-25T00:00:00.000Z",
    });
    const trend = metrics.value?.trend
      .map((t) => `${t.date}:${t.count}`)
      .sort();
    expect(trend).toEqual(["2026-09-24:2"]);
    expect(metrics.value?.measured.latencyMs).toEqual({ sum: 500, count: 2 });
  });
});
