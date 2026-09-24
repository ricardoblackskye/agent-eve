import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresRunHistoryStore } from "../../agent/lib/dark-factory/run-history-postgres";

const connectionString = process.env.DF_RUN_HISTORY_TEST_DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;
const at = "2026-09-24T12:00:00.000Z";

describeWithDatabase("PostgresRunHistoryStore integration", () => {
  const namespace = randomUUID();
  const issue = Number.parseInt(namespace.slice(0, 6), 16) + 1;
  const store = new PostgresRunHistoryStore(connectionString as string);

  afterAll(async () => {
    await store.close();
  });

  it("atomically persists an idempotent delivery, events, and queryable summary", async () => {
    const deliveryId = `pg-delivery-${namespace}`;
    const accepted = await store.acceptDelivery({
      deliveryId,
      repo: "owner/repo",
      issue,
      receivedAt: at,
    });
    const replay = await store.acceptDelivery({
      deliveryId,
      repo: "owner/repo",
      issue,
      receivedAt: at,
    });
    const runId = accepted.value?.runId;
    if (!runId) throw new Error("Postgres delivery acceptance returned no runId");

    const event = await store.appendEvent({
      eventId: `pg-dispatch-${namespace}`,
      runId,
      type: "dispatch.started",
      stage: "dispatch",
      occurredAt: "2026-09-24T12:00:01.000Z",
      status: "running",
    });
    const loaded = await store.getRun(runId);
    const events = await store.listRunEvents(runId);

    expect(accepted.ok).toBe(true);
    expect(accepted.duplicate).toBe(false);
    expect(replay.ok).toBe(true);
    expect(replay.duplicate).toBe(true);
    expect(replay.value?.runId).toBe(runId);
    expect(event.ok).toBe(true);
    expect(loaded.value).toMatchObject({ runId, status: "running" });
    expect(events.value?.items.map((item) => item.event.type)).toEqual([
      "run.accepted",
      "dispatch.started",
    ]);
  });

  it("round-trips review finding dispositions through the event table", async () => {
    const accepted = await store.acceptDelivery({
      deliveryId: `pg-review-${namespace}`,
      repo: "owner/review-counts",
      issue,
      receivedAt: at,
    });
    const runId = accepted.value?.runId;
    if (!runId) throw new Error("Postgres delivery acceptance returned no runId");

    const recorded = await store.appendEvent({
      eventId: `pg-review-round-${namespace}`,
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

  it("creates a new run for each distinct delivery and permits reruns after terminal state", async () => {
    const repo = "owner/active-run";
    const first = await store.acceptDelivery({
      deliveryId: `pg-active-first-${namespace}`,
      repo,
      issue,
      receivedAt: at,
    });
    const controlClaim = await store.claimControlDelivery({
      deliveryId: `pg-control-abort-${namespace}`,
      repo,
      issue,
      transition: "abort",
      receivedAt: "2026-09-24T12:00:00.500Z",
      runId: first.value?.runId,
    });
    const activeDelivery = await store.acceptDelivery({
      deliveryId: `pg-active-second-${namespace}`,
      repo,
      issue,
      receivedAt: "2026-09-24T12:00:01.000Z",
    });
    const runId = first.value?.runId;
    if (!runId) throw new Error("Postgres delivery acceptance returned no runId");

    expect(controlClaim.ok).toBe(true);
    expect(controlClaim.duplicate).toBe(false);
    expect(activeDelivery.ok).toBe(true);
    expect(activeDelivery.duplicate).toBe(false);
    expect(activeDelivery.value?.runId).not.toBe(runId);

    const aborted = await store.appendEvent({
      eventId: `pg-abort-${namespace}`,
      runId,
      type: "run.terminal",
      stage: "terminal",
      occurredAt: "2026-09-24T12:00:02.000Z",
      status: "aborted",
    });
    const replay = await store.claimControlDelivery({
      deliveryId: `pg-control-abort-${namespace}`,
      repo,
      issue,
      transition: "abort",
      receivedAt: "2026-09-24T12:00:02.500Z",
      runId: activeDelivery.value?.runId,
    });
    const rerun = await store.acceptDelivery({
      deliveryId: `pg-active-third-${namespace}`,
      repo,
      issue,
      receivedAt: "2026-09-24T12:00:03.000Z",
    });

    expect(aborted.ok).toBe(true);
    expect(replay.ok).toBe(true);
    expect(replay.duplicate).toBe(true);
    expect(replay.value?.runId).toBe(runId);
    expect(replay.value?.runStatus).toBe("aborted");
    expect(rerun.ok).toBe(true);
    expect(rerun.duplicate).toBe(false);
    expect(rerun.value?.runId).not.toBe(runId);
  });
});
