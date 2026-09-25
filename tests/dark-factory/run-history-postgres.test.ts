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
    if (!runId)
      throw new Error("Postgres delivery acceptance returned no runId");

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
    if (!runId)
      throw new Error("Postgres delivery acceptance returned no runId");

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
    if (!runId)
      throw new Error("Postgres delivery acceptance returned no runId");

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

  it("persists control receipt progress across duplicate delivery reads", async () => {
    const repo = "owner/control-progress";
    const accepted = await store.acceptDelivery({
      deliveryId: `pg-control-progress-run-${namespace}`,
      repo,
      issue,
      receivedAt: at,
    });
    const runId = accepted.value?.runId;
    if (!runId)
      throw new Error("Postgres control progress run was not created");
    const claim = {
      deliveryId: `pg-control-progress-${namespace}`,
      repo,
      issue,
      transition: "resume" as const,
      receivedAt: "2026-09-24T12:00:01.000Z",
      runId,
    };
    const first = await store.claimControlDelivery(claim);
    const handoff = await store.advanceControlDelivery({
      ...claim,
      receivedAt: "2026-09-24T12:00:02.000Z",
      handoffSent: true,
    });
    const replay = await store.claimControlDelivery(claim);
    const completed = await store.advanceControlDelivery({
      ...claim,
      receivedAt: "2026-09-24T12:00:03.000Z",
      completed: true,
    });
    const finalReplay = await store.claimControlDelivery(claim);

    expect(first.ok).toBe(true);
    expect(first.value).toMatchObject({ handoffSent: false, completed: false });
    expect(handoff.ok).toBe(true);
    expect(handoff.value).toMatchObject({
      handoffSent: true,
      completed: false,
    });
    expect(replay.ok).toBe(true);
    expect(replay.duplicate).toBe(true);
    expect(replay.value).toMatchObject({ handoffSent: true, completed: false });
    expect(completed.ok).toBe(true);
    expect(completed.value).toMatchObject({
      handoffSent: true,
      completed: true,
    });
    expect(finalReplay.value).toMatchObject({
      handoffSent: true,
      completed: true,
    });
  });

  it("filters runs by inclusive from and exclusive to alongside repo and status", async () => {
    const repo = `owner/date-filter-${namespace}`;
    const runs = [
      ["pg-date-before", 210, "2026-09-24T12:00:00.999Z"],
      ["pg-date-from", 211, "2026-09-24T12:00:01.000Z"],
      ["pg-date-mid", 212, "2026-09-24T12:00:02.000Z"],
      ["pg-date-before-to", 213, "2026-09-24T12:00:02.999Z"],
      ["pg-date-at-to", 214, "2026-09-24T12:00:03.000Z"],
    ] as const;

    for (const [deliveryId, runIssue, receivedAt] of runs) {
      const result = await store.acceptDelivery({
        deliveryId: `${deliveryId}-${namespace}`,
        repo,
        issue: runIssue,
        receivedAt,
      });
      if (!result.ok) throw new Error("Postgres delivery failed");
    }

    const page = await store.listRuns({
      repo,
      statuses: ["queued"],
      from: "2026-09-24T12:00:01.000Z",
      to: "2026-09-24T12:00:03.000Z",
    });

    expect(page.value?.items.map((run) => run.issue)).toEqual([213, 212, 211]);
  });

  it("aggregates status counts, terminal trend, and measured sums", async () => {
    const repo = `owner/metrics-${namespace}`;
    const terminal = async (
      deliveryId: string,
      runIssue: number,
      status: "succeeded" | "failed" | "aborted",
      completedAt: string,
      extra: Record<string, unknown> = {},
    ) => {
      const accepted = await store.acceptDelivery({
        deliveryId: `${deliveryId}-${namespace}`,
        repo,
        issue: runIssue,
        receivedAt: completedAt,
      });
      if (!accepted.ok) throw new Error("delivery failed");
      const result = await store.appendEvent({
        eventId: `${deliveryId}-t-${namespace}`,
        runId: accepted.value!.runId,
        type: "run.terminal",
        stage: "terminal",
        occurredAt: completedAt,
        status,
        ...extra,
      });
      if (!result.ok) throw new Error("terminal failed");
    };
    await terminal(
      "pg-m-succeeded",
      500,
      "succeeded",
      "2026-09-24T12:00:00.000Z",
      {
        latencyMs: 1000,
        costUsd: 0.5,
      },
    );
    await terminal("pg-m-failed", 501, "failed", "2026-09-24T12:00:00.000Z", {
      latencyMs: 2000,
      costUsd: 1.0,
    });
    await terminal("pg-m-aborted", 502, "aborted", "2026-09-25T08:00:00.000Z", {
      latencyMs: 500,
      costUsd: 0.25,
    });

    const metrics = await store.getRunMetrics({ repo });

    const byStatus = Object.fromEntries(
      metrics.value?.statusCounts.map((c) => [c.status, c.count]) ?? [],
    );
    expect(byStatus).toEqual({
      queued: 0,
      running: 0,
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
});
