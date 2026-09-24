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

  it("advances control delivery progress monotonically and idempotently", async () => {
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
});
