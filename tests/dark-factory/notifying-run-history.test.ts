import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import { NotifyingRunHistoryStore } from "../../agent/lib/dark-factory/notifying-run-history";
import { toRunEvent } from "../../agent/lib/dark-factory/run-history";
import type { Notification } from "../../agent/lib/dark-factory/notifications";

const at = "2026-10-11T12:00:00.000Z";
const directories: string[] = [];
const stores: { close: () => void | Promise<void> }[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function recordingProvider() {
  const sent: Notification[] = [];
  return {
    id: "recorder",
    mode: "live" as const,
    sent,
    async notify(notification: Notification) {
      sent.push(notification);
      return { ok: true, mode: "live" as const, providerId: "recorder" };
    },
  };
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "df-notify-"));
  directories.push(directory);
  const inner = new SqliteRunHistoryStore(
    join(directory, "runs.sqlite"),
    () => "run-1",
  );
  stores.push(inner);
  const provider = recordingProvider();
  const log = vi.fn();
  const store = new NotifyingRunHistoryStore(inner, provider, { log });
  return { inner, store, provider, log };
}

async function accept(store: NotifyingRunHistoryStore, deliveryId = "d-1") {
  return store.acceptDelivery({
    deliveryId,
    repo: "Owner/Repo",
    issue: 317,
    receivedAt: at,
  });
}

describe("NotifyingRunHistoryStore (#317)", () => {
  it("notifies 'started' when the run is accepted", async () => {
    const { store, provider } = setup();

    await accept(store);

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].kind).toBe("started");
    expect(provider.sent[0].runId).toBe("run-1");
    expect(provider.sent[0].issue).toBe(317);
  });

  it("notifies 'started' only ONCE for a replayed delivery", async () => {
    const { store, provider } = setup();

    await accept(store);
    await accept(store);

    expect(provider.sent).toHaveLength(1);
  });

  it.each([
    ["succeeded", "succeeded"],
    ["failed", "failed"],
    ["aborted", "aborted"],
  ] as const)("notifies the terminal transition (%s)", async (status, kind) => {
    const { store, provider } = setup();
    await accept(store);

    await store.appendEvent(
      toRunEvent({
        eventId: "terminal-1",
        runId: "run-1",
        type: "run.terminal",
        stage: "terminal",
        occurredAt: at,
        status,
      }),
    );

    expect(provider.sent.map((n) => n.kind)).toEqual(["started", kind]);
  });

  it("notifies 'parked' when a question is raised", async () => {
    const { store, provider } = setup();
    await accept(store);

    await store.appendEvent(
      toRunEvent({
        eventId: "q-1",
        runId: "run-1",
        type: "worker.question",
        stage: "worker",
        occurredAt: at,
        status: "blocked",
      }),
    );

    expect(provider.sent.map((n) => n.kind)).toEqual(["started", "parked"]);
  });

  it("notifies 'tripped' when the event carries a breaker trip", async () => {
    const { store, provider } = setup();
    await accept(store);

    await store.appendEvent(
      toRunEvent({
        eventId: "trip-1",
        runId: "run-1",
        type: "run.terminal",
        stage: "terminal",
        occurredAt: at,
        status: "failed",
        breakerTrip: {
          reason: "worker-minutes-exceeded",
          limit: 60,
          workerMinutes: 61,
        },
      }),
    );

    expect(provider.sent.map((n) => n.kind)).toContain("tripped");
    expect(provider.sent.find((n) => n.kind === "tripped")?.reasonCode).toBe(
      "worker-minutes-exceeded",
    );
  });

  it("notifies a transition only ONCE when the same event is appended twice", async () => {
    const { store, provider } = setup();
    await accept(store);
    const event = toRunEvent({
      eventId: "terminal-dupe",
      runId: "run-1",
      type: "run.terminal",
      stage: "terminal",
      occurredAt: at,
      status: "succeeded",
    });

    await store.appendEvent(event);
    await store.appendEvent(event);

    expect(provider.sent.filter((n) => n.kind === "succeeded")).toHaveLength(1);
  });

  it("ignores events that are not transitions", async () => {
    const { store, provider } = setup();
    await accept(store);

    await store.appendEvent(
      toRunEvent({
        eventId: "d-started",
        runId: "run-1",
        type: "dispatch.started",
        stage: "dispatch",
        occurredAt: at,
      }),
    );

    expect(provider.sent.map((n) => n.kind)).toEqual(["started"]);
  });

  it("never fails the run when the provider fails, and reports it", async () => {
    const { inner, log } = setup();
    const exploding = {
      id: "boom",
      mode: "live" as const,
      notify: async () => {
        throw new Error("slack is down");
      },
    };
    const store = new NotifyingRunHistoryStore(inner, exploding, { log });

    const accepted = await accept(store);
    expect(accepted.ok).toBe(true);
    expect(log.mock.calls.flat().join(" ")).toMatch(/slack is down/i);

    const appended = await store.appendEvent(
      toRunEvent({
        eventId: "terminal-boom",
        runId: "run-1",
        type: "run.terminal",
        stage: "terminal",
        occurredAt: at,
        status: "failed",
      }),
    );
    expect(appended.ok).toBe(true);
  });
});
