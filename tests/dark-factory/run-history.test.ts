import { describe, expect, it } from "vitest";
import {
  InvalidRunRecordError,
  toRunEvent,
  toRunSummary,
  type RunEvent,
  type RunSummary,
} from "../../agent/lib/dark-factory/run-history";

const at = "2026-09-24T12:00:00.000Z";

function summary(status: RunSummary["status"] = "running"): RunSummary {
  const completed = ["aborted", "succeeded", "failed"].includes(status);
  const started = status !== "queued";
  return {
    runId: "run-1",
    repo: "owner/repo",
    issue: 198,
    status,
    stage: "worker",
    createdAt: at,
    updatedAt: at,
    ...(started ? { startedAt: at } : {}),
    ...(completed ? { completedAt: at } : {}),
    attemptCount: 1,
    reviewCount: 0,
    iterationCount: 1,
    fixCycleCount: 0,
  };
}

function event(type: RunEvent["type"] = "worker.progress"): RunEvent {
  return {
    eventId: "evt-1",
    runId: "run-1",
    type,
    stage: "worker",
    occurredAt: at,
    ...(type === "run.terminal" ? { status: "succeeded" as const } : {}),
  };
}

describe("canonical run history records", () => {
  it.each(["blocked", "aborted"] as const)(
    "preserves %s as a distinct run status",
    (status) => {
      expect(toRunSummary(summary(status)).status).toBe(status);
    },
  );

  it("keeps unmeasured latency and cost absent but preserves measured zero", () => {
    const unmeasured = toRunSummary({ ...summary(), ignored: "drop-me" } as never);
    expect(unmeasured).not.toHaveProperty("latencyMs");
    expect(unmeasured).not.toHaveProperty("costUsd");
    expect(unmeasured).not.toHaveProperty("ignored");

    const measured = toRunSummary({
      ...summary(),
      latencyMs: 0,
      costUsd: 0,
    });
    expect(measured).toMatchObject({ latencyMs: 0, costUsd: 0 });
  });

  it("rejects malformed run identity, status, counters, and timestamps", () => {
    expect(() => toRunSummary({ ...summary(), runId: "  " })).toThrow(
      InvalidRunRecordError,
    );
    expect(() =>
      toRunSummary({ ...summary(), status: "complete" as never }),
    ).toThrow(/status/i);
    expect(() => toRunSummary({ ...summary(), attemptCount: -1 })).toThrow(
      /attemptCount/i,
    );
    expect(() => toRunSummary({ ...summary(), createdAt: "yesterday" })).toThrow(
      /createdAt/i,
    );
  });

  it("requires terminal timestamps but leaves blocked runs resumable", () => {
    expect(() =>
      toRunSummary({ ...summary("succeeded"), completedAt: undefined }),
    ).toThrow(/completedAt/i);
    expect(() =>
      toRunSummary({ ...summary("running"), completedAt: at }),
    ).toThrow(/completedAt/i);
    expect(toRunSummary(summary("blocked")).completedAt).toBeUndefined();
  });

  it("preserves optional event measurements only when they were supplied", () => {
    const unmeasured = toRunEvent(event("run.terminal"));
    expect(unmeasured).not.toHaveProperty("latencyMs");
    expect(unmeasured).not.toHaveProperty("costUsd");

    const measured = toRunEvent({
      ...event("run.terminal"),
      status: "succeeded",
      latencyMs: 0,
      costUsd: 0,
    });
    expect(measured).toMatchObject({
      status: "succeeded",
      latencyMs: 0,
      costUsd: 0,
    });
  });

  it("preserves bounded review-finding disposition counts", () => {
    const review = toRunEvent({
      ...event("review.round"),
      stage: "review",
      reviewRound: 1,
      findingCount: 4,
      resolvedCount: 2,
      acceptedCount: 1,
    });
    expect(review).toMatchObject({
      findingCount: 4,
      resolvedCount: 2,
      acceptedCount: 1,
    });
    expect(() =>
      toRunEvent({
        ...event("review.round"),
        stage: "review",
        reviewRound: 1,
        findingCount: 1,
        acceptedCount: 2,
      }),
    ).toThrow(/findingCount/i);
  });

  it("rejects incomplete or unsafe events", () => {
    expect(() => toRunEvent({ ...event(), eventId: "" })).toThrow(
      /eventId/i,
    );
    expect(() =>
      toRunEvent({ ...event(), type: "unknown" as never }),
    ).toThrow(/type/i);
    expect(() => toRunEvent({ ...event(), costUsd: Number.NaN })).toThrow(
      /costUsd/i,
    );
    expect(() => toRunEvent({ ...event(), prUrl: "javascript:alert(1)" })).toThrow(
      /prUrl/i,
    );
  });

  it("projects resumable blocked state and preserves cumulative counters", async () => {
    const mod = await import("../../agent/lib/dark-factory/run-history");
    const apply = (
      mod as unknown as {
        applyRunEvent?: (summary: RunSummary, event: RunEvent) => RunSummary;
      }
    ).applyRunEvent;
    expect(typeof apply).toBe("function");
    if (!apply) return;

    const blocked = apply(
      summary(),
      toRunEvent({
        ...event("worker.question"),
        status: "blocked",
        iterationCount: 3,
        fixCycleCount: 1,
      }),
    );
    expect(blocked.status).toBe("blocked");
    expect(blocked.completedAt).toBeUndefined();
    expect(blocked.iterationCount).toBe(3);
    expect(blocked.fixCycleCount).toBe(1);

    const resumed = apply(
      blocked,
      toRunEvent({
        eventId: "evt-resume",
        runId: "run-1",
        type: "run.resumed" as never,
        stage: "dispatch",
        occurredAt: "2026-09-24T12:01:00.000Z",
        status: "running",
      }),
    );
    expect(resumed.status).toBe("running");
    expect(resumed.startedAt).toBe(at);

    const reviewed = apply(
      resumed,
      toRunEvent({
        eventId: "evt-review-2",
        runId: "run-1",
        type: "review.round",
        stage: "review",
        occurredAt: "2026-09-24T12:02:00.000Z",
        reviewRound: 2,
        status: "running",
      }),
    );
    expect(reviewed.reviewCount).toBe(2);
  });

  it("records a terminal outcome once and does not let later events rewrite it", async () => {
    const mod = await import("../../agent/lib/dark-factory/run-history");
    const apply = (
      mod as unknown as {
        applyRunEvent?: (summary: RunSummary, event: RunEvent) => RunSummary;
      }
    ).applyRunEvent;
    expect(typeof apply).toBe("function");
    if (!apply) return;

    const finished = apply(
      summary(),
      toRunEvent({
        ...event("run.terminal"),
        status: "succeeded",
        stage: "terminal",
        prUrl: "https://github.com/owner/repo/pull/198",
      }),
    );
    expect(finished.status).toBe("succeeded");
    expect(finished.completedAt).toBe(at);
    expect(finished.prUrl).toBe("https://github.com/owner/repo/pull/198");
    expect(() => apply(finished, event())).toThrow(/terminal/i);
  });
});
