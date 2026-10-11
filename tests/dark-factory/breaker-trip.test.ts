import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import {
  toRunEvent,
  type BreakerTrip,
} from "../../agent/lib/dark-factory/run-history";
import { createCircuitBreaker } from "../../agent/lib/dark-factory/circuit-breaker";
import { recordBreakerTrip } from "../../agent/lib/dark-factory/breaker-trip-recorder";

const at = "2026-10-11T12:00:00.000Z";
const directories: string[] = [];
const stores: SqliteRunHistoryStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "df-breaker-trip-"));
  directories.push(directory);
  const store = new SqliteRunHistoryStore(
    join(directory, "runs.sqlite"),
    () => "run-1",
  );
  stores.push(store);
  return store;
}

describe("breaker trip persistence (#313)", () => {
  it("accepts a closed-vocabulary trip and refuses free text", () => {
    const base = {
      eventId: "trip-1",
      runId: "run-1",
      type: "run.terminal" as const,
      stage: "terminal" as const,
      occurredAt: at,
      status: "failed" as const,
    };
    const trip: BreakerTrip = {
      reason: "worker-minutes-exceeded",
      limit: 60,
      workerMinutes: 61,
    };

    expect(toRunEvent({ ...base, breakerTrip: trip }).breakerTrip).toEqual(trip);

    // A reason outside the closed vocabulary is not a trip, it is prose.
    expect(() =>
      toRunEvent({
        ...base,
        breakerTrip: { ...trip, reason: "we spent far too much" as never },
      }),
    ).toThrow();
    // The bound is a real cap, not free text either.
    expect(() =>
      toRunEvent({ ...base, breakerTrip: { ...trip, limit: 0 } }),
    ).toThrow();
  });

  it("round-trips the trip through the ledger", async () => {
    const store = createStore();
    const accepted = await store.acceptDelivery({
      deliveryId: "d-1",
      repo: "Owner/Repo",
      issue: 313,
      receivedAt: at,
    });
    const runId = accepted.value!.runId;
    const trip: BreakerTrip = {
      reason: "failed-selfcorrect-exceeded",
      limit: 3,
      workerMinutes: 12,
    };

    const written = await recordBreakerTrip(store, { runId, trip, occurredAt: at });
    expect(written.ok).toBe(true);

    const events = (await store.listRunEvents(runId)).value?.items ?? [];
    const persisted = events.find((entry) => entry.event.breakerTrip);
    expect(persisted?.event.breakerTrip).toEqual(trip);
    expect(persisted?.event.type).toBe("run.terminal");
    expect(persisted?.event.status).toBe("failed");
  });

  it("is idempotent per (run, reason)", async () => {
    const store = createStore();
    const accepted = await store.acceptDelivery({
      deliveryId: "d-2",
      repo: "Owner/Repo",
      issue: 313,
      receivedAt: at,
    });
    const runId = accepted.value!.runId;
    const trip: BreakerTrip = {
      reason: "worker-minutes-exceeded",
      limit: 60,
      workerMinutes: 61,
    };

    await recordBreakerTrip(store, { runId, trip, occurredAt: at });
    const replay = await recordBreakerTrip(store, { runId, trip, occurredAt: at });

    expect(replay.ok).toBe(true);
    const events = (await store.listRunEvents(runId)).value?.items ?? [];
    expect(events.filter((entry) => entry.event.breakerTrip)).toHaveLength(1);
  });

  it("stamps the cap that was hit onto the breaker's own trip event", () => {
    const breaker = createCircuitBreaker({
      DF_MAX_WORKER_MINUTES_PER_PBI: "1",
      DF_MIN_DURATION_MS: "0",
    });

    breaker.recordWorkerActivity({
      pbiId: "pbi-313",
      durationMs: 1,
      status: "success",
    });

    const trips = breaker.getTripEvents();
    expect(trips).toHaveLength(1);
    expect(trips[0].reason).toBe("worker-minutes-exceeded");
    expect(trips[0].limit).toBe(1);
  });

  it("stamps the self-correct cap for a failure trip", () => {
    const breaker = createCircuitBreaker({
      DF_MAX_FAILED_SELFCORRECT: "2",
      DF_MIN_DURATION_MS: "60000",
    });

    // The breaker discards sub-threshold durations BEFORE counting a failure, so the
    // activity has to clear minDurationMs to reach the failure branch at all.
    for (const _ of [1, 2]) {
      breaker.recordWorkerActivity({
        pbiId: "pbi-313",
        durationMs: 60_000,
        status: "failure",
      });
    }

    const trips = breaker.getTripEvents();
    expect(trips).toHaveLength(1);
    expect(trips[0].reason).toBe("failed-selfcorrect-exceeded");
    expect(trips[0].limit).toBe(2);
  });
});
